# Tournament owner consumer and QA boundary

CUP is authoritative for canonical level and saved tournament rule. Local cached LK2 level is no
longer a second admission decision before a local tournament command. The existing CUP adapter
prepare/read/dispatch and durable operation custody remain unchanged. Owner rejection receipts add
level/gender reasons to the domain and OpenAPI enum, and repeat the original operation without a
new command. Existing native local tournaments stay CUP_CUSTOM; no paid Viva consumer is invented.

Deploy the additive receipt reader before the CUP writer if a phased deployment is authorized.
Unknown or unavailable owner evidence remains unknown; do not clear custody or switch to direct
Viva. No residency server/SDK/UI, platform CI, deployment or ingress file was changed here.

## QA Hermes handoff

- D-1 legacy residency-purchase route finding is obsolete; current owner consumer belongs to
  DeepSeek, UI/SDK to Claude. This branch does not add fake residency pass routes.
- D-3: `gift-certificate-full-app-idempotency.test.ts` builds actual app.ts (only active session and
  repository are synthetic). Both user/public payment-intents requests without the key return 400
  IDEMPOTENCY_KEY_REQUIRED before repository invocation. No production certificate payment code
  changed. The bare-route test from #683 omits the middleware and cannot establish an app-level bug.
- D-2: Jetson ingress explicitly routes health and public/user/admin API prefixes to api:3000 and
  everything else to the web SPA. The API-domain upstream template sends all paths to API. Thus a
  stale `/lk/residency/passes` request may receive SPA HTML on the combined host; this does not prove
  an API endpoint exists. Keep global SPA fallback for client routes. Owner/platform must confirm
  the consumer's exact mounted API prefix before any narrow ingress patch; none is justified from
  a guessed path. Test the actual approved API route for JSON (including JSON errors), client UI
  route for HTML, and unrelated client route for working SPA navigation. No deploy/** edit here.

On our disposable PostgreSQL 16 database, #683 capacity scenarios passed (capacity 2 and 4,
parallel actor joins and same-actor race). These test games.capacity, not CUP maxPlayers or rating.
Initial activation suite produced 4 audit rows where the old test expected 3. During the task the
Hermes worktree was independently corrected to assert QUOTED, DISPATCH_STARTED, PAYMENT_PENDING,
PAID; the rerun passed all 8 scenarios. We did not modify any of the six Hermes files. Evidence
uses head 52113b355a80515750cd03a016f3f3f0248899b9 plus the owner's then-uncommitted activation-test
correction; do not attribute that corrected working-tree test to the original immutable head.

CUP separately tests real Mongo maxPlayers holds, mixed admin/checkout writers, same-timestamp
CAS, durable receipts, recovery and canonical admission. P0 direct Viva/widget bypass remains
open pending provider enforcement; local or CI green is insufficient.

## Checks

```sh
npm run check
npx vitest run apps/api/src/tournaments/tournament-local-runtime.test.ts packages/domain/src/tournament-local.test.ts packages/legacy-games-adapter/src/tournament-local-owner.test.ts apps/api/src/gift-certificates/gift-certificate-full-app-idempotency.test.ts
```

Use actual Node 22 from .nvmrc; verify `node --version` because host node@22 symlink pointed to
Node 25 during this task. Full source checks and targeted checks are reported separately. Provider,
deployed API/SPA, mobile/browser end-to-end and runtime integration were not executed.

## Terminal refusal client compatibility (2026-11-18)

The browser attempt parser now accepts all six agreed CUP level/gender REJECTED reasons.
The panel explains each reason, offers level setup for missing/unknown level, and permits
an explicit new JOIN after a verified terminal receipt clears local custody. An HTTP error,
unknown/malformed result, lost response or missing read result still preserves the original
key. Repeated reads can recover a durable refusal without a second command.

`apps/web/src/tournament-refusal-flow.test.tsx` composes the actual CUP owner transport/parser,
API runtime, SDK, browser attempt store and rendered panel, with a synthetic CUP response and
in-memory repository. It checks six reasons, repeated read, new keys after resolution and a
lost browser ACK. This is LOCAL composition evidence, not a live CUP/API HTTP, real-browser,
STAGING or PROVIDER acceptance test. Existing unknown-result and account-change regressions
remain. Production certificate code and Hermes QA files are unchanged.
