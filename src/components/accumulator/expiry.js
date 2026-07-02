/**
 * Expiry color coding (display-only, not a monetary/quantity calculation):
 * red = expired or within 30 days, amber = 31-60 days, green = 60+ days.
 */
export function getExpiryTone(expDay) {
  if (!expDay) return { tone: 'none', label: '—' };
  const expDate = new Date(`${expDay}T00:00:00Z`);
  if (Number.isNaN(expDate.getTime())) return { tone: 'none', label: '—' };

  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const daysUntil = Math.round((expDate.getTime() - todayUtc) / 86400000);

  if (daysUntil <= 30) return { tone: 'red', label: expDay, daysUntil };
  if (daysUntil <= 60) return { tone: 'amber', label: expDay, daysUntil };
  return { tone: 'green', label: expDay, daysUntil };
}

export const EXPIRY_TONE_CLASSES = {
  red: 'bg-red-50 text-danger',
  amber: 'bg-amber-50 text-warning',
  green: 'bg-green-50 text-success',
  none: 'text-gray-400',
};
