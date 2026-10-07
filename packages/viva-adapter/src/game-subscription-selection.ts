import { createHash } from 'node:crypto';
import { z } from 'zod';

const HUB_PRODUCT = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const POST_ENFORCEMENT_FROM = '2026-09-01';
const record = z
  .object({
    subscriptionId: z.string().uuid(),
    status: z.string(),
    variant: z.string(),
    visitsLeft: z.number().int().nonnegative(),
    expirationDate: z.string().date(),
    activationDate: z.string(),
    purchaseDate: z.string().optional(),
    purchaseAt: z.string().optional(),
    clientId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
    product: z.object({ id: z.string().uuid() }).optional(),
    holdUntil: z.string().nullish(),
    frozenUntil: z.string().nullish(),
    isFrozen: z.boolean().optional(),
  })
  .passthrough();

export class GameSubscriptionSelectionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
  }
}

// Same calendar semantics as LK1 gateway_hooks.normalizePurchaseDateMoscow.
// This only selects the handed scenario; it never computes an entitlement or tariff.
function purchaseDay(text: string): string | null {
  const value = text.trim();
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if (!day) return null;
  const parsedDay = new Date(day);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day)
    return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/.exec(value);
  return match &&
    Number(match[2] ?? 0) <= 23 &&
    Number(match[3] ?? 0) <= 59 &&
    Number(match[4] ?? 0) <= 59
    ? day
    : null;
}
// Ported from the frozen LK1 gateway lifecycle parser; microseconds round activation upward.
function lifecycleInstant(value: string): number | null {
  if (!purchaseDay(value.slice(0, 10))) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(value + 'T00:00:00.000+03:00');
  const timestamp =
    /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.(\d{1,6}))?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
      value,
    );
  if (!timestamp) return null;
  const milliseconds = value.replace(/(\.\d{3})\d+/, '$1');
  const instant = Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(milliseconds) ? milliseconds : milliseconds + '+03:00',
  );
  const ceiling = /[1-9]/.test((timestamp[1] ?? '').slice(3)) ? 1 : 0;
  return Number.isFinite(instant) ? instant + ceiling : null;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function productIds(row: Record<string, unknown>): readonly unknown[] {
  const nested = (value: unknown) => {
    const record = object(value);
    return record ? [record.id, record.uuid, record.productId] : [];
  };
  const subscription = object(row.subscription);
  return [
    row.productId,
    row.subscriptionProductId,
    row.templateId,
    ...nested(row.product),
    ...nested(row.template),
    subscription?.productId,
    subscription?.subscriptionProductId,
    ...nested(subscription?.product),
    ...nested(subscription?.template),
  ].filter(
    (value) => value !== undefined && value !== null && (typeof value !== 'string' || value.trim()),
  );
}
/** Provider reads stay inside @phub/viva-adapter. No system key, provider write or local tariff. */
export function createOwnedHubSubscriptionReader(options: {
  readonly apiBaseUrl: string;
  readonly providerTenantKey: string;
  readonly fetchImplementation?: typeof fetch;
}) {
  const base = new URL(options.apiBaseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    options.providerTenantKey !== 'iSkq6G'
  )
    throw new GameSubscriptionSelectionError('JOIN_SELECTION_ENDPOINT_INVALID');
  const transport = options.fetchImplementation ?? fetch;
  let failures = 0,
    retryAfter = 0;
  return async (input: {
    readonly accessToken: string;
    readonly providerClientId: string;
    readonly providerSubscriptionId: string;
    readonly startsAt: string;
    readonly signal: AbortSignal;
    readonly correlationId: string;
  }): Promise<{ readonly fingerprint: string }> => {
    if (Date.now() < retryAfter)
      throw new GameSubscriptionSelectionError('JOIN_SELECTION_CIRCUIT_OPEN');
    const get = async (path: string): Promise<unknown> => {
      const url = new URL(
        `${base.href.replace(/\/$/, '')}/v1/${options.providerTenantKey}/${path}`,
      );
      const response = await transport(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'X-Correlation-ID': input.correlationId,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_PROVIDER_UNAVAILABLE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new GameSubscriptionSelectionError('JOIN_SELECTION_RESPONSE_INVALID');
      let body = '',
        bytes = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1_048_576) {
            await reader.cancel();
            throw new GameSubscriptionSelectionError('JOIN_SELECTION_RESPONSE_INVALID');
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_RESPONSE_INVALID');
      }
    };
    try {
      const profile = z.object({ id: z.string().uuid() }).safeParse(await get('profile'));
      if (!profile.success || profile.data.id !== input.providerClientId)
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_FOREIGN_ACTOR');
      const parsed = z
        .object({
          content: z.array(z.object({ subscriptionId: z.string().uuid() }).passthrough()).max(1000),
          totalElements: z.number().int().nonnegative(),
          number: z.literal(0),
          totalPages: z.union([z.literal(0), z.literal(1)]),
          last: z.literal(true),
          hasNext: z.literal(false),
        })
        .safeParse(await get('subscriptions?includeFinished=true&page=0&size=1000'));
      if (
        !parsed.success ||
        parsed.data.totalElements !== parsed.data.content.length ||
        new Set(parsed.data.content.map((row) => row.subscriptionId)).size !==
          parsed.data.content.length
      ) {
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_SUBSCRIPTIONS_INCOMPLETE');
      }
      const matches = parsed.data.content.filter(
        (row) => row.subscriptionId === input.providerSubscriptionId,
      );
      if (matches.length !== 1)
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_INSTANCE_UNAVAILABLE');
      const checked = record.safeParse(matches[0]);
      if (!checked.success)
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_VARIANT_UNAVAILABLE');
      const row = checked.data;
      const products = [...new Set(productIds(row))];
      const purchases = [row.purchaseDate, row.purchaseAt]
        .filter(
          (value): value is string =>
            value !== undefined && value !== null && Boolean(value.trim()),
        )
        .map(purchaseDay);
      const dates = [...new Set(purchases)];
      const eventDay = input.startsAt.slice(0, 10);
      const eventEnd = Date.parse(input.startsAt) + 90 * 60_000;
      const expiryEnd = Date.parse(row.expirationDate + 'T23:59:59.999+03:00');
      const activation = lifecycleInstant(row.activationDate);
      const today = purchaseDay(new Date().toISOString())!;
      const ownerAliases = [row.clientId, object(row.client)?.id].filter(
        (value) => value !== undefined && value !== null,
      );
      const instanceAliases = [row.id, row.clientSubscriptionId].filter(
        (value) => value !== undefined && value !== null,
      );
      if (instanceAliases.some((value) => value !== row.subscriptionId))
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_INSTANCE_AMBIGUOUS');
      if (ownerAliases.some((value) => value !== input.providerClientId))
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_FOREIGN_INSTANCE');
      if (
        products.length !== 1 ||
        products[0] !== HUB_PRODUCT ||
        dates.length !== 1 ||
        !dates[0] ||
        dates[0] < POST_ENFORCEMENT_FROM ||
        row.status !== 'ACTIVE' ||
        row.variant !== 'BY_VISITS' ||
        row.visitsLeft < 1 ||
        activation === null ||
        activation > Date.now() ||
        activation > Date.parse(input.startsAt) ||
        row.expirationDate < today ||
        row.expirationDate < eventDay ||
        expiryEnd < eventEnd ||
        row.holdUntil ||
        row.frozenUntil ||
        row.isFrozen
      ) {
        throw new GameSubscriptionSelectionError('JOIN_SELECTION_VARIANT_UNAVAILABLE');
      }
      failures = 0;
      return { fingerprint: createHash('sha256').update(JSON.stringify(row)).digest('hex') };
    } catch (error) {
      if (
        !(error instanceof GameSubscriptionSelectionError) ||
        error.code === 'JOIN_SELECTION_PROVIDER_UNAVAILABLE'
      ) {
        failures += 1;
        if (failures >= 3) retryAfter = Date.now() + 30_000;
      }
      throw error;
    }
  };
}
