# Timeweb beta candidate rehearsal

## Safety boundary

This runbook exercises a release candidate on the local Docker daemon only. The harness accepts
synthetic secrets, binds the proxy to a random loopback port, creates a unique Compose project and
project-scoped volumes, and removes its containers, networks, volumes, and temporary environment
files at the end. It never connects to Timeweb, Viva, a shared database, or a provider. It does not
publish images, dispatch workflows, migrate a shared database, activate Worker, or edit the Node
bootstrap controller.

The command rejects every ambient `DOCKER_*` or `COMPOSE_*` variable, resolves the active Docker
context with a scrubbed environment, and requires its endpoint to be a local Unix socket. A TCP,
SSH, or otherwise remote Docker endpoint is a hard stop before any container is created.

Do not supply production environment files. Exact published-image mode accepts only the canonical
two-file publication artifact and digest-qualified component images.

## One command

Use the fast static preflight while editing:

```sh
npm run test:timeweb-beta-candidate -- --contract-only
```

The complete one-command release confidence gate requires both the candidate artifact and a
distinct verified previous candidate. Missing, partial, same-candidate, or unverified previous
evidence is rejected before Docker startup. After an authenticated operator downloads both
canonical V2 publication artifacts, run:

```sh
npm run test:timeweb-beta-candidate -- \
  --manifest-dir /absolute/path/to/candidate-artifact \
  --expected-source-sha '<candidate-sha>' \
  --expected-source-tree '<candidate-tree>' \
  --expected-publication-run-id '<candidate-run-id>' \
  --expected-manifest-checksum '<candidate-manifest-sha256>' \
  --previous-manifest-dir /absolute/path/to/previous-artifact \
  --expected-previous-source-sha '<previous-sha>' \
  --expected-previous-source-tree '<previous-tree>' \
  --expected-previous-publication-run-id '<previous-run-id>' \
  --expected-previous-manifest-checksum '<previous-manifest-sha256>'
```

Each artifact directory must contain exactly the canonical `release-manifest.json` and matching
`release-manifest.sha256` identities used by the publication contract. A wrong SHA, tree, workflow
SHA, digest, component set, source-material identity, checksum, mutable tag, or previous candidate
that reuses the current source/tree or component images fails closed before startup. The run IDs and
manifest checksums must be frozen from authenticated canonical publication evidence, not copied
back from the artifacts under test. Registry inventory and tag mapping remain a separate
authenticated GHCR gate.

## Rehearsed sequence

The command performs these stages and stops on the first mismatch:

1. Validate the canonical Timeweb deployment, target, environment, and candidate-manifest
   contracts; generate synthetic runtime environment files with all command capabilities off.
2. Render the dedicated rehearsal Compose file, build the local-only proxy, and pull the exact
   candidate and previous manifest digests. A deliberate API-before-dependencies start must remain
   unready.
3. Start PostgreSQL, Redis, and RabbitMQ; migrate an empty database to HEAD; repeat the migration as
   a no-op; and compare the ordered filename/checksum ledger exactly. Run the exact previous
   migrator on a second empty database, then advance it with the candidate migrator and repeat that
   migration as a no-op. The empty-catalog acknowledgement is scoped to isolated empty-database
   invocations only.
4. Start API, Realtime, and Web through the local reverse proxy. Prove Worker is absent until
   explicitly named, then start it with every write-capable runtime flag disabled.
5. Verify running Web/API/Realtime/Worker image identity, source SHA/tree, release labels, health,
   Web root, API and Realtime readiness, and a read-only invalid-tenant boundary.
6. Run headless-Chrome fixtures at mobile width 375 and desktop width 1440 across login, home,
   profile, games list, game detail, notifications, and chats. Direct-refresh game detail must settle
   without an infinite spinner or error boundary.
7. Restart API, Realtime, Worker, Web, and the proxy; verify health/readback and advanced start
   timestamps; repeat startup and prove service container identities are unchanged; then verify a
   full graceful stop and readiness recovery.
8. Switch API/Realtime/Worker/Web to the distinct previous candidate's exact digest-qualified
   images and prove health while the exact migration ledger stays unchanged.

Browser fixtures synthetically answer enumerated API reads, intercept all browser network requests,
and allow only loopback document/static GET/HEAD traffic. Cross-origin traffic, beacons, forms,
XHR/fetch writes, unknown reads, request failures, HTTP 5xx responses, and every same-origin write
other than synthetic session refresh fail the run. A passing run emits:

```ini
CREATE_ATTEMPTS=0
JOIN_ATTEMPTS=0
PAYMENT_ATTEMPTS=0
PROVIDER_WRITES=0
OTHER_WRITE_ATTEMPTS=0
UNKNOWN_READS=0
```

## Rollback contract

Database migration is forward-only. Rollback never runs a down migration and compares the full
ordered filename/checksum ledger before and after the application switch. The gate emits rollback
PASS only after the separately verified, distinct previous manifest and all five digest images have
been supplied, started, identity-checked, and found healthy.

## Failure-mode map

- Missing, malformed, forbidden, or unexpectedly enabled runtime environment: stop before Compose.
- Wrong component/digest/source/tree/release identity: stop before or at runtime readback.
- API healthy before dependencies: fail the start-order negative control.
- Empty/previous/no-op migration mismatch: stop before application startup.
- Worker auto-start, unhealthy Web/API/Realtime/Worker, changed second-start container, or failed
  graceful stop: fail the runtime rehearsal.
- Browser exception, spinner, error boundary, missing route marker, request failure, HTTP 5xx,
  blocked external/non-read request, unknown read, or any write counter above zero: fail the smoke.
- Rollback ledger drift or previous identity/health mismatch: fail rollback verification.

The command's `IMMUTABLE_CANDIDATE=VERIFIED_WITH_CALLER_FROZEN_PUBLICATION_EVIDENCE` result is
possible only with independently supplied run IDs and checksums. It is not proof that either run is
still the selected publication; freeze that fact immediately before the rehearsal.
