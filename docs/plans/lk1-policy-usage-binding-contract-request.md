# LK1 policy/usage binding: contract request для B3

Статус: **запрос контракта, не разрешение на реализацию.** Документ фиксирует, какой контракт
должна выставить LK1 (B3, `agent/ph-admin-policy-usage-ledger-v1`), чтобы LK2 (B2,
`agent/lk2-policy-usage-binding-v1`) мог связать каждую коммерческую операцию CREATE/JOIN с
policy version/digest, usage context и opaque orchestration receipt.

- Владелец контракта и единственный источник policy publish/version/effective и usage
  counters/reservation: **LK1**.
- Потребитель: **LK2** (`apps/api`, `@phub/subscription-runtime-adapter`).
- Срез: 2026-10-27; `origin/main` @ `871cc2f8`; B1 (#445, head `b84292ab`) — read-only реестр
  опубликованных политик (merge ожидает отдельного approval); база B2 — PR #499 (WARN commercial
  CREATE), после лендинга.
- План среза LK2 и порядок шагов: `docs/plans/lk2-policy-usage-binding-slice-plan.md`.

## Актуализация R1 — 2026-10-31

Повторный source audit main LK1 `788fdb96b3efd60fb09e4187b4ca4b5b00e2daaa` и ph-admin
`83b1c17bc4c5edaec65387b25b5695e48337c3cf` подтверждает: предложенный ниже v2 пока не реализован.
Quote receiver возвращает non-binding v1; Node-RED admission и delegation допускают точный
v1 claim set, receipt содержит 17 v1 полей. Существующий canonical usage ledger ph-admin
не означает наличие совместимого transport contract для LK2.

PR #503 закрывает локальные downgrade/confirmation обходы. Он не отправляет предложенные поля
через v1 и не считает v1 receipt доказательством policy/usage binding. До включения нужны
согласованные exact schemas, minting/expiry usageRef, стабильная retry identity, confirm/release/
compensation semantics, совместимость старых операций и интеграционные негативные тесты.
Реализация R1 разрешена пользователем; live/provider операции остаются за отдельной границей.

## 1. Почему это P0

На срезе LK2 не связывает коммерческую операцию с версией политики:

- `selectedSubscription.policyVersion/policyDigest` есть только в **non-binding** advisory quote
  (`packages/subscription-runtime-adapter/src/index.ts:148-187`), нигде не потребляется и не
  персистится;
- admission request — ровно три ключа (`booked-operation-admission.ts:11-18`), receipt —
  фиксированный набор из 17 ключей (`booked-operation-read.ts:6-24`); policy/usage ref там нет;
- следствия: ретрай после перепубликации политики может реплеить старую попытку; оператор не
  может доказать, какая версия правила и какой usage-резерв привели к брони; LK2 не имеет opaque
  ref, по которому можно сверить ответ LK1.

Границы LK2 не пересматриваются: LK2 не хранит entitlement/счётчики/ledger, не публикует и не
исполняет правила; хранит только opaque refs и digest полученного receipt в существующих
структурах (без новой таблицы — см. план B2).

## 2. Что уже есть и не должно ломаться

| Элемент              | Где                                                                                                                       | Что фиксируем как v1                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote v1 (advisory)  | `packages/subscription-runtime-adapter/src/index.ts:148-187`                                                              | `contractVersion:1`, `nonBinding:true`, `requiresReservationRecheck:true`, `decisionId`, `selectedSubscription{subscriptionInstanceId,policyVersion,policyDigest}`, `limits`, `expiresAt` |
| Admission request v1 | `packages/subscription-runtime-adapter/src/booked-operation-admission.ts:11-18`                                           | ровно `{action:'JOIN_GAME', target:{id,expectedRevision}, paymentIntent:'USE_SUBSCRIPTION'}`                                                                                              |
| Receipt v1           | `packages/subscription-runtime-adapter/src/booked-operation-read.ts:6-24`                                                 | 17 ключей, `contractVersion:1`, `source:'LK1_SUBSCRIPTION_BOOKING_OWNER'`                                                                                                                 |
| Delegation claims    | `apps/api/src/subscriptions/subscription-runtime-actor-delegation-issuer.ts:187-220`                                      | `contract_version:1`, `request_sha256`, `idempotency_key_sha256`, target/provider claims                                                                                                  |
| B1 read boundary     | #445                                                                                                                      | LK2 читает published/effective policy version+digest **только на чтение**, default OFF, ничего не хранит и не исполняет                                                                   |
| LK1 registry read    | ph-admin `GET /api/internal/subscriptions/policy-registry` (main `83b1c17b`)                                              | проверено 2026-10-27: путь, заголовок и enum'ы совпадают с B1-клиентом; включается флагами `SUBSCRIPTIONS_POLICY_REGISTRY_*`                                                              |
| LK1 booking owner    | `lk` repo: `scripts/nodered_booked_operation_receiver_nodes/**`, `outputs/lk1-booked-op-receiver-20261021/HANDOFF-LK1.md` | `POST /lk/integrations/v1/booked-operation-admissions`, `GET /lk/integrations/v1/booked-operations/:operationId`; **точный claim set**, `contract_version:1`, `receipt_version:1`         |

Существующий `policyVersion/policyDigest` в quote — **subscription-scoped и non-binding**: он не
может авторизовать списание и не идентифицирует решение для конкретной цели/действия.

### 2.1 Проверено в LK1 на 2026-10-27

- **Реестр политик уже реализован в ph-admin** (CUP subscriptions service): контроллер
  `internal/subscriptions`, глобальный prefix `api`, авторизация только заголовком
  `x-subscriptions-integration-token`. LK1-флаги: `SUBSCRIPTIONS_POLICY_REGISTRY_ENABLED` и
  `SUBSCRIPTIONS_POLICY_REGISTRY_INTEGRATION_TOKEN` (в LK2 имена с одним `SUBSCRIPTION_...`) —
  при staging-включении легко перепутать, нужна явная пара значений.
- **Ответ реестра совпадает с контрактом B1** по составу и enum'ам: `schemaVersion`,
  `generatedAt`, `items`, `totals`; `publication{publicationId, policyVersion, policyDigest,
state, effectiveAt, applyTo, publishedAt, supersededAt, runtimeCompatibility}`;
  `versions{policyVersion, status, modelVersion 2|3, effectiveAt, applyTo, publicationState}`;
  `instances{total, byPolicyVersion}`, `providerProductIds`, `lastDecision`, `lastQuoteDecision`
  (`channel ?? 'LK2'`). Enum'ы: `DRAFT|ACTIVE|ARCHIVED`, `DRAFT|PUBLISHED|SUPERSEDED`,
  `NEW_ONLY|ACTIVE_AND_NEW`, `PUBLISHED|SUPERSEDED|DISABLED_FOR_NEW_OPERATIONS`.
- **Booking owner — не ph-admin, а LK1 Node-RED receiver** (репозиторий `lk`): он ведёт
  `booked_operation_admissions` и receipt в Mongo, проверяет **точный набор claims** и
  `request_sha256` над каноническим телом `booked-operation-admission:v1\0...`.
- Следствие: admission v2, receipt v2 и новые claims требуют изменений **в Node-RED owner flow**
  (LK1), а `policyRef/usageRef` и счётчики — в ph-admin usage ledger. Контракт должен заранее
  зафиксировать, какой сервис владеет reserve/confirm/release/compensate (рекомендация — ph-admin
  ledger, owner flow только фиксирует `usageRef` в receipt).

### 2.2 База: замороженный контракт CREATE из PR #499 (Draft)

`agent/lk2-commercial-create-warn-v1` (#499) уже фиксирует LK2→LK1 reserve/confirm/release contract
в `docs/contracts/game-commercial-create.md` и реализует strict-клиент
(`apps/api/src/games/game-create-commercial-runtime.ts:157-360`). B2 **расширяет** этот контракт, а
не создаёт параллельное семейство:

- `POST /api/internal/subscription-runtime/lk2/v1/reserve`: запрос `{operationId, action, target{kind,
id, expectedRevision}, paymentMode, paymentIntent, preferredSubscriptionInstanceId, priceSnapshot}`,
  ответ `{reservationId, expiresAt, policyVersion, priceSnapshot}` либо typed refusal / `409` / `503`;
  replay — тем же `operationId` + `Idempotency-Key`.
- `POST .../confirm` → trusted receipt `{receiptId, confirmedAt, appliedRule, usageRef, bookingRef}`.
- `.../release` и `.../compensate` — идемпотентны по `reservationId`/`operationId`.
- admission расширен вторым action `CREATE_GAME` (остальные поля не меняются); LK1 receiver для
  CREATE в #499 не реализован, LK2 отвечает `503 BOOKED_OPERATION_CREATE_ADMISSION_UNAVAILABLE`.
- `GAME_COMMERCIAL_CREATE_ENABLED=true` в production **отклоняется** конфигом до отдельного
  approval для LK1 reserve/confirm/release.

Что добавляет B2 поверх базы: `policyDigest` (в reserve/confirm), `decisionId`/binding quote mode,
usage semantics (`reservedUnits`/`remainingUnits`/readback) и exact receipt v2 key set с
`policyVersion`/`policyDigest`. JOIN по-прежнему идёт через legacy Node-RED owner
(admission + receipt v1) — переводить ли JOIN на этот же контракт, отдельный открытый вопрос.

## 3. Восемь обязательных элементов контракта

### 3.1 Decision-level `policyRef` (action+target scoped)

```json
{ "policyVersion": 3, "policyDigest": "sha256:<64 hex>" }
```

- `policyVersion` — целое `>= 1`; `policyDigest` — `sha256:[a-f0-9]{64}` (та же форма, что
  публикует CUP).
- Ref относится к **решению** (action + target), а не только к подписке; для одного `decisionId`
  ref неизменяем.
- Acceptance: LK2 может сравнить ref из quote, admission и receipt без знания содержимого правил.

### 3.2 Binding quote mode

```json
POST /api/internal/subscription-runtime/lk2/v1/quote
{
  "schemaVersion": 1,
  "decisionMode": "BINDING",
  "action": "GAME_JOIN",
  "target": { "kind": "GAME", "id": "<uuid>", "expectedRevision": 12 },
  "paymentIntent": "USE_SUBSCRIPTION",
  "subscriptionInstanceId": "<uuid>"
}
```

Ответ (v2) дополнительно к v1:

```json
{
  "contractVersion": 2,
  "binding": true,
  "decisionId": "<uuid>",
  "policyRef": { "policyVersion": 3, "policyDigest": "sha256:<64 hex>" },
  "usage": { "usageRef": "<opaque>", "reservationUnits": 1, "remainingUnits": 7 },
  "expiresAt": "2026-10-27T12:00:00.000Z",
  "recheck": { "required": true, "targetRevision": 12 },
  "serviceAllowed": true,
  "subscriptionBenefitAllowed": true,
  "blockers": []
}
```

- Acceptance: `expiresAt` и `recheck.targetRevision` проверяемы LK2 до dispatch; `decisionId`
  обязателен; для одного `decisionId` и одного idempotency-ключа ответ детерминирован.
- WARN-канал (`apps/api/src/subscriptions/subscription-runtime-warn-routes.ts`) продолжает
  работать в advisory-режиме; B2 переводит коммерческий путь на binding только после появления
  этого режима у LK1.

### 3.3 Admission request v2

```json
{
  "action": "JOIN_GAME",
  "target": { "id": "<uuid>", "expectedRevision": 12 },
  "paymentIntent": "USE_SUBSCRIPTION",
  "policyRef": { "policyVersion": 3, "policyDigest": "sha256:<64 hex>" },
  "decisionId": "<uuid>",
  "usageRef": "<opaque>"
}
```

- v2 согласуется через delegation claim `contract_version: 2`; LK1 обязан продолжать принимать
  v1-запрос без новых полей (expand-first).
- Владелец маршрута — LK1 Node-RED receiver (`lk` repo), не ph-admin; текущая версия проверяет
  точный claim set и `contract_version:1`, поэтому v2 — явный список, а не «дополнительные поля».
- Для CREATE admission уже расширен в #499 (`action: CREATE_GAME`, остальные поля не меняются);
  LK1 receiver не реализован, поэтому LK2 отвечает `503 BOOKED_OPERATION_CREATE_ADMISSION_UNAVAILABLE`
  — B2 не должен минтить delegation до реализации receiver.
- Acceptance: LK1 отклоняет v2-запрос со старым/чужим `policyRef`/`usageRef` стабильным кодом и
  не создаёт бронь.

### 3.4 Receipt v2

База зависит от действия:

- **JOIN** — receipt v1: 17 ключей (`booked-operation-read.ts:6-24`), owner — LK1 Node-RED receiver;
- **CREATE** — receipt из замороженного контракта #499: `{receiptId, confirmedAt, appliedRule,
usageRef, bookingRef}`, owner — LK1 reserve/confirm receiver (пока не реализован).

Для обоих действий v2 = база + `policyVersion`, `policyDigest`, опционально `decisionId`;
`contractVersion: 2`. LK2-парсер строгий (exact key set), поэтому нужен **полный** список ключей
v2, а не «добавьте что-нибудь»:

- `usageRef` — opaque `[A-Za-z0-9._:-]{1,200}`, не идентификатор подписки/пользователя;
- `appliedRule` (CREATE) уже называет применённое правило, но не версию/дайджест: `policyVersion`/
  `policyDigest` добавляются отдельно, чтобы сверять решение, а не только текст правила;
- receipt v2 строится в том же owner-процессе, что и база (Node-RED для JOIN, reserve/confirm
  receiver для CREATE), а не в ph-admin; менять обе стороны нужно одновременно;
- v1- и frozen-receipt остаются валидными для операций, начатых до включения;
- unknown keys в v2 → отказ LK2 (fail-closed), поэтому список должен быть согласован заранее.

### 3.5 Reserve / confirm / release / compensate

База уже заморожена в #499 (см. 2.2): reserve → `{reservationId, expiresAt, policyVersion,
priceSnapshot}`, confirm → receipt `{receiptId, confirmedAt, appliedRule, usageRef, bookingRef}`,
release/compensate идемпотентны. B2 расширяет её, сохраняя имена и семантику существующих полей:

| Endpoint                     | Семантика                                                                                            | Идемпотентность                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST .../lk2/v1/reserve`    | база #499 + `policyDigest`, `decisionId`, `reservedUnits`, `remainingUnits`; резерв usage по решению | повтор с тем же `(operationId, Idempotency-Key)` → тот же ответ, второй резерв не создаётся |
| `POST .../lk2/v1/confirm`    | база #499 (receipt) + `policyVersion`, `policyDigest`, `decisionId`; фиксирует резерв                | повтор → тот же receipt; после release/expire → `409` со стабильным кодом                   |
| `POST .../lk2/v1/release`    | освобождает **неподтверждённый** резерв                                                              | повтор → `{released:true}`                                                                  |
| `POST .../lk2/v1/compensate` | компенсирует **подтверждённое** списание                                                             | повтор → `{compensated:true}`                                                               |

- Стабильные коды: недостаточно units (`422`), решение истекло (`410`), конфликт резерва
  (`409`), недоступность (`503`); тела ошибок не содержат PII/токенов.
- Владелец: usage/reservation ledger — ph-admin (B3), а подтверждение брони/receipt — owner flow
  (Node-RED для JOIN, reserve/confirm receiver для CREATE). Нужно решить, где живут
  reserve/confirm/release/compensate: (a) в ph-admin ledger, а owner flow только фиксирует
  `usageRef` в receipt, либо (b) в owner flow с делегированием в ph-admin. Рекомендуется (a):
  один источник счётчика, owner flow отвечает только за booking.
- Recovery: существующий read by `operationId` (`/lk/integrations/v1/booked-operations/{id}`)
  после потерянного ответа возвращает PENDING/UNKNOWN/CONFIRMED и receipt, не создавая новую
  бронь и не увеличивая usage.
- Acceptance: один `decisionId` не может дать два подтверждённых списания.

### 3.6 Usage readback

Usage-блок в binding quote (см. 3.2) и/или
`GET /api/internal/subscription-runtime/lk2/v1/usage?subscriptionInstanceId=<uuid>` →
`{ usageRef, counters, remainingUnits, policyRef, asOf }`.

Счётчики меняет только LK1; LK2 их не кэширует и не хранит, а показывает оператору только как
readback.

### 3.7 Политика delegation claims

По действующему owner-коду (`lk`, HANDOFF-LK1) LK1 проверяет **точный** набор claims, поэтому
«добавить claim» без версии нельзя: нужен v2 claim set и порядок «сначала LK1 принимает v2
(expand), затем LK2 начинает слать». Предлагаемые новые claims: `contract_version:2`,
`policy_version`, `policy_digest`, `decision_id`, `usage_ref`.

Если LK1 решит ослабить проверку до «базовый набор + допускаются дополнительные» — это отдельное
контрактное изменение с security-review, но не обязательное для B2.

### 3.8 Ownership и единый счётчик

- LK1 — единственный owner policy publish/version/effective и usage counters/reservation для
  **всех** каналов (LK2 + LK1-админский).
- Записи LK1-админского канала отражаются в том же счётчике; cross-channel учёт проверяем.
- LK2 присылает только opaque refs; потеря ответа/повтор не увеличивает usage; цепочка
  `rule version → usage reservation → booking → confirm` восстанавливается по LK1 readback.

## 4. Сквозная цепочка (что доказывает B2)

1. binding quote (3.2) даёт `decisionId`, `policyRef`, `usageRef`, `expiresAt`;
2. reserve (3.5) резервирует usage; LK2 сохраняет opaque refs и reservation id у себя;
3. admission v2 (3.3) передаёт refs владельцу бронирования; владелец создаёт booking;
4. confirm (3.5) возвращает receipt v2 (3.4); LK2 сверяет exact binding и сохраняет digest
   receipt;
5. оператор видит в LK1: версию правила, резерв, booking, подтверждение и итоговый счётчик.

Повтор запроса или потерянный ответ не должны давать второй booking и второй usage.

## 5. Совместимость и порядок включения

1. **LK1 expand**: принимает v2-поля/claims и отдаёт receipt v2, не ломая v1-клиентов.
2. **LK2 adopt**: B2 включает binding за флагом (default OFF), после лендинга #499 и B1.
3. **Contract**: удаление v1-путей — отдельным решением после дренажа in-flight операций.

Инварианты внешнего вызова: timeout, bounded retry, circuit breaker, redacted logs, стабильные
коды ошибок, лимит размера ответа (как 1 MiB у реестра политик B1), отсутствие PII и секретов в
телах и метриках.

Отдельно для B1: включение реестра на staging требует одновременного включения LK1-флагов
`SUBSCRIPTIONS_POLICY_REGISTRY_ENABLED` + `SUBSCRIPTIONS_POLICY_REGISTRY_INTEGRATION_TOKEN` и
совпадения токена с LK2 `SUBSCRIPTION_POLICY_REGISTRY_INTEGRATION_TOKEN` (имена флагов отличаются
на одну `S` — это частая причина «UNAVAILABLE» при формально включённых настройках).

Отдельно для B2: пока LK1 reserve/confirm/release для CREATE не реализован,
`GAME_COMMERCIAL_CREATE_ENABLED=true` должен отклоняться конфигом в production (это уже
зафиксировано в #499); B2 не ослабляет этот гейт и включает binding только после контракта B3.

## 6. Acceptance для B3

- [ ] единый счётчик: операция LK2, операция LK1-админки и запись LK1 видны в одном счётчике;
- [ ] идемпотентные reserve/confirm/release/compensate: replay → тот же результат, второго
      списания нет;
- [ ] negative/partial: недостаточно units, истёкшее решение, чужой/устаревший `policyRef`,
      конфликт резерва (`409`), потерянный ответ, недоступность LK1 (`503`);
- [ ] интеграционный прогон с LK2 B2: цепочка rule version → reservation → booking → confirm,
      повтор/потеря ответа не увеличивает usage, LK2 не хранит counters;
- [ ] evidence: readback счётчика до/после, receipt v2, состояние резерва, отсутствие секретов.

## 7. Открытые вопросы (нужны до старта реализации B2)

1. Tenant scope: quote/usage/reservation per tenant или платформенные; реестр политик B1
   tenant-agnostic — это осознанно?
2. Гранулярность счётчика: per subscription instance / per user / per policy version; как
   `applyTo: NEW_ONLY | ACTIVE_AND_NEW` влияет на уже активные подписки.
3. Полный exact key set receipt v2 и итоговый список claims v2; принимает ли LK1 неизвестные
   поля.
4. Семантика `expiresAt` и `recheck.targetRevision`: что именно LK2 обязан перепроверить перед
   dispatch.
5. Различие release и compensate: кто вызывает, что восстанавливается, допустим ли compensate
   после частичного provider-успеха.
6. Staging-контур LK1 и кто прогоняет интеграцию; флаги LK2 на время прогона.
7. Кто владеет таблицей стабильных кодов ошибок.
8. Кто владеет reserve/confirm/release/compensate — ph-admin ledger или LK1 Node-RED owner — и
   кто минтит `usageRef`.
9. Как согласуются staging-флаги: LK1 `SUBSCRIPTIONS_POLICY_REGISTRY_ENABLED` +
   `SUBSCRIPTIONS_POLICY_REGISTRY_INTEGRATION_TOKEN` против LK2
   `SUBSCRIPTION_POLICY_REGISTRY_ENABLED` + `_BASE_URL` + `_INTEGRATION_TOKEN` (имена отличаются
   на одну `S`).
10. Переводим ли JOIN на замороженный reserve/confirm-контракт CREATE (#499) или оставляем legacy
    Node-RED owner для JOIN и добавляем v2 только к нему?

## 8. Не-цели

- LK2 не хранит entitlement/счётчики/ledger и не исполняет правила.
- B2 не меняет публичный API/OpenAPI/SDK и не добавляет миграций (0105 — только если понадобится
  хранить сырое тело receipt; это отдельный CRITICAL-approval).
- Этот документ не разрешает ни writes в LK1, ни staging/production-операции.

## 9. R1 managed JOIN consumer: bounded source contract (2026-10-31)

Sections 1–8 retain the earlier proposal and its historical open questions. The implemented
consumer below adopts only managed `JOIN_GAME` with zero price, positive free minutes and no
paid minutes. CREATE, paid cancellation and activation remain separate work. There is no new
flag, schema, ledger, provider writer or public client identifier.

The commercial JOIN runtime first resolves the existing tenant-scoped, synced VIVA exercise
mapping and actor-owned selected subscription. For a zero-price selection it calls the LK
read-only `/lk/integrations/v2/booked-operation-preflights` route with a short-lived signed actor
delegation and the actor credential. This happens before a seat or admission fingerprint is
persisted. A strict managed response pins canonical CUP subscription instance, policy
version/digest and authoritative target snapshot ID/revision/evidence. The synthetic wire
fixture is `packages/subscription-runtime-adapter/src/fixtures/managed-join-v2.json` (SHA-256
`82f7b918275c86fd357283abd67bc7c727427a3680dfe9906b2d560eea3c0171`), shared with the LK owner.

Only the exact additive `{contractVersion:2, nonBinding:true, operationId, action:'JOIN_GAME',
target, management:'LEGACY'}` response selects the existing v1 free JOIN. LK derives that
classification from its canonical server allowlist, environment and authoritative owned-product
purchase-date selector. Missing instance, timeout, unknown configuration and malformed response
never classify a selection as legacy. Paid legacy JOIN stays on v1. The LK receiver must also
recheck selector drift before a new v1 managed reservation; attempted/completed recovery remains
bound to the original operation.

Managed admission uses `/lk/integrations/v2/booked-operation-admissions`; its signed body contains
only the original expectations, with no invented decision UUID, usage reference or proof TTL.
The existing public operation ID derivation is unchanged across versions. The local request hash
uses the separate `game.join.managed.v2` domain, original public request fingerprint and complete
expectations. An existing operation is read before a fresh price/preflight, so retry does not
repin to a newly published policy. Concurrent different expectations conflict at the existing
idempotency boundary. A durable eligibility refusal retains the same binding in its existing
command result JSON even when no seat exists.

The canonical CUP reserve independently enforces these expectations and owns usage. The LK owner
must verify the canonical FREE decision, final price zero and positive reservation units before
provider booking. LK2 receives minted `booking:<48 lowercase hex>` usage only in the strict v2
receipt obtained through `/lk/integrations/v2/booked-operations/:operationId`. Admission success
alone cannot confirm local participation. The repository checks actor, tenant, game, reservation,
operation, complete provider tuple, request/key hashes, original instance and policy, then stores
the full receipt in the existing payment snapshot in the confirmation transaction. Already-applied
replay must match that stored receipt including usage reference/units; an unbound v1 callback cannot
settle a managed snapshot. Provider identifiers and canonical instance/usage references remain
backend-only and are not added to the public response.

The original top-level `policyRef` is retained for rollback: older #503 code refuses to dispatch or
confirm such a bound snapshot. Rolling code back therefore leaves pending managed operations for
reconciliation; it does not reinterpret them as legacy or create another booking. No usage is
refunded, released or reissued by this consumer. Transport has fixed routes, time/size bounds,
no redirect, no cache and no automatic write retry. Errors remain unresolved or return the
existing commercial error envelope.

LOCAL synthetic tests cover strict managed/LEGACY parsing, the frozen hash contract, signed route
and actor bindings, preflight-before-seat order, paid legacy compatibility, immutable retry,
malformed/mismatched receipt rejection and v1 denial on applied replay. They do not establish
runtime station/exercise mapping freshness, real subscription migration coverage, physical
PostgreSQL concurrency, provider acceptance or device behavior. Existing flags remain unchanged;
activation requires the separately reviewed LK/CUP receiver versions, current mapping evidence and
explicit owner approval. Preflight is non-binding and provides no latest-at-commit guarantee beyond
the canonical CUP reserve precondition.

A stored nonterminal v2 same-key retry can reissue the exact original admission with a fresh actor
credential and signed `recovery_only:true`. The public request fingerprint must still match; its
original expected revision and the stored provider tuple/expectations/reservation are reused.
No preflight, new seat or ordinary admission is repeated. The LK receiver restricts this mode to
an already persisted admission and canonical booking operation; absent canonical state stays
UNKNOWN without reserve/provider booking POST. The mode is outside the immutable body hash and
cannot refresh expectations. After this restricted recovery, LK2 reads and validates the full
receipt normally. Recovery does not change v1 behavior. A raced completed `beginPaidJoin` replay
also goes through the stored receipt validation rather than returning success from its state alone.
