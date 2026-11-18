import {
  ResidencyOwnerError,
  isOrderId,
  type ClientResidencyOwnerClient,
  type ResidencyOwnerCredential,
} from './client-residency-owner-client.js';

/**
 * LK2 consumer of the LK1 residency owner. It owns no order, price or entitlement of its
 * own: every call is forwarded to the owner with the user's server-held Viva delegation
 * and the answer is passed through unchanged (only the product identity is verified).
 */

const OWNER_STATES = new Set([
  'PENDING_PAYMENT',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'PAID',
  'PAID_ACTIVATION_PENDING',
  'ACTIVE',
  'ACTIVATION_FAILED',
  'PAID_REQUIRES_REVIEW',
]);
const OWNER_PAYMENT_STATUS = new Set(['NONE', 'PENDING', 'PAID', 'FAILED', 'UNKNOWN']);
const IDEMPOTENCY_KEY = /^[!-~]{16,128}$/;
// Owner refusals that describe its own configuration, not the caller's request. They are
// surfaced as a retryable availability failure instead of a user error.
const OWNER_CONFIGURATION_CODES = new Set([
  'RESIDENCY_RETURN_TARGET_INVALID',
  'RESIDENCY_PRODUCT_TERMS_MISMATCH',
  'RESIDENCY_PRODUCT_NOT_CONFIGURED',
  'RESIDENCY_CATALOG_UNAVAILABLE',
  'RESIDENCY_PRICING_UNAVAILABLE',
  'RESIDENCY_STATUS_UNAVAILABLE',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ResidencyOrderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ResidencyOrderError';
  }
}

export interface ResidencyOrderActor {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
}

export interface ResidencyOrderRuntimeOptions {
  readonly enabled: boolean;
  /** Exact Viva product both LK2's independent read and the owner must describe. */
  readonly productId: string;
  /** Viva tenant the owner is pinned to. */
  readonly tenantKey: string;
  readonly client?:
    | Pick<
        ClientResidencyOwnerClient,
        | 'catalog'
        | 'createOrder'
        | 'listOrders'
        | 'readOrder'
        | 'readPayment'
        | 'reconcileOrder'
        | 'cancelOrder'
      >
    | undefined;
  readonly token?: ((actor: ResidencyOrderActor) => Promise<ResidencyOwnerCredential>) | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const badAnswer = (): never => {
  throw new ResidencyOrderError('RESIDENCY_OWNER_RESPONSE_INVALID', 503);
};

const assertOrderView = (value: unknown, productId: string): Record<string, unknown> => {
  if (!isRecord(value)) return badAnswer();
  if (value.schemaVersion !== 1) return badAnswer();
  if (typeof value.orderId !== 'string' || !UUID.test(value.orderId)) return badAnswer();
  if (typeof value.state !== 'string' || !OWNER_STATES.has(value.state)) return badAnswer();
  const product = isRecord(value.product) ? value.product : null;
  if (!product || product.productId !== productId) {
    throw new ResidencyOrderError('RESIDENCY_PRODUCT_CONFIG_MISMATCH', 503);
  }
  const pricing = isRecord(value.pricing) ? value.pricing : null;
  if (
    !pricing ||
    !Number.isSafeInteger(pricing.totalMinor) ||
    (pricing.totalMinor as number) <= 0
  ) {
    return badAnswer();
  }
  const payment = isRecord(value.payment) ? value.payment : null;
  if (!payment || typeof payment.status !== 'string' || !OWNER_PAYMENT_STATUS.has(payment.status)) {
    return badAnswer();
  }
  if (!isRecord(value.recovery) || typeof value.recovery.state !== 'string') return badAnswer();
  return value;
};

const assertEnvelope = (value: unknown, productId: string): Record<string, unknown> => {
  if (!isRecord(value)) return badAnswer();
  if (value.schemaVersion !== 1 || typeof value.idempotentReplay !== 'boolean') return badAnswer();
  assertOrderView(value.order, productId);
  return value;
};

export function createResidencyOrderRuntime(options: ResidencyOrderRuntimeOptions) {
  const gate = (actor: ResidencyOrderActor): void => {
    if (!options.enabled) throw new ResidencyOrderError('RESIDENCY_ORDERS_DISABLED', 503);
    if (!options.productId) throw new ResidencyOrderError('RESIDENCY_PRODUCT_NOT_CONFIGURED', 503);
    if (!options.client || !options.token)
      throw new ResidencyOrderError('RESIDENCY_OWNER_UNAVAILABLE', 503);
    if (actor.tenantKey !== options.tenantKey)
      throw new ResidencyOrderError('RESIDENCY_TENANT_NOT_SUPPORTED', 503);
  };

  const ownerCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResidencyOwnerError && OWNER_CONFIGURATION_CODES.has(error.code)) {
        throw new ResidencyOrderError('RESIDENCY_OWNER_CONFIGURATION_INVALID', 503, {
          ownerCode: error.code,
        });
      }
      throw error;
    }
  };

  const credential = async (actor: ResidencyOrderActor): Promise<ResidencyOwnerCredential> => {
    let issued: ResidencyOwnerCredential;
    try {
      issued = await options.token!(actor);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      if (code === 'VIVA_REAUTH_REQUIRED')
        throw new ResidencyOrderError('RESIDENCY_REAUTH_REQUIRED', 409);
      if (code === 'AUTH_SESSION_REVOKED')
        throw new ResidencyOrderError('AUTH_SESSION_REVOKED', 401);
      if (code === 'VIVA_DELEGATION_BUSY')
        throw new ResidencyOrderError('RESIDENCY_REAUTH_UNAVAILABLE', 503);
      throw new ResidencyOrderError('RESIDENCY_OWNER_UNAVAILABLE', 503);
    }
    if (
      !issued ||
      typeof issued.token !== 'string' ||
      !/^[!-~]{16,4096}$/.test(issued.token) ||
      typeof issued.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(issued.expiresAt)) ||
      Date.parse(issued.expiresAt) <= Date.now() + 10_000
    ) {
      throw new ResidencyOrderError('RESIDENCY_REAUTH_REQUIRED', 409);
    }
    return issued;
  };

  const readOrder = async (actor: ResidencyOrderActor, orderId: string): Promise<unknown> => {
    if (!isOrderId(orderId)) throw new ResidencyOrderError('RESIDENCY_ORDER_NOT_FOUND', 404);
    gate(actor);
    const credentialValue = await credential(actor);
    const value = await ownerCall(() =>
      options.client!.readOrder(
        { credential: credentialValue, correlationId: actor.correlationId },
        orderId,
      ),
    );
    return assertOrderView(value, options.productId);
  };

  return {
    async catalog(actor: ResidencyOrderActor): Promise<unknown> {
      gate(actor);
      const credentialValue = await credential(actor);
      const value = await ownerCall(() =>
        options.client!.catalog({
          credential: credentialValue,
          correlationId: actor.correlationId,
        }),
      );
      if (!isRecord(value) || value.schemaVersion !== 1) return badAnswer();
      const product = isRecord(value.product) ? value.product : null;
      if (!product || product.productId !== options.productId)
        throw new ResidencyOrderError('RESIDENCY_PRODUCT_CONFIG_MISMATCH', 503);
      return value;
    },

    async listUnresolved(actor: ResidencyOrderActor): Promise<unknown> {
      gate(actor);
      const credentialValue = await credential(actor);
      const value = await ownerCall(() =>
        options.client!.listOrders({
          credential: credentialValue,
          correlationId: actor.correlationId,
        }),
      );
      if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.orders))
        return badAnswer();
      for (const order of value.orders) assertOrderView(order, options.productId);
      if (value.count !== value.orders.length) return badAnswer();
      return value;
    },

    readOrder,

    async readPayment(actor: ResidencyOrderActor, orderId: string): Promise<unknown> {
      if (!isOrderId(orderId)) throw new ResidencyOrderError('RESIDENCY_ORDER_NOT_FOUND', 404);
      gate(actor);
      const credentialValue = await credential(actor);
      const value = await ownerCall(() =>
        options.client!.readPayment(
          { credential: credentialValue, correlationId: actor.correlationId },
          orderId,
        ),
      );
      if (!isRecord(value) || value.schemaVersion !== 1 || value.orderId !== orderId)
        return badAnswer();
      if (typeof value.state !== 'string' || !OWNER_STATES.has(value.state)) return badAnswer();
      if (typeof value.paymentStatus !== 'string' || !OWNER_PAYMENT_STATUS.has(value.paymentStatus))
        return badAnswer();
      if (!isRecord(value.recovery) || typeof value.recovery.state !== 'string') return badAnswer();
      return value;
    },

    async create(
      actor: ResidencyOrderActor,
      idempotencyKey: string,
      body: unknown,
    ): Promise<unknown> {
      const parsed = parseCreateBody(body);
      gate(actor);
      if (!isRecord(parsed) || !IDEMPOTENCY_KEY.test(idempotencyKey))
        throw new ResidencyOrderError('RESIDENCY_IDEMPOTENCY_KEY_REQUIRED', 400);
      const credentialValue = await credential(actor);
      const value = await ownerCall(() =>
        options.client!.createOrder(
          { credential: credentialValue, correlationId: actor.correlationId, idempotencyKey },
          parsed,
        ),
      );
      return assertEnvelope(value, options.productId);
    },

    async reconcile(
      actor: ResidencyOrderActor,
      orderId: string,
      idempotencyKey: string,
      body: unknown,
    ): Promise<unknown> {
      if (!isOrderId(orderId)) throw new ResidencyOrderError('RESIDENCY_ORDER_NOT_FOUND', 404);
      const parsed = parseReconcileBody(body);
      gate(actor);
      if (!IDEMPOTENCY_KEY.test(idempotencyKey))
        throw new ResidencyOrderError('RESIDENCY_IDEMPOTENCY_KEY_REQUIRED', 400);
      const credentialValue = await credential(actor);
      const value = await ownerCall(() =>
        options.client!.reconcileOrder(
          { credential: credentialValue, correlationId: actor.correlationId, idempotencyKey },
          orderId,
          parsed,
        ),
      );
      return assertEnvelope(value, options.productId);
    },

    async cancel(
      actor: ResidencyOrderActor,
      orderId: string,
      idempotencyKey: string,
    ): Promise<unknown> {
      if (!isOrderId(orderId)) throw new ResidencyOrderError('RESIDENCY_ORDER_NOT_FOUND', 404);
      gate(actor);
      if (!IDEMPOTENCY_KEY.test(idempotencyKey))
        throw new ResidencyOrderError('RESIDENCY_IDEMPOTENCY_KEY_REQUIRED', 400);
      const credentialValue = await credential(actor);
      const value = await ownerCall(() =>
        options.client!.cancelOrder(
          { credential: credentialValue, correlationId: actor.correlationId, idempotencyKey },
          orderId,
        ),
      );
      return assertEnvelope(value, options.productId);
    },

    capability(): { readonly enabled: boolean; readonly productId: string | null } {
      return {
        enabled: options.enabled && Boolean(options.client) && Boolean(options.token),
        productId: options.productId || null,
      };
    },
  };
}

export type ResidencyOrderRuntime = ReturnType<typeof createResidencyOrderRuntime>;

function parseCreateBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
  for (const key of Object.keys(body)) {
    if (!['mode', 'expectedTotalMinor', 'expectedProductId'].includes(key))
      throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
  }
  const mode = body.mode ?? 'NEW';
  if (mode !== 'NEW' && mode !== 'RENEWAL')
    throw new ResidencyOrderError('RESIDENCY_MODE_INVALID', 400);
  if (!Number.isSafeInteger(body.expectedTotalMinor) || (body.expectedTotalMinor as number) <= 0)
    throw new ResidencyOrderError('RESIDENCY_PRICE_CONSENT_REQUIRED', 400);
  if (body.expectedProductId !== undefined) {
    if (typeof body.expectedProductId !== 'string' || !UUID.test(body.expectedProductId))
      throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
  }
  return {
    mode,
    expectedTotalMinor: body.expectedTotalMinor,
    ...(body.expectedProductId === undefined ? {} : { expectedProductId: body.expectedProductId }),
  };
}

function parseReconcileBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
  for (const key of Object.keys(body)) {
    if (key !== 'eventId') throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
  }
  if (body.eventId === undefined) return {};
  if (typeof body.eventId !== 'string' || !/^[!-~]{1,128}$/.test(body.eventId))
    throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
  return { eventId: body.eventId };
}

/** Exported for tests: the same mapping the routes use. */
export function toResidencyOrderError(error: unknown): {
  status: number;
  code: string;
  details?: unknown;
} {
  if (error instanceof ResidencyOrderError)
    return {
      status: error.status,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  if (error instanceof ResidencyOwnerError)
    return {
      status: error.status,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  return { status: 500, code: 'RESIDENCY_INTERNAL' };
}
