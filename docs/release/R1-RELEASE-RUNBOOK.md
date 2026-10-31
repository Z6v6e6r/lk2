# LK2 R1 — release preparation и controlled handoff

## Дополнительные prerequisites текущего checkpoint

Перед tournament consumer зафиксировать actual owner по custom-to-Viva mapping; отдельно проверить CUP accessLevels/claim/readback или LK/Viva binding. Не поставлять два независимых writer для одного участия. Monetary SELF не активировать без versioned game refund/credit contract и approved financial acceptance: historical annual-subscription proof и synthetic options недостаточны. #518 full source green не закрывает native journey gate: latest a644 run дал0passed/5failed на fixture reset; xcresult сохранён и owned cleanup завершён. Приёмка требует успешного actual native run следующего source; compiled/fixture evidence не является device acceptance. LK#271 owner и LK2#519 SELF source/physical CI green; принять compatible heads и native/provider consumers до activation, не активировать standalone owner по зелёному CI.

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

F принимает reviewed signing pipeline. #510 `22303758` имеет successful unsigned native CI `41203337199` и full CI `41203337054`; это не signed/archive/store acceptance. #504 остаётся отдельным Android signing candidate. Approved certificates/profiles/capabilities, signed artifacts и stores ещё требуется принять отдельным пакетом. Не создавать ключи или credentials в процессе аудита.

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

## Merge без неявной доставки

Fresh GitHub read 2026-10-31: repository variable `LK2_STANDARD_DELIVERY_ENABLED=true`;
`timeweb-standard-delivery` environment имеет branch policy без required reviewers. Workflow
`timeweb-standard-delivery.yaml` реагирует на завершённый успешный push/main CI и вызывает
production operator. Поэтому разрешение merge нельзя автоматически трактовать как разрешение
на этот вызов. Исторический RANGE_INELIGIBLE не является защитой от самого operator invocation.

Для согласованного source-only merge требуется отдельное разрешение на конкретный временный
цикл repository variable либо другой уже утверждённый способ изоляции. Предложенный цикл:
проверить исходный value/updated_at и отсутствие незавершённых main CI, delivery/publication/deploy
runs; установить false и подтвердить readback; повторить inventory; проверить exact PR head/main;
merge только разрешённого head; проверить resulting main SHA/tree и его push CI; дождаться
соответствующего workflow_run с terminal `standard-web: skipped` без transport steps. Перед
restore повторно проверить main, отсутствие outstanding main-CI/delivery runs и свой false,
затем вернуть исходный true и проверить readback. Любое чужое изменение требует переоценки.

Variable проверяется при admission job: false не останавливает уже запущенную/допущенную задачу.
Не отменять такие задачи и не переключать flag автоматически. Не восстанавливать true в finally:
поздно завершившийся main CI способен вызвать delivery. Отсутствие run или прошедшее время не
доказывает skip. Этот документ описывает процедуру, но не предоставляет authority; временный цикл и merge #508 одобрены отдельно. False установлен в 12:34:48 UTC и merge `14ebdca6` выполнен;
main CI `41201792854` success, downstream `41202697617`/`standard-web` SKIPPED без steps.
После quiescence/main/false readback исходный true восстановлен и проверен в 12:49:05 UTC.
Никакие transport, publication или deploy steps в этом цикле не исполнялись.

## Cross-repo compensation/readback prerequisite

До зависимого runtime opt-in принять compatible heads в порядке **ph-admin #57 → #58 → #59 → LK #264**.
#58 `cab33ce` physical ledger CI `41201269983` и #59 `70d3820c` physical TTL readback CI
`41204278865` success; это конкретные synthetic CI persistence cases. LK #264 `de95b8cc`
LOCAL 213 passed / 1 existing skip, CI `41204447158` success. Receipt readback возвращает ровно
семь полей после actor/tenant/operation/instance-scoped primary-majority read. Только уже завершённый
`FAILED / APPLIED / PROVIDER_REJECTED / null` позволяет local exact-marker CAS после исходного TTL.
Новый release, подпись или обновление observedAt не допускаются; незавершённое освобождение остаётся
pending. До наличия endpoint или при ошибке consumer остаётся pending, сохраняя совместимость.

Отдельно принять runtime HTTP path, Node-RED crypto/key custody, closed flags и provider sandbox
semantics; не включать producer/strict mode автоматически после merge. Этот пакет не разрешает
B02 owner v2, B03 CREATE, B04 paid cancellation, B05 signup или B06 native guards. #509/#510
нужны для push/build lanes, но не заменяют physical-device acceptance. B12 high исправлен на main;
финальный выбранный source всё равно требует собственного зелёного dependency/full gate.

## Приёмка последующих кандидатов

#511 `ed3854c3` имеет green combined CI, но не разрешение merge. Новый cycle delivery flag
нельзя выводить из уже завершённого approval #508: необходимы exact head и отдельная authority.
Перед каждым разрешённым source-only cycle повторить quiescence/current main/flag checks;
после merge дождаться exact main CI и corresponding delivery SKIPPED без executed steps,
затем проверить отсутствие новых relevant runs и только тогда восстановить исходный flag.

CUP #60 добавляет read-only preflight и optional expectations поверх #59. До использования
managed JOIN v2 принять совместимые owner/consumer heads и selector drift/replay tests;
не подменять explicit LEGACY отсутствующим instance. #512 debug APK и #513 unsigned iOS
проверяют build/consumer slices, но не открывают signed/store/device gates. Эти PR не входят
в source integration #511 и не активируются вследствие её merge автоматически.

## Установка совместимого owner v2 / SELF compensation

До отдельного runtime approval сверить CUP #60, LK #267 и LK2 #515 exact heads и законченный CI. Выполнить отдельную paired runtime приёмку selector/preflight/admission/receipt/recovery без конфигурационного downgrade. Проверить actual Node-RED crypto injection, closed opt-in flags, actor-scoped calls и provider mapping provenance; ключи и live config в этой программе не создавались.

Для #269 устанавливать только полный совместимый graph: bridge, owner authority read, lease reclaim и capability3 вместе. Самостоятельное включение probe запрещено контрактом: успешная capability без actual handler дала бы ложную совместимость. Fresh actor retry обязателен; background token не сохраняется. До rollout подтвердить exact canonical compensation и lost-response recovery на разрешённом target. Старые tenantless rows остаются pending; автоматической миграции нет.

#268 меняет только CI fixture runner для Mongo8. Его green monthly run не доказывает исправность production kernel/Mongo и не является разрешением менять production runtime.

#516 зависит от #513 и существующих server profile/direct-create permissions. Перед native acceptance проверить participant UUID route, OTHER projection, privacy denial, same-key retry и account-switch на реальном устройстве. Unsigned build и browser mock не являются подписанным IPA или device acceptance.
