# Subject: Request for official Viva CRM API contract clarification

Dear Viva CRM API/Product Support team,

PadlHub is assessing a possible server-side integration with Viva CRM for booking and payment
recovery. We are not asking you to enable the integration or perform any transaction. Before any
implementation decision, we need an official written clarification of the production contract for
timeouts, connection resets, duplicate prevention, authoritative recovery and callback security.

Please answer directly under each numbered question. For every answer, please state:

- the exact Viva CRM product/API version and applicable environment;
- the authoritative document title, version and URL, or the attached document identifier;
- the exact endpoint/method, request headers or fields, response fields and status codes where
  applicable;
- any retention, consistency, retry, security, limitation or exception that affects the answer.

Please attach the current production OpenAPI/Swagger, Postman collection or equivalent API
reference and relevant changelog. Please also identify which supplied documents are contractually
authoritative. A general statement such as “supported” is not sufficient without the exact
versioned contract and environment.

## VIVA-Q-01 — Lost-response correlation

After the exact create-booking/create-transaction/payment request is accepted, but the TCP/TLS
connection closes before PadlHub receives the response body, which merchant-controlled value
supplied before that request retrieves precisely that object without repeating the create command?

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-02 — Exact-operation idempotency

For that exact create operation, what is the idempotency header or field, uniqueness scope and
retention; what happens for same key/same payload, same key/changed payload, timeout/reset, and a
retry after the retention window?

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-03 — Authoritative recovery lookup

Which current production read endpoint looks up the object by that merchant-controlled value; can
it return multiple matches; and how are never-created, not-yet-visible, deleted, expired and
rejected distinguished? State the consistency window, history retention and rate limits.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-04 — Identifier lifecycle

List every provider-generated order, booking, payment and transaction identifier, when it first
exists, where it appears in create response/read-back/callback, its scope, reuse rules and
production/demo differences.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-05 — Booking and payment state machine

Provide the current production state machine and identify terminal/reversible statuses for
accepted, rejected, failed, cancelled, expired, authorized, captured, settled, refunded, partially
refunded, reversed and charged back.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-06 — Immutable operation binding

Which immutable read-back fields bind merchant/tenant, actor/client, exercise/game,
booking/order/payment, merchant reference and provider transaction to the same operation?

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-07 — Amount, currency and allocation

Specify amount unit/scale/rounding and authoritative currency representation in write, read-back
and callback. Explain authorized, captured, settled, refunded, fee, net, tip,
reversal/chargeback and multiple-transaction fields. State whether one transaction or payment can
cover multiple positions or bookings, and identify the stable per-position or per-booking allocation
ID.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-08 — Callback authentication and integrity

First confirm whether Viva provides a distinct production payment-event callback/channel rather than
only a generic notification webhook. If it does, provide its authentication/integrity contract:
signature algorithm, canonical payload, covered headers, timestamp/nonce, allowed replay window, key
distribution and rotation, environment separation, and signed merchant/reference fields.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-09 — Callback delivery semantics

Provide callback event-ID scope, retry schedule, duplicate/order guarantees, old-after-new
behavior, acknowledgement status/body and non-2xx handling.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-10 — Authoritative versioned contract

Provide current production OpenAPI/API-reference and changelog URLs, exact supported version,
deprecation policy, and written confirmation of demo/sandbox versus production parity.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-11 — Production operational contract

Define production connect/request timeout expectations; 429 and `Retry-After`; retryable versus
nonretryable HTTP/provider/transport classes; rate-limit scope; maximum retry rate and horizon;
required exponential backoff/jitter; circuit-breaker trip, half-open and recovery probes;
read-after-write consistency; maintenance behavior; and provider SLOs.

**Viva response:**

**Version/environment and authoritative evidence:**

## VIVA-Q-12 — Logging, privacy and failure isolation

Define which provider correlation values may appear in logs/traces, their retention and redaction;
which merchant/reference/client/body fields are forbidden; allowed low-cardinality metric labels;
and how failure/rate-limit/circuit state is isolated per tenant, merchant and acquiring integration.

**Viva response:**

**Version/environment and authoritative evidence:**

## Response authority

Please provide the following details for the person authorizing the answers:

- full name:
- role/title:
- team/department:
- answer date:
- authoritative product/API version:
- applicable environment(s):
- authoritative document and attachment list:

Please do not include customer personal data, credentials, secrets or real transaction identifiers
in the response or examples. Synthetic examples are sufficient.

Thank you,

PadlHub Engineering
