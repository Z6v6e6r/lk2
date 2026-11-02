# Native SELF LEAVE consumer

The Android and iOS game detail expose a dedicated SELF LEAVE panel. It reuses
`GameSelfLeaveAttempts`, including account-scoped public identifiers, the original key stored
before dispatch, Web Locks, result attribution and GET-only recovery after remount. It does not
expose another member's departure, waitlist, payment or result controls. Missing storage/locks or
recovery methods disables submission. An unresolved result, 404 or lost response keeps custody;
an explicit retry calls only the existing restrictive reconcile endpoint with the original key.

Native routes are exactly `DELETE /games/{id}/participants/me`,
`GET /games/{id}/leave-operation` and `POST /games/{id}/leave-operation/reconcile` under the
configured tenant API. JavaScript and Swift/Java validate the method, UUID, original key, bearer,
headers and absence of body/query. Session registries bind each request to its original principal,
epoch and access token before dispatch, after bridge completion and after SDK body decoding.
Identical concurrent mutations are rejected. Logout closes authority before its acknowledgement;
401, 503 and network failure never trigger automatic mutation replay or token refresh.

Empty Android POST/DELETE can otherwise acquire a form Content-Type from HttpsURLConnection.
The native builders explicitly use `text/plain`. The restrictive reconcile endpoint therefore
also accepts the parser's exact empty string only for `text/plain` with optional UTF-8 charset.
Whitespace, JSON/form bodies, other charset, query parameters and command data remain rejected.
The transport still sends zero body bytes. Fastify injection tests cover both valid empty wire
forms and those negatives. Browser/LK1 request behavior and provider ownership remain unchanged.

Rollback removes the native detail action/capability while retaining original operation keys and
server journals. Never delete attempts or issue compensating money operations as UI rollback.
The additive empty-text compatibility remains safe for older clients. No schema, provider flag,
payment configuration, live migration or signing change is needed. Synthetic source/CI evidence
is separate from real provider attribution, signed-device and production acceptance.
