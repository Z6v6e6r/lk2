# Communities Architecture Definition Pack

- Версия: v0.2
- Дата: 2026-08-03
- Владелец: Communities Staff Architect
- Статус: Architecture Runway Week 1; product configuration approved, Gate A `CONDITIONAL-GO`
- План: [communities-architecture-team-plan.md](../plans/communities-architecture-team-plan.md)
- Аудит: [2026-08-03-communities-full-architecture-audit.md](../audits/2026-08-03-communities-full-architecture-audit.md)
- Context map: [communities-domain-context-map.drawio](communities-domain-context-map.drawio)

## 1. Назначение документа

Этот pack фиксирует только доказанные или явно утверждённые решения. Неизвестные продуктовые правила
помечаются `DECISION_NEEDED` и не превращаются во временные enum, API или database default.

Статусы evidence:

- `EVIDENCE` — подтверждено кодом, схемой, аудитом или решением пользователя;
- `APPROVED_BASELINE` — утверждено планом архитектуры;
- `ASSUMPTION` — расчётный envelope для spike, не production fact;
- `DECISION_NEEDED` — требуется решение владельца продукта;
- `NOT_ENOUGH_EVIDENCE` — требуется измерение или operational proof.

## 2. Текущий Gate A verdict

Архитектурный baseline, capability scope и конфигурация P0-A…P0-G приняты владельцем продукта.
Разрешены вертикальные срезы, которые не зависят от оставшихся неизвестных. Полный Gate A ещё не
закрыт для moderation/production GA, потому что требуют ответа:

1. operational DRI/SLA для очереди модерации в ЦУП;
2. RPO/RTO и production load evidence;
3. SEO indexing policy для `PUBLIC` communities.

До этих решений разрешены:

- canonical read fixes и load fixtures;
- PII/security containment;
- expand-only command infrastructure без спорных product enum;
- walking skeleton pin/unpin для уже существующего ACTIVE membership;
- ADR/RFC scaffolding, threat model и measurements.

Запрещены до Gate A:

- create/detail/content schema, зависящая от неутверждённых access/create/policy defaults;
- legacy write proxy или Mongo/PostgreSQL dual-write;
- массовый перенос UI поверх неполных write contracts.

## 3. Capability map

`KEEP / REBUILD` означает сохранить пользовательское поведение/визуал, но не legacy implementation.

| Capability                                                                      | Решение                               | Release       |
| ------------------------------------------------------------------------------- | ------------------------------------- | ------------- |
| Мои сообщества и Home summaries                                                 | KEEP; укрепить canonical read         | Wave A        |
| Discovery/search и detail                                                       | KEEP; новые bounded read models       | Wave A        |
| Create/edit/archive                                                             | KEEP / REBUILD                        | Wave B        |
| Join/request/invite/leave                                                       | KEEP / REBUILD                        | Wave B        |
| OWNER/ADMIN/MODERATOR/MEMBER                                                    | KEEP; server capabilities             | Wave B        |
| Remove/ban/unban/owner transfer                                                 | KEEP / REBUILD                        | Wave B        |
| Reverse-chronological feed                                                      | KEEP; keyset + watermark              | Wave C        |
| Posts/comments/reactions                                                        | KEEP; policy pending                  | Wave C        |
| Images                                                                          | KEEP; presigned quarantine/scan/READY | Wave C        |
| Reports/moderation                                                              | KEEP; shared moderation contour       | Wave C        |
| Community chat/unread                                                           | KEEP; reuse messaging                 | Wave D        |
| Notifications                                                                   | KEEP; durable intent + preferences    | Wave D        |
| Rating                                                                          | LATER                                 | GA-1.1        |
| Personal aggregate feed/recommendation graph/video/deep threads/bots            | LATER                                 | measured need |
| Browser actor/phone/clientId/role, embedded member graph, polling, local unread | DROP                                  | immediately   |

## 4. Bounded contexts и ownership

| Context           | Владеет                                                       | Не владеет                      | Write owner  |
| ----------------- | ------------------------------------------------------------- | ------------------------------- | ------------ |
| Communities Core  | lifecycle, profile, visibility, join policy, owner, revision  | messages, rating, push delivery | `LOCAL_ONLY` |
| Membership        | current membership, role, pin, join request, invite, ban      | profile identity, read cursor   | `LOCAL_ONLY` |
| Community Content | post, comment, reaction, community feed entry                 | chat message                    | `LOCAL_ONLY` |
| Messaging         | COMMUNITY conversation, message sequence/history, read cursor | membership authority            | `LOCAL_ONLY` |
| Moderation        | report, case, evidence, action, appeal                        | direct community row mutation   | `LOCAL_ONLY` |
| Notifications     | intent, inbox, preferences, provider delivery                 | Communities business state      | `LOCAL_ONLY` |
| Rating            | immutable facts, aggregates, published generations            | membership role                 | `LOCAL_ONLY` |
| Media             | upload intent, quarantine, scan, variant, GC                  | publish authorization           | `LOCAL_ONLY` |

Integration rules:

- clients call only PadlHub API;
- public IDs are PadlHub UUID;
- legacy identifiers remain in `integration.external_entity_map`;
- one operation reads one source/version;
- chat authorization depends on canonical Communities membership, but Messaging owns history/cursor;
- moderation requests actions through commands/events; it does not update Communities tables directly.

## 5. State machines: confirmed core

### Community

```text
ABSENT --create + owner membership in one transaction--> ACTIVE --archive--> ARCHIVED
```

- Restore/hard-delete остаются отдельным поздним решением; физическое удаление не входит в GA-1.
- An ACTIVE community must have exactly one ACTIVE owner.

### Membership

```text
NONE --instant join--> ACTIVE
NONE --moderated join--> PENDING
PENDING --approve--> ACTIVE
ACTIVE --leave--> LEFT
ACTIVE --remove--> REMOVED
ACTIVE/PENDING --ban--> BANNED
```

- Join/rejoin requests хранятся отдельно от current membership, чтобы не терять предыдущий статус.
- `REMOVED` не может вернуться автоматически: пользователь создаёт rejoin request, а переход в
  `ACTIVE` возможен только после явного разрешения уполномоченного модератора.
- `DIRECT` invite, выпущенный действующим `OWNER` или `ADMIN` с серверно подтверждённой capability,
  считается таким явным разрешением и может перевести `REMOVED` в `ACTIVE` атомарно с redemption.
- `BANNED` не может создавать join/rejoin request или redeem invite. Unban переводит membership в
  `LEFT`; возвращение в `ACTIVE` проходит через обычный join/rejoin flow.

### Invite

```text
ISSUED --redeem--> ISSUED | EXHAUSTED
ISSUED --expiry--> EXPIRED
ISSUED --revoke--> REVOKED
```

- Token is high-entropy, shown once and stored as hash.
- Invite имеет явный grant mode: `DIRECT` активирует membership, `REQUEST` создаёт join request;
  `BANNED` всегда fail-closed независимо от grant mode.

### Owner transfer

```text
A: ACTIVE/OWNER + B: ACTIVE/member-role
  --one locked revision-checked transaction-->
B: ACTIVE/OWNER + A: ACTIVE/post-transfer-role
```

- Иерархия фиксирована: OWNER назначает ADMIN; OWNER/ADMIN назначают MODERATOR и управляют нижними
  ролями. После обычной передачи прежний OWNER становится ADMIN. Emergency transfer выполняется
  только через PadlHub Admin API из ЦУП, требует двух подтверждающих сотрудников, обязательную
  причину и audit event. После unban membership получает LEFT и проходит обычный join/rejoin flow.

### Post/comment

```text
ABSENT --publish with READY media--> PUBLISHED
PUBLISHED --edit at any time--> PUBLISHED(new immutable revision)
PENDING_MODERATION --CUP reject with reason--> HIDDEN
PUBLISHED --author archive--> ARCHIVED (hidden, body retained)
ARCHIVED --author restore within 30 days--> PUBLISHED or PENDING_MODERATION
PUBLISHED --moderator action--> HIDDEN
HIDDEN --author edit--> PENDING_MODERATION(new immutable revision)
```

- Архивирование не удаляет body или revision history. Архив хранится пять лет с момента
  архивирования; пользовательское восстановление доступно 30 суток. Audit metadata и tombstone
  сохраняются после очистки тела согласно отдельной audit policy.
- Автор может редактировать опубликованный пост или комментарий без ограничения по времени. Каждое
  изменение создаёт immutable revision; изменение MEMBER-публикации в `MODERATED_FEED` возвращает
  материал в очередь модерации.
- Moderation control plane находится в ЦУП. ЦУП вызывает только PadlHub Admin API; canonical cases,
  actions, evidence и audit остаются в PadlHub PostgreSQL, прямые Mongo/PostgreSQL mutations из ЦУП
  запрещены.

## 6. Canonical data baseline

### Existing and retained

- `communities.communities` and `communities.memberships` with tenant composite keys and forced RLS;
- PadlHub UUIDs and `LOCAL_ONLY` domain ownership;
- roles `OWNER / ADMIN / MODERATOR / MEMBER`;
- current membership states `PENDING / ACTIVE / LEFT / REMOVED / BANNED`;
- Home source projection and local community logo storage;
- Messaging `COMMUNITY` conversation, server message sequence and read cursors;
- shared audit/outbox/inbox, notifications and moderation foundation.

### Safe expand before product decisions

- aggregate and membership `revision`;
- command idempotency records with request hash and stored result;
- participant/member list indexes under production-shaped benchmark;
- signed/principal-bound cursor envelope;
- source/readiness/latency/outbox/projection metrics;
- staging/reject/reconciliation schemas for dry-run migration.

### Implemented in the membership lifecycle slice

- durable join request history and one-pending-request invariant;
- membership lifecycle command idempotency records;
- revision-checked User and ЦУП transitions with audit/outbox;
- bounded tenant-wide ЦУП JOIN/REJOIN queue with optional community filter.

### Requires implementation / later operational decisions

- ban-action tables and emergency-transfer approval records;
- content/comment/reaction tables;
- retention/tombstone fields;
- chat feature extensions.

Accepted content limits: post body 1–10,000 Unicode characters, comment body 1–2,000; comments are
flat in GA; reactions are `LIKE`/`DISLIKE` with one current reaction per user and target.

## 7. Consistency map

| State                                | Consistency                             |
| ------------------------------------ | --------------------------------------- |
| Community lifecycle/owner/revision   | strong transaction                      |
| Membership/role/ban                  | strong transaction                      |
| Invite redemption/use count          | strong locked idempotent transaction    |
| Canonical post/comment               | strong row + outbox                     |
| Reaction uniqueness                  | strong unique constraint                |
| Message sequence/history/read cursor | strong; cursor monotonic                |
| Moderation action                    | strong, audited, idempotent             |
| Feed row for one community post      | one canonical row; no per-member copies |
| Counters/search/Home/rating          | eventual versioned projections          |
| Notification delivery                | eventual from durable intent            |
| Presence/typing/socket routing       | ephemeral Redis                         |
| Media scan/variants                  | async; publication only when `READY`    |

Every critical command commits business state, idempotency result, audit and outbox atomically.
Transport delivery is at-least-once; business effect is idempotent.

## 8. Initial command/event catalog

Каждый command получает actor из JWT, tenant context, capability, `Idempotency-Key`, request hash,
expected revision where applicable, stable error, audit и outbox.

| Command family                       | Primary events                                            |
| ------------------------------------ | --------------------------------------------------------- |
| create/update/archive/owner-transfer | `community.created/updated/archived/owner-transferred.v1` |
| membership pin                       | `community.membership.pin_changed.v1`                     |
| join request/cancel/approve/reject   | `community.join-*.v1`                                     |
| invite create/revoke/redeem          | `community.invite-*.v1`                                   |
| leave/remove/ban/unban/role-change   | `community.member-*.v1`                                   |
| post create/edit/delete              | `community.post-*.v1`                                     |
| comment create/edit/delete           | `community.comment-*.v1`                                  |
| reaction set/remove                  | `community.reaction-changed.v1`                           |
| media request/finalize               | `community.media-ready/rejected.v1`                       |
| report submit                        | shared `moderation.case-opened.v1`                        |

Consumers: Home/directory, counters, search, notification intent, realtime hint, rating and analytics.

The realtime transport remains staging-only and acknowledges subscriptions as
`DURABLE_SEQUENCE_HTTP_RECOVERY`. Canonical transactions allocate a monotonic community sequence;
authorized HTTP recovery is authoritative and RabbitMQ supplies identifier-only hints. Production
fan-out remains disabled until load, reconnect and failure-mode proof passes; see ADR
`docs/adr/communities/0004-realtime-authorized-transport-foundation.md`.

## 9. First walking skeleton

`PUT /user/api/v1/{tenantKey}/communities/{communityId}/members/me/pin`

```json
{
  "pinned": true,
  "expectedRevision": 3
}
```

Why safe:

- `pinned_at` already exists;
- actor is always the current user;
- no visibility/join/moderation/retention decision is required;
- the existing `/communities/mine` provides immediate read-back evidence;
- it proves the reusable command transaction boundary.

Gate:

- same key + same request returns original result;
- same key + changed request returns stable idempotency conflict;
- stale revision returns stable version conflict;
- inactive/non-member and cross-tenant requests cannot mutate;
- state/audit/outbox/idempotency commit all-or-nothing;
- legacy ownership never receives a canonical pin write.

## 10. Workload model v1

| Parameter            |                                       Value | Status                              |
| -------------------- | ------------------------------------------: | ----------------------------------- |
| DAU                  |                                     20–100k | EVIDENCE: user target               |
| Read burst           |                                   1,000 RPS | ASSUMPTION: design envelope         |
| Command burst        |                                     150 RPS | ASSUMPTION                          |
| Realtime             |                             20k connections | ASSUMPTION                          |
| Hot community        |             100k memberships, 8–10k sockets | ASSUMPTION                          |
| Synthetic scale      | 500k users, 10k communities, 4m memberships | ASSUMPTION                          |
| Mass notification    |                       100k intents in 5 min | ASSUMPTION; provider quota excluded |
| Actual product peaks |                                     unknown | NOT_ENOUGH_EVIDENCE                 |

Required scenarios: viral feed, reaction contention, hot chat, reconnect storm, join/ban raid,
notification fan-out, cache stampede, media abuse, noisy tenant and broker recovery.

## 11. Threat model v1

| Threat                     | Required control                                                  |
| -------------------------- | ----------------------------------------------------------------- |
| IDOR/tenant escape         | server tenant/principal + composite FK/RLS + negative tests       |
| role spoofing              | no actor/role/phone/clientId authority from request               |
| zero/two owner race        | lock + revision + exactly-one post-condition                      |
| ban bypass                 | authorize every HTTP read/write and WS subscribe                  |
| invite enumeration/replay  | random token, hash, expiry, max-use, revoke, quotas               |
| scraping/noisy neighbour   | bounded keyset pages and actor/IP/community budgets               |
| WS exhaustion              | ticket TTL/jti, heartbeat, backpressure, slow-client shedding     |
| duplicate/poison event     | inbox dedupe, bounded retry, DLQ and replay runbook               |
| stored XSS/deep-link abuse | schema/length bounds, escaping/sanitization, CSP                  |
| malicious media/SSRF       | scoped upload, quarantine, magic/size checks, allowlisted sources |
| PII leakage                | no external identity in public contract, logs, metrics or spans   |
| moderator abuse            | immutable audit/reason/evidence and platform escalation           |
| retention failure          | approved retention/tombstone/GC/legal-hold matrix                 |

Current P0 containment: legacy `phone`/`clientId` URL spans must be suppressed/redacted while the
temporary bridge exists.

## 12. Accepted initial rollout SLO

| Journey                                      |               Initial target |
| -------------------------------------------- | ---------------------------: |
| Eligible community API availability          |                99.9% monthly |
| Mine/directory                               |     p95 ≤150 ms; p99 ≤350 ms |
| Detail                                       |     p95 ≤200 ms; p99 ≤450 ms |
| Feed/chat history                            |     p95 ≤250 ms; p99 ≤600 ms |
| Commands                                     |     p95 ≤400 ms; p99 ≤800 ms |
| Realtime hint after commit                   |           p95 ≤1 s; p99 ≤3 s |
| Projection freshness                         | 99.9% ≤60 s; degraded ≤5 min |
| Unauthorized cross-tenant/capability success |                            0 |
| Duplicate effect under retry                 |                            0 |

RPO, RTO, maintenance window and provider/cost budgets remain `DECISION_NEEDED`.

## 13. Product decision register

### P0-A Visibility and access — accepted A3

1. Legacy-compatible `OPEN/CLOSED`.
2. Four combined types: public, discoverable-private, invite-only, hidden.
3. Independent axes: `PUBLIC/LISTED_PRIVATE/HIDDEN` × `INSTANT/MODERATED/INVITE_ONLY`.

Accepted: independent axes `PUBLIC/LISTED_PRIVATE/HIDDEN` ×
`INSTANT/MODERATED/INVITE_ONLY` with this access matrix:

| Resource before ACTIVE membership | PUBLIC                                | LISTED_PRIVATE | HIDDEN                   |
| --------------------------------- | ------------------------------------- | -------------- | ------------------------ |
| directory                         | visible                               | visible        | absent                   |
| detail                            | full public fields                    | minimal card   | 404; invite gets preview |
| feed                              | public published items                | denied         | denied                   |
| members                           | count + public profile summaries only | denied         | denied                   |
| rating                            | public snapshot when implemented      | denied         | denied                   |
| chat                              | denied                                | denied         | denied                   |

Every mode gives full permitted resources only to `ACTIVE` membership; chat always requires
`ACTIVE`. Search-engine indexing of PUBLIC remains a separate SEO decision.

Accepted field-level contract:

- `LISTED_PRIVATE` directory/detail contains only PadlHub UUID, title, copied logo URL,
  verification, visibility and a server-derived join action. Description and member count are
  absent, not nullable placeholders.
- `HIDDEN` returns the same 404 as a missing aggregate unless the JWT subject has ACTIVE
  membership. Invite preview remains fail-closed until an authenticated signed-invite contract
  exists; legacy `inviteCode` query parameters are rejected.
- `PUBLIC` exposes allowlisted description, active member count, join policy and created time.
- ACTIVE members additionally receive the publishing preset, aggregate revision and only their own
  membership role/status/revision/rank. Generic detail never exposes owner/creator identity,
  embedded members, pending count, invite values, object keys or external identifiers.
- Public member summaries remain a separate slice and must apply canonical profile privacy before
  release.

### P0-B Publishing policy — accepted B3

1. Every ACTIVE member publishes posts/comments/chat as in legacy.
2. Staff publish posts; members comment/chat.
3. Per-community staff/member/approval policy.

Accepted: create requires one explicit preset; there is no server default:

- `OPEN_COMMUNITY`: ACTIVE members create posts/comments/chat messages;
- `STAFF_FEED`: staff create posts; ACTIVE members create comments/chat messages;
- `MODERATED_FEED`: member posts require approval; ACTIVE members create comments/chat messages.

### P0-C Invite and rejoin — accepted C3

1. Valid invite immediately activates membership unless banned.
2. Invite permits request but moderated community still creates PENDING.
3. Invite has explicit `DIRECT/REQUEST` grant mode.

Accepted: explicit `DIRECT/REQUEST` grant mode; `REMOVED` returns only after moderator permission;
a `DIRECT` invite from an authorized active OWNER/ADMIN is sufficient permission; `BANNED` cannot
redeem. Unban produces `LEFT` and never silently restores `ACTIVE` access.

### P0-D Ownership and role hierarchy — accepted D2

1. Only OWNER changes roles; ADMIN manages MEMBER only, close to legacy.
2. OWNER appoints ADMIN; OWNER/ADMIN appoint MODERATOR and manage lower roles.
3. Per-community customizable role policy.

Accepted: fixed hierarchy; former OWNER becomes ADMIN after transfer. Emergency transfer is a
two-person ЦУП operation through PadlHub Admin API with a mandatory reason and audit event. Unban
produces LEFT and never silently restores ACTIVE access.

### P0-E Edit/archive/retention — accepted E2

1. Tombstone and revision history indefinitely.
2. Author soft-delete, moderator hide, purge body after approved retention; audit metadata remains.
3. Immediate body deletion with minimal audit fact.

Accepted: author action archives rather than deletes; archived body and revisions are retained for
five years from archive time; user restore is available for 30 days; audit metadata remains. Author
editing has no time limit, always creates an immutable revision, and re-enters moderation when the
publishing preset requires it.

### P0-F Chat GA — accepted F2

1. One general text chat.
2. General chat + images, mentions and pin.
3. Multiple channels + threads + attachments/mentions/pin.

Accepted: one general chat with images, mentions and pin.

### P0-G Moderation operations — accepted G3

1. Community moderators first line; PadlHub handles escalation/appeal.
2. All moderation centralized in PadlHub.
3. Hybrid: deterministic protection + community actions + PadlHub permanent ban/appeal.

Accepted: hybrid operating model; moderation control plane is the existing ЦУП experience over
PadlHub Admin API. Need: operational role/DRI and SLA for critical/high/normal cases.

## 14. Gate A checklist

- [x] Recommended team and architecture plan approved.
- [x] Modular monolith/PostgreSQL/RabbitMQ/Redis/S3 baseline approved.
- [x] Capability inventory drafted.
- [x] Bounded contexts and consistency map drafted.
- [x] Threat/workload v1 drafted with assumptions labelled.
- [x] P0-A…P0-G configuration answered.
- [x] Core state vocabulary and non-dependent transition guards approved.
- [x] Visibility/resource-access matrix approved; SEO indexing remains separate.
- [x] Fixed role hierarchy approved; detailed capability matrix is pending.
- [x] Archive lifecycle approved: unlimited author edit, immutable revisions, 30-day restore and
      five-year archived-body retention.
- [x] ЦУП moderation control-plane boundary and approve/reject/hide/restore API implemented;
      operational DRI/SLA/appeal path is pending.
- [x] Workload and initial SLO envelope approved.
- [ ] RPO/RTO, maintenance window and provider/cost budgets approved.
- [ ] Each P0 rule linked to acceptance examples and owner.

Gate A is `CONDITIONAL-GO`: create/pin/read/security, governance and the content lifecycle may be
implemented. Moderation GA and production cutover remain blocked only by their listed operational
unknowns and measured evidence.

The non-invite membership lifecycle and the ЦУП JOIN/REJOIN decision queue satisfy this rule and
are implemented. The DIRECT invite runway is also implemented behind a disabled feature flag using
the accepted multi-user, seven-day, explicit-confirmation and MEMBER-only rules. Any current ACTIVE
OWNER/ADMIN may revoke; PENDING remains a conflict. Standard issue is limited per community to five
unexpired ACTIVE links and twenty successful issues in a rolling 24-hour window. A separate
Admin-audience capability `communities.invite.quota.override` may create a one-use, 24-hour
community grant only with mandatory reason and ticket evidence. The next over-quota issue by an
ACTIVE OWNER/ADMIN consumes it atomically; CUP is not the issuer. Activation is now blocked by
implementation verification, real-PostgreSQL quota-race coverage and staging smoke tests rather
than an open product decision.

## 15. Approved create-community slice

- Actor: any authenticated active verified user whose server-issued JWT contains
  `communities.create`; verification is established by the authentication flow, never by a body
  flag.
- Standard quota: fewer than three ACTIVE communities owned and no successful create during the
  preceding 24 hours.
- Override: only an explicit authorized ЦУП/Admin command may bypass quota; User API never accepts
  an override field.
- Required request values: title `1..120`, explicit visibility, join policy and publishing preset.
- Optional request value: description up to 2,000 characters.
- City and logo are optional later steps; tags/minimum level/rules are backward-compatible later
  extensions. Public route uses PadlHub UUID; no slug is created.
- Commit boundary: ACTIVE community revision 1 + ACTIVE OWNER membership revision 1 + publishing
  policy + stored idempotency result + audit + `community.created.v1` outbox event.
- Implementation evidence: the User API, domain service, PostgreSQL repository, expand-safe
  migration, OpenAPI and typed SDK implement this boundary. Actor-scoped advisory locking makes
  quota decisions serializable for concurrent creates; User API hardcodes `quotaOverride=false`.

## 16. Implemented canonical detail/discovery slice

- `/communities/mine` keyset order is membership-owned: pinned first, membership `updated_at DESC`,
  then community UUID. Community content edits never fan out ordering writes to every member; the
  partial membership index serves this order directly.
- Authenticated discovery searches only ACTIVE `PUBLIC/LISTED_PRIVATE`; `HIDDEN` is absent.
- LISTED_PRIVATE descriptions are neither searched nor returned. PUBLIC descriptions may be
  searched through bounded PostgreSQL trigram indexes.
- Keyset pagination uses the exact PostgreSQL `created_at` ordering value plus PadlHub UUID; the
  opaque cursor is bound to the normalized query.
- SQL performs field-level redaction before the domain mapper applies strict minimal/public/member
  schemas. Tenant RLS and explicit tenant predicates remain the second boundary.
- Canonical read runtime is enabled only in `local` mode and fails closed in legacy/mock modes.
- Web routes `/communities` and `/communities/{uuid}` now use the typed SDK; HIDDEN/missing share one
  unavailable state.
