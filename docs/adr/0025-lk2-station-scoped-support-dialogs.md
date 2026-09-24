# ADR 0025: Station-scoped support dialogs for LK2

Status: Proposed

Extends [ADR 0024](0024-station-support-dialogs-bridge.md), which keeps the station tab a bridge to the
LK1 support contour that CUP operators already answer.

## Context

The LK2 «Станции» tab already lists every published station as its own chat destination, and the bridge
already addresses a dialog by station. The store does not: a client has one open dialog per connector,
and the station is an attribute that moves. The product wants the LK2 half to become one dialog per
station, while the CUP operator answers only in the dialog of their own station and can still read the
same client's dialogs with other stations. LK1 must keep its current single-dialog behaviour.

Facts verified against the live contour and the two implementations before writing this ADR:

- `https://padlhub.su/lk/support/*` is served by the NestJS/Express support API (`ph-ab`), not by the
  Node-RED flow that ships in the legacy LK1 project. The dialog resolver therefore lives in
  `SupportService`, and the Node-RED `pickDialog` is not the live resolution path.
- The live ingest rejects an undeclared property
  (`{"message":["property <name> should not exist"],"error":"Bad Request","statusCode":400}`), so a new
  event field must be declared server-side before any client sends it. The live DTO also requires
  `connector`, while the local checkout marks it optional: the deployed revision must be aligned with the
  source before the contract changes.
- `SupportConnectorRegistry.resolveRoute` resolves only declared routes, and the Mongo read path falls
  back to `LK_WEB_MESSENGER` for an unknown value. The bridge sends `connector: 'WEB_LK'`, so LK2 traffic
  is currently indistinguishable from LK1 traffic in CUP.
- `SupportService.findOrCreateOpenDialog` collapses open dialogs through
  `collapseOpenDialogs(client.id, connector)` and moves the dialog's station only when
  `explicitSelectedStationId` is present (or when the dialog is still `UNASSIGNED`). The bridge sends
  `stationId`/`stationName` but not `selectedStationId`, so a message to station B is filed into the
  client's existing station-A dialog and CUP shows it under A.
- The CUP write/read policy already exists: `SupportDialog.writeStationIds` (answer only for the dialog's
  own station), `readOnlyStationIds`, `canAccessDialog` (permission-scoped station list from access
  rules), `isActiveForUser`/`isReadOnlyForUser` on the summary, and an internal
  `listDialogsForClient(clientId)`. `SupportDialogFilters` exposes only `connector` and `stationId`.
- `SupportDialog.accessStationIds` already keeps every station a dialog has ever been assigned to, which
  is the existing precedent for "the station that lost the dialog keeps read access".

## Decision

Dialog identity for LK2 station traffic becomes `(tenant, client, connector, scope = STATION, station)`.
LK1 keeps `(tenant, client, connector)`. The target state:

- a station dialog is created for the exact station of the event and is never moved to another station;
- the operator of a station writes only in that station's dialog; the client's other station dialogs are
  readable read-only, with the existing `writeStationIds`/`readOnlyStationIds` and `canAccessDialog`
  machinery doing the enforcement server-side;
- CUP gains a client view that lists every dialog of the client across stations, and the composer stays
  disabled in a read-only dialog.

## Slices

Each slice is independently reversible and ordered expand first. No slice requires a data migration.

**Slice 0 — contract expand, no behaviour change (the safe first slice).**
Declare `dialogScope?: 'CLIENT' | 'STATION'` (optional, default `CLIENT`) on the ingest DTO of the
deployed support API, carry it through connector normalization into `SupportDialog.dialogScope`, and
persist it. Nothing reads it yet, so LK1 and LK2 behaviour is byte-for-byte identical.
Acceptance: an event without the field behaves exactly as today; the field survives persistence and is
returned on the dialog summary; an undeclared property is still refused; the deployed revision's
`connector` requirement is reconciled with the source.

**Slice 1 — LK2 declares its scope.**
The bridge sends `dialogScope: 'STATION'` together with the explicit station on every station event,
behind a tenant flag. It must not be enabled before slice 0 is deployed, otherwise the whitelist refuses
the event.
Acceptance: with the flag off, the outbound body is unchanged; with it on, a scoped event is accepted and
stored with `dialogScope = STATION`.

**Slice 2 — resolution per scope.**
`collapseOpenDialogs` keys scoped dialogs by `(client, connector, station)`; a scoped event with no
matching station dialog creates one instead of falling back to the client's other dialog; scoped dialogs
never move their station, and `explicitSelectedStationId` is ignored for them. The legacy path stays
untouched.
Acceptance: two stations produce two dialogs with their own message history; an LK1 event still resolves
to its single dialog and still moves the station on explicit selection.

**Slice 3 — client read model.**
Expose the client's dialogs (siblings) with their station and last activity, add `clientId` to
`SupportDialogFilters`, and enforce read access through the existing station scope. Every cross-station
read is audited.
Acceptance: an operator of station A reads B's dialog without being able to write into it, and an
operator outside both scopes reads neither.

**Slice 4 — CUP presentation.**
Client card listing all dialogs by station, a read-only banner driven by `isReadOnlyForUser`, and a
composer disabled outside the writable dialog.

**Optional backfill.** Legacy messages already carry `stationId`, so LK2-originated history can be
grouped into per-station dialogs idempotently. `UNASSIGNED` messages are not attributed. LK1 dialogs are
left alone; the cutover starts the scoped model going forward.

## Consequences

- LK1 keeps one dialog per client and its station-move semantics; the widget, its quick replies, ACL and
  connector assignment are untouched.
- The station tab keeps working across the change: its read model enumerates the viewer's dialogs and
  joins the published station list, and the send path already selects a dialog by station with no
  fallback.
- CUP keeps one inbox. Station dialogs of one client appear as separate rows, and the operator's station
  scope decides which of them is writable.
- Cross-station reading widens who sees a client's correspondence. That is a product and privacy
  decision, not a free consequence: it needs the explicit rule (tenant-bounded, staff with
  `dialogs:read`, station in scope), an audit event per cross-station read, and optionally a dedicated
  permission such as `dialogs:read-cross-station`.

## Known limitations and open questions

- The deployed support API revision must be inspected before slice 0: the live DTO requires `connector`
  while the local source marks it optional, so the contract change has to start from the deployed shape.
- Whether LK2 should later get its own connector route (`LK2_WEB_MESSENGER`) instead of sharing
  `LK_WEB_MESSENGER` is deferred. A separate connector gives a clean operator queue, metrics and quick
  replies, but it also means connector configuration and operator ACL work; the scope field delivers the
  product outcome with a much smaller blast radius.
- The flag that gates slices 1–2 needs an owner, an activation criterion (paired deployment of API and
  web) and a removal or review condition, per the repository flag policy.
- Attachments and unread state follow the dialog, so they become per-station automatically once dialogs
  are per-station; this is desirable but changes what "unread" means in the CUP list.
- The bridge's outbound body is pinned by
  `apps/api/src/support/station-support-provider.test.ts` (exact key list), so slice 1 cannot be merged
  by accident without a deliberate test update.

## Verification

- Slice 0: DTO tests for the optional field, whitelist refusal of unknown properties, persistence and
  summary propagation, plus a characterization test proving the legacy event path is unchanged.
- Slice 1: provider test asserting the exact outbound key list with and without the flag; a contract test
  that the field name matches the declared contract.
- Slice 2: resolver tests for create-per-station, no-move, legacy collapse and station move on explicit
  selection.
- Slice 3: authorization tests for writable/read-only/denied dialog reads plus the audit event.
- Slice 4: rendered CUP check of the client card and the disabled composer for a read-only dialog.

## Alternatives considered

- **Keep one dialog and only show a per-station timeline.** Rejected: attachments, unread state and
  history stay mixed, and the LK2 thread would still be a relabeled view of one provider dialog.
- **Put every LK2 station dialog into the native PadlHub `SUPPORT` conversation model.** This remains the
  documented target of ADR 0024, but it needs the membership/privacy decision and a CUP workspace, and it
  would move operators out of the workspace they use today. Station-scoped dialogs in the shared contour
  deliver the product outcome without that move.
- **Send `selectedStationId` from the bridge and keep one dialog.** Rejected: it makes CUP relabel the
  single dialog on every write — that is the LK1 behaviour the product explicitly wants LK2 to leave,
  and it would hide, not fix, the missing per-station identity.
- **Rely on the Node-RED flow's `pickDialog`.** Rejected: that flow is not the live resolution path on
  `padlhub.su`; implementing the change there would ship a no-op and split the model across two
  implementations.
