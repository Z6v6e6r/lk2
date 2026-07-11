# API contracts

`openapi.yaml` at the repository root is the non-canonical Cabinet API migration draft. The byte-for-byte source supplied with the workspace is preserved separately under `contracts/imported/cabinet-api/0.2.0/`.

Only the OpenAPI 3.1 contracts under `contracts/openapi/` are canonical. Generated client types currently expose the first read-only user boundary. Admin and internal roots exist but intentionally advertise no operations until their authorization, audit and idempotency controls are implemented. The migration map in `contracts/migration-map.yaml` keeps every imported operation blocked or routed explicitly.

Run:

```bash
npm run contracts:lint
npm run contracts:generate
```
