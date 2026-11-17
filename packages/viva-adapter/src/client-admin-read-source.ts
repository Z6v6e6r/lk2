import { z } from 'zod';

/**
 * Read-only Viva Admin API source for the CUP operator view of one PadlHub user's Viva record.
 *
 * Endpoints were taken from the Viva cabinet (cabinet.vivacrm.ru) client card. Every call is a
 * GET with the server-side Viva credential; nothing here writes to Viva. Each method reads one
 * section from one provider endpoint (or one fixed fan-out for the summary) and returns a
 * provider-free projection: no Viva identifiers, no phone, email, names, bank or counterparty
 * data. Rows that name a different Viva client than the server-resolved one fail closed.
 */

export type VivaClientAdminReadErrorCode =
  | 'CLIENT_ADMIN_READ_DISABLED'
  | 'CLIENT_ADMIN_READ_UNAVAILABLE'
  | 'CLIENT_ADMIN_READ_TIMEOUT'
  | 'CLIENT_ADMIN_READ_NOT_FOUND'
  | 'CLIENT_ADMIN_READ_RESPONSE_INVALID'
  | 'CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT'
  | 'CLIENT_ADMIN_READ_CIRCUIT_OPEN';

export class VivaClientAdminReadError extends Error {
  public constructor(
    public readonly code: VivaClientAdminReadErrorCode,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'VivaClientAdminReadError';
  }
}

export type VivaClientAdminReadOperation =
  | 'client_card'
  | 'client_card_meta'
  | 'client_statistics'
  | 'client_bonus_balance'
  | 'client_subscriptions'
  | 'client_bookings'
  | 'client_transactions';

export interface VivaClientAdminReadMetric {
  readonly operation: VivaClientAdminReadOperation;
  readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
}

export interface VivaClientAdminReadSourceOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  /** Server-side Viva Admin API origin, for example https://api.vivacrm.ru. */
  readonly apiBaseUrl: string;
  /** Server-only Viva credential. It is never accepted from a client. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly onMetric?: (metric: VivaClientAdminReadMetric) => void;
}

export interface VivaClientAdminReadInput {
  readonly providerClientId: string;
  readonly correlationId: string;
}

export interface VivaClientAdminPageInput extends VivaClientAdminReadInput {
  /** Zero-based page. */
  readonly page: number;
  readonly size: number;
}

export interface VivaClientAdminPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly size: number;
  readonly totalElements: number | null;
  readonly hasNext: boolean;
  readonly checkedAt: string;
}

export interface VivaClientAdminConsent {
  readonly accepted: boolean;
  readonly acceptedAt: string | null;
}

export interface VivaClientAdminProfile {
  readonly registeredAt: string | null;
  readonly lastLoginAt: string | null;
  readonly lastVisitAt: string | null;
  /** Viva deposit balance in kopecks. */
  readonly depositKopecks: number;
  readonly categoryName: string | null;
  readonly source: string | null;
  readonly hasLoyaltyCard: boolean;
  readonly trialUsed: boolean;
  readonly blacklisted: boolean;
  readonly deleted: boolean;
  readonly hasFamily: boolean;
  readonly managerAssigned: boolean;
  readonly consents: {
    readonly offer: VivaClientAdminConsent;
    readonly personalData: VivaClientAdminConsent;
    readonly privacyPolicy: VivaClientAdminConsent;
    readonly marketing: VivaClientAdminConsent;
  };
  readonly checkedAt: string;
}

export interface VivaClientAdminSummary {
  readonly counters: {
    readonly todayBookings: number;
    readonly waitingTransactions: number;
    readonly activeSubscriptions: number;
    readonly unusedOneTimes: number;
    readonly giftCertificates: number;
    readonly activeGiftCertificates: number;
  };
  readonly statistics: {
    readonly totalBookings: number;
    readonly cancelledBookings: number;
    readonly noShowBookings: number;
    readonly attendancePercent: number;
    readonly salesRub: number;
    readonly refundsRub: number;
    readonly refundsCount: number;
    readonly debtRub: number;
    readonly unpaidDebtBookingsCount: number;
    readonly futureDebtRub: number;
    readonly futureDebtBookingsCount: number;
    readonly subscriptionsTurnoverRub: number;
    readonly totalSubscriptions: number;
    readonly activeSubscriptionUntil: string | null;
    readonly daysWithoutSubscription: number | null;
    readonly tenure: string | null;
  };
  readonly bonusPoints: {
    readonly active: number;
    readonly pending: number;
    readonly totalEarned: number;
  };
  readonly checkedAt: string;
}

export const VIVA_CLIENT_SUBSCRIPTION_GROUPS = ['CURRENT', 'ARCHIVED'] as const;
export type VivaClientSubscriptionGroup = (typeof VIVA_CLIENT_SUBSCRIPTION_GROUPS)[number];

export interface VivaClientAdminSubscription {
  readonly productName: string;
  readonly status: string;
  readonly variant: string | null;
  readonly appliesTo: string | null;
  readonly paymentMethod: string | null;
  readonly costKopecks: number | null;
  readonly purchasedAt: string | null;
  readonly activatedAt: string | null;
  readonly expiresOn: string | null;
  readonly holdUntil: string | null;
  readonly refundedAt: string | null;
  readonly visitsTotal: number | null;
  readonly visitsLeft: number | null;
  readonly freezeDaysTotal: number | null;
  readonly freezeDaysAvailable: number | null;
  readonly limitations: {
    readonly studios: readonly string[];
    readonly exerciseTypes: readonly string[];
    readonly directions: readonly string[];
  };
  readonly bookingsCount: number;
}

export const VIVA_CLIENT_BOOKING_PERIODS = ['TODAY', 'FUTURE', 'PAST'] as const;
export type VivaClientBookingPeriod = (typeof VIVA_CLIENT_BOOKING_PERIODS)[number];

export interface VivaClientAdminBooking {
  readonly startsAt: string;
  readonly duration: string | null;
  readonly studioName: string | null;
  readonly roomName: string | null;
  readonly directionName: string | null;
  readonly exerciseTypeName: string | null;
  readonly format: string | null;
  readonly paymentType: string | null;
  readonly trial: boolean;
  readonly cancelled: boolean;
  readonly cancelledAt: string | null;
  readonly visitConfirmed: boolean;
  readonly settlementStatus: string | null;
  readonly familyBooking: boolean;
  readonly createdAt: string | null;
}

export interface VivaClientAdminTransactionProduct {
  readonly name: string;
  readonly type: string | null;
  readonly costKopecks: number;
  readonly count: number;
  readonly discountKopecks: number;
  readonly refundStatus: string | null;
}

export interface VivaClientAdminTransaction {
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly status: string;
  readonly format: string | null;
  readonly paymentMethod: string | null;
  readonly sumKopecks: number;
  readonly toPayKopecks: number;
  readonly discountKopecks: number;
  readonly refundSumKopecks: number | null;
  readonly refundedAt: string | null;
  readonly studioName: string | null;
  readonly possibleDoublePayment: boolean;
  readonly products: readonly VivaClientAdminTransactionProduct[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VIVA_CLIENT_ADMIN_MAX_PAGE_SIZE = 50;

const text = z.string().max(1_000);
const nullableText = text.nullish();
const timestamp = z.string().trim().max(40).nullish();
const money = z.number().int().nullish();
const namedRef = z.object({ name: nullableText }).passthrough().nullish();
const clientRef = z
  .object({ id: z.string().max(64).optional() })
  .passthrough()
  .nullish();

const clientCardSchema = z
  .object({
    id: z.string().max(64),
    registrationDate: timestamp,
    lastLogin: timestamp,
    lastVisit: timestamp,
    deposit: money,
    source: nullableText,
    loyaltyCard: nullableText,
    clientCategory: namedRef,
    trialUsed: z.boolean().nullish(),
    blacklisted: z.boolean().nullish(),
    deleted: z.boolean().nullish(),
    hasFamily: z.boolean().nullish(),
    managerId: z.string().max(64).nullish(),
    offerAccepted: z.boolean().nullish(),
    offerAcceptedAt: timestamp,
    personalDataAccepted: z.boolean().nullish(),
    personalDataAcceptedAt: timestamp,
    privacyPolicyAccepted: z.boolean().nullish(),
    privacyPolicyAcceptedAt: timestamp,
    marketingConsent: z.boolean().nullish(),
    marketingConsentAt: timestamp,
  })
  .passthrough();

const count = z.number().int().nonnegative().nullish();
const cardMetaSchema = z
  .object({
    todayBookingsCount: count,
    waitingTransactionsCount: count,
    activeSubscriptionsCount: count,
    unusedOnetimesCount: count,
    giftCertificatesCount: count,
    activeGiftCertificatesCount: count,
  })
  .passthrough();

const amount = z.number().finite().nullish();
const statisticsSchema = z
  .object({
    totalBookings: count,
    cancelled: count,
    noShow: count,
    attendancePct: amount,
    salesRub: amount,
    refundsRub: amount,
    refundsCount: count,
    debtRub: amount,
    unpaidDebtBookingsCount: count,
    debtFutureRub: amount,
    futureDebtBookingsCount: count,
    subsTurnoverRub: amount,
    totalSubs: count,
    activeSubUntil: timestamp,
    daysWithoutSub: z.number().int().nullish(),
    withUs: nullableText,
  })
  .passthrough();

const bonusSchema = z
  .object({
    activePoints: amount,
    pendingPoints: amount,
    totalEarned: amount,
  })
  .passthrough();

const pageEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      content: z.array(item).max(VIVA_CLIENT_ADMIN_MAX_PAGE_SIZE),
      totalElements: z.number().int().nonnegative().optional(),
      totalPages: z.number().int().nonnegative().optional(),
      number: z.number().int().nonnegative().optional(),
      last: z.boolean().optional(),
    })
    .passthrough();

const subscriptionSchema = z
  .object({
    subscriptionId: z.string().max(64),
    client: clientRef,
    product: namedRef,
    status: z.string().trim().min(1).max(40),
    variant: nullableText,
    appliesTo: nullableText,
    paymentMethod: nullableText,
    cost: money,
    purchaseDate: timestamp,
    activationDate: timestamp,
    expirationDate: timestamp,
    holdUntil: timestamp,
    refundedAt: timestamp,
    visitsTotal: z.number().int().nullish(),
    visitsLeft: z.number().int().nullish(),
    totalFreezeDays: z.number().int().nullish(),
    availableFreezeDays: z.number().int().nullish(),
    availableStudios: z.array(namedRef).max(500).nullish(),
    availableTypes: z.array(namedRef).max(500).nullish(),
    availableDirections: z.array(namedRef).max(500).nullish(),
    bookings: z
      .array(z.object({ client: clientRef }).passthrough())
      .max(1_000)
      .nullish(),
  })
  .passthrough();

const bookingSchema = z
  .object({
    id: z.string().max(64),
    client: clientRef,
    exerciseDate: z.string().trim().min(10).max(40),
    exerciseDuration: nullableText,
    studio: namedRef,
    room: namedRef,
    exerciseDirection: namedRef,
    exerciseType: namedRef,
    exerciseTypeFormat: nullableText,
    detailedPaymentType: nullableText,
    paymentType: nullableText,
    isTrial: z.boolean().nullish(),
    isCancelled: z.boolean().nullish(),
    cancelled: z.boolean().nullish(),
    cancelledAt: timestamp,
    visitConfirmed: z.boolean().nullish(),
    bookingSettlement: z.object({ status: nullableText }).passthrough().nullish(),
    familyMember: z.unknown().optional(),
    createdAt: timestamp,
  })
  .passthrough();

const transactionSchema = z
  .object({
    id: z.string().max(64),
    client: clientRef,
    createDate: z.string().trim().min(10).max(40),
    paymentDate: timestamp,
    status: z.string().trim().min(1).max(40),
    transactionFormat: nullableText,
    paymentMethod: nullableText,
    sum: z.number().int(),
    toPay: z.number().int(),
    discount: money,
    refundSum: money,
    refundedAt: timestamp,
    paymentStudio: namedRef,
    possibleDoublePayment: z.boolean().nullish(),
    products: z
      .array(
        z
          .object({
            name: z.string().max(1_000),
            type: nullableText,
            cost: z.number().int(),
            count: z.number().int().nonnegative(),
            discount: money,
            refundStatus: nullableText,
          })
          .passthrough(),
      )
      .max(200),
  })
  .passthrough();

const SUBSCRIPTION_GROUP_STATUSES: Record<VivaClientSubscriptionGroup, readonly string[]> = {
  CURRENT: ['ACTIVE', 'NEW', 'HOLD'],
  ARCHIVED: ['EXPIRED', 'REFUNDED', 'NO_VISITS'],
};

function uuid(value: string): string | null {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function names(values: readonly (z.infer<typeof namedRef> | undefined)[] | null | undefined) {
  return (values ?? [])
    .map((value) => value?.name?.trim())
    .filter((value): value is string => Boolean(value));
}

function name(value: z.infer<typeof namedRef> | undefined): string | null {
  return value?.name?.trim() || null;
}

function consent(accepted: boolean | null | undefined, at: string | null | undefined) {
  return { accepted: accepted === true, acceptedAt: at ?? null };
}

export class VivaClientAdminReadSource {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaClientAdminReadSourceOptions) {
    if (
      (options.mode === 'sandbox' || options.mode === 'production') &&
      (!options.apiBaseUrl || !options.apiKey)
    ) {
      throw new Error('VIVA_CLIENT_ADMIN_READ_CREDENTIALS_REQUIRED');
    }
    const maxAttempts = options.maxAttempts ?? 2;
    if (maxAttempts < 1 || maxAttempts > 3) {
      throw new Error('Viva client admin read maxAttempts must be between 1 and 3');
    }
    const baseUrl = options.apiBaseUrl ? new URL(options.apiBaseUrl) : undefined;
    if (
      baseUrl &&
      ((baseUrl.protocol !== 'https:' &&
        baseUrl.hostname !== 'localhost' &&
        baseUrl.hostname !== '127.0.0.1') ||
        (baseUrl.pathname !== '/' && baseUrl.pathname !== ''))
    ) {
      throw new Error('VIVA_CLIENT_ADMIN_READ_BASE_URL_INVALID');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  public async readProfile(input: VivaClientAdminReadInput): Promise<VivaClientAdminProfile> {
    const clientId = this.clientId(input);
    const card = await this.get(
      'client_card',
      `/api/v1/clients/${clientId}`,
      {},
      input.correlationId,
      clientCardSchema,
    );
    if (uuid(card.id) !== clientId) {
      throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT');
    }
    return {
      registeredAt: card.registrationDate ?? null,
      lastLoginAt: card.lastLogin ?? null,
      lastVisitAt: card.lastVisit ?? null,
      depositKopecks: card.deposit ?? 0,
      categoryName: name(card.clientCategory),
      source: card.source?.trim() || null,
      hasLoyaltyCard: Boolean(card.loyaltyCard?.trim()),
      trialUsed: card.trialUsed === true,
      blacklisted: card.blacklisted === true,
      deleted: card.deleted === true,
      hasFamily: card.hasFamily === true,
      managerAssigned: Boolean(card.managerId),
      consents: {
        offer: consent(card.offerAccepted, card.offerAcceptedAt),
        personalData: consent(card.personalDataAccepted, card.personalDataAcceptedAt),
        privacyPolicy: consent(card.privacyPolicyAccepted, card.privacyPolicyAcceptedAt),
        marketing: consent(card.marketingConsent, card.marketingConsentAt),
      },
      checkedAt: this.checkedAt(),
    };
  }

  /** Card counters, statistics snapshot and bonus balance; any failed part fails the section. */
  public async readSummary(input: VivaClientAdminReadInput): Promise<VivaClientAdminSummary> {
    const clientId = this.clientId(input);
    const base = `/api/v1/clients/${clientId}`;
    const [meta, stats, bonus] = await Promise.all([
      this.get('client_card_meta', `${base}/card/meta`, {}, input.correlationId, cardMetaSchema),
      this.get(
        'client_statistics',
        `${base}/card/statistics-snapshot`,
        {},
        input.correlationId,
        statisticsSchema,
      ),
      this.get(
        'client_bonus_balance',
        `${base}/bonus-points/balance`,
        {},
        input.correlationId,
        bonusSchema,
      ),
    ]);
    return {
      counters: {
        todayBookings: meta.todayBookingsCount ?? 0,
        waitingTransactions: meta.waitingTransactionsCount ?? 0,
        activeSubscriptions: meta.activeSubscriptionsCount ?? 0,
        unusedOneTimes: meta.unusedOnetimesCount ?? 0,
        giftCertificates: meta.giftCertificatesCount ?? 0,
        activeGiftCertificates: meta.activeGiftCertificatesCount ?? 0,
      },
      statistics: {
        totalBookings: stats.totalBookings ?? 0,
        cancelledBookings: stats.cancelled ?? 0,
        noShowBookings: stats.noShow ?? 0,
        attendancePercent: stats.attendancePct ?? 0,
        salesRub: stats.salesRub ?? 0,
        refundsRub: stats.refundsRub ?? 0,
        refundsCount: stats.refundsCount ?? 0,
        debtRub: stats.debtRub ?? 0,
        unpaidDebtBookingsCount: stats.unpaidDebtBookingsCount ?? 0,
        futureDebtRub: stats.debtFutureRub ?? 0,
        futureDebtBookingsCount: stats.futureDebtBookingsCount ?? 0,
        subscriptionsTurnoverRub: stats.subsTurnoverRub ?? 0,
        totalSubscriptions: stats.totalSubs ?? 0,
        activeSubscriptionUntil: stats.activeSubUntil ?? null,
        daysWithoutSubscription: stats.daysWithoutSub ?? null,
        tenure: stats.withUs?.trim() || null,
      },
      bonusPoints: {
        active: bonus.activePoints ?? 0,
        pending: bonus.pendingPoints ?? 0,
        totalEarned: bonus.totalEarned ?? 0,
      },
      checkedAt: this.checkedAt(),
    };
  }

  public async listSubscriptions(
    input: VivaClientAdminPageInput & { readonly group: VivaClientSubscriptionGroup },
  ): Promise<VivaClientAdminPage<VivaClientAdminSubscription>> {
    const clientId = this.clientId(input);
    const body = await this.get(
      'client_subscriptions',
      `/api/v1/clients/${clientId}/subscriptions`,
      {
        statuses: SUBSCRIPTION_GROUP_STATUSES[input.group],
        sort: ['createdAt,desc'],
        ...this.pageParams(input),
      },
      input.correlationId,
      pageEnvelope(subscriptionSchema),
    );
    const items = body.content.map((row) => {
      this.assertOwner(row.client, clientId);
      for (const booking of row.bookings ?? []) this.assertOwner(booking.client, clientId);
      return {
        productName: name(row.product) ?? '',
        status: row.status.toUpperCase(),
        variant: row.variant ?? null,
        appliesTo: row.appliesTo ?? null,
        paymentMethod: row.paymentMethod ?? null,
        costKopecks: row.cost ?? null,
        purchasedAt: row.purchaseDate ?? null,
        activatedAt: row.activationDate ?? null,
        expiresOn: row.expirationDate ?? null,
        holdUntil: row.holdUntil ?? null,
        refundedAt: row.refundedAt ?? null,
        visitsTotal: row.visitsTotal ?? null,
        visitsLeft: row.visitsLeft ?? null,
        freezeDaysTotal: row.totalFreezeDays ?? null,
        freezeDaysAvailable: row.availableFreezeDays ?? null,
        limitations: {
          studios: names(row.availableStudios),
          exerciseTypes: names(row.availableTypes),
          directions: names(row.availableDirections),
        },
        bookingsCount: row.bookings?.length ?? 0,
      };
    });
    return this.page(input, body, items);
  }

  public async listBookings(
    input: VivaClientAdminPageInput & {
      readonly period: VivaClientBookingPeriod;
      readonly includeCancelled: boolean;
    },
  ): Promise<VivaClientAdminPage<VivaClientAdminBooking>> {
    const clientId = this.clientId(input);
    const body = await this.get(
      'client_bookings',
      `/api/v1/clients/${clientId}/bookings`,
      {
        timeFilter: [input.period],
        ...(input.includeCancelled ? { includeCanceled: ['true'] } : {}),
        ...this.pageParams(input),
      },
      input.correlationId,
      pageEnvelope(bookingSchema),
    );
    const items = body.content.map((row) => {
      this.assertOwner(row.client, clientId);
      return {
        startsAt: row.exerciseDate,
        duration: row.exerciseDuration ?? null,
        studioName: name(row.studio),
        roomName: name(row.room),
        directionName: name(row.exerciseDirection),
        exerciseTypeName: name(row.exerciseType),
        format: row.exerciseTypeFormat ?? null,
        paymentType: row.detailedPaymentType ?? row.paymentType ?? null,
        trial: row.isTrial === true,
        cancelled: row.isCancelled === true || row.cancelled === true,
        cancelledAt: row.cancelledAt ?? null,
        visitConfirmed: row.visitConfirmed === true,
        settlementStatus: row.bookingSettlement?.status ?? null,
        familyBooking: row.familyMember !== undefined && row.familyMember !== null,
        createdAt: row.createdAt ?? null,
      };
    });
    return this.page(input, body, items);
  }

  public async listTransactions(
    input: VivaClientAdminPageInput,
  ): Promise<VivaClientAdminPage<VivaClientAdminTransaction>> {
    const clientId = this.clientId(input);
    const body = await this.get(
      'client_transactions',
      `/api/v2/clients/${clientId}/transactions`,
      { sort: ['createDate,desc'], ...this.pageParams(input) },
      input.correlationId,
      pageEnvelope(transactionSchema),
    );
    const items = body.content.map((row) => {
      this.assertOwner(row.client, clientId);
      return {
        createdAt: row.createDate,
        paidAt: row.paymentDate ?? null,
        status: row.status.toUpperCase(),
        format: row.transactionFormat ?? null,
        paymentMethod: row.paymentMethod ?? null,
        sumKopecks: row.sum,
        toPayKopecks: row.toPay,
        discountKopecks: row.discount ?? 0,
        refundSumKopecks: row.refundSum ?? null,
        refundedAt: row.refundedAt ?? null,
        studioName: name(row.paymentStudio),
        possibleDoublePayment: row.possibleDoublePayment === true,
        products: row.products.map((product) => ({
          name: product.name.trim(),
          type: product.type ?? null,
          costKopecks: product.cost,
          count: product.count,
          discountKopecks: product.discount ?? 0,
          refundStatus: product.refundStatus ?? null,
        })),
      };
    });
    return this.page(input, body, items);
  }

  private clientId(input: VivaClientAdminReadInput): string {
    if (this.options.mode === 'disabled' || this.options.mode === 'mock') {
      throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_DISABLED');
    }
    const clientId = uuid(input.providerClientId);
    if (!clientId) throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_RESPONSE_INVALID');
    return clientId;
  }

  private assertOwner(ref: z.infer<typeof clientRef> | undefined, clientId: string): void {
    if (ref?.id === undefined) return;
    if (uuid(ref.id) !== clientId) {
      throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT');
    }
  }

  private pageParams(input: VivaClientAdminPageInput): Record<string, readonly string[]> {
    if (
      !Number.isInteger(input.page) ||
      input.page < 0 ||
      input.page > 1_000 ||
      !Number.isInteger(input.size) ||
      input.size < 1 ||
      input.size > VIVA_CLIENT_ADMIN_MAX_PAGE_SIZE
    ) {
      throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_RESPONSE_INVALID');
    }
    return { page: [String(input.page)], size: [String(input.size)] };
  }

  private page<T>(
    input: VivaClientAdminPageInput,
    body: {
      readonly content: readonly unknown[];
      readonly totalElements?: number | undefined;
      readonly totalPages?: number | undefined;
      readonly number?: number | undefined;
      readonly last?: boolean | undefined;
    },
    items: readonly T[],
  ): VivaClientAdminPage<T> {
    if (body.number !== undefined && body.number !== input.page) {
      throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_RESPONSE_INVALID');
    }
    const hasNext =
      body.last !== undefined
        ? !body.last
        : body.totalPages !== undefined
          ? input.page + 1 < body.totalPages
          : items.length >= input.size;
    return {
      items,
      page: input.page,
      size: input.size,
      totalElements: body.totalElements ?? null,
      hasNext,
      checkedAt: this.checkedAt(),
    };
  }

  private checkedAt(): string {
    return new Date(this.now()).toISOString();
  }

  private emit(metric: VivaClientAdminReadMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change read behavior.
    }
  }

  private ensureCircuitClosed(operation: VivaClientAdminReadOperation): void {
    if (this.circuitOpenedAt === undefined) return;
    if (this.now() - this.circuitOpenedAt >= (this.options.circuitResetMs ?? 30_000)) {
      this.circuitOpenedAt = undefined;
      this.consecutiveFailures = 0;
      return;
    }
    this.emit({ operation, outcome: 'circuit_open', attempt: 0, durationMs: 0 });
    throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_CIRCUIT_OPEN', true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private async get<T extends z.ZodTypeAny>(
    operation: VivaClientAdminReadOperation,
    path: string,
    query: Record<string, readonly string[]>,
    correlationId: string,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = new URL(path, this.options.apiBaseUrl);
    for (const [key, values] of Object.entries(query)) {
      for (const value of values) url.searchParams.append(key, value);
    }
    const maxAttempts = this.options.maxAttempts ?? 2;
    let lastError: VivaClientAdminReadError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.ensureCircuitClosed(operation);
      const startedAt = this.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
            'X-Correlation-ID': correlationId,
          },
        });
        if (response.status === 404) {
          throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_NOT_FOUND', false, 404);
        }
        if (!response.ok) {
          throw new VivaClientAdminReadError(
            'CLIENT_ADMIN_READ_UNAVAILABLE',
            isRetryableStatus(response.status),
            response.status,
          );
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_RESPONSE_INVALID');
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          throw new VivaClientAdminReadError('CLIENT_ADMIN_READ_RESPONSE_INVALID');
        }
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation,
          outcome: 'success',
          attempt,
          status: response.status,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return parsed.data;
      } catch (error) {
        const failure =
          error instanceof VivaClientAdminReadError
            ? error
            : error instanceof Error && error.name === 'AbortError'
              ? new VivaClientAdminReadError('CLIENT_ADMIN_READ_TIMEOUT', true)
              : new VivaClientAdminReadError('CLIENT_ADMIN_READ_UNAVAILABLE', true);
        lastError = failure;
        if (failure.code !== 'CLIENT_ADMIN_READ_NOT_FOUND') this.recordFailure();
        this.emit({
          operation,
          outcome: failure.retryable && attempt < maxAttempts ? 'retry' : 'failure',
          attempt,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          durationMs: Math.max(0, this.now() - startedAt),
        });
        if (!failure.retryable || attempt === maxAttempts) throw failure;
        await this.sleep(Math.min((this.options.retryBaseDelayMs ?? 100) * attempt, 1_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new VivaClientAdminReadError('CLIENT_ADMIN_READ_UNAVAILABLE', true);
  }
}
