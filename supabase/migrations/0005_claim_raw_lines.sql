-- ============================================================================
-- Migration 0005: claim_raw_lines — full per-RX source ledger
--
-- claim_line_items (migrations 0001/0003/0004) stores one row PER NDC per
-- claim — the pivoted totals that actually drive accumulator deduction and
-- reimbursement math. That's correct and unchanged.
--
-- The "All Claims" tab needs the opposite granularity: one row per ORIGINAL
-- source line (per RX fill), exactly as it appeared in the uploaded
-- workbook — because a single NDC can be dispensed across multiple RX
-- fills in one day, and the user needs to see each one (Refill No., RX#,
-- Date Filled/Written, payer breakdown, prescriber, etc). This table is
-- purely a record-keeping ledger: it has no effect on the accumulator.
-- Matched status is inherited from whether the line's NDC matched during
-- the same process_claim run.
-- ============================================================================
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

alter table public.claim_raw_lines enable row level security;
create policy raw_lines_select on public.claim_raw_lines for select using (public.is_active_user());
-- No client-side insert/update/delete policy — written only by process_claim (SECURITY DEFINER).

comment on table public.claim_raw_lines is 'Read-only, per-RX-line source ledger for the Claim Batch Results "All Claims" tab. Does not drive accumulator math — see claim_line_items for the NDC-pivoted totals that do.';
