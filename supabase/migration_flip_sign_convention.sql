-- ============================================================================
-- ONE-TIME MIGRATION: flip the accumulator balance sign convention.
--
-- Old convention (until now): qty_on_hand was a raw physical count —
-- POSITIVE = units you have, NEGATIVE = a shortage.
--
-- New convention (confirmed with the pharmacy team, matches their own
-- tracking sheet): qty_on_hand is deficit-framed —
-- NEGATIVE = surplus (units of extra stock, no order needed),
-- POSITIVE = shortage (units short, needs a replenishment order).
--
-- The application code (schema.sql RPCs + the frontend) has already been
-- updated to read/write balances under the NEW convention. This script
-- converts EXISTING rows in the live database so they match: it simply
-- negates the balance-shaped columns. Nothing else about the data changes
-- (dollar amounts, packs ordered, dispensed quantities, dates, etc. are
-- all magnitudes, not signed balances, and are untouched).
--
-- IMPORTANT — run this EXACTLY ONCE, after deploying the updated
-- schema.sql/frontend, never before, and never twice:
--   - Running it before the code deploy would leave live claims/orders
--     being applied under the OLD convention against NEW-convention data.
--   - Running it a second time would flip everything BACK to the old
--     convention, silently reintroducing the bug this fixes.
-- This file is intentionally NOT part of schema.sql (which is safe to
-- re-run any number of times) so it can never be re-applied by accident
-- during a routine schema update.
--
-- Recommended procedure:
--   1. Deploy the updated schema.sql (the RPC changes) and the updated
--      frontend build FIRST.
--   2. During a moment with no one actively uploading claims/invoices,
--      run this whole script once in the Supabase SQL editor.
--   3. Spot-check a few known NDCs on the Accumulator page afterward —
--      a drug you know has plenty of stock should now show a NEGATIVE
--      balance; a drug you know is short should show POSITIVE.
-- ============================================================================

begin;

-- Sanity check: show what's about to change before committing. Review
-- these counts/samples before running the UPDATEs below if running this
-- interactively (select the block above `commit;`, check the output, then
-- run the rest).
select
  (select count(*) from public.accumulator) as accumulator_rows,
  (select count(*) from public.accumulator_audit_log) as audit_log_rows,
  (select count(*) from public.claim_line_items where matched = true) as matched_claim_line_items;

-- 1. Master accumulator table: qty_on_hand and everything derived from it.
update public.accumulator
set qty_on_hand = -qty_on_hand,
    packs_on_hand = case when packs_on_hand is not null then -packs_on_hand else null end,
    cost_on_hand_340b = case when cost_on_hand_340b is not null then -cost_on_hand_340b else null end;

-- 2. Audit log: prior_qty / new_qty are balance snapshots, same convention
--    flip. qty_dispensed and reimbursement_amount are magnitudes (units
--    dispensed / dollars), not signed balances — left untouched. (Their
--    relationship to the new prior_qty/new_qty already holds correctly
--    after just negating these two columns — verified against both
--    claim_dispense and order_received event shapes.)
update public.accumulator_audit_log
set prior_qty = case when prior_qty is not null then -prior_qty else null end,
    new_qty = case when new_qty is not null then -new_qty else null end;

-- 3. Per-claim-line snapshots: qty_before / qty_after are the same kind of
--    balance snapshot as accumulator_audit_log above. qty_dispensed here is
--    also a magnitude — untouched.
update public.claim_line_items
set qty_before = case when qty_before is not null then -qty_before else null end,
    qty_after = case when qty_after is not null then -qty_after else null end
where matched = true;

commit;
