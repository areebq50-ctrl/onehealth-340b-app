-- ============================================================================
-- Migration 0006: correct claim_line_items, wire up claim_raw_lines
--
-- CORRECTION: migration 0003 added RX-ledger columns (rx_number, refill_no,
-- prescriber, etc.) directly to claim_line_items. That was written before
-- inspecting a real claims workbook. Real data shows a single NDC can be
-- dispensed across MULTIPLE RX fills in one claim batch — so a single
-- rx_number/refill_no column on the NDC-pivoted claim_line_items row is
-- ambiguous (which of the contributing RX fills would it represent?).
-- claim_raw_lines (migration 0005) is the correct home for that
-- one-row-per-RX-fill detail. This migration removes the now-incorrect
-- columns from claim_line_items and rewrites process_claim to populate
-- claim_raw_lines instead.
-- ============================================================================

alter table public.claim_line_items drop column if exists refill_no;
alter table public.claim_line_items drop column if exists refills_auth;
alter table public.claim_line_items drop column if exists refills_remain;
alter table public.claim_line_items drop column if exists date_filled;
alter table public.claim_line_items drop column if exists date_written;
alter table public.claim_line_items drop column if exists rx_number;
alter table public.claim_line_items drop column if exists days_supply;
alter table public.claim_line_items drop column if exists primary_paid;
alter table public.claim_line_items drop column if exists patient_paid;
alter table public.claim_line_items drop column if exists tax;
alter table public.claim_line_items drop column if exists fee;
alter table public.claim_line_items drop column if exists total_paid;
alter table public.claim_line_items drop column if exists primary_payer;
alter table public.claim_line_items drop column if exists bin;
alter table public.claim_line_items drop column if exists pcn;
alter table public.claim_line_items drop column if exists group_code;
alter table public.claim_line_items drop column if exists member_id;
alter table public.claim_line_items drop column if exists scc;
alter table public.claim_line_items drop column if exists prescriber;
alter table public.claim_line_items drop column if exists prescriber_npi;

-- ============================================================================
-- process_claim: adds p_raw_lines (one entry per original source row —
-- not pivoted). Each raw line's `matched` flag is inherited from whether
-- its NDC matched during the pivoted p_line_items pass in the SAME
-- transaction, so raw-line matched status can never disagree with the
-- accumulator-driving pivot. Raw lines never touch the accumulator.
-- ============================================================================
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

-- The previous 11-arg overload (without p_raw_lines) is no longer used by the frontend — drop it to avoid ambiguous overload resolution.
drop function if exists public.process_claim(uuid, uuid, date, text, jsonb, boolean, text, text, integer, integer, integer);
