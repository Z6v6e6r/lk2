# Gift certificate local sale sandbox

## Scope

This runbook validates the implemented catalog → order → local payment transition. It never charges
money and never issues, emails or activates a certificate.

## Runtime gates

Use only `APP_ENV=local` or `APP_ENV=ci` with:

```dotenv
GIFT_CERTIFICATE_PAYMENT_MODE=sandbox
GIFT_CERTIFICATE_MEDIA_ENABLED=true
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_BUCKET=padlhub-media
S3_ACCESS_KEY=padlhub
S3_SECRET_KEY=local-development-only
```

Configuration must fail closed if sandbox mode is set in staging or production, or if media is
enabled without the complete private-storage configuration.

## Verification

1. Apply migrations through `0029_gift_certificate_sale_sandbox.sql` to a clean local database.
2. Open the canonical local ЦУП at `http://127.0.0.1:3001/api/ui/admin`. Its
   `Сертификаты` module calls the PadlHub Admin API configured by
   `PADLHUB_NOTIFICATION_API_BASE_URL=http://127.0.0.1:3000` and requires the `admin` role plus
   `gift_certificates.catalog.read`, `gift_certificates.catalog.manage` and
   `gift_certificates.catalog.publish`. Upload a JPEG, PNG or WebP design, save the draft and
   publish it. The standalone client on port `5174` remains a development harness.
3. Read the public catalog and confirm that its design contains only a stable `/public/api/...`
   media path.
4. Create a public order with an `Idempotency-Key`. Confirm that the response amount matches the
   selected server denomination and that a scoped HttpOnly purchase cookie is set.
5. Retry the same command and verify the same order is returned with `replayed=true`.
6. Create a payment intent, open its relative sandbox URL and confirm it.
7. Verify the order is `PAID`, payment is `CONFIRMED`, and exactly one
   `commerce.payment.confirmed.v1` outbox row exists for the payment.
8. Confirm that audit and outbox JSON contain neither buyer/recipient email nor message.

After rebuilding the local ЦУП container, test the public surface at
`http://127.0.0.1:5173/giftcard` and the authenticated surface at
`http://127.0.0.1:5173/gift-certificates`.

## Failure and rollback

Set `GIFT_CERTIFICATE_PAYMENT_MODE=disabled` to remove all payment-intent, hosted-page and confirm
capability. Set `GIFT_CERTIFICATE_MEDIA_ENABLED=false` to disable upload and signed media reads.
These flags do not mutate existing rows. Do not delete or manually mark orders paid; use a later
audited support command once that operational slice exists.
