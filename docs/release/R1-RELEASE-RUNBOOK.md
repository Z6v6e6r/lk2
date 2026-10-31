# LK2 R1 — release preparation и controlled handoff

**Текущее решение NO-GO. Этот документ не разрешает dispatch, публикацию, deploy, provider writes или store upload.** Он связывает R1 критерии с существующими executable runbooks; не создаёт новый deploy process. Baseline/блокеры: [READINESS](R1-READINESS.md), [BLOCKERS](R1-BLOCKERS.md).

## 1. Закрыть source и product gates

- A фиксирует actual main и residual open-PR delta всех трёх repo; B–G закрывают bounded tasks из [DEPENDENCIES](R1-DEPENDENCIES.md).
- Сохранить LK1 canonical writer и публичную совместимость; ни parallel dual-write, ни обвод production guards.
- Изменения identity/payment/contracts/schema/native transport проходят соответствующий specialist review и full applicable gate. Документационный audit не требует запускать runtime stack.
- Интеграция только готовых совместимых heads по [delivery-batches](../runbooks/delivery-batches.md). Merge требует owner authority; исходный запрос на аудит его не даёт.
- Для финального source обязательны main CI, актуальный dependency gate и результаты required suites без silent skips. [E2E matrix](R1-E2E-MATRIX.md) должна иметь per-case evidence.

## 2. Определить exact release package и target

Release owner записывает LK2/LK/ph-admin SHAs и contract versions, Git trees, source CI run/attempt, выбранные компоненты, mobile build numbers, feature scope, target topology/tenant/station и canonical writer. Указывает active operation owner/lease и rollback floor. Сейчас эти поля не заполнены — release package ещё не выбран.

Для Timeweb применяется [immutable publication runbook](../runbooks/timeweb-amd64-image-publication.md): exact current main, source/workflow identity, canonical `PHUB_TIMEWEB_RELEASE_MANIFEST_V2`, checksum и полный пятикомпонентный набор. Проверять актуальный контракт при выборе source. Исторический successful run или чужой manifest нельзя переиспользовать как новое разрешение.

[Release lanes](../runbooks/release-lanes.md) — target contract, пока platform plan не реализован; действующий strict path остаётся исполнительным. `RANGE_INELIGIBLE` Web route не обходить и не rerun без новой гипотезы/разрешения; выбрать разрешённый full package route.

## 3. Принять staging/provider/device evidence

- Зафиксировать отдельное разрешённое окружение, synthetic accounts, owned disposable fixtures и ограниченный список provider sandbox операций/получателей.
- Выполнить Q01–Q22 на candidate-bound runtime и обоих мобильных клиентах; сохранять readback и failures, не только screenshots/HTTP status.
- Проверить concurrency, outbox/broker recovery, payment ambiguity, cancellation compensation, tenant isolation, membership revoke, chat recovery, quiet hours и opt-out.
- Проверить observability: readiness/error rate, booking/payment invariants, queue/outbox age, retries/DLQ, invalid endpoints, worker lag. Наличие YAML alert не равно проверенному alert delivery.
- Любая запись в общую БД, provider request или реальная отправка требует явно разрешённого exact scope. Read-only audit не даёт такого разрешения.

## 4. Подготовить mobile artifacts

F принимает reviewed signing pipeline; #504 — только кандидат Android wiring. iOS signing/archive/upload заглушку требуется заменить в отдельной задаче. Не создавать ключи или credentials в процессе аудита.

Для каждой платформы сохранить source SHA, dependency lock, toolchain, app ID, version/build, artifact SHA-256, approved signing certificate fingerprint и verification result. На iOS проверить provisioned entitlements/APNs environment/topic; на Android Firebase app/provider scope и release signing. Debug APK и simulator build не заменяют release artifact.

Проверить install/upgrade/logout, native commands/payment return, background/terminated push, deep links, offline recovery и совместимость с rollback backend. Владелец store подтверждает privacy/data safety, account deletion, support/privacy URLs, age/content ratings, screenshots, review access, экспортные декларации по применимости. Состояние кабинетов сейчас UNKNOWN.

## 5. Production preflight и decision

Использовать выбранный действующий runbook — [Timeweb](../runbooks/timeweb-lk2-beta.md) либо иной явно назначенный canonical production route. Наличие `deploy-production.yaml` не означает, что он соответствует выбранному target; в этом workflow API не обнаружено runs.

До утверждения нужны immutable source/artifact identities, совместимый schema/roles/ownership ledger, проверенный backup **с restore proof**, предыдущие image digests и [R1-ROLLBACK](R1-ROLLBACK.md), target identity, secrets custody metadata без секретных значений, observability/on-call и заполненный [GO-NOGO](R1-GO-NOGO.md).

Owner одобряет конкретные package/target и перечисленные переходы. Publication, shared migration, routing/provider configuration, app activation и store publication не выводятся из CI или предыдущего merge. Нельзя использовать этот документ как blanket approval. При изменении target/source/risk требуется новое решение; при неизменном явно утверждённом переходе повторный запрос не нужен, но preflight свежий.

## 6. После отдельно разрешённого перехода

Исполнитель соблюдает canonical order и bounds, затем фиксирует фактический artifact/runtime readback, readiness, пользовательский smoke, business invariants и observation. App rollout выполняется последовательно, worker — после compatibility checks. Provider acceptance и device receipt записываются раздельно.

При ambiguous write — остановить повторную отправку и выполнить предусмотренный authoritative readback; при failed gate/drift — остановить переход. Rollback не является универсальным разрешением менять БД/платежи. Не объявлять PRODUCTION success до фактической приемки этого уровня.

Store upload/internal testing, review submission и public rollout — разные состояния. Записать соответствующее owner approval и фактический store receipt для каждого исполненного перехода; отсутствие ответа от store не означает approval.
