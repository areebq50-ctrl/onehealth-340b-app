import { formatQty } from './calculations.js';

/**
 * Plain-English hover explanations for every signed number shown in the
 * app. ONE convention, used everywhere past the point of import: positive
 * on-hand = units you actually have; negative on-hand = you've dispensed
 * more than was on record (a shortage). Packs to Order is the mirror of
 * that: positive = you need to order that many packs, negative = you have
 * that many packs of surplus (over-replenished).
 */

export function explainOnHand(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return 'No value on record.';
  if (n > 0) return `${formatQty(qty)} units currently on hand.`;
  if (n < 0) return `Shortage of ${formatQty(Math.abs(n))} units — more has been dispensed than was on record. An order is needed.`;
  return 'Exactly zero on hand — nothing in stock, nothing owed.';
}

export function explainPacksOnHand(packs, qty) {
  const n = Number(packs);
  if (!Number.isFinite(n)) return 'Pack Size is missing or zero, so this can’t be computed.';
  if (n > 0) return `${formatQty(packs)} full packs’ worth on hand (Qty on Hand ÷ Pack Size).`;
  if (n < 0) return `Short by ${formatQty(Math.abs(n))} packs’ worth (Qty on Hand of ${formatQty(qty)} ÷ Pack Size).`;
  return 'Exactly zero packs on hand.';
}

export function explainCostOnHand(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n)) return 'No value on record.';
  if (n > 0) return `Value of what’s on hand at the 340B price (Qty on Hand × 340B PPU).`;
  if (n < 0) return `Negative because Qty on Hand is negative (a shortage) — this is what you’re short, priced at 340B PPU.`;
  return 'Zero — nothing on hand to value.';
}

export function explainDispensed(qty) {
  const n = Number(qty);
  if (!n) return 'Nothing dispensed.';
  return `${formatQty(Math.abs(n))} units dispensed — subtracted from the balance.`;
}

export function explainOrderReceived(qty) {
  const n = Number(qty);
  if (!n) return 'No order received.';
  return `${formatQty(Math.abs(n))} units received — added to the balance.`;
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

/** For claim_line_items.qty_after / the Daily Results "New Balance" — same on-hand convention, phrased for a post-claim balance. */
export function explainNewBalance(qtyAfter) {
  const n = Number(qtyAfter);
  if (!Number.isFinite(n)) return 'No value on record.';
  if (n > 0) return `${formatQty(qtyAfter)} units remain on hand after this claim.`;
  if (n < 0) return `Went ${formatQty(Math.abs(n))} units negative — this claim dispensed more than was on hand. A shortage, needs an order.`;
  return 'Exactly zero after this claim — fully depleted, nothing short.';
}
