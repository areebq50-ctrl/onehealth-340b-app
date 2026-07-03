-- ============================================================================
-- One.Health Partners — 340B Operations Platform
-- Baseline schema: tables, RLS policies, and atomic RPC functions.
--
-- SETUP ORDER: run this file first, then every file in supabase/migrations/
-- in filename order (0001, 0002, 0003, 0004, ...), then seed.sql. The
-- migrations add pharmacy-level scoping to the accumulator (this baseline
-- predates that and is facility-only) and the RX-level claim ledger fields —
-- they are not optional. See supabase/migrations/ for what each one does.
--
-- ARCHITECTURE NOTE ON WRITES
-- ---------------------------
-- claims, claim_line_items, accumulator_audit_log, and accumulator_field_edit_log
-- have NO direct INSERT/UPDATE/DELETE RLS policies for client roles. All writes
-- to these tables happen exclusively through the SECURITY DEFINER RPC functions
-- defined at the bottom of this file (process_claim, edit_accumulator_row,
-- rollover_month, add_accumulator_row, import_accumulator_rows). Those
-- functions are owned by the migration-running role (bypasses RLS as table
-- owner) and each function body executes as a single Postgres transaction —
-- any RAISE EXCEPTION inside rolls back every write the function made. This is
-- what guarantees "accumulator update + claim write + audit log" are atomic,
-- and that the frontend can never partially update the accumulator via
-- separate calls.
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

-- Master drug inventory, one row per NDC per facility per month/year.
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
  month integer not null check (month between 1 and 12),
  year integer not null check (year between 2020 and 2100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accumulator_unique_ndc_period unique (ndc, facility_id, month, year)
);

create index if not exists idx_accumulator_facility_period on public.accumulator (facility_id, year, month);
create index if not exists idx_accumulator_ndc on public.accumulator (ndc);

-- Insert-only ledger required for HRSA audit readiness. Written by process_claim,
-- edit_accumulator_row (qty_on_hand edits), and rollover_month.
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
    ('claim_dispense', 'claim_reversal', 'manual_qty_edit', 'rollover', 'manual_add', 'import_override'))
);

create index if not exists idx_audit_log_ndc on public.accumulator_audit_log (ndc);
create index if not exists idx_audit_log_claim on public.accumulator_audit_log (claim_id);

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
  new_value text
);

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
  constraint claims_unique_period unique (pharmacy_id, facility_id, claim_date)
);

create index if not exists idx_claims_date on public.claims (claim_date);
create index if not exists idx_claims_facility on public.claims (facility_id);

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
-- record for p_facility_id. Used to enforce "historical months are read-only".
create or replace function public.is_latest_period(p_facility_id uuid, p_month integer, p_year integer)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select (p_year, p_month) = (
    select year, month from public.accumulator
    where facility_id = p_facility_id
    order by year desc, month desc
    limit 1
  )
  or not exists (select 1 from public.accumulator where facility_id = p_facility_id);
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

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

-- facilities: any active user reads; only admin writes
create policy facilities_select on public.facilities for select using (public.is_active_user());
create policy facilities_insert on public.facilities for insert with check (public.is_admin());
create policy facilities_update on public.facilities for update using (public.is_admin()) with check (public.is_admin());
create policy facilities_delete on public.facilities for delete using (public.is_admin());

-- pharmacies: any active user reads; only admin writes
create policy pharmacies_select on public.pharmacies for select using (public.is_active_user());
create policy pharmacies_insert on public.pharmacies for insert with check (public.is_admin());
create policy pharmacies_update on public.pharmacies for update using (public.is_admin()) with check (public.is_admin());
create policy pharmacies_delete on public.pharmacies for delete using (public.is_admin());

-- pharmacy_facilities: any active user reads; only admin writes
create policy pharmacy_facilities_select on public.pharmacy_facilities for select using (public.is_active_user());
create policy pharmacy_facilities_insert on public.pharmacy_facilities for insert with check (public.is_admin());
create policy pharmacy_facilities_delete on public.pharmacy_facilities for delete using (public.is_admin());

-- users: data is org-wide (shared pool), so any active user can read the
-- user directory (needed for "Uploaded By" columns, user pickers, etc).
-- Only admin can write (role/active changes). No delete policy anywhere —
-- deactivation is done via the `active` flag.
create policy users_select_active on public.users for select using (public.is_active_user() or id = auth.uid());
create policy users_update_admin on public.users for update using (public.is_admin()) with check (public.is_admin());

-- accumulator: any active user reads; admin may directly insert/update ONLY
-- into the latest (open) period for a facility — historical months are
-- read-only at the RLS layer. Normal app writes go through the RPCs below,
-- which run as the table owner and therefore are not limited by this policy.
create policy accumulator_select on public.accumulator for select using (public.is_active_user());
create policy accumulator_insert on public.accumulator for insert
  with check (public.is_admin() and public.is_latest_period(facility_id, month, year));
create policy accumulator_update on public.accumulator for update
  using (public.is_admin() and public.is_latest_period(facility_id, month, year))
  with check (public.is_admin() and public.is_latest_period(facility_id, month, year));
-- No delete policy: accumulator rows are never deleted by the app.

-- accumulator_audit_log: insert-only, readable by any active user (reports/export).
create policy audit_log_select on public.accumulator_audit_log for select using (public.is_active_user());
create policy audit_log_insert on public.accumulator_audit_log for insert with check (public.is_active_user());
-- Deliberately no update/delete policy: insert-only ledger, enforced by RLS.

-- accumulator_field_edit_log: same insert-only shape.
create policy field_edit_log_select on public.accumulator_field_edit_log for select using (public.is_active_user());
create policy field_edit_log_insert on public.accumulator_field_edit_log for insert with check (public.is_active_user());

-- claims / claim_line_items: readable by any active user. No client-side
-- insert/update/delete policies — all writes go through process_claim().
create policy claims_select on public.claims for select using (public.is_active_user());
create policy line_items_select on public.claim_line_items for select using (public.is_active_user());

-- ============================================================================
-- STORAGE
-- ============================================================================
-- Bucket for original uploaded claim files, keyed by pharmacy/facility/date.
insert into storage.buckets (id, name, public)
values ('claim-files', 'claim-files', false)
on conflict (id) do nothing;

create policy claim_files_read on storage.objects for select
  using (bucket_id = 'claim-files' and public.is_active_user());
create policy claim_files_insert on storage.objects for insert
  with check (bucket_id = 'claim-files' and public.is_active_user());

-- ============================================================================
-- RPC: process_claim
-- Atomically writes a claim + its line items, updates the accumulator for
-- every matched NDC, and writes one accumulator_audit_log row per matched
-- NDC. If p_overwrite is true, first reverses the previously-applied claim's
-- accumulator effect (adds dispensed qty back) before applying the new one.
-- The whole function body is one Postgres transaction: any exception rolls
-- back every write made so far, so the accumulator can never end up
-- partially updated.
--
-- p_line_items shape (jsonb array):
--   [{ "ndc": "00054032656", "qty_dispensed": 30, "matched": true,
--      "product_name_raw": "AMOXICILLIN 500MG" }, ...]
--
-- Product name / pack size / PPU for matched rows are re-derived from the
-- LIVE accumulator row inside this function (never trusted from the client)
-- so the reimbursement math is guaranteed consistent with what's on record.
-- ============================================================================
create or replace function public.process_claim(
  p_pharmacy_id uuid,
  p_facility_id uuid,
  p_claim_date date,
  p_file_path text,
  p_line_items jsonb,
  p_overwrite boolean default false
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
  v_old_item record;
begin
  if not public.is_active_user() then
    raise exception 'User is not an active platform user';
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
  -- re-applying, so an overwrite never double-counts or under-counts.
  if v_existing_claim_id is not null and p_overwrite then
    for v_old_item in
      select * from public.claim_line_items where claim_id = v_existing_claim_id and matched = true
    loop
      select * into v_acc
      from public.accumulator
      where ndc = v_old_item.ndc and facility_id = p_facility_id and month = v_month and year = v_year
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
          (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type)
        values
          (v_user_id, v_existing_claim_id, v_old_item.ndc, v_old_item.product_name, v_prior_qty,
           -v_old_item.qty_dispensed, v_new_qty, -coalesce(v_old_item.reimbursement_owed, 0), 'claim_reversal');
      end if;
    end loop;

    delete from public.claim_line_items where claim_id = v_existing_claim_id;
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

    if not v_matched then
      insert into public.claim_line_items
        (claim_id, ndc, product_name, qty_dispensed, matched, flag_reason)
      values
        (v_claim_id, v_ndc, v_item->>'product_name_raw', v_qty, false, 'Unmatched: NDC not found in accumulator for this period');
      continue;
    end if;

    select * into v_acc
    from public.accumulator
    where ndc = v_ndc and facility_id = p_facility_id and month = v_month and year = v_year
    for update;

    if not found then
      raise exception 'Matched line item references NDC % with no accumulator row for facility/period %/%/%', v_ndc, p_facility_id, v_month, v_year;
    end if;

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
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type)
    values
      (v_user_id, v_claim_id, v_ndc, v_acc.product_name, v_prior_qty, v_qty, v_new_qty, v_reimb, 'claim_dispense');

    v_total_reimb := v_total_reimb + coalesce(v_reimb, 0);
  end loop;

  update public.claims
  set total_reimbursement = v_total_reimb,
      file_path = coalesce(p_file_path, file_path),
      uploaded_by = v_user_id,
      uploaded_at = now(),
      status = 'completed'
  where id = v_claim_id;

  return v_claim_id;
end;
$$;

revoke all on function public.process_claim from public;
grant execute on function public.process_claim to authenticated;

-- ============================================================================
-- RPC: edit_accumulator_row
-- Admin-only inline edit of a single accumulator row. Any field that changes
-- gets one accumulator_field_edit_log row; a qty_on_hand change additionally
-- gets an accumulator_audit_log row (action_type='manual_qty_edit') because
-- that is the qty-affecting, HRSA-relevant path. Blocked entirely on
-- historical (non-latest) periods.
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

  if not public.is_latest_period(v_row.facility_id, v_row.month, v_row.year) then
    raise exception 'This accumulator period is closed (historical) and cannot be edited';
  end if;

  if p_product_name is distinct from v_row.product_name then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'product_name', v_row.product_name, p_product_name);
  end if;
  if p_pack_size is distinct from v_row.pack_size then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'pack_size', v_row.pack_size::text, p_pack_size::text);
  end if;
  if p_price_340b is distinct from v_row.price_340b then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'price_340b', v_row.price_340b::text, p_price_340b::text);
  end if;
  if p_ppu_340b is distinct from v_row.ppu_340b then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'ppu_340b', v_row.ppu_340b::text, p_ppu_340b::text);
  end if;
  if p_exp_day is distinct from v_row.exp_day then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'exp_day', v_row.exp_day::text, p_exp_day::text);
  end if;
  if p_cin is distinct from v_row.cin then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'cin', v_row.cin, p_cin);
  end if;
  if p_manufacturer is distinct from v_row.manufacturer then
    insert into public.accumulator_field_edit_log (user_id, accumulator_id, ndc, field_name, prior_value, new_value)
    values (v_user_id, p_id, v_row.ndc, 'manufacturer', v_row.manufacturer, p_manufacturer);
  end if;
  if p_qty_on_hand is distinct from v_row.qty_on_hand then
    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type)
    values
      (v_user_id, null, v_row.ndc, coalesce(p_product_name, v_row.product_name), v_row.qty_on_hand,
       v_row.qty_on_hand - p_qty_on_hand, p_qty_on_hand, null, 'manual_qty_edit');
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
-- RPC: add_accumulator_row
-- Admin-only manual add of a brand-new NDC into the current (latest) period
-- for a facility, or the first-ever period if none exists yet.
-- ============================================================================
create or replace function public.add_accumulator_row(
  p_facility_id uuid,
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

  if not public.is_latest_period(p_facility_id, p_month, p_year) then
    raise exception 'Cannot add a row into a closed historical period';
  end if;

  v_packs := case when p_pack_size is not null and p_pack_size <> 0 then p_qty_on_hand / p_pack_size else null end;
  v_cost := case when p_ppu_340b is not null then p_qty_on_hand * p_ppu_340b else null end;

  insert into public.accumulator
    (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
     cost_on_hand_340b, cin, manufacturer, facility_id, month, year)
  values
    (p_ndc, p_product_name, p_pack_size, p_qty_on_hand, v_packs, p_exp_day, p_price_340b, p_ppu_340b,
     v_cost, p_cin, p_manufacturer, p_facility_id, p_month, p_year)
  returning id into v_id;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type)
  values
    (v_user_id, null, p_ndc, p_product_name, 0, -p_qty_on_hand, p_qty_on_hand, null, 'manual_add');

  return v_id;
end;
$$;

revoke all on function public.add_accumulator_row from public;
grant execute on function public.add_accumulator_row to authenticated;

-- ============================================================================
-- RPC: rollover_month
-- Admin-only. Copies every accumulator row from (p_from_month, p_from_year)
-- to (p_to_month, p_to_year) for a facility, carrying forward ending
-- qty_on_hand as the new starting balance and recomputing packs_on_hand /
-- cost_on_hand_340b. Fails loudly (and rolls back) if the target period
-- already has rows, preventing accidental double-rollover.
-- ============================================================================
create or replace function public.rollover_month(
  p_facility_id uuid,
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

  select count(*) into v_existing_count
  from public.accumulator
  where facility_id = p_facility_id and month = p_to_month and year = p_to_year;

  if v_existing_count > 0 then
    raise exception 'Target period %/% already has % accumulator rows — rollover already performed', p_to_month, p_to_year, v_existing_count;
  end if;

  insert into public.accumulator
    (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
     cost_on_hand_340b, cin, manufacturer, facility_id, month, year)
  select
    ndc, product_name, pack_size, qty_on_hand,
    case when pack_size is not null and pack_size <> 0 then qty_on_hand / pack_size else null end,
    exp_day, price_340b, ppu_340b,
    case when ppu_340b is not null then qty_on_hand * ppu_340b else null end,
    cin, manufacturer, facility_id, p_to_month, p_to_year
  from public.accumulator
  where facility_id = p_facility_id and month = p_from_month and year = p_from_year;

  get diagnostics v_inserted_count = row_count;

  insert into public.accumulator_audit_log
    (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type)
  select v_user_id, null, ndc, product_name, qty_on_hand, 0, qty_on_hand, null, 'rollover'
  from public.accumulator
  where facility_id = p_facility_id and month = p_to_month and year = p_to_year;

  return v_inserted_count;
end;
$$;

revoke all on function public.rollover_month from public;
grant execute on function public.rollover_month to authenticated;

-- ============================================================================
-- RPC: import_accumulator_rows
-- Admin-only bulk upsert for the "manual override" starting-balance import
-- flow. p_rows is a jsonb array; each element maps 1:1 to an accumulator
-- row for (p_facility_id, p_month, p_year). Upserts on the
-- (ndc, facility_id, month, year) unique constraint, blocked on historical
-- periods, and logs one audit row per NDC.
-- ============================================================================
create or replace function public.import_accumulator_rows(
  p_facility_id uuid,
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

  if not public.is_latest_period(p_facility_id, p_month, p_year) then
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
    where ndc = v_ndc and facility_id = p_facility_id and month = p_month and year = p_year;

    insert into public.accumulator
      (ndc, product_name, pack_size, qty_on_hand, packs_on_hand, exp_day, price_340b, ppu_340b,
       cost_on_hand_340b, cin, manufacturer, facility_id, month, year)
    values
      (v_ndc, v_row->>'product_name', v_pack_size, v_qty, v_packs,
       nullif(v_row->>'exp_day', '')::date,
       nullif(v_row->>'price_340b', '')::numeric, v_ppu, v_cost,
       v_row->>'cin', v_row->>'manufacturer', p_facility_id, p_month, p_year)
    on conflict (ndc, facility_id, month, year) do update set
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
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type)
    values
      (v_user_id, null, v_ndc, v_row->>'product_name', coalesce(v_prior_qty, 0),
       coalesce(v_prior_qty, 0) - v_qty, v_qty, null, 'import_override');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.import_accumulator_rows from public;
grant execute on function public.import_accumulator_rows to authenticated;
