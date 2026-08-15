import { z } from 'zod';

import type { UserProfile, UserUpcomingBookings } from '@phub/api-sdk';
import {
  DIRECT_VIVA_CONTRACT_READY_OPERATIONS,
  DIRECT_VIVA_READ_OPERATIONS,
  PROFILE_PHOTO_DELIVERY_PATH_PATTERN,
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

const PROFILE_RESPONSE_MAX_BYTES = 64 * 1024;
const DIRECT_RESPONSE_MAX_BYTES = 1024 * 1024;
const SCHEDULE_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_PHOTO_CONTENT_TYPE = /^image\/(?:avif|jpeg|png|webp)(?:;|$)/i;

async function readBoundedBinaryBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const body = await response.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > maxBytes) {
      throw new Error('DIRECT_VIVA_PROFILE_PHOTO_TOO_LARGE');
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('DIRECT_VIVA_PROFILE_PHOTO_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('DIRECT_VIVA_PROFILE_PHOTO_TOO_LARGE');
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('DIRECT_VIVA_RESPONSE_TOO_LARGE');
        throw new Error('DIRECT_VIVA_RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

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
  photo: z.string().max(2_048).nullish(),
  deposit: z.number().int(),
  customFields: z.array(profileCustomFieldSchema),
});

export function vivaProfilePhotoSourceUrl(input: unknown): string | undefined {
  const value = vivaProfileSchema.parse(input).photo?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchClientAssistedVivaProfilePhoto(input: {
  readonly sourceUrl: string;
  readonly allowedHosts: readonly string[];
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}): Promise<{ readonly body: ArrayBuffer; readonly contentType: string }> {
  const sourceUrl = vivaProfilePhotoSourceUrl({
    id: '00000000-0000-4000-8000-000000000000',
    firstName: null,
    middleName: null,
    lastName: null,
    phone: null,
    photo: input.sourceUrl,
    deposit: 0,
    customFields: [],
  });
  if (!sourceUrl) throw new Error('DIRECT_VIVA_PROFILE_PHOTO_URL_INVALID');
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  const allowed = input.allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate.startsWith('.')
      ? hostname.endsWith(candidate) && hostname.length > candidate.length
      : hostname === candidate;
  });
  if (!allowed) throw new Error('DIRECT_VIVA_PROFILE_PHOTO_HOST_NOT_ALLOWED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const response = await (input.fetchImplementation ?? fetch)(sourceUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DIRECT_VIVA_PROFILE_PHOTO_HTTP_${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
    if (!contentType || !PROFILE_PHOTO_CONTENT_TYPE.test(contentType)) {
      throw new Error('DIRECT_VIVA_PROFILE_PHOTO_TYPE_INVALID');
    }
    const maxBytes = input.maxBytes ?? PROFILE_PHOTO_MAX_BYTES;
    const announcedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
      throw new Error('DIRECT_VIVA_PROFILE_PHOTO_TOO_LARGE');
    }
    const body = await readBoundedBinaryBody(response, maxBytes);
    return { body, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

const absoluteUrlSchema = z.string().url();
const normalizedAvatarUrlSchema = z
  .string()
  .refine(
    (value) =>
      PROFILE_PHOTO_DELIVERY_PATH_PATTERN.test(value) || absoluteUrlSchema.safeParse(value).success,
    'avatar URL must be absolute or use the PadlHub profile-photo delivery endpoint',
  );

const normalizedProfileSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1).max(200),
  firstName: z.string().max(100).nullish(),
  avatarUrl: normalizedAvatarUrlSchema.nullish(),
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
 * Client-assisted Viva list/details payloads are deliberately not normalized
 * for UI use here; they are relayed to the server-owned read-job normalizer.
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
        allowedMediaHosts: z.array(z.string().min(1).max(253)).max(32).optional(),
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
const bookingHistoryRequestSchema = z
  .object({
    operation: z.literal('bookings.history.read'),
    page: z.number().int().min(0).max(1000),
    size: z.number().int().min(1).max(100),
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
  | z.input<typeof bookingHistoryRequestSchema>
  | z.input<typeof subscriptionsRequestSchema>
  | z.input<typeof scheduleRequestSchema>;

export type ClientTransportErrorCode =
  'DIRECT_VIVA_UNAVAILABLE' | 'DIRECT_VIVA_REAUTH_REQUIRED' | 'DIRECT_VIVA_RESPONSE_INVALID';

export class ClientTransportError extends Error {
  public constructor(
    public readonly code: ClientTransportErrorCode,
    public readonly operation: DirectVivaReadOperation,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
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
  readonly onMetric?: (metric: DirectVivaReadMetric) => void;
}

export interface DirectVivaReadMetric {
  readonly operation: DirectVivaReadOperation;
  readonly routingRevision: string;
  readonly outcome: 'SUCCESS' | 'UNAVAILABLE' | 'REAUTH_REQUIRED' | 'INVALID' | 'CIRCUIT_OPEN';
  readonly statusClass?: string;
  readonly durationMs: number;
}

export interface ClientReadExecution<TResult> {
  readonly request: DirectVivaReadRequest;
  readonly normalizePadlHub: (payload: unknown) => TResult;
  readonly normalizeViva: (payload: unknown) => TResult;
}

export interface ClientAssistedScheduleReadCommand {
  readonly operation: 'schedule.read';
  readonly date: string;
}

export interface ClientAssistedUpcomingBookingsReadCommand {
  readonly operation: 'bookings.read';
  readonly detailsOperation: 'bookings.details.read';
  readonly page: 0;
  readonly size: 50;
}

export interface ClientAssistedActivityHistoryReadCommand {
  readonly operation: 'bookings.history.read';
  readonly page: number;
  readonly size: number;
}

const clientAssistedActivityHistoryReadCommandSchema = bookingHistoryRequestSchema;

const clientAssistedUpcomingBookingsReadCommandSchema = z
  .object({
    operation: z.literal('bookings.read'),
    detailsOperation: z.literal('bookings.details.read'),
    page: z.literal(0),
    size: z.literal(50),
  })
  .strict();
const clientAssistedBookingListSchema = z.object({
  content: z
    .array(
      z.object({
        id: z.union([z.string().trim().min(1).max(200), z.number().finite().transform(String)]),
        isCancelled: z.boolean(),
      }),
    )
    .max(50),
});

function parseReadRequest(request: DirectVivaReadRequest) {
  switch (request.operation) {
    case 'profile.read':
      return profileRequestSchema.parse(request);
    case 'bookings.read':
      return bookingsRequestSchema.parse(request);
    case 'bookings.details.read':
      return bookingDetailsRequestSchema.parse(request);
    case 'bookings.history.read':
      return bookingHistoryRequestSchema.parse(request);
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
    case 'bookings.history.read':
      url = new URL(`${base}/v2/${tenant}/bookings/history`);
      url.searchParams.set('includeCanceled', 'true');
      url.searchParams.set('page', String(request.page));
      url.searchParams.set('size', String(request.size));
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

  const circuit = new Map<DirectVivaReadOperation, { failures: number; retryAt: number }>();

  async function directReadCore(
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
        return directReadCore(plan, request, false);
      }
      if (!response.ok) {
        throw new ClientTransportError(
          response.status === 401 ? 'DIRECT_VIVA_REAUTH_REQUIRED' : 'DIRECT_VIVA_UNAVAILABLE',
          request.operation,
          response.status,
        );
      }
      try {
        const maxBytes =
          request.operation === 'profile.read'
            ? PROFILE_RESPONSE_MAX_BYTES
            : request.operation === 'schedule.read'
              ? SCHEDULE_RESPONSE_MAX_BYTES
              : DIRECT_RESPONSE_MAX_BYTES;
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          throw new Error('DIRECT_VIVA_RESPONSE_TOO_LARGE');
        }
        const body = await readBoundedResponseBody(response, maxBytes);
        return JSON.parse(body) as unknown;
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

  async function directRead<TResult = unknown>(
    plan: ClientRoutingPlan,
    request: ReturnType<typeof parseReadRequest>,
    allowTokenRefresh: boolean,
    normalize?: (payload: unknown) => TResult,
  ): Promise<TResult> {
    const startedAt = Date.now();
    const currentCircuit = circuit.get(request.operation);
    if (currentCircuit && currentCircuit.retryAt > startedAt) {
      options.onMetric?.({
        operation: request.operation,
        routingRevision: plan.revision,
        outcome: 'CIRCUIT_OPEN',
        durationMs: 0,
      });
      throw new ClientTransportError('DIRECT_VIVA_UNAVAILABLE', request.operation);
    }
    try {
      const payload = await directReadCore(plan, request, allowTokenRefresh);
      let result: TResult;
      try {
        result = normalize ? normalize(payload) : (payload as TResult);
      } catch (error) {
        throw new ClientTransportError(
          'DIRECT_VIVA_RESPONSE_INVALID',
          request.operation,
          undefined,
          error,
        );
      }
      circuit.delete(request.operation);
      options.onMetric?.({
        operation: request.operation,
        routingRevision: plan.revision,
        outcome: 'SUCCESS',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const transportError = error instanceof ClientTransportError ? error : undefined;
      const outcome =
        transportError?.code === 'DIRECT_VIVA_REAUTH_REQUIRED'
          ? 'REAUTH_REQUIRED'
          : transportError?.code === 'DIRECT_VIVA_RESPONSE_INVALID'
            ? 'INVALID'
            : 'UNAVAILABLE';
      if (outcome === 'UNAVAILABLE' || outcome === 'INVALID') {
        const failures = Math.min(5, (currentCircuit?.failures ?? 0) + 1);
        circuit.set(request.operation, {
          failures,
          retryAt: Date.now() + Math.min(30_000, 1_000 * 2 ** (failures - 1)),
        });
      }
      options.onMetric?.({
        operation: request.operation,
        routingRevision: plan.revision,
        outcome,
        ...(transportError?.status
          ? { statusClass: `${Math.floor(transportError.status / 100)}xx` }
          : {}),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  return {
    /**
     * Executes a server-issued schedule command for immediate relay back to the
     * PadlHub API. The result is deliberately not normalized for UI use here:
     * only the server can map provider identifiers and apply recommendations.
     */
    async executeClientAssistedScheduleRead(
      command: ClientAssistedScheduleReadCommand,
    ): Promise<unknown> {
      const request = scheduleRequestSchema.parse(command);
      const plan = await effectivePlan(options.getRoutingPlan);
      if (plan?.mode !== 'MIXED_END_USER_READS' || !plan.directViva) {
        throw new ClientTransportError('DIRECT_VIVA_UNAVAILABLE', request.operation);
      }
      return directRead(plan, request, true);
    },

    /**
     * Executes the server-fixed list -> details chain. Detail identifiers are
     * derived only from the just-read active list and cannot be supplied by UI code.
     */
    async executeClientAssistedUpcomingBookingsRead(
      command: ClientAssistedUpcomingBookingsReadCommand,
    ): Promise<unknown> {
      const parsedCommand = clientAssistedUpcomingBookingsReadCommandSchema.parse(command);
      const plan = await effectivePlan(options.getRoutingPlan);
      if (plan?.mode !== 'MIXED_END_USER_READS' || !plan.directViva) {
        throw new ClientTransportError('DIRECT_VIVA_UNAVAILABLE', parsedCommand.operation);
      }
      const bookings = await directRead(
        plan,
        bookingsRequestSchema.parse({
          operation: parsedCommand.operation,
          page: parsedCommand.page,
          size: parsedCommand.size,
        }),
        true,
      );
      const activeBookingIds = clientAssistedBookingListSchema
        .parse(bookings)
        .content.filter((booking) => !booking.isCancelled)
        .map((booking) => booking.id);
      const details =
        activeBookingIds.length === 0
          ? []
          : await directRead(
              plan,
              bookingDetailsRequestSchema.parse({
                operation: parsedCommand.detailsOperation,
                bookingIds: activeBookingIds,
              }),
              true,
            );
      return { bookings, details };
    },

    /** Executes one server-issued history page and relays the raw response. */
    async executeClientAssistedActivityHistoryRead(
      command: ClientAssistedActivityHistoryReadCommand,
    ): Promise<unknown> {
      const request = clientAssistedActivityHistoryReadCommandSchema.parse(command);
      const plan = await effectivePlan(options.getRoutingPlan);
      if (plan?.mode !== 'MIXED_END_USER_READS' || !plan.directViva) {
        throw new ClientTransportError('DIRECT_VIVA_UNAVAILABLE', request.operation);
      }
      return directRead(plan, request, true);
    },

    async executeRead<TResult>(execution: ClientReadExecution<TResult>): Promise<TResult> {
      const request = parseReadRequest(execution.request);
      const plan = await effectivePlan(options.getRoutingPlan);
      const operationPlan = plan?.operations.find((entry) => entry.operation === request.operation);
      if (!plan || !validDirectPlan(plan, request.operation)) {
        return execution.normalizePadlHub(await options.executePadlHub(request));
      }

      try {
        return await directRead(plan, request, true, execution.normalizeViva);
      } catch (error) {
        if (operationPlan?.fallback === 'PADLHUB_API') {
          return execution.normalizePadlHub(await options.executePadlHub(request));
        }
        throw error;
      }
    },
  };
}
