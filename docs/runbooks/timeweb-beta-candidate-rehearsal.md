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

Run the complete local source rehearsal from a clean candidate commit:

```sh
npm run test:timeweb-beta-candidate
```

Use the fast static preflight while editing:

```sh
npm run test:timeweb-beta-candidate -- --contract-only
```

After an authenticated operator downloads the canonical V2 publication artifact, rehearse those
exact immutable digests without rebuilding the application images:

```sh
npm run test:timeweb-beta-candidate -- \
  --manifest-dir /absolute/path/to/canonical-artifact \
  --expected-source-sha '<40-hex-source-sha>' \
  --expected-source-tree '<40-hex-source-tree>' \
  --expected-publication-run-id '<successful-run-id>' \
  --expected-manifest-checksum '<64-hex-release-manifest-sha256>'
```

The artifact directory must contain exactly the canonical `release-manifest.json` and matching
`release-manifest.sha256` identities used by the publication contract. A wrong SHA, tree, workflow
SHA, digest, component set, source-material identity, checksum, or mutable tag fails closed before
startup. The run ID and manifest checksum must be frozen from authenticated canonical publication
evidence, not copied back from the artifact under test. Registry inventory and tag mapping remain a
separate authenticated GHCR gate.

To prove previous-schema migration and application rollback with real previous binaries, add the
separately frozen previous canonical artifact and its independently observed identities:

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

## Rehearsed sequence

The command performs these stages and stops on the first mismatch:

1. Validate the canonical Timeweb deployment, target, environment, and candidate-manifest
   contracts; generate synthetic runtime environment files with all command capabilities off.
2. Render the dedicated rehearsal Compose file and build local application images, or pull the
   exact manifest digests. A deliberate API-before-dependencies start must remain unready.
3. Start PostgreSQL, Redis, and RabbitMQ; migrate an empty database to HEAD; repeat the migration as
   a no-op; and compare the ordered filename/checksum ledger exactly. With a previous artifact, run
   its exact migrator on a second empty database and then advance it with the candidate migrator.
   Without one, the weaker source-only path is explicitly reported as `PASS_SYNTHETIC_HEAD_MINUS_ONE`.
   The empty-catalog acknowledgement is scoped to an isolated empty-database invocation only.
4. Start API and Web through the local reverse proxy. Prove Worker is absent until explicitly named,
   then start it with every write-capable runtime flag disabled.
5. Verify running Web/API/Worker image identity, source SHA/tree, release labels, health, Web root,
   API readiness, and a read-only invalid-tenant boundary.
6. Run headless-Chrome fixtures at mobile width 375 and desktop width 1440 across login, home,
   profile, games list, game detail, notifications, and chats. Direct-refresh game detail must settle
   without an infinite spinner or error boundary.
7. Restart API and Worker, verify health/readback and advanced start timestamps, repeat startup and
   prove service container identities are unchanged, then verify graceful stop and recovery.
8. With a previous artifact, switch API/Worker/Web to its exact digest-qualified images and prove
   health while the exact migration ledger stays unchanged. Without it, exercise only the
   control-plane identity switch and report `ROLLBACK_REHEARSAL=UNVERIFIED_PREVIOUS_BINARIES`.

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
ordered filename/checksum ledger before and after the application switch. Local source mode uses
the candidate binaries under a distinct control-plane identity, so it proves only switching,
health, and no-database-rollback mechanics; it cannot emit rollback PASS. Full binary compatibility
is proved only when the separately verified previous manifest and digest images are supplied.

## Failure-mode map

- Missing, malformed, forbidden, or unexpectedly enabled runtime environment: stop before Compose.
- Wrong component/digest/source/tree/release identity: stop before or at runtime readback.
- API healthy before dependencies: fail the start-order negative control.
- Empty/previous/no-op migration mismatch: stop before application startup.
- Worker auto-start, unhealthy component, changed second-start container, or failed graceful stop:
  fail the runtime rehearsal.
- Browser exception, spinner, error boundary, missing route marker, request failure, HTTP 5xx,
  blocked external/non-read request, unknown read, or any write counter above zero: fail the smoke.
- Rollback ledger drift or previous identity/health mismatch: fail rollback verification.

The command's `IMMUTABLE_CANDIDATE=VERIFIED_WITH_CALLER_FROZEN_PUBLICATION_EVIDENCE` result is
possible only in canonical artifact mode with an independently supplied run ID and checksum. It is
not proof that the run is still the latest successful publication; freeze that fact immediately
before the rehearsal. Local source mode reports `UNVERIFIED_LOCAL_SOURCE` and must not be presented
as publication proof.
