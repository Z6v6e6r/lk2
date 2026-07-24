# Gift certificate issuance and delivery sandbox

## Scope

This runbook proves the local/CI path from a verified sandbox payment to one issued certificate, a
private PDF download and a sandboxed email-delivery journal. It sends no email and creates no
spendable credit.

## Runtime gates

Use only local or CI values and a random local-only HMAC secret:

```dotenv
APP_ENV=local
GIFT_CERTIFICATE_PAYMENT_MODE=sandbox
GIFT_CERTIFICATE_ISSUANCE_ENABLED=true
GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET=<random value of at least 32 characters>
GIFT_CERTIFICATE_DELIVERY_MODE=sandbox
GIFT_CERTIFICATE_MEDIA_ENABLED=true
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_BUCKET=padlhub-media
S3_ACCESS_KEY=padlhub
S3_SECRET_KEY=<local development credential>
```

Do not rotate the activation HMAC secret while a certificate is `PREPARING`. Configuration rejects
missing object storage, a missing secret, sandbox delivery outside local/CI, or delivery without
issuance.

## Verification

1. Apply migrations through `0032_gift_certificate_design_overlay_coordinates.sql` to a clean
   PostgreSQL database.
2. Start API, worker, RabbitMQ and private object storage with the gates above.
3. Complete catalog → order → sandbox payment confirmation.
4. Confirm the issuer queue acknowledges `commerce.payment.confirmed.v1` and the order gets exactly
   one certificate row, one ready artifact and one `gift.certificate.issued.v1` fact.
5. Open the return link. Polling must change from “выпускаем” to “готов”, and PDF download must
   succeed only with the buyer JWT or guest purchase cookie.
6. Render the PDF and confirm the artwork fills the first page and only the server amount and code
   are added at the selected design's percentage coordinates. The code must not appear in API JSON,
   audit, outbox or logs.
7. Confirm immediate delivery becomes `SANDBOXED`; a future scheduled delivery stays `PENDING`
   until `available_at`.
8. Replay the payment event. Certificate/artifact/delivery counts and issued-event count must remain
   one.

The repository verification command for a disposable migrated database is:

```bash
npm run gift-certificates:sale:verify
```

## Failure and rollback

Set `GIFT_CERTIFICATE_ISSUANCE_ENABLED=false` and
`GIFT_CERTIFICATE_DELIVERY_MODE=disabled`, then restart API and worker. Existing rows and private
objects remain recoverable; new payment facts remain in the broker/dead-letter path for controlled
replay. Do not delete certificates or rewrite `ISSUED` to `PREPARING`. Diagnose object storage,
restore the same HMAC secret, then replay the original fact through the documented broker operation.
