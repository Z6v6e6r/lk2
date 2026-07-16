import { z } from 'zod';

import type { UserProfile, UserUpcomingBookings } from '@phub/api-sdk';
import {
  DIRECT_VIVA_CONTRACT_READY_OPERATIONS,
  DIRECT_VIVA_READ_OPERATIONS,
  type ClientRoutingPlan,
  type DirectVivaReadOperation,
} from '@phub/domain';

export interface DelegatedAvailableSlot {
  readonly id: string;
  readonly stationId: string;
  readonly spaceId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly trustLevel: 'unverified';
}

const delegatedSlotSchema = z.object({
  id: z.union([z.string(), z.number()]),
  station_id: z.union([z.string(), z.number()]),
  space_id: z.union([z.string(), z.number()]),
  starts_at: z.string(),
  ends_at: z.string(),
});

export function normalizeDelegatedAvailability(input: unknown): readonly DelegatedAvailableSlot[] {
  return z
    .array(delegatedSlotSchema)
    .parse(input)
    .map((slot) => ({
      id: String(slot.id),
      stationId: String(slot.station_id),
      spaceId: String(slot.space_id),
      startsAt: slot.starts_at,
      endsAt: slot.ends_at,
      trustLevel: 'unverified',
    }));
}

export const DIRECT_VIVA_CLIENT_RULES = {
  readOnly: true,
  acceptsSystemApiKey: false,
  trustedForCommands: false,
} as const;

const profileCustomFieldSchema = z.object({
  id: z.string().uuid(),
  value: z.array(z.string()),
});

const vivaProfileSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullish(),
  middleName: z.string().nullish(),
  lastName: z.string().nullish(),
  phone: z.string().nullish(),
  deposit: z.number().int(),
  customFields: z.array(profileCustomFieldSchema),
});

const normalizedProfileSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1).max(200),
  firstName: z.string().max(100).nullish(),
  avatarUrl: z.string().url().nullish(),
  phoneLast4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  balanceMinor: z.number().int(),
  currency: z.literal('RUB'),
  level: z.object({
    label: z.string().min(1).max(20),
    value: z.number().min(0).max(10),
    assessmentRequired: z.boolean(),
  }),
});

const normalizedUpcomingBookingsSchema = z
  .object({
    version: z.string().min(1).max(100),
    generatedAt: z.string().datetime({ offset: true }),
    staleAt: z.string().datetime({ offset: true }),
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            kind: z.enum(['game', 'training', 'tournament']),
            title: z.string().min(1).max(160),
            startsAt: z.string().datetime({ offset: true }),
            venue: z.string().min(1).max(160),
            status: z.enum(['confirmed', 'waitlist', 'payment_required']),
            route: z.string().startsWith('/'),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

const PROFILE_LEVEL_FIELD_IDS = [
  'eabfe27b-3f72-4496-9185-1a2ec6e6465e',
  '9018d922-6427-41a6-9ac0-4a2c0440eb8a',
  'f9790818-25fd-4b73-a781-79c02720727d',
] as const;

function profileLevelLabel(value: number): string {
  if (value < 2) return 'D';
  if (value < 3) return 'D+';
  if (value < 3.5) return 'C';
  if (value < 4) return 'C+';
  if (value < 4.7) return 'B';
  if (value < 5.5) return 'B+';
  return 'A';
}

function normalizeProfileLevel(fields: z.infer<typeof profileCustomFieldSchema>[]) {
  for (const fieldId of PROFILE_LEVEL_FIELD_IDS) {
    const raw = fields.find((field) => field.id === fieldId)?.value[0];
    if (!raw) continue;
    const value = Number(raw.replace(',', '.'));
    if (Number.isFinite(value) && value >= 0 && value <= 10) {
      return { label: profileLevelLabel(value), value, assessmentRequired: false };
    }
  }
  return { label: 'D', value: 0, assessmentRequired: true };
}

/** Normalizes the canonical PadlHub response before it reaches the profile UI. */
export function normalizePadlHubUserProfile(input: unknown): UserProfile {
  return normalizedProfileSchema.parse(input) as UserProfile;
}

/**
 * Validates that the bookings boundary contains only stable PadlHub UUIDs.
 * A Viva normalizer is intentionally absent until the provider can return
 * PadlHub identifiers without exposing external ids to the browser.
 */
export function normalizePadlHubUpcomingBookings(input: unknown): UserUpcomingBookings {
  return normalizedUpcomingBookingsSchema.parse(input);
}

/**
 * Drops Viva's profile identifier and binds the response to the authenticated
 * PadlHub user UUID supplied by the already-verified PadlHub session.
 */
export function normalizeVivaUserProfile(input: unknown, padlHubUserId: string): UserProfile {
  const profile = vivaProfileSchema.parse(input);
  const userId = z.string().uuid().parse(padlHubUserId);
  const displayName = [profile.firstName, profile.middleName, profile.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);
  const phoneDigits = profile.phone?.replace(/\D/g, '') ?? '';
  return normalizedProfileSchema.parse({
    userId,
    displayName: displayName || 'Игрок ПадлХАБ',
    ...(profile.firstName?.trim() ? { firstName: profile.firstName.trim().slice(0, 100) } : {}),
    ...(phoneDigits.length >= 4 ? { phoneLast4: phoneDigits.slice(-4) } : {}),
    balanceMinor: profile.deposit,
    currency: 'RUB',
    level: normalizeProfileLevel(profile.customFields),
  }) as UserProfile;
}

const routingOperationSchema = z.object({
  operation: z.enum(DIRECT_VIVA_READ_OPERATIONS),
  transport: z.enum(['PADLHUB_API', 'DIRECT_VIVA']),
  fallback: z.enum(['PADLHUB_API', 'UNAVAILABLE']),
});

const routingPlanSchema = z
  .object({
    revision: z.string().regex(/^[0-9]+$/),
    mode: z.enum(['PADLHUB_ONLY', 'MIXED_END_USER_READS']),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    operations: z.array(routingOperationSchema).length(DIRECT_VIVA_READ_OPERATIONS.length),
    directViva: z
      .object({
        apiBaseUrl: z.string().url(),
        providerTenantKey: z.string().min(1).max(128),
        accessTokenPath: z.literal('/auth/viva/access'),
        allowedRequestHeaders: z.tuple([z.literal('Authorization')]),
      })
      .optional(),
  })
  .superRefine((plan, context) => {
    for (const operation of DIRECT_VIVA_READ_OPERATIONS) {
      if (plan.operations.filter((entry) => entry.operation === operation).length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: `Routing operation ${operation} must occur exactly once`,
        });
      }
    }
    if (plan.mode === 'MIXED_END_USER_READS' && !plan.directViva) {
      context.addIssue({
        code: 'custom',
        path: ['directViva'],
        message: 'Mixed routing plan requires direct Viva transport metadata',
      });
    }
  });

const profileRequestSchema = z.object({ operation: z.literal('profile.read') }).strict();
const bookingsRequestSchema = z
  .object({
    operation: z.literal('bookings.read'),
    page: z.number().int().min(0).max(1000).default(0),
    size: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const bookingDetailsRequestSchema = z
  .object({
    operation: z.literal('bookings.details.read'),
    bookingIds: z.array(z.string().min(1).max(128)).min(1).max(50),
  })
  .strict();
const subscriptionsRequestSchema = z
  .object({
    operation: z.literal('subscriptions.read'),
    includeFinished: z.boolean().default(false),
    page: z.number().int().min(0).max(1000).default(0),
    size: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const scheduleRequestSchema = z
  .object({
    operation: z.literal('schedule.read'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type DirectVivaReadRequest =
  | z.input<typeof profileRequestSchema>
  | z.input<typeof bookingsRequestSchema>
  | z.input<typeof bookingDetailsRequestSchema>
  | z.input<typeof subscriptionsRequestSchema>
  | z.input<typeof scheduleRequestSchema>;

export type ClientTransportErrorCode =
  'DIRECT_VIVA_UNAVAILABLE' | 'DIRECT_VIVA_REAUTH_REQUIRED' | 'DIRECT_VIVA_RESPONSE_INVALID';

export class ClientTransportError extends Error {
  public constructor(
    public readonly code: ClientTransportErrorCode,
    public readonly operation: DirectVivaReadOperation,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'ClientTransportError';
  }
}

export interface ClientTransportExecutorOptions {
  /**
   * The provider may cache a still-valid plan, but forceRefresh must bypass
   * that cache. Fetch failures are safe: the executor falls back to PadlHub.
   */
  readonly getRoutingPlan: (forceRefresh: boolean) => Promise<unknown>;
  readonly getVivaAccessToken: () => string | undefined;
  readonly refreshVivaAccessToken: () => Promise<string>;
  readonly executePadlHub: (request: DirectVivaReadRequest) => Promise<unknown>;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ClientReadExecution<TResult> {
  readonly request: DirectVivaReadRequest;
  readonly normalizePadlHub: (payload: unknown) => TResult;
  readonly normalizeViva: (payload: unknown) => TResult;
}

function parseReadRequest(request: DirectVivaReadRequest) {
  switch (request.operation) {
    case 'profile.read':
      return profileRequestSchema.parse(request);
    case 'bookings.read':
      return bookingsRequestSchema.parse(request);
    case 'bookings.details.read':
      return bookingDetailsRequestSchema.parse(request);
    case 'subscriptions.read':
      return subscriptionsRequestSchema.parse(request);
    case 'schedule.read':
      return scheduleRequestSchema.parse(request);
  }
}

function directReadUrl(plan: ClientRoutingPlan, request: ReturnType<typeof parseReadRequest>): URL {
  if (!plan.directViva) throw new Error('Direct Viva transport is missing');
  const base = plan.directViva.apiBaseUrl.replace(/\/$/, '');
  const tenant = encodeURIComponent(plan.directViva.providerTenantKey);
  let url: URL;
  switch (request.operation) {
    case 'profile.read':
      return new URL(`${base}/v1/${tenant}/profile`);
    case 'bookings.read':
      url = new URL(`${base}/v2/${tenant}/bookings`);
      url.searchParams.set('page', String(request.page));
      url.searchParams.set('size', String(request.size));
      return url;
    case 'bookings.details.read':
      url = new URL(`${base}/v1/${tenant}/bookings/list`);
      for (const bookingId of request.bookingIds) url.searchParams.append('bookingIds', bookingId);
      return url;
    case 'subscriptions.read':
      url = new URL(`${base}/v1/${tenant}/subscriptions`);
      url.searchParams.set('includeFinished', String(request.includeFinished));
      url.searchParams.set('page', String(request.page));
      url.searchParams.set('size', String(request.size));
      return url;
    case 'schedule.read':
      url = new URL(`${base}/v1/${tenant}/exercises`);
      url.searchParams.set('date', request.date);
      return url;
  }
}

function validDirectPlan(plan: ClientRoutingPlan, operation: DirectVivaReadOperation): boolean {
  if (
    !DIRECT_VIVA_CONTRACT_READY_OPERATIONS.includes(
      operation as (typeof DIRECT_VIVA_CONTRACT_READY_OPERATIONS)[number],
    )
  ) {
    return false;
  }
  if (plan.mode !== 'MIXED_END_USER_READS' || !plan.directViva) return false;
  if (plan.directViva.allowedRequestHeaders.join(',') !== 'Authorization') return false;
  const entries = plan.operations.filter((entry) => entry.operation === operation);
  return entries.length === 1 && entries[0]?.transport === 'DIRECT_VIVA';
}

async function effectivePlan(
  getRoutingPlan: ClientTransportExecutorOptions['getRoutingPlan'],
): Promise<ClientRoutingPlan | undefined> {
  try {
    let plan = routingPlanSchema.parse(await getRoutingPlan(false)) as ClientRoutingPlan;
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      plan = routingPlanSchema.parse(await getRoutingPlan(true)) as ClientRoutingPlan;
    }
    return Date.parse(plan.expiresAt) > Date.now() ? plan : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Executes only the fixed direct-read vocabulary above. There is deliberately
 * no generic URL or command method: unknown operations always stay behind the
 * PadlHub API. Both upstream payloads must be normalized before leaving this
 * adapter so Viva identifiers never become public application identifiers.
 */
export function createClientTransportExecutor(options: ClientTransportExecutorOptions) {
  const fetchImplementation =
    options.fetchImplementation ??
    ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function directRead(
    plan: ClientRoutingPlan,
    request: ReturnType<typeof parseReadRequest>,
    allowTokenRefresh: boolean,
  ): Promise<unknown> {
    const token =
      options.getVivaAccessToken() ||
      (allowTokenRefresh ? await options.refreshVivaAccessToken() : undefined);
    if (!token) {
      throw new ClientTransportError('DIRECT_VIVA_REAUTH_REQUIRED', request.operation);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
    try {
      const response = await fetchImplementation(directReadUrl(plan, request), {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (response.status === 401 && allowTokenRefresh) {
        await options.refreshVivaAccessToken();
        return directRead(plan, request, false);
      }
      if (!response.ok) {
        throw new ClientTransportError(
          response.status === 401 ? 'DIRECT_VIVA_REAUTH_REQUIRED' : 'DIRECT_VIVA_UNAVAILABLE',
          request.operation,
          response.status,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new ClientTransportError(
          'DIRECT_VIVA_RESPONSE_INVALID',
          request.operation,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof ClientTransportError) throw error;
      throw new ClientTransportError('DIRECT_VIVA_UNAVAILABLE', request.operation);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async executeRead<TResult>(execution: ClientReadExecution<TResult>): Promise<TResult> {
      const request = parseReadRequest(execution.request);
      const plan = await effectivePlan(options.getRoutingPlan);
      const operationPlan = plan?.operations.find((entry) => entry.operation === request.operation);
      if (!plan || !validDirectPlan(plan, request.operation)) {
        return execution.normalizePadlHub(await options.executePadlHub(request));
      }

      try {
        return execution.normalizeViva(await directRead(plan, request, true));
      } catch (error) {
        if (operationPlan?.fallback === 'PADLHUB_API') {
          return execution.normalizePadlHub(await options.executePadlHub(request));
        }
        throw error;
      }
    },
  };
}
