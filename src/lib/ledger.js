import { signedPacksToOrder } from './calculations.js';

/**
 * Groups raw accumulator_audit_log entries (one row per event) into one
 * row per calendar day for a single NDC: Starting Balance -> that day's
 * Dispensed -> that day's Order Received -> Ending Balance -> Packs to
 * Order, matching how the pharmacy's own spreadsheet tracks a period
 * instead of a flat event log. Multiple same-day events of the same type
 * are summed into that day's one figure.
 */
export function groupAuditEntriesByDay(entries, packSize) {
  const days = new Map();
  for (const e of entries) {
    const dateKey = new Date(e.timestamp).toISOString().slice(0, 10);
    if (!days.has(dateKey)) {
      days.set(dateKey, { date: dateKey, startingBalance: e.prior_qty, dispensed: 0, ordered: 0, otherEvents: [], endingBalance: e.new_qty });
    }
    const day = days.get(dateKey);
    const change = Number(e.new_qty ?? 0) - Number(e.prior_qty ?? 0);
    // Deficit-framed convention: a dispense ADDS (change is positive), an
    // order received SUBTRACTS (change is negative) — the opposite of a
    // raw physical-count ledger.
    if (e.action_type === 'claim_dispense') day.dispensed += change;
    else if (e.action_type === 'order_received') day.ordered += -change;
    else day.otherEvents.push(e.action_type);
    day.endingBalance = e.new_qty;
  }
  return Array.from(days.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      ...day,
      packsToOrder: signedPacksToOrder(day.endingBalance, packSize),
    }));
}

/**
 * Builds a whole-accumulator snapshot for one specific date: every current
 * accumulator row gets that day's Starting/Dispensed/Order Received/Ending
 * Balance/Packs to Order, so the whole master list can be viewed "as of"
 * any day in the period without opening each NDC individually. NDCs with
 * no audit activity on the chosen day carry forward their most recent
 * prior ending balance (Dispensed/Order Received show as 0 that day) so
 * every row always has a value, same as a spreadsheet column for that day
 * would.
 */
export function buildDailySnapshot(accumulatorRows, entriesByNdc, targetDate) {
  return accumulatorRows.map((row) => {
    const days = groupAuditEntriesByDay(entriesByNdc.get(row.ndc) ?? [], row.pack_size);
    const exact = days.find((d) => d.date === targetDate);
    if (exact) return { ...row, ...exact };

    const priorDays = days.filter((d) => d.date < targetDate);
    const nextDays = days.filter((d) => d.date > targetDate);
    let balance;
    if (priorDays.length > 0) {
      balance = priorDays[priorDays.length - 1].endingBalance;
    } else if (nextDays.length > 0) {
      balance = nextDays[0].startingBalance;
    } else {
      balance = row.qty_on_hand;
    }

    return {
      ...row,
      date: targetDate,
      startingBalance: balance,
      dispensed: 0,
      ordered: 0,
      otherEvents: [],
      endingBalance: balance,
      packsToOrder: signedPacksToOrder(balance, row.pack_size),
    };
  });
}

/**
 * Builds a wide, spreadsheet-style matrix: every current accumulator row
 * gets ONE cell per date in `dates` holding that day's Ending Balance —
 * matching a day-per-column layout instead of picking one date at a time.
 * `dates` must be sorted ascending. Each NDC's day-series is computed once
 * (not once per date) and walked with a single forward pointer, so this
 * stays fast even for a full month x a large accumulator.
 */
export function buildDateRangeMatrix(accumulatorRows, entriesByNdc, dates) {
  return accumulatorRows.map((row) => {
    const days = groupAuditEntriesByDay(entriesByNdc.get(row.ndc) ?? [], row.pack_size);
    let dayIdx = 0;
    let carried = null;
    let hadAnyActivityYet = false;
    const cells = dates.map((date) => {
      while (dayIdx < days.length && days[dayIdx].date <= date) {
        carried = days[dayIdx].endingBalance;
        hadAnyActivityYet = true;
        dayIdx += 1;
      }
      const hasActivityToday = dayIdx > 0 && days[dayIdx - 1].date === date;
      if (hadAnyActivityYet) {
        return { date, endingBalance: carried, hasActivityToday, packsToOrder: signedPacksToOrder(carried, row.pack_size) };
      }
      // No activity on or before this date yet — look ahead for the first
      // day's Starting Balance (the value before its first event), else
      // fall back to the row's current on-hand (nothing has ever changed it).
      const next = days.find((d) => d.date > date);
      const fallback = next ? next.startingBalance : row.qty_on_hand;
      return { date, endingBalance: fallback, hasActivityToday: false, packsToOrder: signedPacksToOrder(fallback, row.pack_size) };
    });
    return { ...row, cells };
  });
}
