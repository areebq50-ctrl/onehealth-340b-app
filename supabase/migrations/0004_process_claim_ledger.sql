-- ============================================================================
-- Migration 0004: process_claim stores full RX-level ledger + batch summary
--
-- Depends on 0001, 0002, 0003. Replaces process_claim again to: (a) persist
-- every RX-level field from migration 0003 on each claim_line_items row
-- (both matched and unmatched — unmatched rows still deserve full ledger
-- detail for the "Unmatched" tab), and (b) compute claim_line_count /
-- distinct_rx_count / distinct_ndc_count / total_qty_dispensed on the claims
-- row so the Claim Batch Results page can read them directly instead of
-- recomputing on every view.
--
-- Replenishment (shortage / exact packs / recommended packs) is deliberately
-- NOT stored here — claim_line_items already stores qty_after and pack_size
-- per matched row, which is everything needed to compute it at read time
-- with decimal.js. Storing a derived, rounding-sensitive number would risk
-- it drifting out of sync with the source qty/pack_size it was computed
-- from.
-- ============================================================================
create or replace function public.process_claim(
  p_pharmacy_id uuid,
  p_facility_id uuid,
  p_claim_date date,
  p_file_path text,
  p_line_items jsonb,
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

    if not v_matched then
      v_unmatched_count := v_unmatched_count + 1;
      insert into public.claim_line_items
        (claim_id, ndc, product_name, qty_dispensed, matched, flag_reason,
         refill_no, refills_auth, refills_remain, date_filled, date_written, rx_number, days_supply,
         primary_paid, patient_paid, tax, fee, total_paid, primary_payer, bin, pcn, group_code, member_id,
         scc, prescriber, prescriber_npi)
      values
        (v_claim_id, v_ndc, v_item->>'product_name_raw', v_qty, false,
         'Unmatched: NDC not found in this pharmacy''s accumulator for this period',
         nullif(v_item->>'refill_no','')::integer, nullif(v_item->>'refills_auth','')::integer, nullif(v_item->>'refills_remain','')::integer,
         nullif(v_item->>'date_filled','')::date, nullif(v_item->>'date_written','')::date, v_item->>'rx_number',
         nullif(v_item->>'days_supply','')::numeric,
         nullif(v_item->>'primary_paid','')::numeric, nullif(v_item->>'patient_paid','')::numeric,
         nullif(v_item->>'tax','')::numeric, nullif(v_item->>'fee','')::numeric, nullif(v_item->>'total_paid','')::numeric,
         v_item->>'primary_payer', v_item->>'bin', v_item->>'pcn', v_item->>'group_code', v_item->>'member_id',
         v_item->>'scc', v_item->>'prescriber', v_item->>'prescriber_npi');
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
       refill_no, refills_auth, refills_remain, date_filled, date_written, rx_number, days_supply,
       primary_paid, patient_paid, tax, fee, total_paid, primary_payer, bin, pcn, group_code, member_id,
       scc, prescriber, prescriber_npi)
    values
      (v_claim_id, v_ndc, v_acc.product_name, v_qty, v_acc.pack_size, v_packs, v_acc.ppu_340b,
       v_reimb, v_prior_qty, v_new_qty, true,
       case when v_new_qty < 0 then 'Negative on-hand after this claim' else null end,
       nullif(v_item->>'refill_no','')::integer, nullif(v_item->>'refills_auth','')::integer, nullif(v_item->>'refills_remain','')::integer,
       nullif(v_item->>'date_filled','')::date, nullif(v_item->>'date_written','')::date, v_item->>'rx_number',
       nullif(v_item->>'days_supply','')::numeric,
       nullif(v_item->>'primary_paid','')::numeric, nullif(v_item->>'patient_paid','')::numeric,
       nullif(v_item->>'tax','')::numeric, nullif(v_item->>'fee','')::numeric, nullif(v_item->>'total_paid','')::numeric,
       v_item->>'primary_payer', v_item->>'bin', v_item->>'pcn', v_item->>'group_code', v_item->>'member_id',
       v_item->>'scc', v_item->>'prescriber', v_item->>'prescriber_npi');

    insert into public.accumulator_audit_log
      (user_id, claim_id, ndc, product_name, prior_qty, qty_dispensed, new_qty, reimbursement_amount, action_type, facility_id, pharmacy_id)
    values
      (v_user_id, v_claim_id, v_ndc, v_acc.product_name, v_prior_qty, v_qty, v_new_qty, v_reimb, 'claim_dispense',
       p_facility_id, p_pharmacy_id);

    v_total_reimb := v_total_reimb + coalesce(v_reimb, 0);
  end loop;

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
      distinct_rx_count = (select count(distinct rx_number) from public.claim_line_items where claim_id = v_claim_id and rx_number is not null),
      distinct_ndc_count = (select count(distinct ndc) from public.claim_line_items where claim_id = v_claim_id),
      total_qty_dispensed = v_total_qty,
      uploaded_by = v_user_id,
      uploaded_at = now(),
      status = 'completed'
  where id = v_claim_id;

  return v_claim_id;
end;
$$;

revoke all on function public.process_claim(uuid, uuid, date, text, jsonb, boolean, text, text, integer, integer, integer) from public;
grant execute on function public.process_claim(uuid, uuid, date, text, jsonb, boolean, text, text, integer, integer, integer) to authenticated;
