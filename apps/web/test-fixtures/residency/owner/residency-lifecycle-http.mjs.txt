// Transport-neutral HTTP contract for the LK1 residency lifecycle.
//
// The Node-RED gateway (or a future owner service) verifies the LK bearer and passes
// the authenticated actor here. This module owns routing, request validation, stable
// error codes and cache/privacy headers; the lifecycle engine owns the state machine.

import { ResidencyLifecycleError } from "./residency-lifecycle.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_MIN = 16;
const IDEMPOTENCY_MAX = 128;

const ROUTES = Object.freeze([
  { method: "GET", pattern: /^\/lk\/residency\/catalog$/, name: "catalog" },
  { method: "GET", pattern: /^\/lk\/residency\/status$/, name: "status" },
  { method: "POST", pattern: /^\/lk\/residency\/orders$/, name: "create", idempotent: true },
  { method: "GET", pattern: /^\/lk\/residency\/orders$/, name: "orders" },
  { method: "GET", pattern: /^\/lk\/residency\/orders\/([0-9a-f-]{36})$/, name: "order", params: ["orderId"] },
  { method: "GET", pattern: /^\/lk\/residency\/orders\/([0-9a-f-]{36})\/payment$/, name: "payment", params: ["orderId"] },
  { method: "POST", pattern: /^\/lk\/residency\/orders\/([0-9a-f-]{36})\/reconcile$/, name: "reconcile", idempotent: true, params: ["orderId"] },
  { method: "POST", pattern: /^\/lk\/residency\/orders\/([0-9a-f-]{36})\/cancel$/, name: "cancel", idempotent: true, params: ["orderId"] },
]);

const baseHeaders = (origin) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Correlation-ID, X-Residency-Return-Target",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  Vary: "Origin",
});

function normalizedHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(",");
  }
  return out;
}

function parseBody(body, headers) {
  if (body === undefined || body === null || body === "") return {};
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BODY_BYTES) throw new ResidencyLifecycleError(413, "RESIDENCY_REQUEST_TOO_LARGE", "Request body is too large");
    body = body.toString("utf8");
  }
  if (typeof body !== "string") {
    if (typeof body === "object" && !Array.isArray(body)) return body;
    throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "Invalid request body");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new ResidencyLifecycleError(413, "RESIDENCY_REQUEST_TOO_LARGE", "Request body is too large");
  const contentType = headers["content-type"] || "";
  if (contentType && !/^application\/json\b/i.test(contentType)) {
    throw new ResidencyLifecycleError(415, "RESIDENCY_CONTENT_TYPE_INVALID", "application/json is required");
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "Invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "A JSON object is required");
  }
  return parsed;
}

function readIdempotencyKey(headers) {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || value.length < IDEMPOTENCY_MIN || value.length > IDEMPOTENCY_MAX
    || /\s/.test(value) || value.trim() !== value) {
    throw new ResidencyLifecycleError(400, "RESIDENCY_IDEMPOTENCY_KEY_REQUIRED", "A 16-128 character Idempotency-Key is required");
  }
  return value;
}

function correlationId(headers) {
  const value = headers["x-correlation-id"];
  if (typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value)) return value;
  return "corr:" + cryptoRandomId();
}

function cryptoRandomId() {
  // Node 18+; the gateway already runs on a modern Node runtime.
  return globalThis.crypto?.randomUUID?.() || "00000000-0000-4000-8000-000000000000";
}

/**
 * @param {object} deps
 * @param {(actor: {tenantId: string, userId: string, providerClientId?: string, actorToken?: string}) => object} deps.createLifecycle
 * @param {string} [deps.allowOrigin]
 */
export function createResidencyLifecycleApi({ createLifecycle, allowOrigin = "*" }) {
  if (typeof createLifecycle !== "function") throw new Error("RESIDENCY_CREATE_LIFECYCLE_REQUIRED");
  if (typeof allowOrigin !== "string" || !allowOrigin) throw new Error("RESIDENCY_ORIGIN_INVALID");

  function respond(statusCode, payload, correlation, origin) {
    return { statusCode, headers: { ...baseHeaders(origin), "X-Correlation-ID": correlation }, body: payload };
  }

  function errorResponse(error, correlation, origin) {
    if (error instanceof ResidencyLifecycleError) {
      const body = { code: error.code, message: error.message };
      if (error.details && typeof error.details === "object") body.details = error.details;
      return respond(error.statusCode, body, correlation, origin);
    }
    const status = Number(error?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status <= 599 && typeof error?.code === "string") {
      const message = status < 500 ? String(error.message || "Request failed") : "Upstream request could not be completed";
      return respond(status, { code: error.code, message }, correlation, origin);
    }
    return respond(500, { code: "RESIDENCY_INTERNAL", message: "Internal error" }, correlation, origin);
  }

  async function handle(request) {
    const method = String(request?.method || "").toUpperCase();
    const rawPath = String(request?.path || "");
    const path = rawPath.split("?")[0];
    const query = new URLSearchParams(rawPath.includes("?") ? rawPath.slice(rawPath.indexOf("?") + 1) : "");
    const headers = normalizedHeaders(request?.headers);
    const origin = allowOrigin;
    const correlation = correlationId(headers);
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: { ...baseHeaders(origin), "X-Correlation-ID": correlation }, body: null };
    }
    const route = ROUTES.find((candidate) => candidate.method === method && candidate.pattern.test(path));
    if (!route) return respond(404, { code: "RESIDENCY_ROUTE_NOT_FOUND", message: "Route not found" }, correlation, origin);

    const actor = request.actor;
    if (!actor || typeof actor !== "object" || typeof actor.tenantId !== "string" || typeof actor.userId !== "string"
      || !actor.tenantId || !actor.userId) {
      return respond(401, { code: "RESIDENCY_AUTH_REQUIRED", message: "Authentication required" }, correlation, origin);
    }
    let lifecycle;
    try { lifecycle = createLifecycle(actor); }
    catch { return errorResponse(new Error("factory"), correlation, origin); }

    try {
      const match = route.pattern.exec(path);
      const params = {};
      for (let index = 0; route.params && index < route.params.length; index += 1) params[route.params[index]] = match[index + 1];
      if (route.idempotent) readIdempotencyKey(headers);

      if (route.name === "catalog") return respond(200, await lifecycle.catalog({ tenantId: actor.tenantId, userId: actor.userId }), correlation, origin);
      if (route.name === "status") return respond(200, await lifecycle.status({ tenantId: actor.tenantId, userId: actor.userId }), correlation, origin);
      if (route.name === "create") {
        const body = parseBody(request.body, headers);
        if (Object.keys(body).some((key) => !["mode", "expectedTotalMinor", "expectedProductId"].includes(key))) {
          throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "Unknown request fields");
        }
        const result = await lifecycle.createOrder({
          tenantId: actor.tenantId, userId: actor.userId,
          idempotencyKey: readIdempotencyKey(headers),
          mode: body.mode || "NEW",
          expectedTotalMinor: body.expectedTotalMinor,
          expectedProductId: body.expectedProductId,
          returnTarget: headers["x-residency-return-target"] || undefined,
        });
        return respond(200, { schemaVersion: 1, order: result.order, idempotentReplay: result.idempotentReplay === true,
          recoveryRequired: result.order.recovery.required === true, recovery: result.order.recovery }, correlation, origin);
      }
      if (route.name === "orders") {
        const state = query.get("state");
        const limit = query.get("limit");
        for (const key of query.keys()) {
          if (!["state", "limit"].includes(key)) {
            throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "Unknown query parameters");
          }
        }
        if (limit !== null && limit !== "20") {
          throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "limit must be 20");
        }
        const result = await lifecycle.listOrders({ tenantId: actor.tenantId, userId: actor.userId, state });
        return respond(200, result, correlation, origin);
      }
      if (route.name === "order") {
        const result = await lifecycle.getOrder({ tenantId: actor.tenantId, userId: actor.userId, orderId: params.orderId });
        return respond(200, result.order, correlation, origin);
      }
      if (route.name === "payment") {
        const result = await lifecycle.getPayment({ tenantId: actor.tenantId, userId: actor.userId, orderId: params.orderId });
        return respond(200, result, correlation, origin);
      }
      if (route.name === "reconcile") {
        const body = parseBody(request.body, headers);
        if (Object.keys(body).some((key) => key !== "eventId")) {
          throw new ResidencyLifecycleError(400, "RESIDENCY_REQUEST_INVALID", "Unknown request fields");
        }
        const result = await lifecycle.reconcile({
          tenantId: actor.tenantId, userId: actor.userId, orderId: params.orderId,
          idempotencyKey: readIdempotencyKey(headers),
          eventId: typeof body.eventId === "string" ? body.eventId : undefined,
        });
        return respond(200, { schemaVersion: 1, order: result.order, idempotentReplay: result.idempotentReplay === true,
          reviewRequired: result.order.recovery.state === "REVIEW_REQUIRED",
          retryable: result.retryable === true || result.order.recovery.retryable === true,
          recovery: result.order.recovery }, correlation, origin);
      }
      if (route.name === "cancel") {
        parseBody(request.body, headers);
        const result = await lifecycle.cancel({
          tenantId: actor.tenantId, userId: actor.userId, orderId: params.orderId,
          idempotencyKey: readIdempotencyKey(headers),
        });
        return respond(200, { schemaVersion: 1, order: result.order, idempotentReplay: result.idempotentReplay === true,
          recovery: result.order.recovery }, correlation, origin);
      }
      return respond(404, { code: "RESIDENCY_ROUTE_NOT_FOUND", message: "Route not found" }, correlation, origin);
    } catch (error) {
      return errorResponse(error, correlation, origin);
    }
  }

  return { handle, routes: ROUTES.map(({ method, name, idempotent }) => ({ method, name, idempotent: idempotent === true })) };
}