# LK2 commercial CREATE60 / JOIN60 acceptance on lk2.padlhub.su

Status: source only. Nothing here has been run against lk2. Every write below is a live,
irreversible external operation and needs the owner's explicit approval for that exact action.

## What is live on lk2 and what is not known

- Release `44743866…` (PR #601 merge) runs in project `phub-timeweb-beta`, env root
  `/etc/phub/timeweb-beta` ([beta lane](lk2-beta-lane.md), readback 2026-11-06). That release
  already contains the quarter CREATE routes and the commercial JOIN runtime.
- PR #602 (runtime contract for the quarter CREATE keys) is merged into main as `2740f8d3`
  (owner approval recorded in the PR, 2026-11-06).
- Host: `phub-timeweb-staging` (tailnet `100.77.212.57`, host key pinned in
  `deploy/timeweb/target.json`). Root SSH needs the operator's own key; a session without it
  stops here instead of obtaining access.
- The values in `api.env` (`VIVA_MODE`, commercial flags, delegation keys) are **not recorded in
  Git** and were not read. Read them on the host, names and non-secret values only:

  ```sh
  sudo awk -F= '/^(VIVA_MODE|VIVA_OAUTH_ENABLED|VIVA_AUTH_TENANT_KEY|VIVA_DIRECT_READ_ENABLED|GAMES_(READ|COMMANDS)_ENABLED|GAME_COMMERCIAL_[A-Z_]+|SUBSCRIPTION_RUNTIME_(WARN_MODE|BASE_URL|DELEGATION_ACTIVE_KEY_ID|DELEGATION_ISSUER|DELEGATION_AUDIENCE)|LEGACY_GAMES_PUBLIC_BASE_URL)=/{print} /^(SUBSCRIPTION_RUNTIME_(INTEGRATION_TOKEN|DELEGATION_PRIVATE_KEYS))=/{print $1"=<set>"}' /etc/phub/timeweb-beta/api.env
  ```

- The only admitted owner is `https://padlhub.su/`, the **live LK1** executor. A confirmed CREATE
  books a real whole-court window in Viva and writes off one visit of the organizer's real
  subscription; a confirmed JOIN writes off the joiner's visit. Code rollback reverses neither;
  refunds stay manual (first-version mode).

## Readback 2026-11-06 (owner ran the command above on the host)

Present: `VIVA_MODE=production`, `VIVA_OAUTH_ENABLED=true`, `GAMES_READ_ENABLED=true`,
`GAMES_COMMANDS_ENABLED=true`, `VIVA_DIRECT_READ_ENABLED=true`, `SUBSCRIPTION_RUNTIME_WARN_MODE=OFF`.
Absent and covered by config defaults: `VIVA_AUTH_TENANT_KEY` (`iSkq6G`),
`LEGACY_GAMES_PUBLIC_BASE_URL` (`https://padlhub.su`), `VIVA_END_USER_API_URL`.
Absent and **blocking**: every `GAME_COMMERCIAL_*` key and the whole
`SUBSCRIPTION_RUNTIME_DELEGATION_*` set (private keys, active key id, issuer, audience); for JOIN
also `SUBSCRIPTION_RUNTIME_BASE_URL` and the integration token. The delegation keyring is signing
material paired with the live LK1 verifier: LK1 must trust its public key, issuer and audience
before LK2 can sign a single request. That pairing is a separate owner-approved credential change
on both sides, not an `api.env` edit alone.

## Required `api.env` values

CREATE (transport `QUARTER_OWNER`, enforced by `packages/config`):

| Key                                                      | Value                                          |
| -------------------------------------------------------- | ---------------------------------------------- |
| `GAMES_READ_ENABLED`, `GAMES_COMMANDS_ENABLED`           | `true`                                         |
| `GAME_COMMERCIAL_CREATE_ENABLED`                         | `true`                                         |
| `GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT`                 | `QUARTER_OWNER`                                |
| `GAME_COMMERCIAL_CREATE_OWNER_BASE_URL`                  | `https://padlhub.su/`                          |
| `GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS`                | `5000` (100–5000)                              |
| `VIVA_OAUTH_ENABLED` / `VIVA_AUTH_TENANT_KEY`            | `true` / `iSkq6G`                              |
| `VIVA_MODE`                                              | `production` (or `sandbox`; `mock` is refused) |
| `SUBSCRIPTION_RUNTIME_DELEGATION_*` (keys, id, iss, aud) | the keyring LK1 verifies                       |

JOIN additionally: `GAME_COMMERCIAL_JOIN_ENABLED=true`,
`GAME_COMMERCIAL_JOIN_OWNER_BASE_URL=https://padlhub.su/`, `SUBSCRIPTION_RUNTIME_WARN_MODE=WARN`
with its base URL and integration token, and the join-conditions owner
(`VIVA_DIRECT_READ_ENABLED=true`, `VIVA_END_USER_API_URL=https://api.vivacrm.ru/end-user/api`,
`LEGACY_GAMES_PUBLIC_BASE_URL=https://padlhub.su`). Without any of them the routes keep answering
`GAME_PAYMENT_REQUIRED`.

Writing these keys through the provisioner needs PR #602 (runtime-environment contract) merged;
the beta lane itself does not validate the contract, it only reuses `api.env`.

## Activation and rollback

1. Owner approves and merges #602. Pick a main SHA with green `Pull request checks` and
   `Test stand`.
2. **Approval A — env write:** add the keys above to `/etc/phub/timeweb-beta/api.env` (0600, root).
3. **Approval B — promote:** `sudo deploy/timeweb/lk2-beta-lane.sh plan <sha>`, then
   `promote <sha>`. A config error fails readiness and the lane rolls back automatically.
4. Read-only acceptance (books nothing): each test user signs in on lk2 themselves and exports
   their own access token, then

   ```sh
   PHUB_ORGANIZER_TOKEN=… PHUB_JOINER_TOKEN=… \
   PHUB_ORGANIZER_SUBSCRIPTION_ID=… PHUB_JOINER_SUBSCRIPTION_ID=… \
   PHUB_QUARTER_STATION_ID=… PHUB_QUARTER_COURT_ID=… PHUB_QUARTER_STARTS_AT=2026-11-10T09:00:00.000Z \
   npm run lk2:commercial-acceptance
   ```

5. **Approval C — one real CREATE:** the same command with `--create` (one court, one slot, one
   visit). **Approval D — one real JOIN:** `--join` on the created game or `PHUB_JOIN_GAME_ID`.
6. Rollback: set `GAME_COMMERCIAL_CREATE_ENABLED=false`, remove the transport line, set
   `GAME_COMMERCIAL_JOIN_ENABLED=false`, restart the API (or `lk2-beta-lane.sh rollback`).
   Bookings already confirmed are cancelled in LK1/Viva by hand.

## What the script proves

Read-only: capability open, the court is offered, both subscriptions are active with remaining
units, join conditions apply the joiner's subscription (eligibility, free/paid minutes, price).
`--create`: the owner confirms, the result echoes the original operation (key hash, station,
court, start, subscription), the projected game is 60 minutes with the caller as organizer, one
visit is written off. `--join`: the operation succeeds with a Viva receipt, the joiner is a
participant, one visit is written off. Keys persist in `LK2_ACCEPTANCE_STATE`; a rerun reads the
same operation, an `UNKNOWN` create is reconciled with the same key and body, never re-created.

Open risk: join conditions resolve the LK1 game mapping; a game created by the quarter owner may
not be joinable until its LK1 projection exists. If JOIN reports `UNAVAILABLE`, use an existing
LK1 game via `PHUB_JOIN_GAME_ID`.
