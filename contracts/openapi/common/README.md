# Canonical contract components

Shared OpenAPI 3.1 components live here. The current read-only baseline includes:

- PadlHub UUID identifiers;
- tenant path context;
- correlation request/response headers;
- rate-limit and retry headers;
- standard error envelopes.

Issuer/audience-specific schemes remain in each boundary root. Idempotency and audit extensions must be added with the first critical command; those operations remain blocked in the migration map until then.

Do not reference the imported OpenAPI 3.0.3 document directly. Normalize each operation through the migration map.
