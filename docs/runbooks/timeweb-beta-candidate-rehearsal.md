# Timeweb beta candidate rehearsal

## Safety boundary

This runbook exercises a release candidate on the local Docker daemon only. The harness accepts
synthetic secrets, binds the proxy to a random loopback port, creates a unique Compose project and
project-scoped volumes, and removes its containers, networks, volumes, and temporary environment
files at the end. It never connects to Timeweb, Viva, a shared database, or a provider. It does not
publish images, dispatch workflows, migrate a shared database, activate Worker, or edit the Node
bootstrap controller.

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
  --expected-source-tree '<40-hex-source-tree>'
```

The artifact directory must contain exactly the canonical `release-manifest.json` and matching
`release-manifest.sha256` identities used by the publication contract. A wrong SHA, tree, workflow
SHA, digest, component set, source-material identity, checksum, or mutable tag fails closed before
startup. Registry existence and immutability still require authenticated GHCR evidence.

## Rehearsed sequence

The command performs these stages and stops on the first mismatch:

1. Validate the canonical Timeweb deployment, target, environment, and candidate-manifest
   contracts; generate synthetic runtime environment files with all command capabilities off.
2. Render the dedicated rehearsal Compose file and build local application images, or pull the
   exact manifest digests. A deliberate API-before-dependencies start must remain unready.
3. Start PostgreSQL, Redis, and RabbitMQ; migrate an empty database to HEAD; repeat the migration as
   a no-op; prepare a previous-schema fixture and advance it to HEAD.
4. Start API and Web through the local reverse proxy. Prove Worker is absent until explicitly named,
   then start it with every write-capable runtime flag disabled.
5. Verify running Web/API/Worker image identity, source SHA/tree, release labels, health, Web root,
   API readiness, and a read-only invalid-tenant boundary.
6. Run headless-Chrome fixtures at mobile width 375 and desktop width 1440 across login, home,
   profile, games list, game detail, notifications, and chats. Direct-refresh game detail must settle
   without an infinite spinner or error boundary.
7. Restart API and Worker, verify health/readback and advanced start timestamps, repeat startup and
   prove service container identities are unchanged, then verify graceful stop and recovery.
8. Switch API/Web/proxy back to a distinct previous release identity and prove health while the
   migration ledger stays unchanged.

Browser fixtures block every same-origin write except synthetic session refresh. A passing run emits:

```ini
CREATE_ATTEMPTS=0
JOIN_ATTEMPTS=0
PAYMENT_ATTEMPTS=0
PROVIDER_WRITES=0
OTHER_WRITE_ATTEMPTS=0
UNKNOWN_READS=0
```

## Rollback contract

Database migration is forward-only. Rollback switches application identity and never runs a down
migration or changes the ledger. Local source mode currently uses the candidate binaries under a
distinct previous-release label, so it proves the switching, health, and no-database-rollback
mechanism. Full binary compatibility is proved only when an operator supplies a separately verified
previous immutable candidate; that remains an explicit morning evidence gate.

## Failure-mode map

- Missing, malformed, forbidden, or unexpectedly enabled runtime environment: stop before Compose.
- Wrong component/digest/source/tree/release identity: stop before or at runtime readback.
- API healthy before dependencies: fail the start-order negative control.
- Empty/previous/no-op migration mismatch: stop before application startup.
- Worker auto-start, unhealthy component, changed second-start container, or failed graceful stop:
  fail the runtime rehearsal.
- Browser exception, spinner, error boundary, missing route marker, unknown read, or any write
  counter above zero: fail the browser smoke.
- Rollback ledger drift or previous identity/health mismatch: fail rollback verification.

The command's `IMMUTABLE_CANDIDATE=VERIFIED` result is possible only in canonical artifact mode.
Local source mode reports `UNVERIFIED_LOCAL_SOURCE` and must not be presented as publication proof.
