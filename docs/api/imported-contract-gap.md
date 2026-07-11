# Imported contract gap

The existing `openapi.yaml` is a useful business draft but not a safe canonical contract for the new platform.

## Already aligned

- It describes PadlHub business scenarios instead of Viva DTOs.
- It does not publish Viva URLs or external references.
- It uses a common error schema and sends money in minor units.

## Blocking gaps

- one `/api/v1` namespace instead of user/admin/internal boundaries;
- no mandatory tenant path/context;
- JWT has no PadlHub issuer, audience or required claims contract;
- domain identifiers are arbitrary strings rather than PadlHub UUIDs;
- no `Idempotency-Key` on critical commands;
- no response-wide correlation header contract;
- no 429/Retry-After contract;
- no audit metadata for critical mutations;
- staff and user cancellation are mixed;
- OpenAPI 3.0.3 rather than the target 3.1 format.

The immutable import is stored under `contracts/imported/`. New routes are introduced only after the corresponding migration-map entry has tenant, auth, UUID, idempotency, error, rate-limit and audit semantics.
