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

## Original provider-history capture protocol (unsupported by the observed panel)

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

## Alternative: reviewed direct probes and recipient observations

The approved collection change is implemented in `scripts/timeweb-direct-recipient-evidence.js` with its declaration and regression suite. It is a **pure preparation producer**, with no IO, CLI, native-format adapter, enrollment or controller integration. The old provider-history path above is unchanged and never falls back to this format. No expired callback exception, frozen controller path list or delivery permission is changed.

The output is `PHUB_TIMEWEB_DIRECT_RECIPIENT_PREPARATION_V1`, with purpose `PREPARATION_ONLY_NOT_FOR_ACTIVATION`. Its trust is explicitly `APPROVED_READER_HUMAN_REVIEW_V1`. Hashes bind custody and reviewed assertions; they do not authenticate Gmail/Telegram senders, the reader, the owner or an operator transition. No provider check history, active-incident count, region-health result or provider incident identity is emitted. Receipt hashes are private personal-data fingerprints, not anonymization: keep **both input and output** root-owned 0600 outside Git, PR/CI artifacts and logs.

### Operation-specific review policy

`parseDirectRecipientPolicy` accepts the exact closed `PHUB_TIMEWEB_DIRECT_RECIPIENT_POLICY_V1` fields in the declaration. The fixed target is LK2/server `8886471`/project `262717`. Bind exact source SHA/tree/release, operation and contract SHA-256, and the independently checked collector-source SHA-256. Use a fresh 128-bit nonce generated by the trusted execution owner; the pure library does not generate or enroll it. Pin the approved reader, selected Gmail and Telegram account/sender/peer identities and actual release-owner identity/role. The owner's Telegram account must be the selected recipient account. A different owner peer (for example Saved Messages) needs the separate `owner-account` original account/export capture; it is not inferred from a display name or a forwarded quote.

Monitor expectations retain the two exact IDs/names/HTTPS URLs, GET/200, enabled state, two distinct named regions, 60s interval, 10s timeout, Authorization **configured** (never its value), and enabled email/Telegram. Actual panel assertions are labeled `OPERATOR_ATTESTED_PANEL_CONFIGURATION` and bind the original AX/DOM capture plus the exact expected-configuration hash. This is human-attested configuration, not a native parser or provider ledger. No screenshot/OCR conversion is allowed.

A new private policy starts `state: UNENROLLED`, `templates: null`, `captureReviewSha256: null`. Building evidence then fails `CORRELATION_CAPABILITY_UNPROVEN`. **Do not prefill notification templates.** After a separately authorized real collection, an independent reviewer checks the actual source records and every assertion. Only the exact reviewed operation can use `REVIEWED_PRIVATE_INPUT`, with literal email/Telegram alert/recovery templates and the entire capture-review SHA-256. Templates allow only `{{nonce}}`, `{{monitorName}}`, optionally `{{monitorUrl}}`; the first two occur once. No regex, glob, code/module path or caller adapter is accepted. Alert and recovery templates must differ and match the complete reviewed text exactly. This state is a LOCAL parsing/review state, not production enrollment or permission.

The caller supplies an independently trusted policy SHA plus the exact operation binding/nonce/reader in `expected`. It must not obtain those authority pins from the incoming bundle. `directRecipientCaptureReviewSha256` only computes a custody digest; computing it does not perform review. This iteration supplies no root writer or authenticated operational caller.

**Feasibility remains unproven:** native Timeweb alert and recovery messages must actually carry the nonce. A policy or metadata field cannot insert it into a provider message. The current account/profile and empty complete Gmail search do not prove this capability. If a provider-supported test facility or temporary configuration is needed, prepare and obtain separate authority for that concrete change and its recovery first. If no native correlation mechanism is available, STOP; changing to timestamp-only correlation is outside this policy.

### Original captures and assertions

The closed bundle is `PHUB_TIMEWEB_DIRECT_RECIPIENT_CAPTURE_V1`: exact target, policy and operation hashes, nonce, reader, `captures`, and `gmailSearch`. The in-memory file map is exact; the library opens no paths. A capture has only role/kind/toolVersion/callId/reader/capturedAt/rawFile/rawSize/rawSha256/assertion. Use the actual exposed call pointer and exact tool/Desktop version; invented IDs or export versions are not evidence. Preserve every original raw call/export, including account context and search pages, then human-review assertions against those bytes. Unsupported source formats remain a review/access gap, not permission to synthesize a native adapter.

There are 18 fixed roles plus 1–20 Gmail pages:

- `panel-configuration`: original panel configuration and its human-attested configuration hash.
- `direct-observation`: original direct-probe sample object and a human assertion binding fixed target, full operation/source/collector binding, nonce and trust label.
- `gmail-account`: the selected recipient account's original profile record and account assertion.
- `owner-account`: original Telegram account/export context for the explicit owner's account, identity and peer.
- For each `api` and `web`: `trigger`, `recovery-start`, `owner-active`, `email-alert`, `email-recovery`, `telegram-alert`, `telegram-recovery`.
- `gmail-search-1` through the exact final page.

Operator trigger/recovery assertions have source `APPROVED_OPERATOR_TRANSITION_LOWER_BOUND_V1`, exact monitor/event/operation/nonce and original time. The raw trace must demonstrate that each time is **before or at** the actual corresponding failure/recovery transition. A manually chosen later timestamp understates delay and is invalid. This producer labels these as operator-attested lower bounds, never provider incident times. No operator trace was executed during preparation.

Message assertions have source `APPROVED_READER_HUMAN_REVIEW_V1`, immutable original message ID, exact account/sender/peer (email peer is null), original recorded time, monitor ID, ALERT/RECOVERY/OWNER_ACTIVE and exact reviewed text. Keep native Gmail IDs/thread/internal timestamps/raw MIME/authentication trace, and Telegram account/chat/from/message IDs/date/text/export context in the original bytes. Assertions are reviewed against these records; this module does **not** claim a tested native connector/export parser or independent sender authentication. Distinct message identity is required within each account/peer/channel. Shared Telegram export call IDs require identical raw hash/size, capture time and tool version for all referenced roles; differing exports need distinct actual call IDs.

`gmailSearch` contains the exact bounded query, `windowEndAt`, and consecutive page roles. The query is `after:<earliest-trigger-seconds-minus-1> before:<window-end-seconds-plus-1> in:anywhere "<nonce>"`. The cutoff is fixed at collection, not refreshed at later review. Each original page must have the same query, chained request/next tokens and message IDs; the final next token is null. The complete ID set must be exactly the four email alert/recovery messages for the two monitors. Missing, extra, duplicate or ambiguous records fail. Search scope includes Spam/Trash; no unrelated mailbox search is authorized by this schema.

### Timing and direct probes

For each monitor, both recipient observations must be captured within 300s of the witnessed trigger lower bound. `capturedAt` is a conservative **delivered-by upper bound**, never a native arrival timestamp. Telegram `date_unixtime` and email sender Date alone do not prove arrival. Retrospective exports cannot invent an earlier capture; when no trustworthy recipient arrival timestamp exists, collect the original recipient-side records during the active drill. Requiring this is deliberately stricter than equating send time to delivery.

The authentic owner's original message must follow both recipient observations, occur within 600s of the trigger, and precede the recovery lower bound. The fixed reply text states active observation and contains monitor name, exact operation hash and nonce. A later capture of that original owner message is allowed; an automatically generated owner file, generic approval or quoted/forwarded reply is not. Both recovery recipient observations must occur within 300s of the recovery lower bound, after it. Original message times must precede their capture times and stay in the corresponding lifecycle order.

Consume the four-probe, 61-round, 900s sample shape returned by existing `observeCriticalWeb`; do not run activation to obtain a capture and do not add a second probe loop. This preparation validates monotonic recorded sample order, bounded gaps, successful-probe latencies and the existing p95 API/Web thresholds after both recovery deliveries. The assertion binds the approved target/source/operation/collector but remains human-reviewed. The raw latency-only object does **not** prove API/Web image/container identity or restart invariants. Current controller `observation.json` adds `installedWeb` and is not this pure input shape; it cannot be silently stripped or presented as a standalone read-only collector result. A later separately reviewed operational collector must reuse the existing function with safe read-only attest/probe seams and preserve original raw identity/restart attestations. No such collector was enrolled or run here.

Human review may occur within 24h of original captures; timestamps are preserved and never refreshed. This is a preparation review window, **not** the controller's 30s final monitoring/identity freshness gate. Before any eventual activation, the adopted controller must separately establish fresh health/identity/backup evidence and durable nonce non-reuse. Bundle-local identity/hash checks are not persistent replay protection.

### Later adoption gates

Before this format can support delivery, establish actual nonce/template feasibility and authentic original captures; review and approve an exact root0600 collector/writer/enrollment plan with failure/retained-state rehearsal; implement and independently review explicit controller policy/operation/receipt adoption; select a new exact eligible runtime anchor rather than widening the frozen eight-file tail; and obtain exact authority for any provider test/settings, notifications/owner messages, installation, publication and activation. Keep fresh backup/isolated restore, runtime identity, readiness, rollback and recovery-delivery checks. This PR changes none of the enrolled controller's gates and creates no canonical production readback.

## Checks and remaining evidence

Run focused Vitest tests and `python3 -I -S -B scripts/test-timeweb-database-backup.py`; all Docker/Git/server interfaces in pipeline scenarios are mocked and temporary files are task-owned. For this CRITICAL operational-code preparation also run the existing `npm run check`, configured secret/PII checks and independent security/release review. Use CI evidence for the exact task head; a missing local scanner is reported rather than silently claimed.

Remaining before live execution: current source decision/eligibility, exact installation plan/approval, physical pinned-image and phase-recovery rehearsal, real private captures and native nonce/template feasibility, independently reviewed original-record assertions or fixed native adapters, canonical collector/writer and explicit new-policy adoption, fresh bounded proofs and exact live approval. Neither preparation nor a green Draft PR authorizes a deploy.
