-- ============================================================================
-- Migration 0001: Pharmacy-scoped accumulator
--
-- PROBLEM: accumulator was keyed on (ndc, facility_id, month, year) with no
-- pharmacy_id. Every pharmacy under a facility shared one accumulator row
-- per NDC/month, so a Blue Swan claim could silently deduct inventory that
-- Lawrence Hause thought was its own.
--
-- SAFETY: this migration is defensive. It adds pharmacy_id as nullable
-- first, then only enforces NOT NULL if every row already has a value (true
-- for a fresh install with zero accumulator rows). If you already have real
-- accumulator rows without a pharmacy assigned, this migration will leave
-- the column nullable and RAISE NOTICE telling you to backfill manually —
-- it will NOT guess which pharmacy owns existing inventory, and it will NOT
-- duplicate rows across pharmacies.
--
-- Run this in the Supabase SQL Editor (or `supabase db push`) against a
-- database that already has schema.sql applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. accumulator: add pharmacy_id
-- ----------------------------------------------------------------------------
alter table public.accumulator add column if not exists pharmacy_id uuid references public.pharmacies(id);

do $$
declare
  v_null_count integer;
begin
  select count(*) into v_null_count from public.accumulator where pharmacy_id is null;
  if v_null_count = 0 then
    alter table public.accumulator alter column pharmacy_id set not null;
    raise notice 'accumulator.pharmacy_id set to NOT NULL (no existing rows needed backfill).';
  else
    raise notice 'accumulator has % row(s) with NULL pharmacy_id. NOT NULL was NOT applied. '
      'Backfill pharmacy_id for every existing row (update public.accumulator set pharmacy_id = ... where id = ...), '
      'then run: alter table public.accumulator alter column pharmacy_id set not null;', v_null_count;
  end if;
end $$;

-- Replace the old facility-only uniqueness with facility+pharmacy uniqueness.
alter table public.accumulator drop constraint if exists accumulator_unique_ndc_period;
alter table public.accumulator add constraint accumulator_unique_ndc_period
  unique (ndc, facility_id, pharmacy_id, month, year);

drop index if exists idx_accumulator_facility_period;
create index if not exists idx_accumulator_facility_pharmacy_period
  on public.accumulator (facility_id, pharmacy_id, year, month);
create index if not exists idx_accumulator_pharmacy on public.accumulator (pharmacy_id);

-- ----------------------------------------------------------------------------
-- 2. Validate facility/pharmacy pairs everywhere they're stored together.
--    Reusable trigger: rejects any insert/update where (facility_id,
--    pharmacy_id) isn't a real link in pharmacy_facilities.
-- ----------------------------------------------------------------------------
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

drop trigger if exists validate_accumulator_pharmacy_facility on public.accumulator;
create trigger validate_accumulator_pharmacy_facility
  before insert or update of pharmacy_id, facility_id on public.accumulator
  for each row execute function public.validate_pharmacy_facility_pair();

drop trigger if exists validate_claims_pharmacy_facility on public.claims;
create trigger validate_claims_pharmacy_facility
  before insert or update of pharmacy_id, facility_id on public.claims
  for each row execute function public.validate_pharmacy_facility_pair();

-- ----------------------------------------------------------------------------
-- 3. is_latest_period becomes pharmacy-scoped (old 3-arg version dropped).
-- ----------------------------------------------------------------------------
drop function if exists public.is_latest_period(uuid, integer, integer) CASCADE;

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

-- RLS policies on accumulator must reference the new 4-arg signature.
drop policy if exists accumulator_insert on public.accumulator;
drop policy if exists accumulator_update on public.accumulator;

create policy accumulator_insert on public.accumulator for insert
  with check (public.is_admin() and public.is_latest_period(facility_id, pharmacy_id, month, year));
create policy accumulator_update on public.accumulator for update
  using (public.is_admin() and public.is_latest_period(facility_id, pharmacy_id, month, year))
  with check (public.is_admin() and public.is_latest_period(facility_id, pharmacy_id, month, year));

-- ----------------------------------------------------------------------------
-- 4. Audit tables: add facility_id/pharmacy_id so pharmacy is visible in
--    every audit entry, and add a claim_batch_id for cross-record tracing.
--    Nullable — these describe historical rows too, and manual edits don't
--    always have a claim_batch_id.
-- ----------------------------------------------------------------------------
alter table public.accumulator_audit_log add column if not exists facility_id uuid references public.facilities(id);
alter table public.accumulator_audit_log add column if not exists pharmacy_id uuid references public.pharmacies(id);
create index if not exists idx_audit_log_pharmacy on public.accumulator_audit_log (pharmacy_id);

alter table public.accumulator_audit_log drop constraint if exists accumulator_audit_log_action_type_check;
alter table public.accumulator_audit_log add constraint accumulator_audit_log_action_type_check
  check (action_type in (
    'claim_dispense', 'claim_reversal', 'manual_qty_edit', 'rollover', 'manual_add', 'import_override', 'manual_delete'
  ));

alter table public.accumulator_field_edit_log add column if not exists facility_id uuid references public.facilities(id);
alter table public.accumulator_field_edit_log add column if not exists pharmacy_id uuid references public.pharmacies(id);
create index if not exists idx_field_edit_log_pharmacy on public.accumulator_field_edit_log (pharmacy_id);

-- ----------------------------------------------------------------------------
-- 5. claims: file-history / traceability fields. claims.pharmacy_id already
--    existed and was already correctly enforced — the bug was accumulator,
--    not claims. This just adds the metadata File History needs to display.
-- ----------------------------------------------------------------------------
alter table public.claims add column if not exists original_filename text;
alter table public.claims add column if not exists file_hash text;
alter table public.claims add column if not exists total_rows integer;
alter table public.claims add column if not exists valid_rows integer;
alter table public.claims add column if not exists invalid_rows integer;
alter table public.claims add column if not exists matched_count integer;
alter table public.claims add column if not exists unmatched_count integer;

create index if not exists idx_claims_file_hash on public.claims (pharmacy_id, facility_id, file_hash);

comment on column public.accumulator.pharmacy_id is 'Required. Every accumulator row belongs to exactly one pharmacy — never shared across pharmacies at the same facility.';
comment on column public.claims.file_hash is 'SHA-256 of the uploaded file content, used for duplicate-upload detection alongside pharmacy+facility+claim_date.';
