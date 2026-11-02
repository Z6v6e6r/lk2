# Native owner profile settings

Android and iOS expose the existing owner-scoped privacy and booking-preferences
PUT contracts. Web SDK behavior, backend authorization and LK1 remain unchanged.
The native capability accepts only these two resources, exact typed fields,
version preconditions, allowed headers and a resource-specific idempotency key.
It cannot choose another user, tenant, provider or profile mutation.

A canonical body plus resource produces a deterministic SHA-256 command key.
An explicit retry of the same version/body reconstructs the same key after a lost
acknowledgement; a different body uses a different key and remains subject to the
server's version CAS. No automatic PUT replay or 401 refresh occurs. A failed
request does not claim successful persistence. Server receipts and audit/outbox
remain the authority; native clients do not maintain a second settings store.

Every command holds its original principal and access token through bridge fetch
and SDK JSON decoding. An obsolete response cannot populate the current account's
cache or UI. A new session may start its own attempt while an old session is still
pending; old completion cannot remove the new attempt's ownership. UI requests are
retired on account/session changes and unmount. Native GET bypasses the Web settings
cache so a reopened profile reads canonical versions.

Synthetic tests cover strict bodies and namespace boundaries, duplicate dispatch,
401/409/network failures, explicit same-key retry, token rotation during response
decoding, old/new attempt overlap, and Android/iOS profile form saves. Swift and
Java independently validate the request before native networking. CI additionally
requires all three Android settings tests in the native report. Local DOM tests
are not rendered-browser or signed-device acceptance. No real settings, provider,
credentials, deployment or store operations are part of this change.

Rollback is source reversion of this native capability and its consumers; there
is no migration, backfill, new configuration or backend contract change.

The existing profile history link also resolves on iOS. It uses the existing
self-only authenticated GET, a native limit of 100, and rejects a response whose
userId differs from the cabinet owner. No arbitrary user selector, rating mutation
or public identity read is added. History errors retain an explicit reload action.
