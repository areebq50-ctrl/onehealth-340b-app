-- ============================================================================
-- ONE-TIME CLEANUP: full reset of Heartland -> Lawrence House, July 2026.
--
-- Deletes, in this scope ONLY (nothing outside this facility/pharmacy/month
-- is touched):
--   1. Claims for July 2026 (cascades automatically to claim_line_items and
--      claim_raw_lines).
--   2. Accumulator rows for July 2026 (cascades automatically to
--      accumulator_orders).
--   3. accumulator_audit_log entries timestamped in July 2026 for this
--      facility/pharmacy.
--   4. accumulator_field_edit_log entries timestamped in July 2026 for this
--      facility/pharmacy.
--
-- This is a deliberate exception to "the audit log is never deleted" —
-- normally accumulator_audit_log is permanent, insert-only compliance
-- history. This cleanup is only appropriate because everything in this
-- specific scope has been acknowledged as testing/setup churn, not real
-- dispensing history that needs to be preserved. Do not reuse this pattern
-- for a period that contains real, final data.
--
-- Run ONCE. After this, the plan is: re-import the accumulator, then
-- re-upload the real claim(s), then the real invoice — in that order, on a
-- clean slate.
-- ============================================================================

begin;

-- Preview counts before deleting anything — review these before running the
-- DELETEs below (select the block above `commit;` first if running
-- interactively, check the numbers look right, then run the rest).
select
  (select count(*) from public.claims c
     join public.pharmacies p on p.id = c.pharmacy_id
     join public.facilities f on f.id = c.facility_id
     where f.name = 'Heartland' and p.name = 'Lawrence House'
       and c.claim_date >= '2026-07-01' and c.claim_date < '2026-08-01') as claims_to_delete,
  (select count(*) from public.accumulator a
     join public.pharmacies p on p.id = a.pharmacy_id
     join public.facilities f on f.id = a.facility_id
     where f.name = 'Heartland' and p.name = 'Lawrence House'
       and a.month = 7 and a.year = 2026) as accumulator_rows_to_delete,
  (select count(*) from public.accumulator_audit_log l
     join public.pharmacies p on p.id = l.pharmacy_id
     join public.facilities f on f.id = l.facility_id
     where f.name = 'Heartland' and p.name = 'Lawrence House'
       and l.timestamp >= '2026-07-01' and l.timestamp < '2026-08-01') as audit_log_rows_to_delete,
  (select count(*) from public.accumulator_field_edit_log e
     join public.pharmacies p on p.id = e.pharmacy_id
     join public.facilities f on f.id = e.facility_id
     where f.name = 'Heartland' and p.name = 'Lawrence House'
       and e.timestamp >= '2026-07-01' and e.timestamp < '2026-08-01') as field_edit_log_rows_to_delete;

-- 1. Claims (cascades to claim_line_items + claim_raw_lines).
delete from public.claims c
using public.pharmacies p, public.facilities f
where c.pharmacy_id = p.id and c.facility_id = f.id
  and f.name = 'Heartland' and p.name = 'Lawrence House'
  and c.claim_date >= '2026-07-01' and c.claim_date < '2026-08-01';

-- 2. Accumulator rows (cascades to accumulator_orders).
delete from public.accumulator a
using public.pharmacies p, public.facilities f
where a.pharmacy_id = p.id and a.facility_id = f.id
  and f.name = 'Heartland' and p.name = 'Lawrence House'
  and a.month = 7 and a.year = 2026;

-- 3. Audit log entries for this facility/pharmacy/period.
delete from public.accumulator_audit_log l
using public.pharmacies p, public.facilities f
where l.pharmacy_id = p.id and l.facility_id = f.id
  and f.name = 'Heartland' and p.name = 'Lawrence House'
  and l.timestamp >= '2026-07-01' and l.timestamp < '2026-08-01';

-- 4. Field-edit log entries for this facility/pharmacy/period.
delete from public.accumulator_field_edit_log e
using public.pharmacies p, public.facilities f
where e.pharmacy_id = p.id and e.facility_id = f.id
  and f.name = 'Heartland' and p.name = 'Lawrence House'
  and e.timestamp >= '2026-07-01' and e.timestamp < '2026-08-01';

commit;
