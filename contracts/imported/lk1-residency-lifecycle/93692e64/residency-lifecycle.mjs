// Residency lifecycle domain (LK1 owner contour).
//
// This module is transport-agnostic. The Node-RED gateway composes its source with the
// Mongo/HTTP adapters; tests drive it with in-memory ports. It owns order state and
// orchestration only: the product terms, final price and discount lines come from
// authoritative ports (Viva product card / CUP publication), and activation is
// confirmed only by the CUP residency owner. No tariff or business rule is invented here.
//
// The renewal rule is pinned to the CUP contract: the paid window always starts at the
// transaction paymentDate and lasts exactly the product term. CUP never carries the
// remaining days of an older instance, so an early renewal that would burn those days is
// refused before any provider POST instead of failing after the money is taken.

export const RESIDENCY_LIFECYCLE_VERSION = 1;
export const RESIDENCY_LIFECYCLE_CONTRACT = "residency-lifecycle.v2";

/** Canonical Viva product. Kept in one place; the price is always read from the provider. */
export const RESIDENCY_PRODUCT_ID = "4037a3a3-e551-4f9a-a9db-1410e46b8635";

export const ORDER_STATES = Object.freeze({
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  PAID: "PAID",
  ACTIVATION_PENDING: "PAID_ACTIVATION_PENDING",
  ACTIVE: "ACTIVE",
  ACTIVATION_FAILED: "ACTIVATION_FAILED",
  PAID_REQUIRES_REVIEW: "PAID_REQUIRES_REVIEW",
});

export const RESIDENCY_STATES = Object.freeze({
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  NONE: "NONE",
  UNAVAILABLE: "UNAVAILABLE",
});

/** Public recovery vocabulary. Derived from durable order fields, never from a request flag. */
export const RECOVERY_STATES = Object.freeze({
  NONE: "NONE",
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
  AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
  UNKNOWN_OUTCOME: "UNKNOWN_OUTCOME",
  ACTIVATION_PENDING: "ACTIVATION_PENDING",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  TERMINAL: "TERMINAL",
});

const TERMINAL_STATES = [ORDER_STATES.ACTIVE, ORDER_STATES.CANCELLED, ORDER_STATES.PAYMENT_FAILED, ORDER_STATES.EXPIRED];
const UNRESOLVED_STATES = [ORDER_STATES.PENDING_PAYMENT, ORDER_STATES.PAID, ORDER_STATES.ACTIVATION_PENDING,
  ORDER_STATES.ACTIVATION_FAILED, ORDER_STATES.PAID_REQUIRES_REVIEW];
const CONFIRMED_TERMINAL_PAYMENT = ["FAILED"];

const hasControls = (value) => Array.from(value).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max
  && value.trim() === value && !hasControls(value);
const iso = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const money = (value) => Number.isSafeInteger(value) && value >= 0;
const uuid = (value) => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const stable = (value) => JSON.stringify((function sort(input) {
  if (Array.isArray(input)) return input.map(sort);
  if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
  return input;
})(value));

export class ResidencyLifecycleError extends Error {
  constructor(statusCode, code, message, details) {
    super(message || code);
    this.name = "ResidencyLifecycleError";
    this.statusCode = statusCode;
    this.code = code;
    if (details && typeof details === "object") this.details = details;
  }
}

const fail = (statusCode, code, message, details) => { throw new ResidencyLifecycleError(statusCode, code, message, details); };

/**
 * @param {object} deps
 * @param {{now:()=>number}} deps.clock
 * @param {{orderId:(tenantId:string,key:string)=>string, eventId:()=>string}} deps.ids
 * @param {(value:string)=>string} deps.sha256
 * @param {object} deps.store
 * @param {object} deps.catalog
 * @param {object} deps.payments
 * @param {object} deps.activation
 * @param {object} deps.discounts
 * @param {object} deps.status
 * @param {object} [deps.config]
 */
export function createResidencyLifecycle(deps) {
  if (!deps || typeof deps !== "object") throw new Error("RESIDENCY_LIFECYCLE_DEPS_REQUIRED");
  const { clock, ids, sha256, store, catalog, payments, activation, discounts, status } = deps;
  for (const [name, value] of Object.entries({ clock, ids, sha256, store, catalog, payments, activation, discounts, status })) {
    if (!value || typeof value !== "object" && typeof value !== "function") throw new Error("RESIDENCY_LIFECYCLE_DEP_INVALID:" + name);
  }
  const config = deps.config || {};
  const productId = config.productId || RESIDENCY_PRODUCT_ID;
  if (!uuid(productId)) throw new Error("RESIDENCY_PRODUCT_ID_INVALID");
  const maxPaymentAgeMs = Number.isSafeInteger(config.maxPaymentAgeMs) && config.maxPaymentAgeMs > 0
    ? config.maxPaymentAgeMs : 30 * 60 * 1000;
  const dispatchLeaseMs = Number.isSafeInteger(config.dispatchLeaseMs) && config.dispatchLeaseMs > 0
    ? config.dispatchLeaseMs : 2 * 60 * 1000;
  const returnTargets = config.returnTargets && typeof config.returnTargets === "object" ? config.returnTargets : null;
  const defaultReturnTarget = text(config.defaultReturnTarget, 32) ? config.defaultReturnTarget : "widget";
  const windowSlackMs = 5 * 60 * 1000;

  const nowIso = () => new Date(clock.now()).toISOString();

  function validateIdempotencyKey(key) {
    if (!text(key, 128) || key.length < 16 || /\s/.test(key)) {
      fail(400, "RESIDENCY_IDEMPOTENCY_KEY_REQUIRED", "A 16-128 character Idempotency-Key is required");
    }
    return key;
  }

  function readReturnTarget(value) {
    const target = value === undefined || value === null ? defaultReturnTarget : value;
    if (!text(target, 32) || !/^[a-z][a-z0-9_-]{0,31}$/.test(target)) {
      fail(400, "RESIDENCY_RETURN_TARGET_INVALID", "The payment return target is not supported");
    }
    if (returnTargets && !returnTargets[target]) {
      fail(400, "RESIDENCY_RETURN_TARGET_INVALID", "The payment return target is not configured");
    }
    if (!returnTargets && target !== defaultReturnTarget) {
      fail(400, "RESIDENCY_RETURN_TARGET_INVALID", "The payment return target is not configured");
    }
    return target;
  }

  function requestHash(mode, expectedTotalMinor, expectedProductId) {
    return sha256(stable({
      contract: RESIDENCY_LIFECYCLE_CONTRACT, productId, mode,
      expectedTotalMinor, expectedProductId,
    }));
  }

  function assertOrderShape(order) {
    if (!order || typeof order !== "object" || !uuid(order.orderId) || !text(order.tenantId, 128) || !text(order.userId, 128)
      || !text(order.idempotencyKeyHash, 128) || !text(order.requestHash, 128)
      || !Object.values(ORDER_STATES).includes(order.state) || !iso(order.createdAt) || !iso(order.updatedAt)
      || !Number.isSafeInteger(order.revision) || order.revision < 1) {
      throw new Error("RESIDENCY_ORDER_STORAGE_INVALID");
    }
    if (!order.pricing || !money(order.pricing.baseAmountMinor) || !money(order.pricing.totalMinor)
      || !Array.isArray(order.pricing.discountLines) || order.pricing.totalMinor > order.pricing.baseAmountMinor
      || order.pricing.baseAmountMinor - order.pricing.discountLines.reduce((sum, line) => sum + line.amountMinor, 0) !== order.pricing.totalMinor) {
      throw new Error("RESIDENCY_ORDER_PRICING_INVALID");
    }
    if (!order.product || order.product.productId !== productId || !text(order.product.title, 160)
      || !Number.isSafeInteger(order.product.termDays) || order.product.termDays <= 0 || order.product.currency !== "RUB") {
      throw new Error("RESIDENCY_ORDER_PRODUCT_INVALID");
    }
    if (!order.payment || !["NONE", "DISPATCHING", "PENDING", "PAID", "FAILED", "UNKNOWN"].includes(order.payment.status)) {
      throw new Error("RESIDENCY_ORDER_PAYMENT_INVALID");
    }
    if (!order.activation || typeof order.activation !== "object" || !Array.isArray(order.events)
      || (order.residency !== null && (typeof order.residency !== "object" || !Object.values(RESIDENCY_STATES).includes(order.residency.state)))
      || ![1, null].includes(order.activeSlot)) {
      throw new Error("RESIDENCY_ORDER_STORAGE_INVALID");
    }
    return order;
  }

  function isOverdue(order) {
    return order.payment.status === "PENDING" && iso(order.payment.expiresAt)
      && clock.now() > Date.parse(order.payment.expiresAt);
  }

  /**
   * Recovery is a projection of durable fields. It therefore survives a restart, a lost
   * response and a different device, and it never depends on the mutation response that
   * created the condition.
   */
  function recoveryView(order) {
    const reason = (value) => (text(value, 64) ? value : null);
    if (order.state === ORDER_STATES.ACTIVE) {
      return { state: RECOVERY_STATES.NONE, required: false, reason: null, action: "NONE", retryable: false, since: order.updatedAt };
    }
    if (TERMINAL_STATES.includes(order.state)) {
      const codes = {
        [ORDER_STATES.CANCELLED]: "ORDER_CANCELLED",
        [ORDER_STATES.PAYMENT_FAILED]: "PAYMENT_FAILED",
        [ORDER_STATES.EXPIRED]: "ORDER_EXPIRED",
      };
      return {
        state: RECOVERY_STATES.TERMINAL, required: false,
        reason: reason(order.activation?.lastErrorCode) || reason(order.payment?.lastErrorCode) || codes[order.state] || null,
        action: "START_NEW_ORDER", retryable: false, since: order.updatedAt,
      };
    }
    if (order.state === ORDER_STATES.PAID_REQUIRES_REVIEW || order.state === ORDER_STATES.ACTIVATION_FAILED) {
      return {
        state: RECOVERY_STATES.REVIEW_REQUIRED, required: true,
        reason: reason(order.activation?.lastErrorCode) || (order.state === ORDER_STATES.PAID_REQUIRES_REVIEW ? "PAYMENT_REVIEW" : "ACTIVATION_FAILED"),
        action: "CONTACT_SUPPORT", retryable: false, since: order.updatedAt,
      };
    }
    if (order.state === ORDER_STATES.PAID || order.state === ORDER_STATES.ACTIVATION_PENDING) {
      return {
        state: RECOVERY_STATES.ACTIVATION_PENDING, required: true,
        reason: reason(order.activation?.lastErrorCode), action: "RETRY_RECONCILE", retryable: true,
        since: reason(order.activation?.lastErrorCode) ? order.updatedAt : order.payment?.lastCheckedAt || order.updatedAt,
      };
    }
    if (["DISPATCHING", "UNKNOWN"].includes(order.payment.status)) {
      const leaseExpired = clock.now() >= Date.parse(order.createdAt) + dispatchLeaseMs;
      return {
        state: RECOVERY_STATES.UNKNOWN_OUTCOME, required: true,
        reason: reason(order.payment?.lastErrorCode) || reason(order.activation?.lastErrorCode)
          || (leaseExpired ? "DISPATCH_LEASE_EXPIRED" : "DISPATCH_OUTCOME_UNKNOWN"),
        action: "RETRY_RECONCILE", retryable: true,
        since: order.payment?.lastCheckedAt || order.updatedAt,
      };
    }
    if (order.payment.status === "UNKNOWN") {
      return {
        state: RECOVERY_STATES.UNKNOWN_OUTCOME, required: true,
        reason: reason(order.payment?.lastErrorCode) || "PAYMENT_STATUS_UNKNOWN",
        action: "RETRY_RECONCILE", retryable: true,
        since: order.payment?.lastCheckedAt || order.updatedAt,
      };
    }
    if (isOverdue(order)) {
      return {
        state: RECOVERY_STATES.AWAITING_CONFIRMATION, required: true,
        reason: "LOCAL_PAYMENT_WINDOW_ELAPSED", action: "RETRY_RECONCILE", retryable: true,
        since: order.payment?.lastCheckedAt || order.updatedAt,
      };
    }
    return {
      state: RECOVERY_STATES.AWAITING_PAYMENT, required: false, reason: null,
      action: "PAY", retryable: true, since: order.payment?.lastCheckedAt || order.updatedAt,
    };
  }

  function paymentView(order) {
    const payable = order.state === ORDER_STATES.PENDING_PAYMENT && order.payment.status === "PENDING";
    const recovery = recoveryView(order);
    return {
      status: order.payment.status === "DISPATCHING" ? "UNKNOWN" : order.payment.status,
      paymentUrl: payable && text(order.payment.paymentUrl, 4096) ? order.payment.paymentUrl : null,
      expiresAt: order.payment.expiresAt || null,
      overdue: isOverdue(order),
      instruction: payable
        ? "Оплатите по ссылке. Статус обновится после подтверждения банком."
        : recovery.state === RECOVERY_STATES.UNKNOWN_OUTCOME
          ? "Платёж отправлен, результат ещё не подтверждён. Не создавайте новый заказ; проверьте этот заказ позже."
          : recovery.state === RECOVERY_STATES.ACTIVATION_PENDING
            ? "Оплата получена. Активация резидентства подтверждается клубом."
            : recovery.state === RECOVERY_STATES.REVIEW_REQUIRED
              ? "Нужна проверка клуба. Не создавайте новый заказ."
              : recovery.state === RECOVERY_STATES.AWAITING_CONFIRMATION
                ? "Ожидается подтверждение оплаты. Не создавайте новый заказ; проверьте этот заказ позже."
                : null,
    };
  }

  function publicOrder(order) {
    assertOrderShape(order);
    const recovery = recoveryView(order);
    const residency = order.residency ? {
      state: order.residency.state,
      validFrom: order.residency.validFrom,
      validUntil: order.residency.validUntil,
      source: order.residency.source,
      observedAt: order.residency.observedAt,
    } : null;
    const term = order.product.termDays * 86400000;
    return {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      orderId: order.orderId,
      mode: order.mode,
      state: order.state,
      terminal: TERMINAL_STATES.includes(order.state),
      terminalReason: TERMINAL_STATES.includes(order.state) && order.state !== ORDER_STATES.ACTIVE ? recovery.reason : null,
      product: {
        productId: order.product.productId,
        title: order.product.title,
        termDays: order.product.termDays,
        currency: order.product.currency,
      },
      pricing: {
        baseAmountMinor: order.pricing.baseAmountMinor,
        discountLines: order.pricing.discountLines.map((line) => ({ ...line })),
        totalMinor: order.pricing.totalMinor,
        currency: order.pricing.currency,
      },
      consent: order.consent && money(order.consent.expectedTotalMinor)
        ? { expectedTotalMinor: order.consent.expectedTotalMinor, productId: order.consent.productId, acceptedAt: order.consent.acceptedAt }
        : null,
      renewal: order.mode === "RENEWAL" && iso(order.renewalBaseValidUntil)
        ? { baseValidUntil: order.renewalBaseValidUntil,
          minimumValidUntil: new Date(Date.parse(order.renewalBaseValidUntil) + term).toISOString() }
        : null,
      payment: paymentView(order),
      recovery,
      activation: {
        state: order.activation.state,
        attempts: order.activation.attempts,
        lastErrorCode: order.activation.lastErrorCode || null,
      },
      residency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      revision: order.revision,
    };
  }

  function ensurePricing(quote, baseAmountMinor) {
    if (!quote || !Array.isArray(quote.discountLines)) fail(503, "RESIDENCY_PRICING_UNAVAILABLE", "Confirmed pricing is unavailable");
    const lines = quote.discountLines.map((line) => {
      if (!line || typeof line !== "object" || !text(line.code, 64) || !money(line.amountMinor)
        || line.amountMinor > baseAmountMinor || (line.title !== undefined && !text(line.title, 160))
        || (line.source !== undefined && !text(line.source, 64))) {
        fail(503, "RESIDENCY_PRICING_INVALID", "Confirmed pricing is invalid");
      }
      return { code: line.code, title: line.title || line.code, amountMinor: line.amountMinor, source: line.source || "CUP" };
    });
    if (new Set(lines.map((line) => line.code)).size !== lines.length) fail(503, "RESIDENCY_PRICING_INVALID", "Duplicate discount codes");
    const discount = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    if (!money(discount) || discount > baseAmountMinor) fail(503, "RESIDENCY_PRICING_INVALID", "Discount exceeds the base amount");
    return { discountLines: lines, totalMinor: baseAmountMinor - discount };
  }

  function renewalContext(current, termDays) {
    if (!current || current.state === RESIDENCY_STATES.UNAVAILABLE) {
      return { eligible: false, reason: "STATUS_UNAVAILABLE", eligibleAt: null, currentValidUntil: null, expected: null };
    }
    if (current.state !== RESIDENCY_STATES.ACTIVE) {
      return {
        eligible: false, reason: "NOT_ACTIVE", eligibleAt: null, currentValidUntil: null,
        expected: { termDays, startsAt: "PAYMENT_DATE", earliestValidUntil: null },
      };
    }
    const base = Date.parse(current.validUntil);
    const eligible = clock.now() >= base;
    const earliestStart = Math.max(clock.now(), base);
    return {
      eligible,
      // CUP starts every paid window at its own paymentDate and never carries remaining
      // days, so an early renewal would burn them. It is refused before the transaction.
      reason: eligible ? null : "REMAINING_DAYS_NOT_TRANSFERABLE",
      eligibleAt: eligible ? null : current.validUntil,
      currentValidUntil: current.validUntil,
      expected: {
        termDays, startsAt: "PAYMENT_DATE",
        earliestValidUntil: new Date(earliestStart + termDays * 86400000).toISOString(),
      },
    };
  }

  async function readCatalog(query = {}) {
    const product = await catalog.read({ productId });
    if (!product || product.productId !== productId || !text(product.title, 160) || !money(product.priceMinor)
      || product.priceMinor <= 0 || !Number.isSafeInteger(product.termDays) || product.termDays <= 0
      || product.currency !== "RUB" || !iso(product.checkedAt)) {
      fail(503, "RESIDENCY_CATALOG_UNAVAILABLE", "The residency product is unavailable");
    }
    let current = null;
    if (text(query.tenantId, 128) && text(query.userId, 128)) {
      try { current = await getResidencyStatus({ tenantId: query.tenantId, userId: query.userId }); }
      catch { current = null; }
    }
    const renewal = current
      ? renewalContext(current, product.termDays)
      : { eligible: false, reason: "STATUS_UNAVAILABLE", eligibleAt: null, currentValidUntil: null,
        expected: { termDays: product.termDays, startsAt: "PAYMENT_DATE", earliestValidUntil: null } };
    return {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      product: {
        productId: product.productId,
        title: product.title,
        termDays: product.termDays,
        priceMinor: product.priceMinor,
        currency: product.currency,
        benefits: Array.isArray(product.benefits) ? product.benefits : [],
      },
      renewalEligible: renewal.eligible,
      renewal,
      checkedAt: product.checkedAt,
    };
  }

  async function getResidencyStatus(query) {
    let result;
    try { result = await status.read({ tenantId: query.tenantId, userId: query.userId }); }
    catch { return { schemaVersion: RESIDENCY_LIFECYCLE_VERSION, state: RESIDENCY_STATES.UNAVAILABLE,
      validFrom: null, validUntil: null, source: null, observedAt: null, reason: "SOURCE_UNAVAILABLE" }; }
    if (!result || !Object.values(RESIDENCY_STATES).includes(result.state)) {
      return { schemaVersion: RESIDENCY_LIFECYCLE_VERSION, state: RESIDENCY_STATES.UNAVAILABLE, validFrom: null, validUntil: null, source: null, observedAt: null, reason: "SOURCE_INVALID" };
    }
    if (result.state === RESIDENCY_STATES.UNAVAILABLE) {
      return { schemaVersion: RESIDENCY_LIFECYCLE_VERSION, state: result.state, validFrom: null, validUntil: null, source: result.source || null, observedAt: null, reason: text(result.reason, 64) ? result.reason : "SOURCE_UNAVAILABLE" };
    }
    if (result.state !== RESIDENCY_STATES.NONE && (!iso(result.validFrom) || !iso(result.validUntil) || Date.parse(result.validUntil) <= Date.parse(result.validFrom))) {
      return { schemaVersion: RESIDENCY_LIFECYCLE_VERSION, state: RESIDENCY_STATES.UNAVAILABLE, validFrom: null, validUntil: null, source: result.source || null, observedAt: null, reason: "SOURCE_INVALID" };
    }
    return {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      state: result.state,
      validFrom: result.validFrom || null,
      validUntil: result.validUntil || null,
      source: result.source || null,
      observedAt: result.observedAt || null,
      reason: null,
    };
  }

  function readConsent(command) {
    if (!money(command.expectedTotalMinor) || command.expectedTotalMinor <= 0) {
      fail(400, "RESIDENCY_PRICE_CONSENT_REQUIRED", "expectedTotalMinor is required to confirm the price");
    }
    const expectedProductId = command.expectedProductId === undefined || command.expectedProductId === null
      ? productId : command.expectedProductId;
    if (!uuid(expectedProductId)) fail(400, "RESIDENCY_REQUEST_INVALID", "expectedProductId must be a product id");
    return { expectedTotalMinor: command.expectedTotalMinor, expectedProductId };
  }

  async function createOrder(command) {
    if (!command || typeof command !== "object") fail(400, "RESIDENCY_REQUEST_INVALID", "Invalid request");
    const { tenantId, userId, idempotencyKey } = command;
    const mode = command.mode || "NEW";
    if (!text(tenantId, 128) || !text(userId, 128)) fail(401, "RESIDENCY_AUTH_REQUIRED", "Authentication required");
    if (mode !== "NEW" && mode !== "RENEWAL") fail(400, "RESIDENCY_MODE_INVALID", "mode must be NEW or RENEWAL");
    validateIdempotencyKey(idempotencyKey);
    const consent = readConsent(command);
    const returnTarget = readReturnTarget(command.returnTarget);
    if (consent.expectedProductId !== productId) {
      fail(409, "RESIDENCY_PRICE_CHANGED", "The confirmed product no longer matches", {
        expectedProductId: consent.expectedProductId, productId,
      });
    }
    const keyHash = sha256(tenantId + "\n" + userId + "\n" + idempotencyKey);
    const hash = requestHash(mode, consent.expectedTotalMinor, consent.expectedProductId);

    const replay = await store.findOrderByKey(tenantId, keyHash);
    if (replay) {
      assertOrderShape(replay);
      if (replay.requestHash !== hash) fail(409, "RESIDENCY_IDEMPOTENCY_CONFLICT", "The key was used for another request");
      return { order: publicOrder(replay), idempotentReplay: true };
    }

    const current = await getResidencyStatus({ tenantId, userId });
    // A trustworthy UNKNOWN must not be treated as absence. Buying while the source is
    // unavailable could double-charge an existing resident, so fail closed before any
    // eligibility decision.
    if (current.state === RESIDENCY_STATES.UNAVAILABLE) {
      fail(503, "RESIDENCY_STATUS_UNAVAILABLE", "Residency status is unavailable");
    }
    if (mode === "RENEWAL" && current.state !== RESIDENCY_STATES.ACTIVE) {
      fail(409, "RESIDENCY_RENEWAL_NOT_ELIGIBLE", "Renewal requires an active residency");
    }
    if (mode === "NEW" && current.state === RESIDENCY_STATES.ACTIVE) {
      fail(409, "RESIDENCY_RENEWAL_REQUIRED", "An active residency can only be renewed");
    }
    if (mode === "RENEWAL") {
      // The CUP window starts at the new paymentDate. Renewing while days remain would
      // silently drop them, so the refusal happens here, before the durable order and
      // therefore before any provider POST. The term is the pinned product term (the
      // adapter rejects any product whose validityDays is not 30).
      const renewal = renewalContext(current, 30);
      if (!renewal.eligible) {
        fail(409, "RESIDENCY_RENEWAL_TOO_EARLY",
          "The remaining days cannot be carried into a new residency window", {
            reason: renewal.reason,
            eligibleAt: renewal.eligibleAt,
            currentValidUntil: renewal.currentValidUntil,
            expected: renewal.expected,
          });
      }
    }

    const pending = await store.findUnresolvedOrder(tenantId, userId);
    if (pending) fail(409, "RESIDENCY_ORDER_ALREADY_PENDING", "An unresolved residency order already exists");

    const product = await catalog.read({ productId });
    if (!product || product.productId !== productId || !money(product.priceMinor) || product.priceMinor <= 0
      || !text(product.title, 160) || !Number.isSafeInteger(product.termDays) || product.termDays <= 0
      || product.currency !== "RUB" || !iso(product.checkedAt)) {
      fail(503, "RESIDENCY_CATALOG_UNAVAILABLE", "The residency product is unavailable");
    }
    let quote;
    try {
      quote = await discounts.quote({
        tenantId, userId, mode, productId, baseAmountMinor: product.priceMinor,
        residencyState: current.state, validUntil: current.validUntil,
      });
    } catch {
      fail(503, "RESIDENCY_PRICING_UNAVAILABLE", "Confirmed pricing is unavailable");
    }
    const pricing = ensurePricing(quote, product.priceMinor);
    // Consent is an exact total, not a ceiling: the user confirmed the amount shown by the
    // catalog. A lower current total is also a change (a new discount can change the terms
    // the user agreed to), so both directions are refused before the durable order.
    if (pricing.totalMinor !== consent.expectedTotalMinor) {
      fail(409, "RESIDENCY_PRICE_CHANGED", "The confirmed total no longer matches the current total", {
        expectedTotalMinor: consent.expectedTotalMinor, totalMinor: pricing.totalMinor,
        currency: product.currency, productId: product.productId,
      });
    }

    const now = nowIso();
    const order = {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      orderId: ids.orderId(tenantId, keyHash),
      tenantId, userId,
      idempotencyKeyHash: keyHash,
      requestHash: hash,
      mode,
      state: ORDER_STATES.PENDING_PAYMENT,
      product: { productId: product.productId, title: product.title, termDays: product.termDays, currency: product.currency },
      pricing: { baseAmountMinor: product.priceMinor, discountLines: pricing.discountLines, totalMinor: pricing.totalMinor, currency: product.currency },
      consent: { expectedTotalMinor: consent.expectedTotalMinor, productId: consent.expectedProductId, acceptedAt: now },
      returnTarget,
      payment: { status: "DISPATCHING", providerTransactionId: null, paymentUrl: null, expiresAt: null, paidAt: null,
        lastCheckedAt: now, lastErrorCode: null },
      activation: { state: "DISPATCHING", attempts: 0, lastErrorCode: null, clientSubscriptionId: null, startedAt: null },
      residency: null,
      events: [],
      activeSlot: 1,
      renewalBaseValidUntil: mode === "RENEWAL" ? current.validUntil : null,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };

    // The durable attempt exists before the provider POST. A crash after this point leaves
    // DISPATCHING; the order keeps its active slot and is resolved by provider/CUP
    // evidence, never by a second POST or by the mere passage of time.
    const inserted = await store.insertOrder(order);
    if (!inserted?.ok) {
      const existing = await store.findOrderByKey(tenantId, keyHash);
      if (existing && existing.requestHash === hash) return { order: publicOrder(existing), idempotentReplay: true };
      const active = await store.findUnresolvedOrder(tenantId, userId);
      if (active) fail(409, "RESIDENCY_ORDER_ALREADY_PENDING", "An unresolved residency order already exists");
      fail(409, "RESIDENCY_ORDER_CONFLICT", "The order was created concurrently");
    }

    let payment;
    try {
      payment = await payments.create({
        tenantId, userId, orderId: order.orderId, mode,
        productId: product.productId, amountMinor: pricing.totalMinor, currency: product.currency,
        successUrl: returnTargets?.[returnTarget]?.successUrl, failUrl: returnTargets?.[returnTarget]?.failUrl,
      });
    } catch (error) {
      const rejected = error?.outcome === "REJECTED";
      const code = text(error?.code, 64) ? error.code : "DISPATCH_OUTCOME_UNKNOWN";
      if (rejected) {
        // The provider refused the request with a 4xx and created nothing: a confirmed
        // basis for a terminal local failure.
        const failed = await transition(order, ORDER_STATES.PAYMENT_FAILED, {
          payment: { ...order.payment, status: "FAILED", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: code },
          activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: code },
        });
        return { order: publicOrder(failed), idempotentReplay: false };
      }
      // The outcome is unknown. The order stays unresolved and keeps the active slot: no
      // delivered link does not prove that no financial operation exists.
      const unresolved = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: code },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(unresolved), idempotentReplay: false, recoveryRequired: true };
    }
    if (!payment || !["PENDING", "PAID", "UNCONFIRMED"].includes(payment.status)) {
      const unresolved = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_INVALID" },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(unresolved), idempotentReplay: false, recoveryRequired: true };
    }
    if (payment.status === "UNCONFIRMED") {
      // The provider accepted the request but the result could not be verified. Keep the
      // transaction id that is already known so a later read recovers the late result.
      const transactionId = text(payment.providerTransactionId, 128) ? payment.providerTransactionId : null;
      const unresolved = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: {
          ...order.payment, status: "UNKNOWN", providerTransactionId: transactionId, paymentUrl: null,
          lastCheckedAt: nowIso(), lastErrorCode: text(payment.reason, 64) ? payment.reason : "DISPATCH_OUTCOME_UNKNOWN",
        },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(unresolved), idempotentReplay: false, recoveryRequired: true };
    }
    if (!money(payment.amountMinor) || payment.amountMinor !== pricing.totalMinor) {
      const unresolved = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: { ...order.payment, status: "UNKNOWN",
          providerTransactionId: text(payment.providerTransactionId, 128) ? payment.providerTransactionId : null,
          paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_AMOUNT_MISMATCH" },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(unresolved), idempotentReplay: false, recoveryRequired: true };
    }
    if (payment.status === "PENDING" && !text(payment.providerTransactionId, 128)) {
      // A payable link without a provider id cannot be verified, recovered or safely
      // voided. Keep the attempt unresolved instead of advertising an unverifiable link.
      const unresolved = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: "TRANSACTION_ID_MISSING" },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(unresolved), idempotentReplay: false, recoveryRequired: true };
    }

    const nextState = payment.status === "PAID" ? ORDER_STATES.PAID : ORDER_STATES.PENDING_PAYMENT;
    const updated = await transition(order, nextState, {
      payment: {
        status: payment.status,
        providerTransactionId: text(payment.providerTransactionId, 128) ? payment.providerTransactionId : null,
        paymentUrl: payment.status === "PENDING" && text(payment.paymentUrl, 4096) ? payment.paymentUrl : null,
        expiresAt: payment.expiresAt && iso(payment.expiresAt) ? payment.expiresAt : null,
        paidAt: payment.status === "PAID" ? (payment.paidAt && iso(payment.paidAt) ? payment.paidAt : nowIso()) : null,
        lastCheckedAt: nowIso(), lastErrorCode: null,
      },
      activation: { ...order.activation, state: "NOT_STARTED" },
    });
    if (nextState === ORDER_STATES.PAID) {
      const activated = await activate(updated);
      return { order: publicOrder(activated), idempotentReplay: false };
    }
    return { order: publicOrder(updated), idempotentReplay: false };
  }

  /**
   * The local payment window is not the provider's payment lifetime. Passing it never
   * releases the possibility of a new checkout: only a confirmed terminal provider
   * result (or a confirmed PAID) changes the order.
   */
  async function expireIfDue(order) {
    if (order.state !== ORDER_STATES.PENDING_PAYMENT) return order;
    if (["DISPATCHING", "UNKNOWN"].includes(order.payment.status) && !order.payment.providerTransactionId) {
      // A crashed or unverifiable dispatch keeps the slot. The dispatch lease records a
      // reason for operators and clients; it is not a permission to buy again.
      if (clock.now() < Date.parse(order.createdAt) + dispatchLeaseMs) return order;
      if (order.payment.lastErrorCode === "DISPATCH_LEASE_EXPIRED") return order;
      return transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: { ...order.payment, lastErrorCode: order.payment.lastErrorCode || "DISPATCH_LEASE_EXPIRED", lastCheckedAt: nowIso() },
      });
    }
    if (order.payment.status !== "PENDING" || !order.payment.providerTransactionId) return order;
    if (!order.payment.expiresAt || clock.now() < Date.parse(order.payment.expiresAt)) return order;
    let read;
    try {
      read = await payments.read({
        tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
        amountMinor: order.pricing.totalMinor, providerTransactionId: order.payment.providerTransactionId,
      });
    } catch { return order; }
    if (read?.status === "PAID") {
      const paid = await transition(order, ORDER_STATES.PAID, {
        payment: { ...order.payment, status: "PAID", paymentUrl: null,
          paidAt: iso(read.paidAt) ? read.paidAt : nowIso(), lastCheckedAt: nowIso(), lastErrorCode: null },
      });
      return activate(paid);
    }
    if (CONFIRMED_TERMINAL_PAYMENT.includes(read?.status)) {
      return transition(order, ORDER_STATES.PAYMENT_FAILED, {
        payment: { ...order.payment, status: "FAILED", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_FAILED" },
      });
    }
    // PENDING, UNKNOWN, a missing read or an unavailable read never frees the slot.
    return order;
  }

  /** Best-effort provider readback for a payment view; it never creates an operation. */
  async function refreshFromProvider(order) {
    if (order.state !== ORDER_STATES.PENDING_PAYMENT) return order;
    if (!order.payment.providerTransactionId) return order;
    if (order.payment.status === "PENDING" && order.payment.paymentUrl
      && (!order.payment.expiresAt || clock.now() < Date.parse(order.payment.expiresAt))) {
      return order;
    }
    let read;
    try {
      read = await payments.read({
        tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
        amountMinor: order.pricing.totalMinor, providerTransactionId: order.payment.providerTransactionId,
      });
    } catch { return order; }
    if (!read || !["PAID", "PENDING", "FAILED", "UNKNOWN"].includes(read.status)) return order;
    if (read.status === "PAID") {
      if (!money(read.amountMinor) || read.amountMinor !== order.pricing.totalMinor) return order;
      return transition(order, ORDER_STATES.PAID, {
        payment: { ...order.payment, status: "PAID", paymentUrl: null,
          paidAt: iso(read.paidAt) ? read.paidAt : nowIso(), lastCheckedAt: nowIso(), lastErrorCode: null },
      });
    }
    if (read.status === "FAILED") {
      return transition(order, ORDER_STATES.PAYMENT_FAILED, {
        payment: { ...order.payment, status: "FAILED", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_FAILED" },
      });
    }
    if (read.status === "PENDING") {
      return transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: {
          ...order.payment, status: "PENDING",
          providerTransactionId: text(read.providerTransactionId, 128) ? read.providerTransactionId : order.payment.providerTransactionId,
          paymentUrl: text(read.paymentUrl, 4096) ? read.paymentUrl : order.payment.paymentUrl,
          expiresAt: iso(read.expiresAt) ? read.expiresAt : order.payment.expiresAt,
          lastCheckedAt: nowIso(), lastErrorCode: null,
        },
      });
    }
    return transition(order, ORDER_STATES.PENDING_PAYMENT, {
      payment: { ...order.payment, status: "UNKNOWN", lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_STATUS_UNKNOWN" },
    });
  }

  async function getOrder(query) {
    if (!query || !text(query.tenantId, 128) || !text(query.userId, 128) || !uuid(query.orderId)) {
      fail(400, "RESIDENCY_REQUEST_INVALID", "Invalid order request");
    }
    const order = await store.getOrder(query.tenantId, query.userId, query.orderId);
    if (!order) fail(404, "RESIDENCY_ORDER_NOT_FOUND", "Order not found");
    assertOrderShape(order);
    const effective = await expireIfDue(order);
    return { order: publicOrder(effective) };
  }

  async function listOrders(query) {
    if (!query || !text(query.tenantId, 128) || !text(query.userId, 128)) {
      fail(401, "RESIDENCY_AUTH_REQUIRED", "Authentication required");
    }
    if (query.state !== "unresolved") fail(400, "RESIDENCY_REQUEST_INVALID", "state must be unresolved");
    if (typeof store.listUnresolvedOrders !== "function") throw new Error("RESIDENCY_STORE_LIST_REQUIRED");
    const rows = await store.listUnresolvedOrders(query.tenantId, query.userId, 20);
    const orders = [];
    for (const row of rows) {
      assertOrderShape(row);
      const effective = await expireIfDue(row);
      if (!TERMINAL_STATES.includes(effective.state)) orders.push(publicOrder(effective));
    }
    return { schemaVersion: RESIDENCY_LIFECYCLE_VERSION, orders, count: orders.length };
  }

  async function getPayment(query) {
    await getOrder(query);
    let order = await store.getOrder(query.tenantId, query.userId, query.orderId);
    assertOrderShape(order);
    order = await refreshFromProvider(order);
    if (order.state === ORDER_STATES.PAID || order.state === ORDER_STATES.ACTIVATION_PENDING) {
      // A paid order is surfaced as paid even before CUP activation is confirmed.
      const view = publicOrder(order);
      return { ...paymentPayload(view), state: order.state, paymentStatus: view.payment.status, paymentUrl: null };
    }
    const view = publicOrder(order);
    return { ...paymentPayload(view), state: view.state, paymentStatus: view.payment.status,
      paymentUrl: view.payment.paymentUrl };
  }

  function paymentPayload(view) {
    return {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      orderId: view.orderId,
      state: view.state,
      paymentStatus: view.payment.status,
      paymentUrl: view.payment.paymentUrl,
      expiresAt: view.payment.expiresAt,
      overdue: view.payment.overdue,
      instruction: view.payment.instruction,
      recovery: view.recovery,
      terminal: view.terminal,
      terminalReason: view.terminalReason,
    };
  }

  async function transition(order, state, patch = {}) {
    const resolved = [ORDER_STATES.ACTIVE, ORDER_STATES.PAYMENT_FAILED, ORDER_STATES.EXPIRED, ORDER_STATES.CANCELLED].includes(state);
    const next = {
      ...order,
      ...patch,
      state,
      activeSlot: resolved ? null : 1,
      updatedAt: nowIso(),
      revision: order.revision + 1,
    };
    const updated = await store.updateOrder(order.tenantId, order.orderId, order.revision, next);
    if (!updated?.ok) {
      // Another worker won the CAS. Return the durable row for an idempotent answer.
      const current = await store.getOrder(order.tenantId, order.userId, order.orderId);
      if (current) return current;
      fail(409, "RESIDENCY_ORDER_CONFLICT", "The order changed concurrently");
    }
    return next;
  }

  function providerPaid(read) {
    return Boolean(read) && read.status === "PAID" && money(read.amountMinor)
      && (read.providerTransactionId === undefined || read.providerTransactionId === null || text(read.providerTransactionId, 128));
  }

  async function activate(order) {
    const eligible = [ORDER_STATES.PAID, ORDER_STATES.ACTIVATION_PENDING, ORDER_STATES.ACTIVATION_FAILED].includes(order.state)
      || (order.state === ORDER_STATES.PENDING_PAYMENT && ["DISPATCHING", "UNKNOWN"].includes(order.payment.status));
    if (!eligible) return order;
    if (order.state === ORDER_STATES.ACTIVE) return order;
    const inFlightSince = iso(order.activation.startedAt) ? Date.parse(order.activation.startedAt) : null;
    if (order.activation.state === "IN_FLIGHT" && inFlightSince !== null && clock.now() - inFlightSince < 120000) {
      // Another worker owns this activation. Do not call CUP twice.
      return order;
    }
    const claimed = {
      ...order,
      activation: { ...order.activation, state: "IN_FLIGHT", startedAt: nowIso() },
      updatedAt: nowIso(),
      revision: order.revision + 1,
    };
    const claim = await store.updateOrder(order.tenantId, order.orderId, order.revision, claimed);
    if (!claim?.ok) {
      const current = await store.getOrder(order.tenantId, order.userId, order.orderId);
      return current || order;
    }
    order = claimed;
    let instance;
    try {
      instance = await activation.findInstance({
        tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
        productId: order.product.productId, providerTransactionId: order.payment.providerTransactionId,
        paidAt: order.payment.paidAt,
      });
    } catch {
      return transition(order, ORDER_STATES.ACTIVATION_PENDING, {
        activation: { ...order.activation, state: "PENDING", lastErrorCode: "INSTANCE_LOOKUP_UNAVAILABLE" },
      });
    }
    if (!instance || !text(instance.clientSubscriptionId, 128)) {
      // An absent instance is retryable: CUP must confirm the purchase first, and a
      // later reconcile can see the issued instance without a second charge.
      return transition(order, ORDER_STATES.ACTIVATION_PENDING, {
        activation: { ...order.activation, state: "PENDING", lastErrorCode: "INSTANCE_NOT_FOUND" },
      });
    }
    if (iso(instance.purchasedAt) && Date.parse(instance.purchasedAt) < Date.parse(order.createdAt)) {
      // An instance purchased before this order is not evidence for it. This is the
      // renewal guard against binding an old subscription to the new payment.
      return transition(order, ORDER_STATES.ACTIVATION_PENDING, {
        activation: { ...order.activation, state: "PENDING", lastErrorCode: "INSTANCE_BEFORE_ORDER" },
      });
    }
    let result;
    try {
      result = await activation.activate({
        tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
        productId: order.product.productId, providerTransactionId: order.payment.providerTransactionId,
        clientSubscriptionId: instance.clientSubscriptionId,
      });
    } catch {
      return transition(order, ORDER_STATES.ACTIVATION_PENDING, {
        activation: { ...order.activation, state: "PENDING", attempts: order.activation.attempts + 1, lastErrorCode: "ACTIVATION_UNAVAILABLE" },
      });
    }
    if (result?.state === "ACTIVE" && iso(result.validFrom) && iso(result.validUntil)
      && Date.parse(result.validUntil) > Date.parse(result.validFrom)) {
      const anomaly = activationAnomaly(order, result);
      if (anomaly) {
        // The provider/rights owner returned a window that contradicts the pinned CUP
        // contract. This is an anomaly after payment, never the routine renewal path.
        return transition(order, ORDER_STATES.ACTIVATION_FAILED, {
          activation: { ...order.activation, state: "REJECTED", attempts: order.activation.attempts + 1,
            lastErrorCode: anomaly, clientSubscriptionId: instance.clientSubscriptionId },
        });
      }
      return transition(order, ORDER_STATES.ACTIVE, {
        payment: order.payment.status === "PAID" ? order.payment : {
          ...order.payment,
          status: "PAID",
          providerTransactionId: order.payment.providerTransactionId || null,
          paymentUrl: null,
          paidAt: iso(instance.purchasedAt) ? instance.purchasedAt : nowIso(),
          lastCheckedAt: nowIso(),
        },
        activation: {
          state: "ACTIVE", attempts: order.activation.attempts + 1,
          lastErrorCode: null, clientSubscriptionId: instance.clientSubscriptionId,
        },
        residency: {
          state: RESIDENCY_STATES.ACTIVE,
          validFrom: result.validFrom,
          validUntil: result.validUntil,
          source: text(result.source, 64) ? result.source : "CUP_RESIDENCY_POLICY",
          observedAt: iso(result.observedAt) ? result.observedAt : nowIso(),
        },
      });
    }
    if (result?.state === "REJECTED") {
      return transition(order, ORDER_STATES.ACTIVATION_FAILED, {
        activation: {
          state: "REJECTED", attempts: order.activation.attempts + 1,
          lastErrorCode: text(result.reason, 64) ? result.reason : "ACTIVATION_REJECTED",
          clientSubscriptionId: instance.clientSubscriptionId,
        },
      });
    }
    return transition(order, ORDER_STATES.ACTIVATION_PENDING, {
      activation: {
        state: "PENDING", attempts: order.activation.attempts + 1,
        lastErrorCode: text(result?.reason, 64) ? result.reason : "ACTIVATION_UNAVAILABLE",
        clientSubscriptionId: instance.clientSubscriptionId,
      },
    });
  }

  /**
   * CUP pins every paid window to its own paymentDate + the product term. The guard
   * verifies exactly that contract and rejects a window that would overlap the previous
   * one; it no longer demands that the term be added on top of the old validUntil.
   */
  function activationAnomaly(order, result) {
    const start = Date.parse(result.validFrom);
    const end = Date.parse(result.validUntil);
    const term = order.product.termDays * 86400000;
    if (Math.abs(end - start - term) > windowSlackMs) return "ACTIVATION_WINDOW_TERM_MISMATCH";
    if (order.mode === "RENEWAL" && iso(order.renewalBaseValidUntil)
      && start < Date.parse(order.renewalBaseValidUntil) - windowSlackMs) {
      return "RENEWAL_WINDOW_OVERLAP";
    }
    return null;
  }

  async function reconcile(command) {
    if (!command || !text(command.tenantId, 128) || !text(command.userId, 128) || !uuid(command.orderId)) {
      fail(400, "RESIDENCY_REQUEST_INVALID", "Invalid reconcile request");
    }
    validateIdempotencyKey(command.idempotencyKey);
    const eventId = text(command.eventId, 128) ? command.eventId : null;
    const order = await store.getOrder(command.tenantId, command.userId, command.orderId);
    if (!order) fail(404, "RESIDENCY_ORDER_NOT_FOUND", "Order not found");
    assertOrderShape(order);

    if (eventId && order.events.some((event) => event.eventId === eventId)) {
      return { order: publicOrder(order), idempotentReplay: true };
    }
    if (order.state === ORDER_STATES.ACTIVE) return { order: publicOrder(order), idempotentReplay: false };
    if (order.state === ORDER_STATES.CANCELLED) {
      // Do not revive a cancelled order. A provider PAID read is surfaced for manual review
      // and refund; no activation or second charge is performed.
      let paid = false;
      if (order.payment.providerTransactionId) {
        try {
          const read = await payments.read({ tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
            amountMinor: order.pricing.totalMinor, providerTransactionId: order.payment.providerTransactionId });
          paid = providerPaid(read);
        } catch { paid = false; }
      }
      return { order: publicOrder({ ...order, payment: { ...order.payment, status: paid ? "PAID" : order.payment.status } }), idempotentReplay: false, reviewRequired: paid };
    }
    if (order.state === ORDER_STATES.PAID_REQUIRES_REVIEW) return { order: publicOrder(order), idempotentReplay: false, reviewRequired: true };

    const alreadyPaid = order.payment.status === "PAID"
      || [ORDER_STATES.PAID, ORDER_STATES.ACTIVATION_PENDING, ORDER_STATES.ACTIVATION_FAILED].includes(order.state);
    const failClosedRead = () => ({ order: publicOrder(order), idempotentReplay: false, retryable: true });

    if (order.state === ORDER_STATES.PAYMENT_FAILED) {
      if (!order.payment.providerTransactionId) return { order: publicOrder(order), idempotentReplay: false };
      let read;
      try {
        read = await payments.read({ tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
          amountMinor: order.pricing.totalMinor, providerTransactionId: order.payment.providerTransactionId });
      } catch { return failClosedRead(); }
      if (read?.status === "PAID") {
        const review = await transition(order, ORDER_STATES.PAID_REQUIRES_REVIEW, {
          payment: { ...order.payment, status: "PAID", paymentUrl: null,
            paidAt: iso(read.paidAt) ? read.paidAt : nowIso(), lastCheckedAt: nowIso() },
          activation: { ...order.activation, state: "REQUIRES_REVIEW", lastErrorCode: "PAYMENT_AFTER_FAILURE" },
          events: appendEvent(order, eventId),
        });
        return { order: publicOrder(review), idempotentReplay: false, reviewRequired: true };
      }
      return { order: publicOrder(order), idempotentReplay: false };
    }

    if (!order.payment.providerTransactionId) {
      // A lost create response or a callback without a provider id is reconciled by
      // CUP's owned-instance evidence, never by a second create. An absent instance
      // stays retryable; only CUP can confirm the purchase.
      const activated = await activate(order);
      return { order: publicOrder(activated), idempotentReplay: false,
        retryable: ![ORDER_STATES.ACTIVE, ORDER_STATES.PAID_REQUIRES_REVIEW].includes(activated.state) };
    }
    let read;
    try {
      read = await payments.read({
        tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
        amountMinor: order.pricing.totalMinor,
        providerTransactionId: order.payment.providerTransactionId,
      });
    } catch { return failClosedRead(); }
    if (!read || !["PAID", "PENDING", "FAILED", "UNKNOWN"].includes(read.status)) return failClosedRead();

    if (read.status === "PAID") {
      if (!money(read.amountMinor) || read.amountMinor !== order.pricing.totalMinor) {
        const review = await transition(order, ORDER_STATES.PAID_REQUIRES_REVIEW, {
          payment: { ...order.payment, status: "PAID", paymentUrl: null,
            paidAt: iso(read.paidAt) ? read.paidAt : nowIso(), lastCheckedAt: nowIso() },
          activation: { ...order.activation, state: "REQUIRES_REVIEW", lastErrorCode: "AMOUNT_MISMATCH" },
          events: appendEvent(order, eventId),
        });
        return { order: publicOrder(review), idempotentReplay: false, reviewRequired: true };
      }
      if (read.providerTransactionId && order.payment.providerTransactionId
        && read.providerTransactionId !== order.payment.providerTransactionId) {
        const review = await transition(order, ORDER_STATES.PAID_REQUIRES_REVIEW, {
          payment: { ...order.payment, status: "PAID", paymentUrl: null, lastCheckedAt: nowIso() },
          activation: { ...order.activation, state: "REQUIRES_REVIEW", lastErrorCode: "TRANSACTION_MISMATCH" },
          events: appendEvent(order, eventId),
        });
        return { order: publicOrder(review), idempotentReplay: false, reviewRequired: true };
      }
      if (alreadyPaid) {
        const activated = await activate(order);
        return { order: publicOrder(activated), idempotentReplay: false,
          retryable: activated.state === ORDER_STATES.ACTIVATION_PENDING };
      }
      const paid = await transition(order, ORDER_STATES.PAID, {
        payment: {
          ...order.payment,
          status: "PAID",
          providerTransactionId: read.providerTransactionId || order.payment.providerTransactionId,
          paymentUrl: null,
          paidAt: iso(read.paidAt) ? read.paidAt : nowIso(),
          lastCheckedAt: nowIso(), lastErrorCode: null,
        },
        activation: { ...order.activation, state: "NOT_STARTED" },
        events: appendEvent(order, eventId),
      });
      const activated = await activate(paid);
      return { order: publicOrder(activated), idempotentReplay: false };
    }

    // PAID is final. A later PENDING/UNKNOWN read never downgrades the order or
    // re-exposes a payment link; a FAILED/refund contradiction goes to review.
    if (alreadyPaid) {
      if (read.status === "FAILED") {
        const review = await transition(order, ORDER_STATES.PAID_REQUIRES_REVIEW, {
          payment: { ...order.payment, status: "PAID", paymentUrl: null, lastCheckedAt: nowIso() },
          activation: { ...order.activation, state: "REQUIRES_REVIEW", lastErrorCode: "PAYMENT_CONTRADICTION" },
          events: appendEvent(order, eventId),
        });
        return { order: publicOrder(review), idempotentReplay: false, reviewRequired: true };
      }
      return failClosedRead();
    }

    if (read.status === "FAILED") {
      const failed = await transition(order, ORDER_STATES.PAYMENT_FAILED, {
        payment: { ...order.payment, status: "FAILED", paymentUrl: null, lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_FAILED" },
        events: appendEvent(order, eventId),
      });
      return { order: publicOrder(failed), idempotentReplay: false };
    }
    if (order.state === ORDER_STATES.EXPIRED) {
      // A late PENDING/UNKNOWN read never reopens an expired order.
      return { order: publicOrder(order), idempotentReplay: false };
    }
    if (read.status === "PENDING") {
      const pending = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
        payment: {
          ...order.payment,
          status: "PENDING",
          paymentUrl: text(read.paymentUrl, 4096) ? read.paymentUrl : order.payment.paymentUrl,
          expiresAt: iso(read.expiresAt) ? read.expiresAt : order.payment.expiresAt,
          lastCheckedAt: nowIso(), lastErrorCode: null,
        },
        events: appendEvent(order, eventId),
      });
      return { order: publicOrder(pending), idempotentReplay: false };
    }
    const unknown = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
      payment: { ...order.payment, status: "UNKNOWN", lastCheckedAt: nowIso(), lastErrorCode: "PAYMENT_STATUS_UNKNOWN" },
      events: appendEvent(order, eventId),
    });
    return { order: publicOrder(unknown), idempotentReplay: false, retryable: true };
  }

  function appendEvent(order, eventId) {
    if (!eventId) return order.events;
    const events = order.events.concat({ eventId, at: nowIso() });
    return events.slice(-50);
  }

  async function cancel(command) {
    if (!command || !text(command.tenantId, 128) || !text(command.userId, 128) || !uuid(command.orderId)) {
      fail(400, "RESIDENCY_REQUEST_INVALID", "Invalid cancel request");
    }
    validateIdempotencyKey(command.idempotencyKey);
    const order = await store.getOrder(command.tenantId, command.userId, command.orderId);
    if (!order) fail(404, "RESIDENCY_ORDER_NOT_FOUND", "Order not found");
    assertOrderShape(order);
    if (order.state === ORDER_STATES.CANCELLED) return { order: publicOrder(order), idempotentReplay: true };
    if (order.state === ORDER_STATES.ACTIVE) fail(409, "RESIDENCY_ORDER_ACTIVE", "An active order cannot be cancelled");
    if (![ORDER_STATES.PENDING_PAYMENT, ORDER_STATES.PAYMENT_FAILED, ORDER_STATES.EXPIRED, ORDER_STATES.PAID_REQUIRES_REVIEW].includes(order.state)) {
      fail(409, "RESIDENCY_ORDER_NOT_CANCELLABLE", "The order is not cancellable");
    }
    // A PAID order waiting for activation must not be cancelled into a refund automatically.
    if (order.payment.status === "PAID") fail(409, "RESIDENCY_ORDER_PAID", "A paid order requires activation or review");
    // A cancellation needs a confirmed basis. An unresolved dispatch may already be paid.
    if (["DISPATCHING", "UNKNOWN"].includes(order.payment.status) && !order.payment.providerTransactionId) {
      fail(409, "RESIDENCY_PAYMENT_STATUS_UNKNOWN", "Payment status is unknown; contact support before cancelling");
    }
    if (order.payment.providerTransactionId) {
      let read;
      try {
        read = await payments.read({
          tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
          amountMinor: order.pricing.totalMinor, providerTransactionId: order.payment.providerTransactionId,
        });
      } catch {
        fail(503, "RESIDENCY_PAYMENT_STATUS_UNAVAILABLE", "Payment status is unavailable; retry before cancelling");
      }
      if (read?.status === "PAID") {
        fail(409, "RESIDENCY_ORDER_PAID", "A paid order requires activation or review");
      }
      if (read?.status === "PENDING" || read?.status === "UNKNOWN" || !read) {
        fail(409, "RESIDENCY_PAYMENT_STATUS_UNKNOWN", "Payment status is unresolved; retry later or contact support");
      }
    } else if (order.payment.status === "PENDING") {
      // A payable link with no provider id cannot be verified or safely voided.
      fail(409, "RESIDENCY_PAYMENT_STATUS_UNKNOWN", "Payment status is unresolved; contact support");
    }
    const cancelled = await transition(order, ORDER_STATES.CANCELLED, {
      payment: { ...order.payment, paymentUrl: null },
    });
    return { order: publicOrder(cancelled), idempotentReplay: false };
  }

  async function sweepExpired(command = {}) {
    if (!text(command.tenantId, 128)) fail(400, "RESIDENCY_REQUEST_INVALID", "tenantId is required");
    const rows = await store.listExpiredPending(command.tenantId, nowIso());
    let expired = 0;
    for (const row of rows) {
      assertOrderShape(row);
      if (row.state !== ORDER_STATES.PENDING_PAYMENT || !row.payment.expiresAt) continue;
      if (Date.parse(row.payment.expiresAt) > clock.now()) continue;
      try {
        const next = await expireIfDue(row);
        if (next.state === ORDER_STATES.PAYMENT_FAILED || next.state === ORDER_STATES.EXPIRED) expired += 1;
      } catch {
        // Best effort; the durable row stays eligible for the next sweep.
      }
    }
    return { expired };
  }

  return {
    catalog: readCatalog,
    status: getResidencyStatus,
    createOrder,
    getOrder,
    listOrders,
    getPayment,
    reconcile,
    cancel,
    sweepExpired,
    // Exposed for the Node-RED adapter and tests.
    _internals: { assertOrderShape, publicOrder, ensurePricing, providerPaid, recoveryView, activationAnomaly,
      maxPaymentAgeMs, UNRESOLVED_STATES },
  };
}
