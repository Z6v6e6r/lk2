# Timeweb CUP player-level pilot

Scope is `local-padel` on the production Timeweb lane. This source preparation is not an
activation, host enrollment, or privileged operation receipt. Keep the public ingress and its
pinned adapted hash unchanged. The retired `lk2-beta-lane` uses the production database identity.
Its local dump and listing check are not evidence of an independently restored backup.

## Restore and migration admission

Use a fresh read-only target, PostgreSQL major/version, database size, ledger and owner/ACL
readback. The historical full-restore disk profile has an 18 GiB source ceiling. Use a separately
admitted external encrypted scratch/retention target for a larger database. The release owner
must bind that host and transport identity into the existing Timeweb backup custody. Stream the
archive from one exported read-only PostgreSQL snapshot, with no large plaintext file on
Timeweb. Bind the same snapshot to the ledger, account/session/delegation and identity witnesses.
Verify archive bytes, SHA-256, readable TOC and full isolated `pg_restore --exit-on-error` on
anchored PostgreSQL 16 with no application access. Verify content, catalog, owner, ACL and RLS
against that same snapshot. Seal fresh evidence and release only the operation's own locks.
A synthetic replay is local evidence. The exact external restore route and its live receipt must
be admitted by the Timeweb controller before a production transition.

Production 0119 is a separate exact operation, with the existing Timeweb executor and host
lease. Generic populated migration and the retired beta migration mode refuse pending 0119.
Foundation-checked empty catalogs can still bootstrap. Bind the immutable candidate, backup
receipt, ledger and table preimage to one attempt. Use the same PostgreSQL advisory key
`7140221` as the ordinary migrator, bounded lock/statement timeouts and the verified owner
context. The operation applies just `0119_cup_calculated_player_levels.sql` and adds its ledger
row in one transaction. Any mismatch in pre/postchecks rolls back DDL and ledger together.

| Input          | Expected on the observed Timeweb lane                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Initial ledger | 122 rows through 0118, sorted `filename\tchecksum\n` SHA-256 `7f89ae797f3981e8ca347ee36a135739ecd23c6a072f25624b212c46dbbf397e` |
| Migration      | `f4b3b75576a67940fc5fb874cb5855675a6782e398803bee5316b4b75ac95b31`                                                              |
| Final ledger   | 123 rows, sorted TSV SHA-256 `135185893ad4716e42ffdf8db6f148dc5b7c7ec2af7bf4acea4ec515419f9963`                                 |
| Table          | Exact old validated three-event check, verified owner and unchanged table identity, ACL and FORCE RLS                           |
| Result         | Exact widened 21-event check; `NOT VALID` keeps it enforced for new writes and avoids rescanning the table                      |

The ledger hashes use a different serialization from the existing backup producer's JSON
prefix. Preserve the selected receipt's source serialization as well as the migration TSV
witness. Preserve existing ACL/grantors and role membership. If the existing authorized identity
cannot own the exact transaction, stop for separate owner admission. Missing or uncertain ACK
requires read-only reconciliation of that attempt, ledger and catalog, with no automatic retry.
Application rollback retains the expanded constraint and migration history.

### Exact 0119 exception for the retained schedule archive

The `--critical-cup-0119` profile is only for migration bytes from `2105e3e03d68`
on the currently pinned Timeweb database and the `43d4bd64e5ae` application baseline.
It requires a separately reviewed and enrolled controller. The root-only request lives
at `/opt/phub/timeweb-beta/operator/cup-0119-migration.json`. Its schema
`PHUB_TIMEWEB_CUP_0119_REQUEST_V1` binds a new v4 attempt ID, exact enrolled
`controllerSha`, exact `migrationSourceSha`, running `postgresContainerId`, UTC
`expiresAt` within an hour, and `retainedBackupReceiptSha256`.

Set `externalRestoreDecision` to an object with status
`OWNER_WAIVED_EXTERNAL_RESTORE_FOR_CUP_0119`, the enrolled `owner`, and the
`referenceSha256` of the explicit owner decision. The decision applies to this schema
operation. The controller verifies the named local archive and its receipt without
requiring an independent restore of that archive. Retain its actual archive time and
unrestored status in recovery evidence. Application releases still use their own
backup admission.

Use the exact enrolled controller with `--critical-cup-0119` and the request path.
It claims the common migrations executor and both host markers, records the catalog
fingerprint and intent before SQL, then compares the exact committed ledger and catalog
before sealing a receipt. A normal PostgreSQL rollback is terminal only after an exact
preimage readback. On uncertain exit use `--critical-cup-0119-reconcile` with the same
request. Reconciliation never applies the SQL. If the launch was recorded and exact
preimage remains without a terminal rollback receipt, keep the markers and reconcile
the client/backend before any lock cleanup.

The shared test-stand updater also uses the ordinary packaged migrator. On an existing 122-row
stand, schedule that stand's separate migration admission before the updater. An empty
disposable stand can bootstrap normally. This runbook does not authorize a shared stand reset.

## Closed ingress

The prepared pair in `deploy/timeweb/cup-level-pilot/` uses the CUP sender's existing HTTP
loopback option. The CUP bridge dials one private endpoint with mTLS and verifies the dedicated
server CA and exact SNI. Timeweb checks a dedicated CUP client CA, requires client TLS
authentication and forwards one exact `POST /internal/api/v1/local-padel/player-level-projections`
to the verified API candidate. Both proxies reject path variants and remove caller-supplied
forwarding and certificate assertion headers. LK2 retains its integration-token, tenant, payload
and idempotency checks. The selected player pair is scoped by CUP; the receiver independently
resolves the current active Viva mapping.

The public Caddy and its 80/443 contract stay on their current source. A future private listener
needs an exact non-public, non-wildcard bind, an approved data-plane route from CUP and source
firewall restriction to the authorized peer. Management connectivity alone does not establish
this route. Run `node deploy/timeweb/cup-level-pilot/validate-config.js timeweb private` on
Timeweb's admitted values and `node deploy/timeweb/cup-level-pilot/validate-config.js cup private`
on the CUP side. Require the exact adapted hashes, matching host/SNI and a CUP upstream equal
to the Timeweb listener in the activation receipt. The validator
permits a private IPv4 data-plane address, a high port and a single upstream, with the Timeweb API
named `api-pilot`. It loads the configuration to verify it and opens no listener. Use `stand` for
the loopback fixture. Keep the candidate API distinct from the existing public alias. The
standard runtime environment contract does not enroll
the pilot's separate secret overlay. Prepare and admit it separately with
`CUP_PLAYER_LEVEL_PROJECTION_ENABLED`, exact `CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY` and a
root-custodied `CUP_PLAYER_LEVEL_PROJECTION_TOKEN_FILE` mounted to the candidate API, plus a
dedicated service certificate. Keep local tournament commands, Worker/Realtime rollout and
public reader switching outside that ingress operation. Use a trusted production image digest,
approved secret paths and an exact target check before permitting any peer.

Keep feature flags OFF until the backup, 0119 and proxy receipts are admitted. The private API
writes the shared `profile.user_summaries` and `eligibility.player_sport_levels`. These records can
be visible to the existing public reader. Use an isolated database for a pilot whose public data
must stay unchanged. For a future live pilot, capture the selected player's current public read
and obtain separate approval for that player's visible change. Verify the CUP pair against the
live linked user and the idle target queue before enabling the receiver, then enable only the
CUP pilot sender. Reconcile uncertain delivery by the same event and revision.
Stop on target drift, unverified certificate, wrong tenant, remap, retry/circuit growth or
unknown ACK. For pause, stop the sender, then the ingress. Keep persisted projections and schema.

References for the proxy syntax are the [Caddy TLS directive](https://caddyserver.com/docs/caddyfile/directives/tls)
and [Caddy HTTP transport](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
