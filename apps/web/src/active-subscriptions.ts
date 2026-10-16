// Read-only consumer of the COMPLETE self-subscription contract in PR #398.
// Home summaries are deliberately never used as a fallback for this list.
export interface ActiveSubscription {
  readonly id: string;
  readonly title: string | null;
  readonly kind: 'INDIVIDUAL' | 'GROUP' | 'UNKNOWN';
  readonly status: 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'EXHAUSTED' | 'UNKNOWN';
  readonly remaining: {
    readonly amount: number | null;
    readonly unit: 'VISITS' | 'MINUTES' | 'DAYS' | 'UNITS' | 'UNKNOWN';
  };
  readonly validUntil: string | null;
}
interface SubscriptionPage {
  readonly scope: 'CURRENT';
  readonly coverage: 'COMPLETE';
  readonly snapshot: { readonly id: string; readonly asOf: string; readonly staleAt: string };
  readonly freshness: 'FRESH' | 'STALE';
  readonly items: readonly ActiveSubscription[];
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}
export type ActiveSubscriptions = Pick<SubscriptionPage, 'snapshot' | 'freshness' | 'items'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const invalid = (): never => {
  throw new Error('SUBSCRIPTIONS_INCOMPLETE');
};

function parsePage(value: unknown): SubscriptionPage {
  const result = value as SubscriptionPage | null;
  if (
    !result ||
    result.scope !== 'CURRENT' ||
    result.coverage !== 'COMPLETE' ||
    !result.snapshot ||
    !uuid.test(result.snapshot.id) ||
    !timestamp(result.snapshot.asOf) ||
    !timestamp(result.snapshot.staleAt) ||
    Date.parse(result.snapshot.asOf) > Date.parse(result.snapshot.staleAt) ||
    !['FRESH', 'STALE'].includes(result.freshness) ||
    !Array.isArray(result.items) ||
    result.items.length > 50 ||
    !result.page ||
    result.page.limit !== 50 ||
    !Number.isSafeInteger(result.page.offset) ||
    result.page.offset < 0 ||
    !Number.isSafeInteger(result.page.total) ||
    result.page.total < 0 ||
    typeof result.page.hasMore !== 'boolean' ||
    (result.page.nextCursor !== null &&
      (typeof result.page.nextCursor !== 'string' ||
        result.page.nextCursor.length === 0 ||
        result.page.nextCursor.length > 4096))
  )
    return invalid();
  for (const item of result.items as readonly ActiveSubscription[]) {
    if (
      !item ||
      !uuid.test(item.id) ||
      (item.title !== null &&
        (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200)) ||
      !['INDIVIDUAL', 'GROUP', 'UNKNOWN'].includes(item.kind) ||
      !['SCHEDULED', 'ACTIVE', 'PAUSED', 'EXHAUSTED', 'UNKNOWN'].includes(item.status) ||
      !item.remaining ||
      !['VISITS', 'MINUTES', 'DAYS', 'UNITS', 'UNKNOWN'].includes(item.remaining.unit) ||
      (item.remaining.amount !== null &&
        (typeof item.remaining.amount !== 'number' ||
          !Number.isFinite(item.remaining.amount) ||
          item.remaining.amount < 0)) ||
      (item.remaining.unit === 'UNKNOWN' && item.remaining.amount !== null) ||
      (item.validUntil !== null && !timestamp(item.validUntil))
    )
      return invalid();
  }
  return result;
}

export async function readActiveSubscriptions(
  request: (path: string) => Promise<unknown>,
): Promise<ActiveSubscriptions> {
  let first: SubscriptionPage | undefined;
  let cursor: string | null = null;
  let freshness: 'FRESH' | 'STALE' = 'FRESH';
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const items: ActiveSubscription[] = [];
  // Bound a failed/misbehaving cursor chain; never publish a truncated result.
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const current = parsePage(await request(`/subscriptions?${query.toString()}`));
    first ??= current;
    if (current.freshness === 'STALE') freshness = 'STALE';
    if (
      current.snapshot.id !== first.snapshot.id ||
      current.snapshot.asOf !== first.snapshot.asOf ||
      current.snapshot.staleAt !== first.snapshot.staleAt ||
      current.page.total !== first.page.total ||
      current.page.offset !== items.length
    )
      return invalid();
    for (const item of current.items) {
      const id = item.id.toLowerCase();
      const previous = items.at(-1)?.id.toLowerCase();
      if (ids.has(id) || (previous && id <= previous)) return invalid();
      ids.add(id);
      items.push(item);
    }
    const more = items.length < current.page.total;
    if (
      items.length > current.page.total ||
      current.page.hasMore !== more ||
      (more && (current.items.length !== 50 || !current.page.nextCursor)) ||
      (!more && current.page.nextCursor !== null)
    )
      return invalid();
    if (!more)
      return {
        snapshot: first.snapshot,
        freshness,
        items: items.filter((item) => item.status === 'ACTIVE'),
      };
    cursor = current.page.nextCursor;
    if (!cursor || cursors.has(cursor)) return invalid();
    cursors.add(cursor);
  }
  return invalid();
}

export function subscriptionIsValidityOnly(title: string | null): boolean {
  const normalized = title?.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
  return (
    normalized !== undefined &&
    ['дружба', 'дружба 2.0', 'дружба2.0', 'ра', 'академия'].includes(normalized)
  );
}

export function subscriptionValidity(value: string | null): string {
  return value && timestamp(value)
    ? `Действует до ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))}`
    : 'Срок действия не указан';
}

export function subscriptionRemaining(item: ActiveSubscription): string {
  const { amount, unit } = item.remaining;
  if (amount === null || unit === 'UNKNOWN') return 'Остаток не указан';
  if (unit === 'VISITS') return `Посещений осталось: ${amount}`;
  if (unit === 'MINUTES') return `Минут осталось: ${amount}`;
  if (unit === 'DAYS') return `Дней осталось: ${amount}`;
  return `Остаток: ${amount}`;
}
