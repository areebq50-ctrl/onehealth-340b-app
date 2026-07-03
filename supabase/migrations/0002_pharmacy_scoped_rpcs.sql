-- ============================================================================
-- Migration 0002: Pharmacy-scoped RPC functions
--
-- Rewrites every accumulator-writing RPC to require and enforce pharmacy_id.
-- Each function still executes as a single Postgres transaction (SECURITY
-- DEFINER function body), so partial writes are still impossible.
--
-- Depends on 0001_pharmacy_scoped_accumulator.sql having been applied first.
-- ============================================================================

-- ============================================================================
-- RPC: process_claim (pharmacy-scoped)
--
-- Every accumulator lookup now filters by pharmacy_id in addition to
-- facility_id/ndc/month/year, so a claim can never touch another pharmacy's
-- inventory. Also now records original_filename/file_hash/row counts on the
-- claim for File History, and returns the claim id (== the "claim batch id"
-- used to trace every downstream record: line items, accumulator changes,
-- audit log entries).
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
      uploaded_by = v_user_id,
      uploaded_at = now(),
      status = 'completed'
  where id = v_claim_id;

  return v_claim_id;
end;
$$;

revoke all on function public.process_claim(uuid, uuid, date, text, jsonb, boolean, text, text, integer, integer, integer) from public;
grant execute on function public.process_claim(uuid, uuid, date, text, jsonb, boolean, text, text, integer, integer, integer) to authenticated;

-- ============================================================================
-- RPC: edit_accumulator_row (unchanged signature — the row's own pharmacy_id
-- is read from the row itself; is_latest_period call and audit logging now
-- include it).
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
-- RPC: delete_accumulator_row (new) — admin-only, latest-period-only, fully
-- audited (action_type='manual_delete') before the row is removed.
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
-- RPC: add_accumulator_row (now requires p_pharmacy_id)
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
-- RPC: rollover_month (now requires p_pharmacy_id, copies only that
-- pharmacy's rows)
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
-- RPC: import_accumulator_rows (now requires p_pharmacy_id, upsert conflict
-- target includes pharmacy_id)
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
