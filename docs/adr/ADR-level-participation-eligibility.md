# ADR: Level participation eligibility

Status: Accepted for foundation; activation constrained
Date: 2026-08-16

## Context

Legacy PadlHub flows mixed participation, subscription applicability and payment steps. Level information was available to clients but was not an authoritative shared rule. Multiple repositories use different level representations and one legacy numeric-to-grade mapping conflicts with the current CUP/UI mapping.

## Decision

### Separate participation and payment eligibility

Level is a Participation Eligibility rule. It runs after state/duplicate/capacity and invitation validation, but before subscription/payment rules. A personal invitation bypasses only `LEVEL_RANGE`; it cannot bypass capacity, lifecycle, duplicate, security, subscription or payment requirements.

### Canonical implementation

The pure deterministic algorithm lives once in `packages/domain/src/participation-eligibility.ts`. Server commands and CUP preview import it. React, Node-RED, `ph-ab` and legacy clients must not reimplement the formula. Cross-technology/legacy consumers use PadlHub API/OpenAPI/SDK contracts.

### Server authority and transaction boundary

The final command derives actor/tenant from JWT and loads player level, activity constraint, policy and invitation from local trusted storage. Game join, waitlist join and waitlist promotion evaluate immediately before mutation within the tenant transaction. Client precheck is UX only.

Legacy and cross-service writers use the internal participation-command boundary instead of a
browser endpoint. The caller is authenticated by a dedicated exact-tenant server credential and may
submit only canonical PadlHub actor/activity IDs plus the requested action. It cannot submit level,
rank, policy, constraint, invitation, bypass or eligibility outcome. The authorization is durable,
idempotent and expires unless the trusted writer acknowledges `APPLIED` or `FAILED`. A writer adapter
must derive the canonical actor from its already authenticated session; browser-supplied identity is
not authoritative.

### Canonical scale

Eligibility uses `levelId` and integer `rank`, never a display string comparison. The first PADEL scale preserves the actual existing order: D, D+, C, C+, B, B+, A. Scale rows and player assignments carry `scaleVersion`. New scale versions are additive; historical decisions retain their version.

The current CUP Mongo rating ledger remains an upstream operational source during migration. This ADR does not declare a new numeric rating formula. Only normalized labels are seeded into the participation projection until an explicit mapping/sync contract is approved.

### Policy

Policy key: tenant + sport + activity type (GAME, TOURNAMENT, TRAINING). Fields include mode, asymmetric tolerance, missing/legacy actions and waitlist recheck. Bounds are inclusive:

```text
effectiveMinRank = minRank - lowerToleranceSteps
effectiveMaxRank = maxRank + upperToleranceSteps
allowed = playerRank >= effectiveMinRank && playerRank <= effectiveMaxRank
```

Publishing is explicit, versioned, optimistic, idempotent and audited. Rollback publishes a new version copied from history. Personal-invite and organizer-creation bypasses are system invariants displayed read-only in CUP.

### Missing and unknown player level

- Missing assignment: `PLAYER_LEVEL_REQUIRED`.
- Expected but unparseable/unmappable assignment: `PLAYER_LEVEL_UNKNOWN`.
- Valid known level outside effective range: `LEVEL_NOT_ALLOWED`.

The LK must offer SELF_DECLARED and ONBOARDING flows and preserve the activity return context. That UX is an activation dependency, not a reason to weaken the server rule.

The authenticated self-service command derives the player from JWT and always records
`SELF_DECLARED`; callers cannot submit `playerId`, `rank`, `source` or assessment facts.
`ONBOARDING` is written only by the trusted PadlHub assessment command. The browser receives
question, option and branch identifiers, but no score operations, caps, thresholds or result
fields. It submits only the selected option IDs. The server validates the exact visible branch,
rejects missing, hidden, duplicate or unknown answers, computes the numeric result with the
versioned domain assessment and maps the derived label through the active canonical scale. Actor,
tenant and provenance come from the JWT and command implementation. A legacy client assertion is
not sufficient evidence for that source.

The assessment algorithm lives once in `packages/domain/src/level-assessment.ts`. Its public
definition and completion payload are deliberately asymmetric: clients can render the flow but
cannot claim a score, label, rank, source or player identity. Assessment versions are immutable;
an unsupported version fails closed and requires the client to reload the current definition.

### Invitations

Only a server-loaded PERSONAL invitation for the same tenant/activity/recipient, active, unrevoked, unexpired and under its use limit can produce `PERSONAL_INVITE_BYPASS`. Public link, community and team invitations never do. ADMIN is a separate future RBAC/audit override.

### Organizer creation

Activity creation and automatic organizer participation may return `ORGANIZER_CREATION_BYPASS`; ordinary later rejoin cannot. An informational `ORGANIZER_OUTSIDE_LEVEL_RANGE` may be shown without blocking or changing the range.

### Legacy constraints

One normalization adapter will translate supported legacy fields. Non-contiguous `accessLevels` is invalid rather than guessed. Text extraction is tagged `LEGACY_TEXT_FALLBACK` and is never allowed to hard-block. New activities must use canonical IDs.

### Payments

Starting a paid reservation stores an immutable decision snapshot linked to the operation. Callback/recovery uses that snapshot and does not reject because level, scale, range or policy changed after payment started. A new payment attempt gets a new decision.

### Existing registrations

No existing participant is deleted, no payment/refund is triggered, and completed activities are not recalculated. When a range changes, existing out-of-range participants remain and appear only in impact reporting.

### Waitlist

Join is checked. Promotion rechecks in the final transaction. A denied candidate leaves the active queue with a durable reason and processing continues. A saved personal invitation is revalidated, not trusted from the earlier result.

### Rollout and compatibility

Modes are OFF, SHADOW, WARN and BLOCK. Initial rows are OFF/zero. Old clients remain compatible because `invitationId` is optional and structured reason codes are additive. Activation is independent per tenant/sport/activity and rollback requires no application release.

`OFF` still stores an auditable SKIP decision for a final command so paid operations can have an exact snapshot. It does not change the user outcome.

## Data model

New `eligibility` schema tables:

- `canonical_levels`
- `player_sport_levels`
- `player_level_commands`
- `level_policies`
- `policy_commands`
- `activation_readiness`
- `personal_invitations`
- `decisions`
- `payment_snapshots`
- `activity_level_projections`
- `participation_commands`

Game rows gain sport and canonical range IDs. Roster rows reference their decision; waitlist entries also retain the personal invitation ID for revalidation.

## Observability

Every evaluated rule persists a decision and emits structured telemetry. OTEL counters use bounded labels only: tenant, sport, activity type, mode, outcome, reason and constraint source. Player/activity IDs are structured-log fields, not metric labels.

## Consequences

Positive:

- One formula and stable reason codes.
- Final game mutation is protected against client tampering and TOCTOU.
- Policy can roll forward/back without deployment.
- Paid game intent freezes the admission decision.

Costs and constraints:

- A local sport-level projection must be kept fresh.
- The trusted assessment updates PadlHub profile and eligibility projections; a separate outbox or
  adapter is still required if Viva must display the same value during the transition.
- Legacy writers must be routed before BLOCK.
- Tournament/training commands and their callback/recovery integration still require migration;
  the legacy game callback bridge is implemented only as a default-off deployment candidate and
  still needs callback-loss reconciliation.
- Decision storage adds write volume; retention/aggregation must be monitored in SHADOW.

## Rejected alternatives

- React-only validation: bypassable and stale.
- A second formula in Node-RED/ph-ab: guarantees drift.
- Synchronous Viva lookup per attempt: adds provider load and availability coupling.
- Text level comparison or implicit numeric-to-grade conversion: mappings already conflict.
- Treating any invite link as PERSONAL: recipient/tenant/activity evidence is absent.
- Rechecking level at payment callback without a snapshot: breaks already-started operations.

## Activation gates

BLOCK is rejected by the policy repository until the writer, player projection, client recovery and payment recovery gates carry evidence for that exact tenant/sport/activity. The audited blockers in `docs/audits/level-eligibility-current-state.md` define what is required to mark those gates ready.
