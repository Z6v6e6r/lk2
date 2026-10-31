# B2: LK2 policy/usage binding — план среза

Статус на 2026-10-31: **локальная защитная часть реализована в Draft PR #503;
end-to-end binding заблокирован отсутствующим owner v2**. Реализация разрешена в рамках R1;
это не разрешение на merge, публикацию или provider/live операции.

- Ветка: `agent/lk2-policy-usage-binding-v1`; базовый main LK2 `d6a0458a1ae79aac3efccb0396486444d27d73e7`.
- Повторно проверены main LK1 `788fdb96b3efd60fb09e4187b4ca4b5b00e2daaa` и ph-admin
  `83b1c17bc4c5edaec65387b25b5695e48337c3cf`: quote остаётся non-binding v1,
  admission/delegation/receipt не несут согласованный policy/usage binding v2.
- Строгий parser в `@phub/domain` используется БД и adapter; старые импорты adapter сохранены.
  JSON snapshot сохраняет refs без миграции. Отсутствие refs допускает v1; explicit null,
  неполные или повреждённые refs отвергаются, а не понижаются до legacy.
- JOIN с refs отклоняется до DB/provider dispatch. Чтение и reconciliation существующей bound
  попытки возвращают UNKNOWN; confirmation callback не может погасить её receipt v1.
- CREATE seam сверяет echo refs и запрошенные reservationUnits. Это LOCAL synthetic evidence,
  не подтверждение реального контракта provider.
- `commercialJoinRequestHashV2` — подготовленная локальная функция; не активный wire v2.
  Legacy v1 fingerprint и owner contract сохранены. Новый флаг активации не добавлен.
- Следующий dependency gate: [точный upstream контракт](lk1-policy-usage-binding-contract-request.md),
  затем owner implementation, совместимость v1/v2 и интеграционное acceptance.

Ниже сохранена исходная декомпозиция от 2026-10-27; её исторические статусы не являются текущим
подтверждением готовности. LK2 не получает собственный entitlement/usage ledger.

## 1. База и предусловия

| Предусловие                                              | Состояние на 2026-10-27                             | Что это даёт/блокирует                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 (#445) — read-only реестр published/effective политик | Land-ready, head `b84292ab`, merge ожидает approval | даёт LK2 чтение `policyVersion`+`policyDigest` из CUP; B2 не обязан сам публиковать/хранить политики                                                                    |
| PR #499 — WARN managed commercial CREATE (`P0 #1 A1`)    | Draft, `agent/lk2-commercial-create-warn-v1`        | **база B2**: коммерческий CREATE, строгий WARN-контракт и замороженный reserve/confirm/release client; B2 ветвится от финального head #499 после лендинга, не от `main` |
| Контракт B3 (LK1)                                        | внешний, блокер; запрос оформлен                    | binding quote, admission v2, receipt v2, reserve/confirm/release/compensate, usage readback                                                                             |
| LK1 booking owner v2 (`lk` repo, Node-RED receiver)      | v1 есть, v2 нет; внешний                            | admission v2, receipt v2 и claims v2 требуют изменений в owner flow, не в ph-admin                                                                                      |
| LK1 CUP registry (ph-admin)                              | endpoint есть на main `83b1c17b`, выключен флагами  | B1 staging readback: включить `SUBSCRIPTIONS_POLICY_REGISTRY_*` и совпадение integration-token с LK2                                                                    |
| Staging LK1 + authority на интеграционный прогон         | нет                                                 | acceptance B2 нельзя закрыть только fake-owner тестами                                                                                                                  |

Срез доказательств для ссылок ниже: `origin/main` @ `871cc2f8` (+ content B1 `b84292ab`). LK1-факты
проверены 2026-10-27 по ph-admin main `83b1c17b` и handoff `lk`/`outputs/lk1-booked-op-receiver-20261021`.
После лендинга #499 номера строк в `games/**`, `apps/api/src/main.ts` и `packages/config` могут
сдвинуться — перед реализацией перепроверить по фактическому head.

## 2. Что уже есть (не ломать)

| Механизм                                       | Где                                                                                                                                                                                          | Роль в B2                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Commercial JOIN orchestrator                   | `apps/api/src/games/game-commercial-join.ts`                                                                                                                                                 | durable attempt, single dispatch, reconcile; сюда добавляются refs                                            |
| Request fingerprint v1                         | `game-commercial-join.ts:324-341`, label `game.join.paid.v1` (`:329`)                                                                                                                        | в v2 добавляются `policyRef`/`usageRef`; v1-хеш не редактировать                                              |
| Exact binding check                            | `game-commercial-join.ts:905-922`                                                                                                                                                            | сверка receipt с binding; расширяется на refs при их наличии                                                  |
| Durable writer                                 | `packages/database/src/game-roster-repository.ts:1684-1873` (`beginPaidJoin`), `:1344-1416` (`loadPaidJoinAttempt`), snapshot write `:1805-1829`, read `snapshot->'providerBinding'` `:1369` | сюда же аддитивно ложатся `policyRef`/`usageRef`                                                              |
| `eligibility.payment_snapshots.snapshot` jsonb | `packages/database/migrations/0084_participation_level_eligibility.sql:204-217`                                                                                                              | **персистенция без миграции**: свободный jsonb, уже пишется/читается                                          |
| `games.payment_confirmation_evidence`          | `packages/database/migrations/0085_game_payment_confirmation_evidence.sql:26,44`                                                                                                             | durable digest receipt (`evidence_hash`, unique по reservation) уже есть                                      |
| Admission v1                                   | `packages/subscription-runtime-adapter/src/booked-operation-admission.ts:11-18` (ровно 3 ключа), `:59-75` (детерминированный operationId)                                                    | v2 — расширение контракта LK1, не локальная правка                                                            |
| Receipt v1                                     | `packages/subscription-runtime-adapter/src/booked-operation-read.ts:6-24` (17 ключей), strict parser `:26-77`                                                                                | v2 — новый exact key set                                                                                      |
| Delegation claims v1                           | `apps/api/src/subscriptions/subscription-runtime-actor-delegation-issuer.ts:187-220`                                                                                                         | v2 claims — только после ответа B3 (3.7)                                                                      |
| WARN advisory quote                            | `apps/api/src/subscriptions/subscription-runtime-warn-routes.ts:42-52`                                                                                                                       | публичный ответ не расширяется; policy/usage refs остаются internal                                           |
| Fake-owner seams                               | `apps/api/src/games/game-commercial-join.test.ts:84-104`, `:554`; `game-commercial-join-runtime.test.ts:235-290` (`admissionTransport`)                                                      | готовые fake LK1 для B2-тестов, без сети                                                                      |
| CREATE frozen LK1 contract (#499)              | `docs/contracts/game-commercial-create.md`; `apps/api/src/games/game-create-commercial-runtime.ts:157-360`                                                                                   | reserve/confirm/release клиент и strict receipt parse уже есть; B2 расширяет refs, не создаёт новый транспорт |
| LK1 owner v1 (admission/receipt)               | `lk` repo: `scripts/nodered_booked_operation_receiver_nodes/**`, `outputs/lk1-booked-op-receiver-20261021/HANDOFF-LK1.md`                                                                    | **точный claim set**, `contract_version:1`, `receipt_version:1`; v2 — внешняя работа LK1                      |

Проверенный факт: на срезе в LK2 **нет** таблиц entitlement/usage counters и нет
`booked_operation*` таблицы; последняя миграция — `0104_identity_external_subject_link_commands.sql`.

## 3. Границы среза

**Scope:** коммерческий JOIN (и CREATE после #499); binding policy/usage refs; opaque orchestration
ref; строгий WARN→binding контракт; персистенция только в существующий jsonb; fake-owner тесты;
флаг default OFF.

**Non-goals (не делать в B2):**

- публичный API/OpenAPI/SDK и любые public DTO-поля;
- counters/ledger/entitlement внутри LK2;
- evaluation политик на стороне LK2;
- миграция 0105 (см. §6) и любая новая таблица;
- reserve/confirm на стороне LK2 как источник истины;
- изменения admission/delegation до ответа B3 по claims (3.7 контракта);
- production/staging-операции без отдельного approval.

## 4. Шаги среза (порядок обязателен)

1. **Типы и парсеры.** В `@phub/subscription-runtime-adapter` добавить `CommercialPolicyRef`
   (`policyVersion`, `policyDigest`), `CommercialUsageRef` (`usageRef`, `reservationUnits?`) и
   `CommercialOrchestrationRef` (opaque receipt ref) со строгими `parse*`/normalize в стиле
   `booked-operation-read.ts`: reject `policyVersion < 1`, `policyDigest` не
   `sha256:[a-f0-9]{64}`, лишние ключи. Юнит-тесты accept/reject.
2. **Персистенция без миграции.** Протянуть optional refs:
   `CommercialJoinCommandEnvelope` → `beginPaidJoin` → `payment_snapshots.snapshot` рядом с
   `providerBinding`; читать в `loadPaidJoinAttempt` (целый jsonb, чтобы отличать отсутствующее поле от explicit null), отдавать только во внутренний attempt view. Никаких новых колонок,
   индексов и таблиц; размер refs ограничить (snapshot читается под 1500 ms statement timeout).
3. **Owner binding и receipt v2.** Для CREATE базовый reserve/confirm/release-клиент уже есть в
   #499 (`game-create-commercial-runtime.ts:157-360`): расширяем его `policyRef`/`decisionId`/
   `usageRef` и strict receipt v2, не создавая второй транспорт. Для JOIN расширяем legacy-порт
   (`CommercialJoinOwnerPort` в `game-commercial-join.ts`) и exact binding check `:905-922`:
   при наличии refs — сравнивать, при отсутствии — поведение не меняется. Receipt v2 парсить
   строгим exact key set (после фиксации списка в контракте, 3.4), не ослабляя fail-closed.
4. **Request hash v2.** Новый label `game.join.paid.v2` (не править v1 на месте) с включением
   `policyRef`/`usageRef`/`decisionId`; старые in-flight ключи продолжают работать по v1. Тест:
   ретрай с тем же ключом после перепубликации политики → ref mismatch → UNKNOWN/reconcile, не
   новая покупка.
5. **Fake-owner тесты** (на существующих seam'ах): refs сохранены и прочитаны; повтор с тем же
   ключом не создаёт второй резерв и не меняет refs; mismatch → reconcile, не второй purchase;
   receipt без refs работает по-старому (backward compatible); потерянный ответ → owner read,
   не второй dispatch; в LK2 нет записи counters.
6. **Флаг и включение.** Новое поведение — только за флагом/composition (по образцу
   `gameCommercialJoin`: без owner/refs композиция не создаётся, путь остаётся
   `GAME_PAYMENT_REQUIRED`). Флаг: owner/purpose, activation criterion, removal-or-review
   condition. Default OFF; production — отдельным решением.

## 5. Acceptance → шаги → evidence

| Acceptance B2                                                                                     | Шаги | Evidence                                                                                     |
| ------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| одна операция CREATE/JOIN доказывает цепочку rule version → usage reservation → booking → confirm | 1-4  | fake-owner тест цепочки + readback `policyRef`/`usageRef`/receipt; STAGING-прогон с LK1      |
| повтор/потеря ответа не увеличивает usage                                                         | 4-5  | тесты replay и lost-response; readback счётчика LK1 до/после (STAGING)                       |
| LK2 не хранит counters                                                                            | 2,5  | миграционный grep + assert отсутствия записи counters в тестах; только opaque refs/digest    |
| fake-owner тесты                                                                                  | 5    | локальные тесты пакета/`apps/api`                                                            |
| реальный staging-прогон с LK1                                                                     | 6    | STAGING evidence: флаги LK1+LK2, версия/дайджест политики, резерв, booking, confirm, счётчик |

Staging-предусловия (проверено 2026-10-27): LK1-реестр включается флагами
`SUBSCRIPTIONS_POLICY_REGISTRY_ENABLED` + `SUBSCRIPTIONS_POLICY_REGISTRY_INTEGRATION_TOKEN`, а LK2
ждёт `SUBSCRIPTION_POLICY_REGISTRY_ENABLED` + `_BASE_URL` + `_INTEGRATION_TOKEN` (имена отличаются
на одну `S`). Для reservation/booking нужен v2 в LK1 Node-RED owner flow: текущий owner проверяет
точный claim set и `contract_version:1`/`receipt_version:1`.

## 6. Миграция 0105 — не нужна, если не меняется требование

Refs и `providerBinding` живут в `payment_snapshots.snapshot` jsonb без DDL. 0105 (CRITICAL,
отдельный approval) нужна только если:

- требуется хранить **сырое тело** opaque receipt (сейчас хранится только digest в
  `payment_confirmation_evidence`); либо
- нужна индексируемая/constrained колонка (`policy_version integer not null` и т.п.); либо
- refs должны попасть в `games.operations`/`command_idempotency` (там нет подходящего jsonb для
  IN_PROGRESS-попытки).

Если B3 формулирует требование иначе — это отдельное решение, не расширение B2 «по ходу».

## 7. Риски и rollback

| Риск                                                | Митигация                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Смена request hash ломает in-flight идемпотентность | новый label v2, v1 не трогать, флаг, тест на replay                       |
| LK2 начнёт хранить counters «для удобства»          | явный non-goal, тесты на отсутствие writes, review                        |
| Receipt v2 exact-key парсер не совпадёт с LK1       | согласованный список до реализации, version-negotiation тесты             |
| Двойной usage при retry                             | единственный dispatch уже реализован; reserve/confirm идемпотентны на LK1 |
| Рост snapshot jsonb / statement timeout             | только фиксированный набор коротких refs, лимиты длины                    |
| Дрейф базы после лендинга #499                      | rebase только своей ветки после лендинга; перепроверить точки вставки     |

Rollback: флаг OFF ⇒ refs остаются инертными в существующем jsonb, схема не меняется,
deploy-only откат. Persist-данные (refs) совместимы со старым кодом.

## 8. Открытые вопросы

Все блокирующие вопросы к LK1 собраны в
`docs/plans/lk1-policy-usage-binding-contract-request.md` §7. Дополнительно к LK2:

- база B2 = финальный head #499; нужен его land/approval до создания
  `agent/lk2-policy-usage-binding-v1`;
- кто владелец worktree/ветки `agent/lk2-commercial-create-warn-v1` на момент старта B2;
- нужен ли отдельный флаг на CREATE-часть после #499 или один общий `GAME_COMMERCIAL_*`;
- переводим ли JOIN на замороженный reserve/confirm-контракт CREATE или добавляем v2 к legacy
  Node-RED owner (см. контракт §7 п.10).

## 9. Не-цели документа

Документ не разрешает merge, staging/deploy, миграции, writes в LK1 или production-включение.
После появления контракта B3 и лендинга #499 план перепроверяется и превращается в реализацию
отдельным task-branch loop с независимым CRITICAL-review.
