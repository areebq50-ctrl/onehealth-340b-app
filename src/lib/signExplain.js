import { formatQty } from './calculations.js';

/**
 * Plain-English hover explanations for every signed number shown in the
 * app. ONE convention, confirmed with the pharmacy team and used
 * EVERYWHERE — in the database, every RPC, and every screen — with no
 * separate "physical count" representation anywhere internally:
 *
 *   NEGATIVE = surplus (this much extra stock on hand, no order needed).
 *   POSITIVE = shortage (this much short, needs a replenishment order).
 *   Zero     = exactly balanced.
 *
 * Dispensing a claim ADDS to the balance (consumes stock, moves it toward
 * positive/shortage). An order received SUBTRACTS (replenishes stock,
 * moves it toward negative/surplus). Packs to Order mirrors the balance
 * directly: positive = order that many packs, negative = that many packs
 * of surplus.
 */

export function explainOnHand(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return 'No value on record.';
  if (n < 0) return `${formatQty(Math.abs(n))} units of surplus on hand — no order needed.`;
  if (n > 0) return `Shortage of ${formatQty(n)} units — needs a replenishment order.`;
  return 'Exactly balanced — zero surplus, zero shortage.';
}

export function explainPacksOnHand(packs, qty) {
  const n = Number(packs);
  if (!Number.isFinite(n)) return 'Pack Size is missing or zero, so this can’t be computed.';
  if (n < 0) return `${formatQty(Math.abs(n))} full packs’ worth of surplus on hand (Qty on Hand ÷ Pack Size).`;
  if (n > 0) return `Short by ${formatQty(n)} packs’ worth (Qty on Hand of ${formatQty(qty)} ÷ Pack Size).`;
  return 'Exactly balanced — zero packs of surplus or shortage.';
}

export function explainCostOnHand(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n)) return 'No value on record.';
  if (n < 0) return `Value of the surplus on hand at the 340B price (Qty on Hand × 340B PPU).`;
  if (n > 0) return `Positive because Qty on Hand is positive (a shortage) — this is what you're short, priced at 340B PPU.`;
  return 'Zero — nothing surplus or short to value.';
}

export function explainDispensed(qty) {
  const n = Number(qty);
  if (!n) return 'Nothing dispensed.';
  return `${formatQty(Math.abs(n))} units dispensed — added to the balance (consumes surplus / deepens shortage).`;
}

export function explainOrderReceived(qty) {
  const n = Number(qty);
  if (!n) return 'No order received.';
  return `${formatQty(Math.abs(n))} units received — subtracted from the balance (replenishes stock).`;
}

/** For the raw, un-clamped signedPacksToOrder() value shown in the Accumulator/Daily Ledger/Replenishment views. */
export function explainSignedPacksToOrder(result) {
  if (!result || result.flagged) return result?.reason ?? 'Cannot be computed.';
  const n = Number(result.value);
  if (n > 0) return `Needs ${formatQty(result.value)} pack(s) ordered to cover the current shortage.`;
  if (n < 0) return `${formatQty(Math.abs(n))} pack(s) of surplus on hand — over-replenished, no order needed right now.`;
  return 'Exactly balanced — no order needed.';
}

/** For the clamped packsToOrder() shape used on the Replenishment by NDC tab (never negative — 0 means no shortage). */
export function explainRecommendedPacks(recommendedPacks) {
  const n = Number(recommendedPacks);
  if (!n) return 'On hand covers demand — no order needed from this claim.';
  return `Recommend ordering ${formatQty(recommendedPacks)} whole pack(s) to cover today’s shortage.`;
}

/** For claim_line_items.qty_after / the Daily Results "New Balance" — same convention, phrased for a post-claim balance. */
export function explainNewBalance(qtyAfter) {
  const n = Number(qtyAfter);
  if (!Number.isFinite(n)) return 'No value on record.';
  if (n < 0) return `${formatQty(Math.abs(n))} units of surplus remain after this claim — no order needed.`;
  if (n > 0) return `Went ${formatQty(n)} units positive — this claim dispensed more than the surplus covered. A shortage, needs an order.`;
  return 'Exactly zero after this claim — fully balanced, nothing short.';
}
