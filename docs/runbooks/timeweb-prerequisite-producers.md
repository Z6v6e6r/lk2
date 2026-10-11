# Timeweb backup and observability prerequisite producers

Scope: `lk2.padlhub.su`, Timeweb server `8886471`, project `262717`. This runbook supplements the existing critical Web-only activation runbook with the old API retained; it does not authorize installation, execution, publication, notification sending or activation. These tools stay outside the enrolled controller source and its frozen eight-file compatibility bridge.

## Evidence levels and sequencing

LOCAL mock checks prove parsing, command scope and failure handling. They do not prove PostgreSQL entrypoint behavior, real panel extraction, channel delivery or production restore. CI source checks likewise do not supply PRODUCTION proof.

Freeze an eligible current source/controller/publication first. Resolve main drift before making a live dump: the published `2e5f79fd` candidate no longer matches main `941760f8`. Do not widen the compatibility bridge to make a candidate eligible. A merge of this producer PR is another source transition, requiring fresh eligibility checks. These historical SHAs identify the observed blocker, not a current source selection.

Prepare/verify monitoring and alert proof before scheduling the separately approved live backup near activation. Backup proof expires after one hour; final provider readback expires after 30 seconds. Do not create an unusable production-data artifact while an upstream gate is unresolved.

## Standalone backup tool

Files: `scripts/control-timeweb-database-backup.py`, `scripts/prepare-timeweb-database-backup-source.py`, mock regression suite and Vitest wrapper. The runtime entry is only:

```sh
/usr/bin/python3 -I -S -B /opt/phub/timeweb-beta/operator/tools/<approved-tool-commit>/control-timeweb-database-backup.py --execute /opt/phub/timeweb-beta/operator/database-backup-restore.json
```

Never run this command without exact-target approval and all gates below. The helper never deploys, pulls an image, restores into the live database, emits dump bytes, provisions credentials or alters the enrolled source/config. It writes a custom-format dump and an exact existing nine-field `PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1` receipt. A clean migration-ledger hash must match before dump, after dump, in the isolated restore and after cleanup.

The source query/dump sessions set `default_transaction_read_only=on` and use `--no-password`. User/database names are resolved inside the existing PostgreSQL container; no host database URL or password is accepted. Commands have bounded timeouts, fixed environment and redacted failure codes. Dump output has a child file-size limit in addition to capacity checks.

### Reviewed source and installation receipt

From an exact clean task checkout, after its commit is frozen:

```sh
python3 -I -S -B scripts/prepare-timeweb-database-backup-source.py /absolute/clean/checkout <approved-tool-commit> /private/task-output/source-proof.json
```

This is a LOCAL-only producer, not an installer. It disables Git replacement objects, hooks/fsmonitor and inherited Git configuration, refuses shallow/grafted/alternate object stores, pins the repository URL, and exports raw commit/root-tree/scripts-tree witnesses. Git object IDs, raw SHA-256 values and the script blob are independently recomputed. `toolProofSha256` binds the complete canonical proof. The repository numeric identity `1297548073` is a claim in this proof; the installation owner must separately verify it against read-only GitHub repository/PR/CI evidence for the exact approved head. A self-consistent Git chain alone does not prove review or repository membership.

Before a later installation, prepare a concrete root-only exclusive-copy plan, its SHA-256 and exact GitHub evidence. Verify the helper/proof bytes before copying. Install under `/opt/phub/timeweb-beta/operator/tools/<toolCommit>/` with secure root parents, helper `root:root 0755`, and `installation-receipt.json` `root:root 0600`, one hardlink each. The receipt has exactly:

- `schema: PHUB_TIMEWEB_BACKUP_INSTALLATION_V1`;
- `sourceProof`: complete source proof;
- `installedPath`, `installedAt` in millisecond UTC;
- `installationPlanSha256` of the independently reviewed installation plan;
- `metadata`: exact installed helper `dev`, `ino`, `uid`, `gid`, numeric `mode`, `nlink`, `size` from descriptor/readback.

Re-read both objects with `O_NOFOLLOW`, hash the receipt bytes, and preserve readback plus GitHub identity/CI/approval pointers privately. Runtime repeats provenance, inode/content custody and secure-parent checks before issuing the backup receipt and unlocking. No signing key is introduced. Installation itself is a separately approved server mutation; no installer has been executed during preparation.

### Closed operation request

Use exact `PHUB_TIMEWEB_BACKUP_OPERATION_V1` keys from `validate_operation`; unknown/duplicate fields fail. Bind the approved target, `toolCommit`, helper/proof/installation SHA-256 values, selected immutable `releaseId`/`controllerSha`/`controllerTree`/config SHA-256, full container-boundary SHA-256, exact baseline API/PostgreSQL identities, expiry and confirmation. The release has attempt `1`, expiry is 20–60 minutes at entry and is rechecked throughout. Confirmation is `BACKUP_RESTORE_<CANDIDATE_FIRST_12_UPPER>_KEEP_API_0D6078BE7A50`.

The accepted API/PostgreSQL baseline is deliberately the reviewed `0d6078be` runtime and fixed PostgreSQL digest/IDs/start times in the helper. Drift stops; do not edit a request to accept another live baseline without a reviewed source change. Produce the boundary hash using selected `INSPECT_FORMAT` data for **all** `docker ps -aq --no-trunc` IDs sorted lexically, encoded with compact JSON plus newline. Include stopped containers. Never export `.Config.Env`. Freshly verify HEAD/tree, clean root-owned source and exact config, source runtime/boundary, no running migrator, no delivery lock or prior transaction, local linux/amd64 restore image, available disk/RAM and current approval.

The request is exclusively installed as `root:root 0600` at the fixed path. Do not reuse a prior operation, expiry, dump directory or receipt.

### Required physical rehearsal before execution

A separate explicit approval must name a task-owned disposable fixture and the exact pinned local PostgreSQL image. No fixture was provisioned during this preparation. Exercise the helper's complete command contour: unprivileged `postgres` user, network `none`, read-only root, only the three exact tmpfs mounts, no bind/anonymous volumes or ports, dropped capabilities/no-new-privileges, no restart/auto-remove, PID/memory/swap/CPU caps. Test real create/start/readiness, custom dump TOC, full restore, ledger equality, graceful stop and removal. Verify Docker inspect normalization against the expected fields. Prove failure/reconciliation at every phase below. A generic PostgreSQL health smoke is insufficient.

The restore uses tmpfs and may retain decrypted business data on failure. The image's entrypoint must work under the exact isolation constraints; any mismatch is STOP, never a reason to relax isolation during production execution.

### Retained-state recovery matrix

The helper shares `/opt/phub/timeweb-beta/standard/active` as an exclusive **directory** with `backup-restore.json` ownership marker. Enrolled controllers must see it as occupied. Their existing automatic/manual `recover`/`reconcile` commands do not own this lock. Every failure retains state, emits STOP, and prohibits replay; no cleanup is inferred from a timeout.

| Last observed state                              | Required read-only reconciliation before a separately approved exact cleanup                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock directory, marker absent                    | Match recorded lock dev/ino and exclusive creation trace; empty lock without a marker is ambiguous, never auto-delete.                                                                                                     |
| Marker only / operation copy absent              | Verify marker bytes/operation/tool hashes, directory and marker identities, unchanged runtime/source, absence of any restore container/dump.                                                                               |
| Operation copied / dump intent or partial dump   | Verify immutable operation and phase records; identify the partial file by dev/ino/SHA/size; do not treat it as backup or restart dumping.                                                                                 |
| Restore create intent, create result uncertain   | Search exact recorded name/operation label; inspect identity and isolation before any stop/remove. No second create.                                                                                                       |
| Restore created/running/stopped                  | Match recorded full container ID, operation label, image and complete containment; inspect actual state. Stop/remove only that ID with renewed runtime/source proof.                                                       |
| Restore verified / dump renamed / receipt absent | Retain dump; ledger phase records do not authorize synthesizing a receipt or activation.                                                                                                                                   |
| Success receipt / container removal uncertain    | Verify dump/receipt/ledgers and identify the owned container or prove its absence. A receipt alone does not prove cleanup.                                                                                                 |
| Success cleanup record / lock retained           | Prove owned container absent, exact dump/receipt, unchanged runtime/source/tool/request, lock marker bytes/dev/ino and no foreign lock contents before unlinking that marker then removing the empty same-inode directory. |

Prepare the actual recovery command list from observed private receipts before approval. No `rm -rf`, broad container cleanup, live restore, deletion of foreign objects or automatic unlock. Rehearse interruption before/after each exclusive write, create/start/stop/remove and unlink/rmdir transition. The mock suite tests retained failures; this is not the physical recovery rehearsal.

## Private panel/channel capture protocol

`timeweb-observability-capture-bundle.js` is a pure preparation library with no filesystem/network access, writer or CLI. Its default adapter registry is empty; a complete input still fails `capture_adapter_unavailable`. Test-only synthetic adapters are confined to the test file. There is no operational path accepting adapter module paths, environment/argv trust switches or supplied normalized V1 readbacks.

The official documented Timeweb API supplies notification preferences but does not supply the monitor/incident history and recipient delivery/owner-observation proof needed here. Preference settings, webhook configuration, a screenshot, a sender API acceptance and a receipt hash alone do not prove delivery or current monitoring.

The first separately approved read-only session must establish:

1. Actual Timeweb account/project and panel raw export for monitors API `26ed404e-98e5-45c5-98e3-31b9dfd6f0f2` and Web `b25e28a0-02d8-49e4-a0a1-f49f62abc02c`; exact observed URL, raw format, tool-call ID when exposed, immutable resource IDs, configuration, consecutive provider check history, active/closed incident identity and provider times. Do not guess private APIs, inject cookies or read an unmasked Authorization value.
2. Actual selected recipient account/peer identities. Gmail: bounded complete search for the exact test/monitor event, raw RFC2822/MIME/message ID/internal timestamp and trusted sender/authentication metadata. Telegram: recipient-side account UI, exact peer/message identity, timezone and original message times/content. Bot send acceptance is insufficient. If search is incomplete, ambiguous, or cannot correlate a unique provider test identity, STOP.
3. Actual release-owner reply pointer stating they observed that same incident while active, after both deliveries and before recovery. Do not invent an ACK endpoint or fabricate a reply/time.
4. Raw export/tool-call pointer availability, capture custody/redaction review and the exact selectors/parser rules. Missing observable IDs or exportable raw bytes are STOP. An invented pointer or manually entered normalized field is not an adapter.

If one role needs several real tool calls (for example complete Gmail search plus raw message, or panel details plus history), preserve every original call/raw output. Revise the bundle schema before enrollment if its single-call envelope cannot represent that evidence; do not collapse constituent captures into a normalized boolean.

Add reviewed source-defined adapters only after these captures establish real formats. Adapters parse the raw bytes themselves and cross-check parsed origin/identity/time against the envelope. They must prove channel search completeness, sender/receiver identity, uniqueness, event correlation and provider predecessor-check links. If a required fact is absent from the real UI/channel, record the capability gap rather than inferring PASS. Adapter implementation is another in-scope reversible source iteration; it does not authorize reads, notification triggers or receipt enrollment.

### Closed private bundle

`PHUB_TIMEWEB_PRIVATE_CAPTURE_BUNDLE_V1` has only `schema`, exact target, approved reader audit ID and ten capture envelopes: three monitor rounds, provider incident active/closed, email alert/recovery, Telegram alert/recovery, and owner active reply. Each envelope has only role/kind/tool/callId/reader, observed source origin/immutable ID/URL, capturedAt, `raw/<role>.bin`, raw size and SHA-256. No canonical `monitors`, `deliveries`, counts, booleans, PASS or adapter override is accepted. The parser accepts an exact in-memory raw-file map, never opens an input path.

Hashes/tool traces are custody/audit links under the approved collector and root-owned input trust boundary, **not** origin authentication. Bundle metadata cannot override parsed facts. Capture exports may contain PII; keep them out of Git, PR bodies, CI artifacts, logs and shared environment files. No credential/cookie/header value is allowed in captures; stop and discard a contaminated private capture according to the owner's approved handling plan. Screenshots can support a private trace but never derive proof via OCR.

Derivation checks three advancing consecutive healthy provider checks, stable monitor configuration, zero active incidents, exact incident/test identities, distinct message identities, channel completeness/identity and the active owner reply. It then builds the existing exact V1 schemas and calls `validateUpgradeMonitoring` (pure validators only). Final capture must be no older than 30 seconds, monitor checks no older than 130 seconds; alert/recovery deliveries and owner observation keep the owning contract's deadlines. Import must preserve captured timestamps, never refresh them on copy/retry.

After adapters pass local/CI and independent review, prepare a separately approved root0600 canonical writer/enrollment and rehearse capture-to-import timing. This preparation intentionally supplies no such writer and creates no canonical server readback. Live collection, an induced incident/real alert, channel messages, paid operations, enrollment and Web activation each require the already defined exact-target authority. No monitoring automation is created.

## Checks and remaining evidence

Run focused Vitest tests and `python3 -I -S -B scripts/test-timeweb-database-backup.py`; all Docker/Git/server interfaces in pipeline scenarios are mocked and temporary files are task-owned. For this CRITICAL operational-code preparation also run the existing `npm run check`, configured secret/PII checks and independent security/release review. Use CI evidence for the exact task head; a missing local scanner is reported rather than silently claimed.

Remaining before live execution: current source decision/eligibility, exact installation plan/approval, physical pinned-image and phase-recovery rehearsal, actual private captures and reviewed adapters, canonical readback writer/enrollment, fresh bounded proofs and exact live approval. Neither preparation nor a green Draft PR authorizes a deploy.
