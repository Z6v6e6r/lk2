import { z } from 'zod';

const id = z.union([z.string().min(1).max(200), z.number().int().nonnegative().transform(String)]);
const subscription = z
  .object({
    subscriptionId: id,
    status: z.string().min(1),
    expirationDate: z.string().date().nullish(),
    holdUntil: z.string().nullish(),
    frozenUntil: z.string().nullish(),
    isFrozen: z.boolean().optional(),
    activationDate: z.string().nullish(),
  })
  .passthrough();
export interface VivaNotificationFact {
  readonly key: string;
  readonly trigger: 'SUBSCRIPTION_ENDS' | 'BIRTHDAY' | 'TRAINING_ATTENDED';
  readonly anchor: string;
  readonly valid: boolean;
  readonly serviceTitle: string;
  readonly scope: string;
}
export interface VivaAttendanceFact extends VivaNotificationFact {
  readonly clientId: string;
}
export class VivaNotificationSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
// LK1 treats expirationDate as an inclusive Moscow calendar date. No guessed UTC end-of-day.
export function vivaSubscriptionDeadline(date: string): string {
  const parsed = z.string().date().parse(date);
  const next = new Date(Date.parse(parsed + 'T00:00:00+03:00') + 86_400_000);
  return next.toISOString();
}
export function normalizeVivaSubscription(
  raw: unknown,
  now: Date = new Date(),
): VivaNotificationFact {
  const value = subscription.parse(raw);
  const valid =
    (value.status === 'ACTIVE' ||
      (value.status === 'EXPIRED' &&
        Boolean(value.expirationDate) &&
        Date.parse(vivaSubscriptionDeadline(value.expirationDate!)) <= now.getTime())) &&
    Boolean(value.activationDate) &&
    !value.isFrozen &&
    !value.holdUntil &&
    !value.frozenUntil &&
    Boolean(value.expirationDate);
  return {
    key: `subscription:${value.subscriptionId}`,
    trigger: 'SUBSCRIPTION_ENDS',
    anchor: value.expirationDate
      ? vivaSubscriptionDeadline(value.expirationDate)
      : '1970-01-01T00:00:00Z',
    valid,
    serviceTitle: 'Абонемент',
    scope: 'SUBSCRIPTIONS',
  };
}
export function vivaBirthdayFacts(raw: unknown, now: Date): VivaNotificationFact[] {
  const date = z.string().date().nullable().parse(raw);
  if (!date) return [];
  const monthDay = date.slice(5);
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric' }).format(now),
  );
  return [year, year + 1].flatMap((y) => {
    // Explicit policy: February 29 is celebrated only in leap years.
    const day = `${y}-${monthDay}`;
    if (!z.string().date().safeParse(day).success) return [];
    return [
      {
        key: `birthday:${y}`,
        trigger: 'BIRTHDAY' as const,
        anchor: `${day}T10:00:00+03:00`,
        valid: true,
        serviceTitle: 'День рождения',
        scope: 'BIRTHDAY',
      },
    ];
  });
}
const record = (raw: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(raw);
const value = (r: Record<string, unknown>, keys: string[]): unknown =>
  keys.map((k) => r[k]).find((x) => x !== undefined && x !== null);
const scalar = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const explicit = (v: unknown): boolean => v === true || v === 1 || v === 'true';
/** Strict confirmed visit, never merely a completed exercise or a booked participant. */
export function normalizeVivaAttendance(
  exerciseRaw: unknown,
  bookingRaw: unknown,
  now: Date,
  allowedTypeIds: readonly string[],
  allowedStudioIds: readonly string[],
): VivaAttendanceFact | null {
  const e = record(exerciseRaw),
    b = record(bookingRaw);
  const type = typeof e.type === 'object' && e.type ? record(e.type) : {};
  const studio = typeof e.studio === 'object' && e.studio ? record(e.studio) : {};
  const typeId = scalar(value(e, ['typeId', 'exerciseTypeId']) ?? type.id ?? '');
  const studioId = scalar(value(e, ['studioId', 'stationId']) ?? studio.id ?? '');
  if (!allowedTypeIds.includes(typeId) || !allowedStudioIds.includes(studioId)) return null;
  const exerciseId = id.parse(value(e, ['id', 'exerciseId']));
  const end = z.iso.datetime({ offset: true }).parse(value(e, ['timeToIso', 'timeTo', 'endsAt']));
  const cancelled =
    explicit(e.cancelled) ||
    explicit(e.isCancelled) ||
    /CANCEL|ARCHIV|DELETE/.test(scalar(e.status).toUpperCase());
  const client = record(value(b, ['client', 'customer', 'user', 'member', 'participant']) ?? {});
  const clientId = id.safeParse(
    value(client, ['id', 'clientId', 'userId', 'uuid']) ??
      value(b, ['clientId', 'userId', 'memberId']),
  );
  if (!clientId.success) return null;
  const statuses = [
    'status',
    'state',
    'registrationStatus',
    'bookingStatus',
    'paymentStatus',
    'sourceStatus',
  ].map((k) => scalar(b[k]).toUpperCase());
  const excluded =
    cancelled ||
    explicit(b.cancelled) ||
    explicit(b.isCancelled) ||
    statuses.some((s) =>
      /CANCEL|REFUND|WAIT|PENDING|UNPAID|FAIL|NO.?SHOW|ABSENT|ARCHIV|DELETE/.test(s),
    );
  const denied =
    b.visitConfirmed === false || b.visitConfirmed === 0 || b.visitConfirmed === 'false';
  const confirmed =
    !denied &&
    (['visitConfirmed', 'visited', 'attended', 'checkedIn', 'checkIn', 'present'].some((k) =>
      explicit(b[k]),
    ) ||
      statuses.some((s) => /^(VISIT_CONFIRMED|ATTENDED|VISITED|CHECKED_IN|PRESENT)$/.test(s)));
  return {
    key: `attendance:${exerciseId}:${clientId.data}`,
    trigger: 'TRAINING_ATTENDED',
    anchor: end,
    valid: !excluded && confirmed && Date.parse(end) <= now.getTime(),
    serviceTitle: 'Тренировка',
    scope: `ATTENDANCE:${exerciseId}`,
    clientId: clientId.data,
  };
}

interface ReadBudget {
  requests: number;
  bytes: number;
  rows: number;
  deadline: number;
}
const readBudget = (): ReadBudget => ({
  requests: 0,
  bytes: 0,
  rows: 0,
  deadline: Date.now() + 30_000,
});
const checkBudget = (budget: ReadBudget): void => {
  if (
    budget.requests > 32 ||
    budget.bytes > 8_388_608 ||
    budget.rows > 2000 ||
    Date.now() >= budget.deadline
  )
    throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SCAN_BUDGET_EXCEEDED');
};
/** Notification-only reads. Fixed Viva origins, no user-selected source or URL, bounded complete pages. */
export class VivaNotificationSource {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      providerTenantKey: string;
      timeoutMs: number;
      fetchImplementation?: typeof fetch;
      now?: () => number;
      onOutcome?: (code: string) => void;
    },
  ) {
    if (
      options.providerTenantKey !== 'iSkq6G' ||
      options.timeoutMs < 500 ||
      options.timeoutMs > 30_000
    )
      throw new VivaNotificationSourceError('VIVA_NOTIFICATION_CONFIGURATION_INVALID');
  }
  private async get(
    path: string,
    accessToken: string,
    correlationId: string,
    admin = false,
    budget: ReadBudget = readBudget(),
  ): Promise<unknown> {
    const now = this.options.now ?? Date.now;
    if (this.openUntil > now())
      throw new VivaNotificationSourceError('VIVA_NOTIFICATION_CIRCUIT_OPEN');
    for (let attempt = 0; attempt < 2; attempt++) {
      budget.requests++;
      checkBudget(budget);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(this.options.timeoutMs, Math.max(1, budget.deadline - Date.now())),
      );
      try {
        const url = new URL(
          path,
          admin
            ? 'https://api.vivacrm.ru/api/v1/'
            : `https://api.vivacrm.ru/end-user/api/v1/${encodeURIComponent(this.options.providerTenantKey)}/`,
        );
        const response = await (this.options.fetchImplementation ?? fetch)(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${accessToken}`, 'X-Correlation-ID': correlationId },
        });
        if (!response.ok) {
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
          throw new VivaNotificationSourceError('VIVA_NOTIFICATION_READ_FAILED');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new VivaNotificationSourceError('VIVA_NOTIFICATION_RESPONSE_INVALID');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          budget.bytes += next.value.length;
          checkBudget(budget);
          if (size > 4_194_304) {
            await reader.cancel();
            throw new VivaNotificationSourceError('VIVA_NOTIFICATION_RESPONSE_TOO_LARGE');
          }
          chunks.push(next.value);
        }
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        const result: unknown = JSON.parse(text);
        this.failures = 0;
        try {
          this.options.onOutcome?.('READ_OK');
        } catch {
          /* Metrics cannot change source truth. */
        }
        return result;
      } catch (error) {
        controller.abort();
        if (
          error instanceof VivaNotificationSourceError &&
          error.code === 'VIVA_NOTIFICATION_SCAN_BUDGET_EXCEEDED'
        )
          throw error;
        if (attempt === 1) {
          if (++this.failures >= 3) this.openUntil = now() + 30_000;
          try {
            this.options.onOutcome?.('READ_FAILED');
          } catch {
            /* Metrics cannot change source truth. */
          }
          throw new VivaNotificationSourceError('VIVA_NOTIFICATION_READ_FAILED');
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new VivaNotificationSourceError('VIVA_NOTIFICATION_READ_FAILED');
  }
  private async pages(
    path: string,
    token: string,
    correlationId: string,
    admin = false,
    budget: ReadBudget = readBudget(),
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    let expected: number | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 50; page++) {
      const raw = await this.get(
        `${path}${path.includes('?') ? '&' : '?'}page=${page}&size=500`,
        token,
        correlationId,
        admin,
        budget,
      );
      const p = z
        .object({
          content: z.array(z.unknown()).max(500),
          number: z.number().int().nonnegative(),
          last: z.boolean(),
          totalElements: z.number().int().nonnegative(),
          totalPages: z.number().int().nonnegative(),
        })
        .parse(raw);
      budget.rows += p.content.length;
      checkBudget(budget);
      if (
        p.number !== page ||
        p.totalPages > 50 ||
        (p.totalPages < 1 && p.totalElements !== 0) ||
        (expected !== undefined && expected !== p.totalElements)
      )
        throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SNAPSHOT_INCOMPLETE');
      expected = p.totalElements;
      for (const row of p.content) {
        const signature = JSON.stringify(row);
        if (seen.has(signature))
          throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SNAPSHOT_DUPLICATE');
        seen.add(signature);
        all.push(row);
      }
      if (p.last) {
        if (all.length !== p.totalElements || page !== Math.max(0, p.totalPages - 1))
          throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SNAPSHOT_INCOMPLETE');
        return all;
      }
      if (!p.content.length) break;
    }
    throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SNAPSHOT_INCOMPLETE');
  }
  async readOwned(input: {
    accessToken: string;
    correlationId: string;
    now: Date;
  }): Promise<{ externalClientId: string; facts: VivaNotificationFact[] }> {
    const budget = readBudget();
    const profile = z
      .object({
        id: id.optional(),
        clientId: id.optional(),
        birthDate: z.string().date().nullable(),
      })
      .passthrough()
      .parse(await this.get('profile', input.accessToken, input.correlationId, false, budget));
    const externalClientId = id.parse(profile.clientId ?? profile.id);
    const rows = await this.pages(
      'subscriptions?includeFinished=true',
      input.accessToken,
      input.correlationId,
      false,
      budget,
    );
    const facts = rows.map((row) => normalizeVivaSubscription(row, input.now));
    if (new Set(facts.map((f) => f.key)).size !== facts.length)
      throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SNAPSHOT_DUPLICATE');
    return {
      externalClientId,
      facts: [...facts, ...vivaBirthdayFacts(profile.birthDate, input.now)],
    };
  }
  async readAttendance(input: {
    accessToken: string;
    correlationId: string;
    date: string;
    now: Date;
    allowedTypeIds: readonly string[];
    allowedStudioIds: readonly string[];
  }): Promise<{ facts: VivaAttendanceFact[]; scopes: string[] }> {
    const budget = readBudget();
    z.string().date().parse(input.date);
    const exercises = await this.pages(
      `exercises?date=${input.date}`,
      input.accessToken,
      input.correlationId,
      true,
      budget,
    );
    if (exercises.length > 30)
      throw new VivaNotificationSourceError('VIVA_NOTIFICATION_SCAN_BUDGET_EXCEEDED');
    const facts: VivaAttendanceFact[] = [];
    const scopes: string[] = [];
    for (const raw of exercises) {
      const e = record(raw);
      const exerciseId = id.parse(value(e, ['id', 'exerciseId']));
      const type = typeof e.type === 'object' && e.type ? record(e.type) : {};
      const studio = typeof e.studio === 'object' && e.studio ? record(e.studio) : {};
      if (
        !input.allowedTypeIds.includes(
          scalar(value(e, ['typeId', 'exerciseTypeId']) ?? type.id ?? ''),
        ) ||
        !input.allowedStudioIds.includes(
          scalar(value(e, ['studioId', 'stationId']) ?? studio.id ?? ''),
        )
      )
        continue;
      const end = z.iso
        .datetime({ offset: true })
        .parse(value(e, ['timeToIso', 'timeTo', 'endsAt']));
      if (Date.parse(end) > input.now.getTime()) continue;
      const bookings = await this.pages(
        `exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&sort=visitConfirmed,asc`,
        input.accessToken,
        input.correlationId,
        true,
        budget,
      );
      const normalized = bookings
        .map((b) =>
          normalizeVivaAttendance(e, b, input.now, input.allowedTypeIds, input.allowedStudioIds),
        )
        .filter((f): f is VivaAttendanceFact => f !== null);
      scopes.push(`ATTENDANCE:${exerciseId}`);
      facts.push(...normalized);
    }
    return { facts, scopes };
  }
}
