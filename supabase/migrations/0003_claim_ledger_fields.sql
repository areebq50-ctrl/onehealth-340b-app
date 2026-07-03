-- ============================================================================
-- Migration 0003: RX-level claim ledger fields
--
-- The real claims workbook ("Sheet" tab) carries far more per-line detail
-- than NDC/Drug Name/Qty: Refill No., RX#, Date Filled/Written, payer
-- breakdown (Primary/Patient Paid, Tax, Fee, Total), and payer identifiers
-- (BIN/PCN/Group/Member ID/Prescriber). This adds columns to preserve that
-- detail per claim line, plus batch-level summary counters on `claims` so
-- the Claim Batch Results page doesn't need to recompute them from scratch
-- on every view.
--
-- All identifier fields (rx_number, bin, pcn, group_code, member_id) are
-- stored as text specifically to avoid leading-zero loss, matching how the
-- source workbook itself already stores them (confirmed against a real
-- file: Primary BIN/PCN/Group/ID are text-typed cells in the source).
-- ============================================================================

alter table public.claim_line_items add column if not exists refill_no integer;
alter table public.claim_line_items add column if not exists refills_auth integer;
alter table public.claim_line_items add column if not exists refills_remain integer;
alter table public.claim_line_items add column if not exists date_filled date;
alter table public.claim_line_items add column if not exists date_written date;
alter table public.claim_line_items add column if not exists rx_number text;
alter table public.claim_line_items add column if not exists days_supply numeric;
alter table public.claim_line_items add column if not exists primary_paid numeric;
alter table public.claim_line_items add column if not exists patient_paid numeric;
alter table public.claim_line_items add column if not exists tax numeric;
alter table public.claim_line_items add column if not exists fee numeric;
alter table public.claim_line_items add column if not exists total_paid numeric;
alter table public.claim_line_items add column if not exists primary_payer text;
alter table public.claim_line_items add column if not exists bin text;
alter table public.claim_line_items add column if not exists pcn text;
alter table public.claim_line_items add column if not exists group_code text;
alter table public.claim_line_items add column if not exists member_id text;
alter table public.claim_line_items add column if not exists scc text;
alter table public.claim_line_items add column if not exists prescriber text;
alter table public.claim_line_items add column if not exists prescriber_npi text;

create index if not exists idx_line_items_rx_number on public.claim_line_items (rx_number);

-- Batch-level summary counters (distinct from claims.matched_count/unmatched_count
-- added in migration 0001, which already exist).
alter table public.claims add column if not exists claim_line_count integer;
alter table public.claims add column if not exists distinct_rx_count integer;
alter table public.claims add column if not exists distinct_ndc_count integer;
alter table public.claims add column if not exists total_qty_dispensed numeric;

comment on column public.claim_line_items.rx_number is 'Stored as text to preserve leading zeros, matching the source workbook''s own text-typed RX# column.';
