-- ============================================================================
-- One.Health Partners — 340B Operations Platform
-- CONSOLIDATED schema: tables, RLS policies, and atomic RPC functions.
--
-- This is the single source of truth. It folds in what used to be
-- supabase/migrations/0001-0006 (pharmacy-scoped accumulator + RX-level
-- claim ledger) directly into each table/function's final shape — it does
-- NOT replay the migration history. Run this once on a fresh Supabase
-- project (SQL Editor), then supabase/seed.sql. The old migrations/ folder
-- has been removed; do not run it alongside this file.
--
-- SAFE TO RE-RUN: every CREATE TABLE uses IF NOT EXISTS; every CREATE
-- POLICY/TRIGGER is preceded by a matching DROP ... IF EXISTS ... CASCADE;
-- every function uses CREATE OR REPLACE, with DROP FUNCTION IF EXISTS
-- CASCADE first for any signature that changed shape historically (so no
-- orphaned overload can ever cause a "duplicate function" conflict).
--
-- ARCHITECTURE NOTE ON WRITES
-- ---------------------------
-- claims, claim_line_items, claim_raw_lines, accumulator_audit_log, and
-- accumulator_field_edit_log have NO direct INSERT/UPDATE/DELETE RLS
-- policies for client roles. All writes to these tables happen exclusively
-- through the SECURITY DEFINER RPC functions defined at the bottom of this
-- file (process_claim, edit_accumulator_row, delete_accumulator_row,
-- add_accumulator_row, rollover_month, import_accumulator_rows). Those
-- functions are owned by the role that runs this script (bypasses RLS as
-- table owner) and each function body executes as a single Postgres
-- transaction — any RAISE EXCEPTION inside rolls back every write the
-- function made.
--
-- ARCHITECTURE NOTE ON PHARMACY SCOPING
-- --------------------------------------
-- Every accumulator row, claim, and audit entry belongs to exactly one
-- pharmacy. accumulator is keyed on (ndc, facility_id, pharmacy_id, month,
-- year) — never shared across pharmacies at the same facility even for the
-- same NDC. A trigger (validate_pharmacy_facility_pair) rejects any row
-- whose (facility_id, pharmacy_id) isn't a real link in pharmacy_facilities.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- TABLES
-- ============================================================================

create table if not exists public.facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_code text not null unique,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.pharmacies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Many-to-many: a pharmacy can serve multiple facilities.
create table if not exists public.pharmacy_facilities (
  pharmacy_id uuid not null references public.pharmacies(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  primary key (pharmacy_id, facility_id)
);

-- Mirrors auth.users; role/active/profile fields live here.
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role text not null default 'regular' check (role in ('admin', 'regular')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Master drug inventory. One row per NDC per FACILITY + PHARMACY per
-- month/year — pharmacy_id is required and is part of the uniqueness key,
-- so two pharmacies at the same facility never share an accumulator row.
create table if not exists public.accumulator (
  id uuid primary key default gen_random_uuid(),
  ndc varchar(11) not null,
  product_name text not null,
  pack_size numeric,
  qty_on_hand numeric not null default 0,
  packs_on_hand numeric,
  exp_day date,
  price_340b numeric,
  ppu_340b numeric,
  cost_on_hand_340b numeric,
  cin text,
  manufacturer text,
  facility_id uuid not null references public.facilities(id),
  pharmacy_id uuid not null references public.pharmacies(id),
  month integer not null check (month between 1 and 12),
  year integer not null check (year between 2020 and 2100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accumulator_unique_ndc_period unique (ndc, facility_id, pharmacy_id, month, year)
);

create index if not exists idx_accumulator_facility_pharmacy_period on public.accumulator (facility_id, pharmacy_id, year, month);
create index if not exists idx_accumulator_ndc on public.accumulator (ndc);
create index if not exists idx_accumulator_pharmacy on public.accumulator (pharmacy_id);

comment on column public.accumulator.pharmacy_id is 'Required. Every accumulator row belongs to exactly one pharmacy — never shared across pharmacies at the same facility.';

-- Insert-only ledger required for HRSA audit readiness. Written by
-- process_claim, edit_accumulator_row, delete_accumulator_row,
-- add_accumulator_row, rollover_month, and import_accumulator_rows.
create table if not exists public.accumulator_audit_log (
  id uuid primary key default gen_random_uuid(),
  "timestamp" timestamptz not null default now(),
  user_id uuid references public.users(id),
  claim_id uuid,
  ndc varchar(11) not null,
  product_name text,
  prior_qty numeric,
  qty_dispensed numeric,
  new_qty numeric,
  reimbursement_amount numeric,
  action_type text not null check (action_type in
    ('claim_dispense', 'claim_reversal', 'manual_qty_edit', 'rollover', 'manual_add', 'import_override', 'manual_delete')),
  facility_id uuid references public.facilities(id),
  pharmacy_id uuid references public.pharmacies(id)
);

create index if not exists idx_audit_log_ndc on public.accumulator_audit_log (ndc);
create index if not exists idx_audit_log_claim on public.accumulator_audit_log (claim_id);
create index if not exists idx_audit_log_pharmacy on public.accumulator_audit_log (pharmacy_id);

-- Companion insert-only log for non-qty inline edits (pack size, price, PPU,
-- exp day, CIN, manufacturer). Kept separate from accumulator_audit_log
-- because that table's columns are qty/reimbursement-shaped; this one is a
-- generic field-level diff log, still insert-only, still HRSA-relevant.
create table if not exists public.accumulator_field_edit_log (
  id uuid primary key default gen_random_uuid(),
  "timestamp" timestamptz not null default now(),
  user_id uuid references public.users(id),
  accumulator_id uuid not null,
  ndc varchar(11) not null,
  field_name text not null,
  prior_value text,
  new_value text,
  facility_id uuid references public.facilities(id),
  pharmacy_id uuid references public.pharmacies(id)
);

create index if not exists idx_field_edit_log_pharmacy on public.accumulator_field_edit_log (pharmacy_id);

-- One row per pharmacy/facility/claim-date upload ("claim batch"). Already
-- correctly pharmacy-scoped from the start via the unique constraint below.
create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references public.pharmacies(id),
  facility_id uuid not null references public.facilities(id),
  claim_date date not null,
  uploaded_by uuid references public.users(id),
  uploaded_at timestamptz not null default now(),
  file_path text,
  status text not null default 'completed' check (status in ('completed', 'superseded')),
  total_reimbursement numeric not null default 0,
  notes text,
  original_filename text,
  file_hash text,
  total_rows integer,
  valid_rows integer,
  invalid_rows integer,
  matched_count integer,
  unmatched_count integer,
  claim_line_count integer,
  distinct_rx_count integer,
  distinct_ndc_count integer,
  total_qty_dispensed numeric,
  constraint claims_unique_period unique (pharmacy_id, facility_id, claim_date)
);

create index if not exists idx_claims_date on public.claims (claim_date);
create index if not exists idx_claims_facility on public.claims (facility_id);
create index if not exists idx_claims_file_hash on public.claims (pharmacy_id, facility_id, file_hash);

comment on column public.claims.file_hash is 'SHA-256 of the uploaded file content, used for duplicate-upload detection alongside pharmacy+facility+claim_date.';

-- One row PER NDC per claim (pivoted/summed) — drives accumulator
-- deduction, reimbursement, and the audit log. For per-RX-line detail
-- (Refill No., RX#, prescriber, etc.) see claim_raw_lines below.
create table if not exists public.claim_line_items (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  ndc varchar(11) not null,
  product_name text,
  qty_dispensed numeric not null,
  pack_size numeric,
  packs_dispensed numeric,
  ppu_340b numeric,
  reimbursement_owed numeric,
  qty_before numeric,
  qty_after numeric,
  matched boolean not null default false,
  flag_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_line_items_claim on public.claim_line_items (claim_id);
create index if not exists idx_line_items_ndc on public.claim_line_items (ndc);

-- One row PER ORIGINAL SOURCE LINE (per RX fill) — pure record-keeping for
-- the "All Claims" tab. Never affects the accumulator; matched status is
-- inherited from whichever NDC-level claim_line_items row shares its NDC.
create table if not exists public.claim_raw_lines (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  line_number integer not null,
  ndc varchar(11) not null,
  product_name text,
  qty_dispensed numeric not null,
  matched boolean not null default false,
  refill_no integer,
  refills_auth integer,
  refills_remain integer,
  date_filled date,
  date_written date,
  rx_number text,
  days_supply numeric,
  primary_paid numeric,
  patient_paid numeric,
  tax numeric,
  fee numeric,
  total_paid numeric,
  primary_payer text,
  bin text,
  pcn text,
  group_code text,
  member_id text,
  scc text,
  prescriber text,
  prescriber_npi text,
  created_at timestamptz not null default now()
);

create index if not exists idx_raw_lines_claim on public.claim_raw_lines (claim_id);
create index if not exists idx_raw_lines_rx on public.claim_raw_lines (rx_number);
create index if not exists idx_raw_lines_ndc on public.claim_raw_lines (ndc);

comment on table public.claim_raw_lines is 'Read-only, per-RX-line source ledger for the Claim Batch Results "All Claims" tab. Does not drive accumulator math — see claim_line_items for the NDC-pivoted totals that do.';
comment on column public.claim_raw_lines.rx_number is 'Stored as text to preserve leading zeros, matching the source workbook''s own text-typed RX# column.';

-- ============================================================================
-- HELPER FUNCTIONS (security definer so RLS policies can call them without
-- recursively evaluating RLS on public.users)
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' and active from public.users where id = auth.uid()), false);
$$;

create or replace function public.is_active_user()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select active from public.users where id = auth.uid()), false);
$$;

-- True when (p_month, p_year) is the latest (i.e. currently-open) period on
-- record for this facility+pharmacy pair. Used to enforce "historical
-- months are read-only", scoped per pharmacy (not per facility) so closing
-- one pharmacy's month never affects another pharmacy at the same facility.
drop function if exists public.is_latest_period(uuid, integer, integer) cascade;
create or replace function public.is_latest_period(p_facility_id uuid, p_pharmacy_id uuid, p_month integer, p_year integer)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select (p_year, p_month) = (
    select year, month from public.accumulator
    where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id
    order by year desc, month desc
    limit 1
  )
  or not exists (
    select 1 from public.accumulator where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id
  );
$$;

-- Rejects any insert/update where (facility_id, pharmacy_id) isn't a real
-- link in pharmacy_facilities. Applied to accumulator and claims.
create or replace function public.validate_pharmacy_facility_pair()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pharmacy_id is null or new.facility_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.pharmacy_facilities
    where pharmacy_id = new.pharmacy_id and facility_id = new.facility_id
  ) then
    raise exception 'Pharmacy % is not linked to facility %', new.pharmacy_id, new.facility_id;
  end if;
  return new;
end;
$$;

-- Auto-create a public.users row (role='regular') whenever a new Supabase Auth
-- user is created. Admins upgrade the role afterward from Settings.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, role, active)
  values (new.id, new.email, 'regular', true)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

drop trigger if exists on_auth_user_created on auth.users cascade;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

drop trigger if exists validate_accumulator_pharmacy_facility on public.accumulator cascade;
create trigger validate_accumulator_pharmacy_facility
  before insert or update of pharmacy_id, facility_id on public.accumulator
  for each row execute function public.validate_pharmacy_facility_pair();

drop trigger if exists validate_claims_pharmacy_facility on public.claims cascade;
create trigger validate_claims_pharmacy_facility
  before insert or update of pharmacy_id, facility_id on public.claims
  for each row execute function public.validate_pharmacy_facility_pair();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table public.facilities enable row level security;
alter table public.pharmacies enable row level security;
alter table public.pharmacy_facilities enable row level security;
alter table public.users enable row level security;
alter table public.accumulator enable row level security;
alter table public.accumulator_audit_log enable row level security;
alter table public.accumulator_field_edit_log enable row level security;
alter table public.claims enable row level security;
alter table public.claim_line_items enable row level security;
alter table public.claim_raw_lines enable row level security;

-- facilities: any active user reads; only admin writes
drop policy if exists facilities_select on public.facilities;
create policy facilities_select on public.facilities for select using (public.is_active_user());
drop policy if exists facilities_insert on public.facilities;
create policy facilities_insert on public.facilities for insert with check (public.is_admin());
drop policy if exists facilities_update on public.facilities;
create policy facilities_update on public.facilities for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists facilities_delete on public.facilities;
create policy facilities_delete on public.facilities for delete using (public.is_admin());

-- pharmacies: any active user reads; only admin writes
drop policy if exists pharmacies_select on public.pharmacies;
create policy pharmacies_select on public.pharmacies for select using (public.is_active_user());
drop policy if exists pharmacies_insert on public.pharmacies;
create policy pharmacies_insert on public.pharmacies for insert with check (public.is_admin());
drop policy if exists pharmacies_update on public.pharmacies;
create policy pharmacies_update on public.pharmacies for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists pharmacies_delete on public.pharmacies;
create policy pharmacies_delete on public.pharmacies for delete using (public.is_admin());

-- pharmacy_facilities: any active user reads; only admin writes
drop policy if exists pharmacy_facilities_select on public.pharmacy_facilities;
create policy pharmacy_facilities_select on public.pharmacy_facilities for select using (public.is_active_user());
drop policy if exists pharmacy_facilities_insert on public.pharmacy_facilities;
create policy pharmacy_facilities_insert on public.pharmacy_facilities for insert with check (public.is_admin());
drop policy if exists pharmacy_facilities_delete on public.pharmacy_facilities;
create policy pharmacy_facilities_delete on public.pharmacy_facilities for delete using (public.is_admin());

-- users: data is org-wide (shared pool), so any active user can read the
-- user directory (needed for "Uploaded By" columns, user pickers, etc).
-- Only admin can write (role/active changes). No delete policy anywhere —
-- deactivation is done via the `active` flag.
drop policy if exists users_select_self on public.users;
drop policy if exists users_select_admin on public.users;
drop policy if exists users_select_active on public.users;
create policy users_select_active on public.users for select using (public.is_active_user() or id = auth.uid());
drop policy if exists users_update_admin on public.users;
create policy users_update_admin on public.users for update using (public.is_admin()) with check (public.is_admin());

-- accumulator: any active user reads; admin may directly insert/update ONLY
-- into the latest (open) period for a facility+pharmacy — historical
-- months are read-only at the RLS layer. Normal app writes go through the
-- RPCs below, which run as the table owner and are not limited by this
-- policy. No delete policy: rows are only removed via delete_accumulator_row.
drop policy if exists accumulator_select on public.accumulator;
create policy accumulator_select on public.accumulator for select using (public.is_active_user());
drop policy if exists accumulator_insert on public.accumulator;
create policy accumulator_insert on public.accumulator for insert
  with check (public.is_admin() and public.is_latest_period(facility_id, pharmacy_id, month, year));
drop policy if exists accumulator_update on public.accumulator;
create policy accumulator_update on public.accumulator for update
  using (public.is_admin() and public.is_latest_period(facility_id, pharmacy_id, month, year))
  with check (public.is_admin() and public.is_latest_period(facility_id, pharmacy_id, month, year));

-- accumulator_audit_log: insert-only, readable by any active user (reports/export).
drop policy if exists audit_log_select on public.accumulator_audit_log;
create policy audit_log_select on public.accumulator_audit_log for select using (public.is_active_user());
drop policy if exists audit_log_insert on public.accumulator_audit_log;
create policy audit_log_insert on public.accumulator_audit_log for insert with check (public.is_active_user());
-- Deliberately no update/delete policy: insert-only ledger, enforced by RLS.

-- accumulator_field_edit_log: same insert-only shape.
drop policy if exists field_edit_log_select on public.accumulator_field_edit_log;
create policy field_edit_log_select on public.accumulator_field_edit_log for select using (public.is_active_user());
drop policy if exists field_edit_log_insert on public.accumulator_field_edit_log;
create policy field_edit_log_insert on public.accumulator_field_edit_log for insert with check (public.is_active_user());

-- claims / claim_line_items / claim_raw_lines: readable by any active user.
-- No client-side insert/update/delete policies — all writes go through process_claim().
drop policy if exists claims_select on public.claims;
create policy claims_select on public.claims for select using (public.is_active_user());
drop policy if exists line_items_select on public.claim_line_items;
create policy line_items_select on public.claim_line_items for select using (public.is_active_user());
drop policy if exists raw_lines_select on public.claim_raw_lines;
create policy raw_lines_select on public.claim_raw_lines for select using (public.is_active_user());

-- ============================================================================
-- STORAGE
-- ============================================================================
-- Bucket for original uploaded claim files, keyed by pharmacy/facility/date.
insert into storage.buckets (id, name, public)
values ('claim-files', 'claim-files', false)
on conflict (id) do nothing;

drop policy if exists claim_files_read on storage.objects;
create policy claim_files_read on storage.objects for select
  using (bucket_id = 'claim-files' and public.is_active_user());
drop policy if exists claim_files_insert on storage.objects;
create policy claim_files_insert on storage.objects for insert
  with check (bucket_id = 'claim-files' and public.is_active_user());

-- ============================================================================
-- RPC: process_claim
--
-- Atomically writes a claim (batch) + its NDC-pivoted line items + its
-- per-RX raw ledger, updates the accumulator for every matched NDC scoped
-- to this exact pharmacy, and writes one accumulator_audit_log row per
-- matched NDC. If p_overwrite is true, first reverses the previously-applied
-- claim's accumulator effect (adds dispensed qty back) before applying the
-- new one. The whole function body is one Postgres transaction: any
-- exception rolls back every write made so far.
--
-- p_line_items shape (jsonb array, NDC-pivoted — drives accumulator):
--   [{ "ndc": "00054032656", "qty_dispensed": 30, "matched": true,
--      "product_name_raw": "AMOXICILLIN 500MG" }, ...]
-- p_raw_lines shape (jsonb array, one per original source row — ledger only):
--   [{ "ndc": ..., "qty_dispensed": ..., "rx_number": ..., "refill_no": ..., ... }]
--
-- Product name / pack size / PPU for matched rows are re-derived from the
-- LIVE accumulator row inside this function (never trusted from the client).
-- ============================================================================
drop function if exists public.process_claim(uuid, uuid, date, text, jsonb, boolean) cascade;
drop function if exists public.process_claim(uuid, uuid, date, text, jsonb, boolean, text, text, integer, integer, integer) cascade;
drop function if exists public.process_claim(uuid, uuid, date, text, jsonb, jsonb, boolean, text, text, integer, integer, integer) cascade;

create or replace function public.process_claim(
  p_pharmacy_id uuid,
  p_facility_id uuid,
  p_claim_date date,
  p_file_path text,
  p_line_items jsonb,
  p_raw_lines jsonb default null,
  p_overwrite boolean default false,
  p_original_filename text default null,
  p_file_hash text default null,
  p_total_rows integer default null,
  p_valid_rows integer default null,
  p_invalid_rows integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_month integer := extract(month from p_claim_date);
  v_year integer := extract(year from p_claim_date);
  v_claim_id uuid;
  v_existing_claim_id uuid;
  v_item jsonb;
  v_ndc varchar(11);
  v_qty numeric;
  v_matched boolean;
  v_acc record;
  v_prior_qty numeric;
  v_new_qty numeric;
  v_reimb numeric;
  v_packs numeric;
  v_total_reimb numeric := 0;
  v_matched_count integer := 0;
  v_unmatched_count integer := 0;
  v_line_count integer := 0;
  v_total_qty numeric := 0;
  v_old_item record;
  v_ndc_matched jsonb := '{}'::jsonb;
  v_raw_line jsonb;
  v_line_number integer := 0;
begin
  if not public.is_active_user() then
    raise exception 'User is not an active platform user';
  end if;

  if p_pharmacy_id is null then
    raise exception 'A specific pharmacy must be selected to process a claim';
  end if;

  if not exists (
    select 1 from public.pharmacy_facilities
    where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id
  ) then
    raise exception 'Pharmacy % does not belong to facility %', p_pharmacy_id, p_facility_id;
  end if;

  if p_line_items is null or jsonb_array_length(p_line_items) = 0 then
    raise exception 'No line items supplied';
  end if;

  select id into v_existing_claim_id
  from public.claims
  where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id and claim_date = p_claim_date;

  if v_existing_claim_id is not null and not p_overwrite then
    raise exception 'A claim already exists for this pharmacy/facility/date. Set p_overwrite=true to confirm replacement.';
  end if;

  -- Reverse the previously-applied claim's accumulator effect before
  -- re-applying, so an overwrite/reprocess never double-counts. Scoped to
  -- this pharmacy's accumulator only.
  if v_existing_claim_id is not null and p_overwrite then
    for v_old_item in
      select * from public.claim_line_items where claim_id = v_existing_claim_id and matched = true
    loop
      select * into v_acc
      from public.accumulator
      where ndc = v_old_item.ndc and facility_id = p_facility_id and pharmacy_id = p_pharmacy_id
        and month = v_month and year = v_year
      for update;

      if found then
        v_prior_qty := v_acc.qty_on_hand;
        v_new_qty := v_prior_qty + v_old_item.qty_dispensed;

        update public.accumulator
        set qty_on_hand = v_new_qty,
            packs_on_hand = case when pack_size is not null and pack_size <> 0 then v_new_qty / pack_size else null end,
            cost_on_hand_340b = case when ppu_340b is not null then v_new_qty * ppu_340b else null end,
            updated_at = now()
        where id = v_acc.id;

        insert into public.accumulator_audit_log
          (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
        values
          (v_user_id, v_existing_claim_id, v_old_item.ndc, v_old_item.product_name, v_prior_qty,
           -v_old_item.qty_dispensed, v_new_qty, -coalesce(v_old_item.reimbursement_owed, 0), 'claim_reversal',
           p_facility_id, p_pharmacy_id);
      end if;
    end loop;

    delete from public.claim_line_items where claim_id = v_existing_claim_id;
    delete from public.claim_raw_lines where claim_id = v_existing_claim_id;
    v_claim_id := v_existing_claim_id;
  else
    insert into public.claims (pharmacy_id, facility_id, claim_date, uploaded_by, file_path, total_reimbursement)
    values (p_pharmacy_id, p_facility_id, p_claim_date, v_user_id, p_file_path, 0)
    returning id into v_claim_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_ndc := v_item->>'ndc';
    v_qty := (v_item->>'qty_dispensed')::numeric;
    v_matched := coalesce((v_item->>'matched')::boolean, false);

    if v_ndc is null or v_qty is null then
      raise exception 'Line item missing ndc or qty_dispensed: %', v_item;
    end if;

    v_line_count := v_line_count + 1;
    v_total_qty := v_total_qty + v_qty;
    v_ndc_matched := v_ndc_matched || jsonb_build_object(v_ndc, v_matched);

    if not v_matched then
      v_unmatched_count := v_unmatched_count + 1;
      insert into public.claim_line_items
        (claim_id, ndc, product_name, qty_dispensed, matched, flag_reason)
      values
        (v_claim_id, v_ndc, v_item->>'product_name_raw', v_qty, false,
         'Unmatched: NDC not found in this pharmacy''s accumulator for this period');
      continue;
    end if;

    select * into v_acc
    from public.accumulator
    where ndc = v_ndc and facility_id = p_facility_id and pharmacy_id = p_pharmacy_id
      and month = v_month and year = v_year
    for update;

    if not found then
      raise exception 'No accumulator found for this pharmacy (%) at facility % for period %/%. NDC % cannot be matched — start this pharmacy''s accumulator for this month first.',
        p_pharmacy_id, p_facility_id, v_month, v_year, v_ndc;
    end if;

    v_matched_count := v_matched_count + 1;
    v_prior_qty := v_acc.qty_on_hand;
    v_new_qty := v_prior_qty - v_qty;
    v_reimb := case when v_acc.ppu_340b is not null then round(v_qty * v_acc.ppu_340b, 4) else null end;
    v_packs := case when v_acc.pack_size is not null and v_acc.pack_size <> 0 then v_qty / v_acc.pack_size else null end;

    update public.accumulator
    set qty_on_hand = v_new_qty,
        packs_on_hand = case when v_acc.pack_size is not null and v_acc.pack_size <> 0 then v_new_qty / v_acc.pack_size else null end,
        cost_on_hand_340b = case when v_acc.ppu_340b is not null then v_new_qty * v_acc.ppu_340b else null end,
        updated_at = now()
    where id = v_acc.id;

    insert into public.claim_line_items
      (claim_id, ndc, product_name, qty_dispensed, pack_size, packs_dispensed, ppu_340b,
       reimbursement_owed, qty_before, qty_after, matched, flag_reason)
    values
      (v_claim_id, v_ndc, v_acc.product_name, v_qty, v_acc.pack_size, v_packs, v_acc.ppu_340b,
       v_reimb, v_prior_qty, v_new_qty, true,
       case when v_new_qty < 0 then 'Negative on-hand after this claim' else null end);

    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, v_claim_id, v_ndc, v_acc.product_name, v_prior_qty, v_qty, v_new_qty, v_reimb, 'claim_dispense',
       p_facility_id, p_pharmacy_id);

    v_total_reimb := v_total_reimb + coalesce(v_reimb, 0);
  end loop;

  -- Raw per-RX ledger — record-keeping only, inherits matched status from
  -- the pivot above, never touches the accumulator.
  if p_raw_lines is not null then
    for v_raw_line in select * from jsonb_array_elements(p_raw_lines)
    loop
      v_line_number := v_line_number + 1;
      v_ndc := v_raw_line->>'ndc';
      insert into public.claim_raw_lines
        (claim_id, line_number, ndc, product_name, qty_dispensed, matched,
         refill_no, refills_auth, refills_remain, date_filled, date_written, rx_number, days_supply,
         primary_paid, patient_paid, tax, fee, total_paid, primary_payer, bin, pcn, group_code, member_id,
         scc, prescriber, prescriber_npi)
      values
        (v_claim_id, v_line_number, v_ndc, v_raw_line->>'product_name',
         coalesce((v_raw_line->>'qty_dispensed')::numeric, 0),
         coalesce((v_ndc_matched->v_ndc)::boolean, false),
         nullif(v_raw_line->>'refill_no','')::integer, nullif(v_raw_line->>'refills_auth','')::integer, nullif(v_raw_line->>'refills_remain','')::integer,
         nullif(v_raw_line->>'date_filled','')::date, nullif(v_raw_line->>'date_written','')::date, v_raw_line->>'rx_number',
         nullif(v_raw_line->>'days_supply','')::numeric,
         nullif(v_raw_line->>'primary_paid','')::numeric, nullif(v_raw_line->>'patient_paid','')::numeric,
         nullif(v_raw_line->>'tax','')::numeric, nullif(v_raw_line->>'fee','')::numeric, nullif(v_raw_line->>'total_paid','')::numeric,
         v_raw_line->>'primary_payer', v_raw_line->>'bin', v_raw_line->>'pcn', v_raw_line->>'group_code', v_raw_line->>'member_id',
         v_raw_line->>'scc', v_raw_line->>'prescriber', v_raw_line->>'prescriber_npi');
    end loop;
  end if;

  update public.claims
  set total_reimbursement = v_total_reimb,
      file_path = coalesce(p_file_path, file_path),
      original_filename = coalesce(p_original_filename, original_filename),
      file_hash = coalesce(p_file_hash, file_hash),
      total_rows = coalesce(p_total_rows, total_rows),
      valid_rows = coalesce(p_valid_rows, valid_rows),
      invalid_rows = coalesce(p_invalid_rows, invalid_rows),
      matched_count = v_matched_count,
      unmatched_count = v_unmatched_count,
      claim_line_count = v_line_count,
      distinct_rx_count = (select count(distinct rx_number) from public.claim_raw_lines where claim_id = v_claim_id and rx_number is not null),
      distinct_ndc_count = (select count(distinct ndc) from public.claim_line_items where claim_id = v_claim_id),
      total_qty_dispensed = v_total_qty,
      uploaded_by = v_user_id,
      uploaded_at = now(),
      status = 'completed'
  where id = v_claim_id;

  return v_claim_id;
end;
$$;

revoke all on function public.process_claim(uuid, uuid, date, text, jsonb, jsonb, boolean, text, text, integer, integer, integer) from public;
grant execute on function public.process_claim(uuid, uuid, date, text, jsonb, jsonb, boolean, text, text, integer, integer, integer) to authenticated;

-- ============================================================================
-- RPC: edit_accumulator_row
-- Admin-only inline edit of a single accumulator row. Any field that changes
-- gets one accumulator_field_edit_log row; a qty_on_hand change additionally
-- gets an accumulator_audit_log row (action_type='manual_qty_edit'). Blocked
-- entirely on historical (non-latest) periods for that row's own pharmacy.
-- ============================================================================
create or replace function public.edit_accumulator_row(
  p_id uuid,
  p_product_name text,
  p_pack_size numeric,
  p_price_340b numeric,
  p_ppu_340b numeric,
  p_exp_day date,
  p_qty_on_hand numeric,
  p_cin text,
  p_manufacturer text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'Only admins may edit accumulator rows';
  end if;

  select * into v_row from public.accumulator where id = p_id for update;
  if not found then
    raise exception 'Accumulator row % not found', p_id;
  end if;

  if not public.is_latest_period(v_row.facility_id, v_row.pharmacy_id, v_row.month, v_row.year) then
    raise exception 'This accumulator period is closed (historical) and cannot be edited';
  end if;

  if p_product_name is distinct from v_row.product_name then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'product_name', v_row.product_name, p_product_name, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_pack_size is distinct from v_row.pack_size then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'pack_size', v_row.pack_size::text, p_pack_size::text, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_price_340b is distinct from v_row.price_340b then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'price_340b', v_row.price_340b::text, p_price_340b::text, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_ppu_340b is distinct from v_row.ppu_340b then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'ppu_340b', v_row.ppu_340b::text, p_ppu_340b::text, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_exp_day is distinct from v_row.exp_day then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'exp_day', v_row.exp_day::text, p_exp_day::text, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_cin is distinct from v_row.cin then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'cin', v_row.cin, p_cin, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_manufacturer is distinct from v_row.manufacturer then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value, facility_id, pharmacy_id)
    values (v_user_id, p_id, v_row.ndc, 'manufacturer', v_row.manufacturer, p_manufacturer, v_row.facility_id, v_row.pharmacy_id);
  end if;
  if p_qty_on_hand is distinct from v_row.qty_on_hand then
    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, null, v_row.ndc, coalesce(p_product_name, v_row.product_name), v_row.qty_on_hand,
       v_row.qty_on_hand - p_qty_on_hand, p_qty_on_hand, null, 'manual_qty_edit', v_row.facility_id, v_row.pharmacy_id);
  end if;

  update public.accumulator
  set product_name = p_product_name,
      pack_size = p_pack_size,
      price_340b = p_price_340b,
      ppu_340b = p_ppu_340b,
      exp_day = p_exp_day,
      qty_on_hand = p_qty_on_hand,
      packs_on_hand = case when p_pack_size is not null and p_pack_size <> 0 then p_qty_on_hand / p_pack_size else null end,
      cost_on_hand_340b = case when p_ppu_340b is not null then p_qty_on_hand * p_ppu_340b else null end,
      cin = p_cin,
      manufacturer = p_manufacturer,
      updated_at = now()
  where id = p_id;
end;
$$;

revoke all on function public.edit_accumulator_row from public;
grant execute on function public.edit_accumulator_row to authenticated;

-- ============================================================================
-- RPC: delete_accumulator_row
-- Admin-only, latest-period-only, fully audited (action_type='manual_delete')
-- before the row is removed.
-- ============================================================================
create or replace function public.delete_accumulator_row(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'Only admins may delete accumulator rows';
  end if;

  select * into v_row from public.accumulator where id = p_id for update;
  if not found then
    raise exception 'Accumulator row % not found', p_id;
  end if;

  if not public.is_latest_period(v_row.facility_id, v_row.pharmacy_id, v_row.month, v_row.year) then
    raise exception 'This accumulator period is closed (historical) and cannot be deleted from';
  end if;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
  values
    (v_user_id, null, v_row.ndc, v_row.product_name, v_row.qty_on_hand, v_row.qty_on_hand, 0, null, 'manual_delete', v_row.facility_id, v_row.pharmacy_id);

  delete from public.accumulator where id = p_id;
end;
$$;

revoke all on function public.delete_accumulator_row from public;
grant execute on function public.delete_accumulator_row to authenticated;

-- ============================================================================
-- RPC: add_accumulator_row
-- Admin-only manual add of a brand-new NDC into the current (latest) period
-- for a specific facility+pharmacy, or the first-ever period if none exists yet.
-- ============================================================================
create or replace function public.add_accumulator_row(
  p_facility_id uuid,
  p_pharmacy_id uuid,
  p_month integer,
  p_year integer,
  p_ndc varchar(11),
  p_product_name text,
  p_pack_size numeric,
  p_qty_on_hand numeric,
  p_exp_day date,
  p_price_340b numeric,
  p_ppu_340b numeric,
  p_cin text,
  p_manufacturer text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_packs numeric;
  v_cost numeric;
begin
  if not public.is_admin() then
    raise exception 'Only admins may add accumulator rows';
  end if;

  if p_pharmacy_id is null then
    raise exception 'A specific pharmacy must be selected before adding an NDC';
  end if;

  if not exists (
    select 1 from public.pharmacy_facilities where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id
  ) then
    raise exception 'Pharmacy % does not belong to facility %', p_pharmacy_id, p_facility_id;
  end if;

  if not public.is_latest_period(p_facility_id, p_pharmacy_id, p_month, p_year) then
    raise exception 'Cannot add a row into a closed historical period';
  end if;

  v_packs := case when p_pack_size is not null and p_pack_size <> 0 then p_qty_on_hand / p_pack_size else null end;
  v_cost := case when p_ppu_340b is not null then p_qty_on_hand * p_ppu_340b else null end;

  insert into public.accumulator
    (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
     cost_on_hand_340b, cin, manufacturer, facility_id, pharmacy_id, month, year)
  values
    (p_ndc, p_product_name, p_pack_size, p_qty_on_hand, v_packs, p_exp_day, p_price_340b, p_ppu_340b,
     v_cost, p_cin, p_manufacturer, p_facility_id, p_pharmacy_id, p_month, p_year)
  returning id into v_id;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
  values
    (v_user_id, null, p_ndc, p_product_name, 0, -p_qty_on_hand, p_qty_on_hand, null, 'manual_add', p_facility_id, p_pharmacy_id);

  return v_id;
end;
$$;

revoke all on function public.add_accumulator_row from public;
grant execute on function public.add_accumulator_row to authenticated;

-- ============================================================================
-- RPC: rollover_month
-- Admin-only. Copies every accumulator row from (p_from_month, p_from_year)
-- to (p_to_month, p_to_year) for ONE facility+pharmacy, carrying forward
-- ending qty_on_hand as the new starting balance and recomputing
-- packs_on_hand / cost_on_hand_340b. Fails loudly (and rolls back) if the
-- target period already has rows for this pharmacy.
-- ============================================================================
create or replace function public.rollover_month(
  p_facility_id uuid,
  p_pharmacy_id uuid,
  p_from_month integer,
  p_from_year integer,
  p_to_month integer,
  p_to_year integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing_count integer;
  v_inserted_count integer;
begin
  if not public.is_admin() then
    raise exception 'Only admins may roll over a month';
  end if;

  if p_pharmacy_id is null then
    raise exception 'A specific pharmacy must be selected before rolling over a month';
  end if;

  if not exists (
    select 1 from public.pharmacy_facilities where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id
  ) then
    raise exception 'Pharmacy % does not belong to facility %', p_pharmacy_id, p_facility_id;
  end if;

  select count(*) into v_existing_count
  from public.accumulator
  where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id and month = p_to_month and year = p_to_year;

  if v_existing_count > 0 then
    raise exception 'Target period %/% already has % accumulator rows for this pharmacy — rollover already performed', p_to_month, p_to_year, v_existing_count;
  end if;

  insert into public.accumulator
    (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
     cost_on_hand_340b, cin, manufacturer, facility_id, pharmacy_id, month, year)
  select
    ndc, product_name, pack_size, qty_on_hand,
    case when pack_size is not null and pack_size <> 0 then qty_on_hand / pack_size else null end,
    exp_day, price_340b, ppu_340b,
    case when ppu_340b is not null then qty_on_hand * ppu_340b else null end,
    cin, manufacturer, facility_id, pharmacy_id, p_to_month, p_to_year
  from public.accumulator
  where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id and month = p_from_month and year = p_from_year;

  get diagnostics v_inserted_count = row_count;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
  select v_user_id, null, ndc, product_name, qty_on_hand, 0, qty_on_hand, null, 'rollover', facility_id, pharmacy_id
  from public.accumulator
  where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id and month = p_to_month and year = p_to_year;

  return v_inserted_count;
end;
$$;

revoke all on function public.rollover_month from public;
grant execute on function public.rollover_month to authenticated;

-- ============================================================================
-- RPC: import_accumulator_rows
-- Admin-only bulk upsert for the "manual override" starting-balance import
-- flow, scoped to one facility+pharmacy+period. Upserts on the
-- (ndc, facility_id, pharmacy_id, month, year) unique constraint, blocked
-- on historical periods, and logs one audit row per NDC.
-- ============================================================================
create or replace function public.import_accumulator_rows(
  p_facility_id uuid,
  p_pharmacy_id uuid,
  p_month integer,
  p_year integer,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row jsonb;
  v_count integer := 0;
  v_ndc varchar(11);
  v_qty numeric;
  v_pack_size numeric;
  v_ppu numeric;
  v_packs numeric;
  v_cost numeric;
  v_prior_qty numeric;
begin
  if not public.is_admin() then
    raise exception 'Only admins may import accumulator data';
  end if;

  if p_pharmacy_id is null then
    raise exception 'A specific pharmacy must be selected before importing an accumulator';
  end if;

  if not exists (
    select 1 from public.pharmacy_facilities where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id
  ) then
    raise exception 'Pharmacy % does not belong to facility %', p_pharmacy_id, p_facility_id;
  end if;

  if not public.is_latest_period(p_facility_id, p_pharmacy_id, p_month, p_year) then
    raise exception 'Cannot import into a closed historical period';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_ndc := v_row->>'ndc';
    v_qty := (v_row->>'qty_on_hand')::numeric;
    v_pack_size := nullif(v_row->>'pack_size', '')::numeric;
    v_ppu := nullif(v_row->>'ppu_340b', '')::numeric;
    v_packs := case when v_pack_size is not null and v_pack_size <> 0 then v_qty / v_pack_size else null end;
    v_cost := case when v_ppu is not null then v_qty * v_ppu else null end;

    select qty_on_hand into v_prior_qty
    from public.accumulator
    where ndc = v_ndc and facility_id = p_facility_id and pharmacy_id = p_pharmacy_id and month = p_month and year = p_year;

    insert into public.accumulator
      (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
       cost_on_hand_340b, cin, manufacturer, facility_id, pharmacy_id, month, year)
    values
      (v_ndc, v_row->>'product_name', v_pack_size, v_qty, v_packs,
       nullif(v_row->>'exp_day', '')::date,
       nullif(v_row->>'price_340b', '')::numeric, v_ppu, v_cost,
       v_row->>'cin', v_row->>'manufacturer', p_facility_id, p_pharmacy_id, p_month, p_year)
    on conflict (ndc, facility_id, pharmacy_id, month, year) do update set
      product_name = excluded.product_name,
      pack_size = excluded.pack_size,
      qty_on_hand = excluded.qty_on_hand,
      packs_on_hand = excluded.packs_on_hand,
      exp_day = excluded.exp_day,
      price_340b = excluded.price_340b,
      ppu_340b = excluded.ppu_340b,
      cost_on_hand_340b = excluded.cost_on_hand_340b,
      cin = excluded.cin,
      manufacturer = excluded.manufacturer,
      updated_at = now();

    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, null, v_ndc, v_row->>'product_name', coalesce(v_prior_qty, 0),
       coalesce(v_prior_qty, 0) - v_qty, v_qty, null, 'import_override', p_facility_id, p_pharmacy_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.import_accumulator_rows from public;
grant execute on function public.import_accumulator_rows to authenticated;

-- ============================================================================
-- PATCH: per-line accumulator snapshot fields, unmatched-NDC resolution
-- (openFDA-assisted add-and-match or explicit skip-with-reason), and
-- replenishment order confirmation. Appended rather than woven into the
-- sections above so the diff against the prior consolidated file stays
-- reviewable; still idempotent and safe to re-run like everything above.
-- ============================================================================

-- claim_line_items gains a snapshot of the accumulator fields that don't
-- already have a column (cin/manufacturer/exp_day/price_340b), captured at
-- the moment the claim was processed — consistent with pack_size/ppu_340b,
-- which were already snapshotted this way. This lets the daily results
-- table render CIN/Manufacturer/Expiry/340B Price without a live join back
-- to the (possibly since-edited) current accumulator row. It also gains
-- skip_reason/resolved_by/resolved_at for the unmatched-NDC workflow below.
alter table public.claim_line_items add column if not exists cin text;
alter table public.claim_line_items add column if not exists manufacturer text;
alter table public.claim_line_items add column if not exists exp_day date;
alter table public.claim_line_items add column if not exists price_340b numeric;
alter table public.claim_line_items add column if not exists skip_reason text;
alter table public.claim_line_items add column if not exists resolved_by uuid references public.users(id);
alter table public.claim_line_items add column if not exists resolved_at timestamptz;

comment on column public.claim_line_items.skip_reason is 'Set when a user explicitly skips an unmatched NDC with a reason instead of adding it to the accumulator. NULL with matched=false means still pending review — every claim line must end up matched, skipped-with-reason, or manually added, never silently dropped.';

-- Re-declare process_claim with the SAME signature (no new DROP FUNCTION
-- guard needed — CREATE OR REPLACE on an unchanged argument list just swaps
-- the body) to also snapshot cin/manufacturer/exp_day/price_340b onto each
-- matched line item from the live accumulator row at processing time.
create or replace function public.process_claim(
  p_pharmacy_id uuid,
  p_facility_id uuid,
  p_claim_date date,
  p_file_path text,
  p_line_items jsonb,
  p_raw_lines jsonb default null,
  p_overwrite boolean default false,
  p_original_filename text default null,
  p_file_hash text default null,
  p_total_rows integer default null,
  p_valid_rows integer default null,
  p_invalid_rows integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_month integer := extract(month from p_claim_date);
  v_year integer := extract(year from p_claim_date);
  v_claim_id uuid;
  v_existing_claim_id uuid;
  v_item jsonb;
  v_ndc varchar(11);
  v_qty numeric;
  v_matched boolean;
  v_acc record;
  v_prior_qty numeric;
  v_new_qty numeric;
  v_reimb numeric;
  v_packs numeric;
  v_total_reimb numeric := 0;
  v_matched_count integer := 0;
  v_unmatched_count integer := 0;
  v_line_count integer := 0;
  v_total_qty numeric := 0;
  v_old_item record;
  v_ndc_matched jsonb := '{}'::jsonb;
  v_raw_line jsonb;
  v_line_number integer := 0;
begin
  if not public.is_active_user() then
    raise exception 'User is not an active platform user';
  end if;

  if p_pharmacy_id is null then
    raise exception 'A specific pharmacy must be selected to process a claim';
  end if;

  if not exists (
    select 1 from public.pharmacy_facilities
    where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id
  ) then
    raise exception 'Pharmacy % does not belong to facility %', p_pharmacy_id, p_facility_id;
  end if;

  if p_line_items is null or jsonb_array_length(p_line_items) = 0 then
    raise exception 'No line items supplied';
  end if;

  select id into v_existing_claim_id
  from public.claims
  where pharmacy_id = p_pharmacy_id and facility_id = p_facility_id and claim_date = p_claim_date;

  if v_existing_claim_id is not null and not p_overwrite then
    raise exception 'A claim already exists for this pharmacy/facility/date. Set p_overwrite=true to confirm replacement.';
  end if;

  if v_existing_claim_id is not null and p_overwrite then
    for v_old_item in
      select * from public.claim_line_items where claim_id = v_existing_claim_id and matched = true
    loop
      select * into v_acc
      from public.accumulator
      where ndc = v_old_item.ndc and facility_id = p_facility_id and pharmacy_id = p_pharmacy_id
        and month = v_month and year = v_year
      for update;

      if found then
        v_prior_qty := v_acc.qty_on_hand;
        v_new_qty := v_prior_qty + v_old_item.qty_dispensed;

        update public.accumulator
        set qty_on_hand = v_new_qty,
            packs_on_hand = case when pack_size is not null and pack_size <> 0 then v_new_qty / pack_size else null end,
            cost_on_hand_340b = case when ppu_340b is not null then v_new_qty * ppu_340b else null end,
            updated_at = now()
        where id = v_acc.id;

        insert into public.accumulator_audit_log
          (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
        values
          (v_user_id, v_existing_claim_id, v_old_item.ndc, v_old_item.product_name, v_prior_qty,
           -v_old_item.qty_dispensed, v_new_qty, -coalesce(v_old_item.reimbursement_owed, 0), 'claim_reversal',
           p_facility_id, p_pharmacy_id);
      end if;
    end loop;

    delete from public.claim_line_items where claim_id = v_existing_claim_id;
    delete from public.claim_raw_lines where claim_id = v_existing_claim_id;
    v_claim_id := v_existing_claim_id;
  else
    insert into public.claims (pharmacy_id, facility_id, claim_date, uploaded_by, file_path, total_reimbursement)
    values (p_pharmacy_id, p_facility_id, p_claim_date, v_user_id, p_file_path, 0)
    returning id into v_claim_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_line_items)
  loop
    v_ndc := v_item->>'ndc';
    v_qty := (v_item->>'qty_dispensed')::numeric;
    v_matched := coalesce((v_item->>'matched')::boolean, false);

    if v_ndc is null or v_qty is null then
      raise exception 'Line item missing ndc or qty_dispensed: %', v_item;
    end if;

    v_line_count := v_line_count + 1;
    v_total_qty := v_total_qty + v_qty;
    v_ndc_matched := v_ndc_matched || jsonb_build_object(v_ndc, v_matched);

    if not v_matched then
      v_unmatched_count := v_unmatched_count + 1;
      insert into public.claim_line_items
        (claim_id, ndc, product_name, qty_dispensed, matched, flag_reason)
      values
        (v_claim_id, v_ndc, v_item->>'product_name_raw', v_qty, false,
         'Unmatched: NDC not found in this pharmacy''s accumulator for this period');
      continue;
    end if;

    select * into v_acc
    from public.accumulator
    where ndc = v_ndc and facility_id = p_facility_id and pharmacy_id = p_pharmacy_id
      and month = v_month and year = v_year
    for update;

    if not found then
      raise exception 'No accumulator found for this pharmacy (%) at facility % for period %/%. NDC % cannot be matched — start this pharmacy''s accumulator for this month first.',
        p_pharmacy_id, p_facility_id, v_month, v_year, v_ndc;
    end if;

    v_matched_count := v_matched_count + 1;
    v_prior_qty := v_acc.qty_on_hand;
    v_new_qty := v_prior_qty - v_qty;
    v_reimb := case when v_acc.ppu_340b is not null then round(v_qty * v_acc.ppu_340b, 4) else null end;
    v_packs := case when v_acc.pack_size is not null and v_acc.pack_size <> 0 then v_qty / v_acc.pack_size else null end;

    update public.accumulator
    set qty_on_hand = v_new_qty,
        packs_on_hand = case when v_acc.pack_size is not null and v_acc.pack_size <> 0 then v_new_qty / v_acc.pack_size else null end,
        cost_on_hand_340b = case when v_acc.ppu_340b is not null then v_new_qty * v_acc.ppu_340b else null end,
        updated_at = now()
    where id = v_acc.id;

    insert into public.claim_line_items
      (claim_id, ndc, product_name, qty_dispensed, pack_size, packs_dispensed, ppu_340b,
       reimbursement_owed, qty_before, qty_after, matched, flag_reason,
       cin, manufacturer, exp_day, price_340b)
    values
      (v_claim_id, v_ndc, v_acc.product_name, v_qty, v_acc.pack_size, v_packs, v_acc.ppu_340b,
       v_reimb, v_prior_qty, v_new_qty, true,
       case when v_new_qty < 0 then 'Negative on-hand after this claim' else null end,
       v_acc.cin, v_acc.manufacturer, v_acc.exp_day, v_acc.price_340b);

    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, v_claim_id, v_ndc, v_acc.product_name, v_prior_qty, v_qty, v_new_qty, v_reimb, 'claim_dispense',
       p_facility_id, p_pharmacy_id);

    v_total_reimb := v_total_reimb + coalesce(v_reimb, 0);
  end loop;

  if p_raw_lines is not null then
    for v_raw_line in select * from jsonb_array_elements(p_raw_lines)
    loop
      v_line_number := v_line_number + 1;
      v_ndc := v_raw_line->>'ndc';
      insert into public.claim_raw_lines
        (claim_id, line_number, ndc, product_name, qty_dispensed, matched,
         refill_no, refills_auth, refills_remain, date_filled, date_written, rx_number, days_supply,
         primary_paid, patient_paid, tax, fee, total_paid, primary_payer, bin, pcn, group_code, member_id,
         scc, prescriber, prescriber_npi)
      values
        (v_claim_id, v_line_number, v_ndc, v_raw_line->>'product_name',
         coalesce((v_raw_line->>'qty_dispensed')::numeric, 0),
         coalesce((v_ndc_matched->v_ndc)::boolean, false),
         nullif(v_raw_line->>'refill_no','')::integer, nullif(v_raw_line->>'refills_auth','')::integer, nullif(v_raw_line->>'refills_remain','')::integer,
         nullif(v_raw_line->>'date_filled','')::date, nullif(v_raw_line->>'date_written','')::date, v_raw_line->>'rx_number',
         nullif(v_raw_line->>'days_supply','')::numeric,
         nullif(v_raw_line->>'primary_paid','')::numeric, nullif(v_raw_line->>'patient_paid','')::numeric,
         nullif(v_raw_line->>'tax','')::numeric, nullif(v_raw_line->>'fee','')::numeric, nullif(v_raw_line->>'total_paid','')::numeric,
         v_raw_line->>'primary_payer', v_raw_line->>'bin', v_raw_line->>'pcn', v_raw_line->>'group_code', v_raw_line->>'member_id',
         v_raw_line->>'scc', v_raw_line->>'prescriber', v_raw_line->>'prescriber_npi');
    end loop;
  end if;

  update public.claims
  set total_reimbursement = v_total_reimb,
      file_path = coalesce(p_file_path, file_path),
      original_filename = coalesce(p_original_filename, original_filename),
      file_hash = coalesce(p_file_hash, file_hash),
      total_rows = coalesce(p_total_rows, total_rows),
      valid_rows = coalesce(p_valid_rows, valid_rows),
      invalid_rows = coalesce(p_invalid_rows, invalid_rows),
      matched_count = v_matched_count,
      unmatched_count = v_unmatched_count,
      claim_line_count = v_line_count,
      distinct_rx_count = (select count(distinct rx_number) from public.claim_raw_lines where claim_id = v_claim_id and rx_number is not null),
      distinct_ndc_count = (select count(distinct ndc) from public.claim_line_items where claim_id = v_claim_id),
      total_qty_dispensed = v_total_qty,
      uploaded_by = v_user_id,
      uploaded_at = now(),
      status = 'completed'
  where id = v_claim_id;

  return v_claim_id;
end;
$$;

revoke all on function public.process_claim(uuid, uuid, date, text, jsonb, jsonb, boolean, text, text, integer, integer, integer) from public;
grant execute on function public.process_claim(uuid, uuid, date, text, jsonb, jsonb, boolean, text, text, integer, integer, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Unmatched-NDC resolution: an NDC in the daily claims that isn't in the
-- accumulator must never be silently dropped. resolve_unmatched_line either
-- (a) adds a brand-new accumulator row (seeded from an openFDA lookup the
-- frontend performs and lets the user review/correct) and retroactively
-- matches the claim line against it, deducting qty and logging exactly like
-- a normal claim_dispense — or (b) records an explicit skip reason, leaving
-- the line visibly "reviewed and skipped" rather than just "unmatched".
-- Callable by any active user (not admin-only) since it's a normal part of
-- daily claims processing, not an administrative accumulator edit.
-- ----------------------------------------------------------------------------
drop function if exists public.resolve_unmatched_line(uuid, text, varchar, text, numeric, numeric, date, numeric, numeric, text, text, text) cascade;
create or replace function public.resolve_unmatched_line(
  p_line_item_id uuid,
  p_action text,
  p_ndc varchar(11) default null,
  p_product_name text default null,
  p_pack_size numeric default null,
  p_qty_on_hand numeric default null,
  p_exp_day date default null,
  p_price_340b numeric default null,
  p_ppu_340b numeric default null,
  p_cin text default null,
  p_manufacturer text default null,
  p_skip_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_line record;
  v_claim record;
  v_acc record;
  v_new_qty numeric;
  v_packs numeric;
  v_reimb numeric;
  v_month integer;
  v_year integer;
begin
  if not public.is_active_user() then
    raise exception 'User is not an active platform user';
  end if;

  if p_action not in ('add_and_match', 'skip') then
    raise exception 'Invalid action % — expected add_and_match or skip', p_action;
  end if;

  select * into v_line from public.claim_line_items where id = p_line_item_id for update;
  if not found then
    raise exception 'Claim line item % not found', p_line_item_id;
  end if;
  if v_line.matched then
    raise exception 'This line item is already matched';
  end if;

  select * into v_claim from public.claims where id = v_line.claim_id;
  if not found then
    raise exception 'Parent claim for line item % not found', p_line_item_id;
  end if;

  if p_action = 'skip' then
    if p_skip_reason is null or trim(p_skip_reason) = '' then
      raise exception 'A reason is required to skip an unmatched NDC';
    end if;
    update public.claim_line_items
    set skip_reason = p_skip_reason,
        resolved_by = v_user_id,
        resolved_at = now(),
        flag_reason = 'Skipped: ' || p_skip_reason
    where id = p_line_item_id;
    return;
  end if;

  -- add_and_match
  if p_ndc is null or p_product_name is null or p_pack_size is null or p_pack_size = 0 then
    raise exception 'NDC, product name, and a non-zero pack size are required to add a new accumulator row';
  end if;

  v_month := extract(month from v_claim.claim_date)::integer;
  v_year := extract(year from v_claim.claim_date)::integer;

  select * into v_acc
  from public.accumulator
  where ndc = p_ndc and facility_id = v_claim.facility_id and pharmacy_id = v_claim.pharmacy_id
    and month = v_month and year = v_year
  for update;

  if not found then
    insert into public.accumulator
      (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
       cost_on_hand_340b, cin, manufacturer, facility_id, pharmacy_id, month, year)
    values
      (p_ndc, p_product_name, p_pack_size, coalesce(p_qty_on_hand, 0),
       coalesce(p_qty_on_hand, 0) / p_pack_size,
       p_exp_day, p_price_340b, p_ppu_340b,
       case when p_ppu_340b is not null then coalesce(p_qty_on_hand, 0) * p_ppu_340b else null end,
       p_cin, p_manufacturer, v_claim.facility_id, v_claim.pharmacy_id, v_month, v_year)
    returning * into v_acc;

    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, v_claim.id, p_ndc, p_product_name, 0, -coalesce(p_qty_on_hand, 0), coalesce(p_qty_on_hand, 0), null,
       'manual_add', v_claim.facility_id, v_claim.pharmacy_id);
  end if;

  v_new_qty := v_acc.qty_on_hand - v_line.qty_dispensed;
  v_reimb := case when v_acc.ppu_340b is not null then round(v_line.qty_dispensed * v_acc.ppu_340b, 4) else null end;
  v_packs := case when v_acc.pack_size is not null and v_acc.pack_size <> 0 then v_line.qty_dispensed / v_acc.pack_size else null end;

  update public.accumulator
  set qty_on_hand = v_new_qty,
      packs_on_hand = case when v_acc.pack_size is not null and v_acc.pack_size <> 0 then v_new_qty / v_acc.pack_size else null end,
      cost_on_hand_340b = case when v_acc.ppu_340b is not null then v_new_qty * v_acc.ppu_340b else null end,
      updated_at = now()
  where id = v_acc.id;

  update public.claim_line_items
  set matched = true,
      product_name = v_acc.product_name,
      pack_size = v_acc.pack_size,
      packs_dispensed = v_packs,
      ppu_340b = v_acc.ppu_340b,
      price_340b = v_acc.price_340b,
      cin = v_acc.cin,
      manufacturer = v_acc.manufacturer,
      exp_day = v_acc.exp_day,
      reimbursement_owed = v_reimb,
      qty_before = v_acc.qty_on_hand,
      qty_after = v_new_qty,
      flag_reason = case when v_new_qty < 0 then 'Negative on-hand after this claim' else null end,
      skip_reason = null,
      resolved_by = v_user_id,
      resolved_at = now()
  where id = p_line_item_id;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
  values
    (v_user_id, v_claim.id, p_ndc, v_acc.product_name, v_acc.qty_on_hand, v_line.qty_dispensed, v_new_qty, v_reimb, 'claim_dispense',
     v_claim.facility_id, v_claim.pharmacy_id);

  update public.claims
  set matched_count = coalesce(matched_count, 0) + 1,
      unmatched_count = greatest(coalesce(unmatched_count, 0) - 1, 0),
      total_reimbursement = coalesce(total_reimbursement, 0) + coalesce(v_reimb, 0)
  where id = v_claim.id;
end;
$$;

revoke all on function public.resolve_unmatched_line from public;
grant execute on function public.resolve_unmatched_line to authenticated;

-- ----------------------------------------------------------------------------
-- Replenishment order confirmation: logs the order and adds the received
-- qty back into the running balance. accumulator_orders is an insert-only
-- ledger (no update/delete policy for any role), same pattern as the audit
-- log tables.
-- ----------------------------------------------------------------------------
create table if not exists public.accumulator_orders (
  id uuid primary key default gen_random_uuid(),
  accumulator_id uuid not null references public.accumulator(id) on delete cascade,
  ndc varchar(11) not null,
  product_name text,
  facility_id uuid not null references public.facilities(id),
  pharmacy_id uuid not null references public.pharmacies(id),
  month integer not null,
  year integer not null,
  qty_ordered numeric not null,
  packs_ordered numeric,
  unit_cost_340b numeric,
  total_cost numeric,
  ordered_by uuid references public.users(id),
  ordered_at timestamptz not null default now(),
  notes text
);

create index if not exists idx_accumulator_orders_accumulator on public.accumulator_orders (accumulator_id);
create index if not exists idx_accumulator_orders_pharmacy on public.accumulator_orders (pharmacy_id);

alter table public.accumulator_orders enable row level security;
drop policy if exists accumulator_orders_select on public.accumulator_orders;
create policy accumulator_orders_select on public.accumulator_orders for select using (public.is_active_user());
-- Deliberately no insert/update/delete policy — written only via confirm_replenishment_order() below.

-- 'order_received' is a new action_type — drop and re-add the check
-- constraint to allow it (adding a bare CHECK value isn't ALTERable in
-- place in Postgres; this is the standard idempotent pattern for it).
alter table public.accumulator_audit_log drop constraint if exists accumulator_audit_log_action_type_check;
alter table public.accumulator_audit_log add constraint accumulator_audit_log_action_type_check check (action_type in
  ('claim_dispense', 'claim_reversal', 'manual_qty_edit', 'rollover', 'manual_add', 'import_override', 'manual_delete', 'order_received'));

create or replace function public.confirm_replenishment_order(
  p_accumulator_id uuid,
  p_qty_ordered numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row record;
  v_new_qty numeric;
  v_packs numeric;
  v_cost numeric;
  v_order_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'User is not an active platform user';
  end if;

  if p_qty_ordered is null or p_qty_ordered <= 0 then
    raise exception 'Qty ordered must be a positive number';
  end if;

  select * into v_row from public.accumulator where id = p_accumulator_id for update;
  if not found then
    raise exception 'Accumulator row % not found', p_accumulator_id;
  end if;

  if not public.is_latest_period(v_row.facility_id, v_row.pharmacy_id, v_row.month, v_row.year) then
    raise exception 'This accumulator period is closed (historical) and cannot receive an order';
  end if;

  v_new_qty := v_row.qty_on_hand + p_qty_ordered;
  v_packs := case when v_row.pack_size is not null and v_row.pack_size <> 0 then p_qty_ordered / v_row.pack_size else null end;
  v_cost := case when v_packs is not null and v_row.price_340b is not null then v_packs * v_row.price_340b else null end;

  update public.accumulator
  set qty_on_hand = v_new_qty,
      packs_on_hand = case when v_row.pack_size is not null and v_row.pack_size <> 0 then v_new_qty / v_row.pack_size else null end,
      cost_on_hand_340b = case when v_row.ppu_340b is not null then v_new_qty * v_row.ppu_340b else null end,
      updated_at = now()
  where id = p_accumulator_id;

  insert into public.accumulator_orders
    (accumulator_id, ndc, product_name, facility_id, pharmacy_id, month, year, qty_ordered, packs_ordered, unit_cost_340b, total_cost, ordered_by, notes)
  values
    (p_accumulator_id, v_row.ndc, v_row.product_name, v_row.facility_id, v_row.pharmacy_id, v_row.month, v_row.year,
     p_qty_ordered, v_packs, v_row.price_340b, v_cost, v_user_id, p_notes)
  returning id into v_order_id;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
  values
    (v_user_id, null, v_row.ndc, v_row.product_name, v_row.qty_on_hand, -p_qty_ordered, v_new_qty, null, 'order_received',
     v_row.facility_id, v_row.pharmacy_id);

  return v_order_id;
end;
$$;

revoke all on function public.confirm_replenishment_order from public;
grant execute on function public.confirm_replenishment_order to authenticated;

-- ============================================================================
-- PATCH: explicit table/sequence grants for the `authenticated` role.
--
-- Postgres checks base GRANT privileges BEFORE it evaluates Row Level
-- Security policies. If `authenticated` was never granted table-level
-- access (this happens when a project's schema is set up without
-- Supabase's usual "alter default privileges" bootstrap already in place),
-- every query — even ones RLS would otherwise allow — fails immediately
-- with "permission denied for table X", and RLS is never reached at all.
--
-- This grants broad table/sequence privileges to `authenticated` and
-- leaves RLS as the sole real security boundary, exactly how every policy
-- above was already designed: tables like claims/claim_line_items/
-- accumulator_audit_log have zero client-facing INSERT/UPDATE/DELETE
-- policies, so granting the base privilege here does not open up direct
-- writes to them — RLS still has no permissive policy for those
-- operations, so they remain blocked, and the only path in stays the
-- SECURITY DEFINER RPCs (which write as the table owner regardless of
-- these grants). This is purely an unblocking fix, not a security change.
-- ============================================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;

-- ============================================================================
-- PATCH: fix "Lawrence Hause" -> "Lawrence House" (was misspelled in the
-- original seed data). One-time, idempotent — a no-op once already renamed.
-- ============================================================================
update public.pharmacies set name = 'Lawrence House' where name = 'Lawrence Hause';

-- ============================================================================
-- PATCH: pharmacy CRUD for Settings — rename a pharmacy and/or replace its
-- facility associations atomically, or delete a pharmacy outright. Admin
-- only. Deleting is blocked (not silently allowed) if the pharmacy already
-- has accumulator, claims, or order history — that data is never discarded
-- as a side effect of a Settings-page cleanup action.
-- ============================================================================
create or replace function public.update_pharmacy(
  p_id uuid,
  p_name text,
  p_facility_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins may edit pharmacies';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception 'Pharmacy name cannot be empty';
  end if;

  if exists (select 1 from public.pharmacies where id <> p_id and lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A pharmacy named "%" already exists', trim(p_name);
  end if;

  update public.pharmacies set name = trim(p_name) where id = p_id;
  if not found then
    raise exception 'Pharmacy % not found', p_id;
  end if;

  delete from public.pharmacy_facilities where pharmacy_id = p_id;
  if p_facility_ids is not null and array_length(p_facility_ids, 1) > 0 then
    insert into public.pharmacy_facilities (pharmacy_id, facility_id)
    select p_id, unnest(p_facility_ids)
    on conflict do nothing;
  end if;
end;
$$;

revoke all on function public.update_pharmacy from public;
grant execute on function public.update_pharmacy to authenticated;

create or replace function public.delete_pharmacy(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins may delete pharmacies';
  end if;

  if exists (select 1 from public.accumulator where pharmacy_id = p_id)
     or exists (select 1 from public.claims where pharmacy_id = p_id)
     or exists (select 1 from public.accumulator_orders where pharmacy_id = p_id)
  then
    raise exception 'Cannot delete this pharmacy — it already has accumulator, claims, or order history. That data is never silently discarded.';
  end if;

  delete from public.pharmacy_facilities where pharmacy_id = p_id;
  delete from public.pharmacies where id = p_id;
end;
$$;

revoke all on function public.delete_pharmacy from public;
grant execute on function public.delete_pharmacy to authenticated;

-- ============================================================================
-- PATCH: delete an entire claim batch, and bulk-delete an accumulator
-- period. Both admin-only, both blocked outside the latest (open) period —
-- deleting historical data would require also correcting every subsequent
-- month's rolled-over balance, which these do not attempt, so historical
-- periods stay read-only exactly like every other write path in this app.
-- ============================================================================

-- Deletes a claim batch, reversing its accumulator effect for every matched
-- NDC first (adds the dispensed qty back, same math as the overwrite-reversal
-- branch of process_claim) and logging a 'claim_reversal' audit row per NDC.
-- claim_line_items/claim_raw_lines cascade-delete via their FK. The prior
-- claim_dispense audit rows are NOT deleted — accumulator_audit_log is an
-- immutable ledger, so the historical record that this claim happened (and
-- was later reversed) survives even though the claim record itself is gone.
create or replace function public.delete_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim record;
  v_month integer;
  v_year integer;
  v_item record;
  v_acc record;
  v_prior_qty numeric;
  v_new_qty numeric;
begin
  if not public.is_admin() then
    raise exception 'Only admins may delete a claim batch';
  end if;

  select * into v_claim from public.claims where id = p_claim_id for update;
  if not found then
    raise exception 'Claim % not found', p_claim_id;
  end if;

  v_month := extract(month from v_claim.claim_date)::integer;
  v_year := extract(year from v_claim.claim_date)::integer;

  if not public.is_latest_period(v_claim.facility_id, v_claim.pharmacy_id, v_month, v_year) then
    raise exception 'This claim is in a closed historical period and cannot be deleted — historical periods are read-only';
  end if;

  for v_item in
    select * from public.claim_line_items where claim_id = p_claim_id and matched = true
  loop
    select * into v_acc
    from public.accumulator
    where ndc = v_item.ndc and facility_id = v_claim.facility_id and pharmacy_id = v_claim.pharmacy_id
      and month = v_month and year = v_year
    for update;

    if found then
      v_prior_qty := v_acc.qty_on_hand;
      v_new_qty := v_prior_qty + v_item.qty_dispensed;

      update public.accumulator
      set qty_on_hand = v_new_qty,
          packs_on_hand = case when pack_size is not null and pack_size <> 0 then v_new_qty / pack_size else null end,
          cost_on_hand_340b = case when ppu_340b is not null then v_new_qty * ppu_340b else null end,
          updated_at = now()
      where id = v_acc.id;

      insert into public.accumulator_audit_log
        (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
      values
        (v_user_id, p_claim_id, v_item.ndc, v_item.product_name, v_prior_qty,
         -v_item.qty_dispensed, v_new_qty, -coalesce(v_item.reimbursement_owed, 0), 'claim_reversal',
         v_claim.facility_id, v_claim.pharmacy_id);
    end if;
  end loop;

  delete from public.claims where id = p_claim_id;
end;
$$;

revoke all on function public.delete_claim from public;
grant execute on function public.delete_claim to authenticated;

-- Bulk-deletes every accumulator row for one facility+pharmacy+period at
-- once (e.g. to redo a bad import from scratch), logging one
-- 'manual_delete' audit row per NDC first — same per-row audit pattern as
-- delete_accumulator_row, just looped across the whole period.
create or replace function public.delete_accumulator_period(
  p_facility_id uuid,
  p_pharmacy_id uuid,
  p_month integer,
  p_year integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row record;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only admins may delete an accumulator period';
  end if;

  if not public.is_latest_period(p_facility_id, p_pharmacy_id, p_month, p_year) then
    raise exception 'This accumulator period is closed (historical) and cannot be deleted';
  end if;

  for v_row in
    select * from public.accumulator
    where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id and month = p_month and year = p_year
  loop
    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, null, v_row.ndc, v_row.product_name, v_row.qty_on_hand, v_row.qty_on_hand, 0, null, 'manual_delete', p_facility_id, p_pharmacy_id);
    v_count := v_count + 1;
  end loop;

  delete from public.accumulator
  where facility_id = p_facility_id and pharmacy_id = p_pharmacy_id and month = p_month and year = p_year;

  return v_count;
end;
$$;

revoke all on function public.delete_accumulator_period from public;
grant execute on function public.delete_accumulator_period to authenticated;
