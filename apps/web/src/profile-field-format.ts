/**
 * Provider-owned profile values are optional on the wire: a section-scoped local
 * read omits them instead of claiming zero balance or an unassessed level. The
 * UI renders this placeholder whenever a value is absent.
 */
export const UNKNOWN_VALUE_PLACEHOLDER = '—';

/**
 * Formats a balance the server actually observed. Returns `null` for an absent
 * or unusable value so the caller renders the placeholder rather than `0 ₽`.
 */
export function formatBalance(
  balanceMinor: number | undefined,
  currency: string | undefined,
  style: 'plain' | 'currency' = 'plain',
): string | null {
  if (balanceMinor === undefined || !Number.isFinite(balanceMinor)) return null;
  if (style === 'plain') return new Intl.NumberFormat('ru-RU').format(balanceMinor / 100);
  if (!currency) return null;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(balanceMinor / 100);
}
