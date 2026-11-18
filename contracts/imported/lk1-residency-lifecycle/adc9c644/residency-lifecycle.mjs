// Residency lifecycle domain (LK1 owner contour).
//
// This module is transport-agnostic. The Node-RED gateway composes its source with the
// Mongo/HTTP adapters; tests drive it with in-memory ports. It owns order state and
// orchestration only: the product terms, final price and discount lines come from
// authoritative ports (Viva product card / CUP publication), and activation is
// confirmed only by the CUP residency owner. No tariff or business rule is invented here.

export const RESIDENCY_LIFECYCLE_VERSION = 1;

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
  constructor(statusCode, code, message) {
    super(message || code);
    this.name = "ResidencyLifecycleError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const fail = (statusCode, code, message) => { throw new ResidencyLifecycleError(statusCode, code, message); };

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

  const nowIso = () => new Date(clock.now()).toISOString();

  function validateIdempotencyKey(key) {
    if (!text(key, 128) || key.length < 16 || /\s/.test(key)) {
      fail(400, "RESIDENCY_IDEMPOTENCY_KEY_REQUIRED", "A 16-128 character Idempotency-Key is required");
    }
    return key;
  }

  function requestHash(mode) {
    return sha256(stable({ contract: "residency-lifecycle.v1", productId, mode }));
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

  function publicOrder(order) {
    assertOrderShape(order);
    const residency = order.residency ? {
      state: order.residency.state,
      validFrom: order.residency.validFrom,
      validUntil: order.residency.validUntil,
      source: order.residency.source,
      observedAt: order.residency.observedAt,
    } : null;
    return {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      orderId: order.orderId,
      mode: order.mode,
      state: order.state,
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
      payment: {
        status: order.payment.status === "DISPATCHING" ? "UNKNOWN" : order.payment.status,
        paymentUrl: order.state === ORDER_STATES.PENDING_PAYMENT && order.payment.status === "PENDING"
          ? order.payment.paymentUrl || null : null,
        expiresAt: order.payment.expiresAt || null,
        instruction: order.state === ORDER_STATES.PENDING_PAYMENT && order.payment.status === "PENDING"
          ? "Оплатите по ссылке. Статус обновится после подтверждения банком." : null,
      },
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

  async function readCatalog() {
    const product = await catalog.read({ productId });
    if (!product || product.productId !== productId || !text(product.title, 160) || !money(product.priceMinor)
      || product.priceMinor <= 0 || !Number.isSafeInteger(product.termDays) || product.termDays <= 0
      || product.currency !== "RUB" || !iso(product.checkedAt)) {
      fail(503, "RESIDENCY_CATALOG_UNAVAILABLE", "The residency product is unavailable");
    }
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
      renewalEligible: product.renewalEligible === true,
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

  async function createOrder(command) {
    if (!command || typeof command !== "object") fail(400, "RESIDENCY_REQUEST_INVALID", "Invalid request");
    const { tenantId, userId, idempotencyKey } = command;
    const mode = command.mode || "NEW";
    if (!text(tenantId, 128) || !text(userId, 128)) fail(401, "RESIDENCY_AUTH_REQUIRED", "Authentication required");
    if (mode !== "NEW" && mode !== "RENEWAL") fail(400, "RESIDENCY_MODE_INVALID", "mode must be NEW or RENEWAL");
    validateIdempotencyKey(idempotencyKey);
    const keyHash = sha256(tenantId + "\n" + userId + "\n" + idempotencyKey);
    const hash = requestHash(mode);

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
      payment: { status: "DISPATCHING", providerTransactionId: null, paymentUrl: null, expiresAt: null, paidAt: null, lastCheckedAt: now },
      activation: { state: "DISPATCHING", attempts: 0, lastErrorCode: null, clientSubscriptionId: null, startedAt: null },
      residency: null,
      events: [],
      activeSlot: 1,
      renewalBaseValidUntil: mode === "RENEWAL" ? current.validUntil : null,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };

    // The durable attempt exists before the provider POST. A crash after this point
    // leaves DISPATCHING, and a retry returns the same order instead of charging again.
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
      });
    } catch {
      // The client never received a payment link, so the attempt can be closed and
      // its active slot released without a second charge. A provider transaction that
      // was created but never returned is support-reconciled, not re-POSTed.
      const updated = await transition(order, ORDER_STATES.CANCELLED, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso() },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(updated), idempotentReplay: false, recoveryRequired: true, reviewRequired: true };
    }
    if (!payment || !money(payment.amountMinor) || payment.amountMinor !== pricing.totalMinor
      || !["PENDING", "PAID"].includes(payment.status)) {
      const updated = await transition(order, ORDER_STATES.CANCELLED, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso() },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" },
      });
      return { order: publicOrder(updated), idempotentReplay: false, recoveryRequired: true, reviewRequired: true };
    }
    if (payment.status === "PENDING" && !text(payment.providerTransactionId, 128)) {
      // A payable link without a provider id cannot be verified, recovered or safely
      // voided. Do not advertise it; close the attempt and release the slot.
      const updated = await transition(order, ORDER_STATES.CANCELLED, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso() },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "TRANSACTION_ID_MISSING" },
      });
      return { order: publicOrder(updated), idempotentReplay: false, recoveryRequired: true, reviewRequired: true };
    }

    const nextState = payment.status === "PAID" ? ORDER_STATES.PAID : ORDER_STATES.PENDING_PAYMENT;
    const updated = await transition(order, nextState, {
      payment: {
        status: payment.status,
        providerTransactionId: text(payment.providerTransactionId, 128) ? payment.providerTransactionId : null,
        paymentUrl: payment.status === "PENDING" && text(payment.paymentUrl, 4096) ? payment.paymentUrl : null,
        expiresAt: payment.expiresAt && iso(payment.expiresAt) ? payment.expiresAt : null,
        paidAt: payment.status === "PAID" ? (payment.paidAt && iso(payment.paidAt) ? payment.paidAt : nowIso()) : null,
        lastCheckedAt: nowIso(),
      },
      activation: { ...order.activation, state: "NOT_STARTED" },
    });
    if (nextState === ORDER_STATES.PAID) {
      const activated = await activate(updated);
      return { order: publicOrder(activated), idempotentReplay: false };
    }
    return { order: publicOrder(updated), idempotentReplay: false };
  }

  async function expireIfDue(order) {
    if (order.state === ORDER_STATES.PENDING_PAYMENT && ["DISPATCHING", "UNKNOWN"].includes(order.payment.status)
      && !order.payment.providerTransactionId) {
      if (clock.now() < Date.parse(order.createdAt) + dispatchLeaseMs) return order;
      // A crash left an attempt with no provider id and no link was delivered.
      // Close it and free the active slot instead of locking the customer out.
      return transition(order, ORDER_STATES.CANCELLED, {
        payment: { ...order.payment, status: "UNKNOWN", paymentUrl: null, lastCheckedAt: nowIso() },
        activation: { ...order.activation, state: "NOT_STARTED", lastErrorCode: "DISPATCH_LEASE_EXPIRED" },
      });
    }
    if (order.state !== ORDER_STATES.PENDING_PAYMENT || order.payment.status !== "PENDING" || !order.payment.expiresAt) return order;
    if (clock.now() < Date.parse(order.payment.expiresAt)) return order;
    if (!order.payment.providerTransactionId) {
      // A payable link without a provider id cannot be verified or safely voided.
      return order;
    }
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
          paidAt: iso(read.paidAt) ? read.paidAt : nowIso(), lastCheckedAt: nowIso() },
      });
      return activate(paid);
    }
    if (read?.status === "PENDING" || read?.status === "FAILED") {
      return transition(order, ORDER_STATES.EXPIRED, {
        payment: { ...order.payment, paymentUrl: null, lastCheckedAt: nowIso() },
      });
    }
    return order;
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

  async function getPayment(query) {
    const result = await getOrder(query);
    const order = await store.getOrder(query.tenantId, query.userId, query.orderId);
    assertOrderShape(order);
    let paymentUrl = order.payment.status === "PENDING" ? order.payment.paymentUrl : null;
    if (order.state === ORDER_STATES.PENDING_PAYMENT && !paymentUrl) {
      // A lost create response may still have produced a payable operation. Read it back
      // by the original order identity; never POST a new transaction.
      try {
        const read = await payments.read({
          tenantId: order.tenantId, userId: order.userId, orderId: order.orderId,
          amountMinor: order.pricing.totalMinor,
          providerTransactionId: order.payment.providerTransactionId,
        });
        if (read && read.status === "PENDING" && text(read.paymentUrl, 4096)) {
          paymentUrl = read.paymentUrl;
          const recovered = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
            payment: {
              ...order.payment,
              status: "PENDING",
              providerTransactionId: text(read.providerTransactionId, 128) ? read.providerTransactionId : order.payment.providerTransactionId,
              paymentUrl: read.paymentUrl,
              expiresAt: iso(read.expiresAt) ? read.expiresAt : order.payment.expiresAt,
              lastCheckedAt: nowIso(),
            },
          });
          return {
            schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
            orderId: recovered.orderId,
            state: recovered.state,
            paymentStatus: recovered.payment.status,
            paymentUrl,
            expiresAt: recovered.payment.expiresAt,
            instruction: "Оплатите по ссылке. Статус обновится после подтверждения банком.",
          };
        }
      } catch {
        // Keep the order pending; the caller can retry the status read.
      }
    }
    return {
      schemaVersion: RESIDENCY_LIFECYCLE_VERSION,
      orderId: order.orderId,
      state: result.order.state,
      paymentStatus: order.payment.status,
      paymentUrl,
      expiresAt: order.payment.expiresAt,
      instruction: paymentUrl ? "Оплатите по ссылке. Статус обновится после подтверждения банком." : "Ссылка на оплату ещё не получена. Обновите статус заказа.",
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
      if (order.mode === "RENEWAL" && iso(order.renewalBaseValidUntil)) {
        const base = Date.parse(order.renewalBaseValidUntil);
        const expectedEnd = base + order.product.termDays * 86400000;
        const startsWithoutGap = Date.parse(result.validFrom) <= base + 5 * 60 * 1000;
        const endsWithoutLoss = Date.parse(result.validUntil) >= expectedEnd - 5 * 60 * 1000;
        if (!startsWithoutGap || !endsWithoutLoss) {
          return transition(order, ORDER_STATES.ACTIVATION_FAILED, {
            activation: { ...order.activation, state: "REJECTED", attempts: order.activation.attempts + 1,
              lastErrorCode: "RENEWAL_WINDOW_NOT_EXTENDED", clientSubscriptionId: instance.clientSubscriptionId },
          });
        }
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
          lastCheckedAt: nowIso(),
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
        payment: { ...order.payment, status: "FAILED", paymentUrl: null, lastCheckedAt: nowIso() },
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
          lastCheckedAt: nowIso(),
        },
        events: appendEvent(order, eventId),
      });
      return { order: publicOrder(pending), idempotentReplay: false };
    }
    const unknown = await transition(order, ORDER_STATES.PENDING_PAYMENT, {
      payment: { ...order.payment, status: "UNKNOWN", lastCheckedAt: nowIso() },
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
    // Never cancel a dispatched order whose provider outcome is unknown: it may be paid.
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
        if (next.state === ORDER_STATES.EXPIRED) expired += 1;
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
    getPayment,
    reconcile,
    cancel,
    sweepExpired,
    // Exposed for the Node-RED adapter and tests.
    _internals: { assertOrderShape, publicOrder, ensurePricing, providerPaid, maxPaymentAgeMs },
  };
}