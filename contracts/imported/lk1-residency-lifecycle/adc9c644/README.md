# LK1 residency lifecycle owner — imported snapshot

- Source: `Z6v6e6r/lk`, PR #443 (Draft), commit `adc9c64464ff25c679459b66bfff9cd00b82e1b2`.
- Files (byte-identical, verified by `SOURCE.sha256` in `apps/web/src/residency-owner.test-helper.ts`):
  - `node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs`
  - `node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-http.mjs`
- `*.d.mts` files are local type declarations for TypeScript tests; they are not part of the
  source and are not hashed.

Purpose: LK2 web tests drive the real owner state machine and HTTP contract through a synthetic
LK2 consumer transport and the real `@phub/api-sdk` client. This is test evidence only. It is
not runtime code, it is not the LK2 server consumer, and it performs no provider call.

Update only by replacing the files with a newer reviewed owner commit, refreshing
`SOURCE.sha256` and renaming this directory to the new short SHA.
