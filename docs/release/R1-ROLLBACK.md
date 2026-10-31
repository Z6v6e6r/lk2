# LK2 R1 — rollback и recovery readiness

Статус: **PARTIAL source procedures / UNKNOWN свежая rehearsal готовность**. В этом аудите rollback, restore, изменение flags, остановка worker, возвраты или store actions не выполнялись. Этот документ — требования к подготовке, не разрешение операций.

Каноническая основа: [application rollback](../runbooks/rollback.md), [Timeweb runtime](../runbooks/timeweb-lk2-beta.md), [publication custody](../runbooks/timeweb-amd64-image-publication.md). Выбранные target, previous digests, backup receipt и совместимый mobile/backend floor должны быть заполнены release owner до GO.

## Что требуется сохранить до rollout

| Объект              | Необходимое доказательство                                                                                           | Статус этого аудита             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Backend package     | Canonical manifest/checksum, source/tree/run, пять компонентов, предыдущие runtime digests                           | UNKNOWN selected package        |
| Database            | Exact schema/ledger, compatible old binary, owned backup, successful isolated restore, роли/ACL                      | UNKNOWN fresh target proof      |
| Business operations | Durable attempts/idempotency keys/receipt states, unresolved payment/refund/booking list в защищённом evidence store | UNKNOWN runtime; не выгружалось |
| Outbox/realtime     | Event schema compatibility, consumer checkpoint/lease, lag и DLQ baseline                                            | PARTIAL source mechanisms       |
| Native builds       | Released build/version/hash/signing identity, minimum compatible API/event versions                                  | BLOCKED signing/native parity   |
| Operations          | Incident owner, rollout/rollback authority, target/lease, RPO/RTO, observation thresholds                            | UNKNOWN selected release        |

## Матрица отказов и безопасного восстановления

| Отказ                                 | Требуемое действие после соответствующего разрешения                                                                      | Что запрещено считать восстановлением                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Candidate не прошёл preflight         | Не активировать; сохранить failed category/receipt; устранить в task branch                                               | Повторный dispatch или ослабление guard                                             |
| Неизвестный результат provider POST   | Freeze original operation, GET/readback/reconcile по canonical owner; сохранять pending/unknown                           | Новый POST с новым ключом, ручное PAID/BOOKED                                       |
| Частичная cancellation/refund         | Reconcile provider outcome; применить idempotent compensation только по подтверждённому результату                        | Спекулятивный возврат визита/денег или повторный refund                             |
| App/readiness regression              | Выбрать проверенный previous digest; доказать schema/event compatibility; canonical sequential rollback и smoke           | Mutable tag, rebuild на host, schema downgrade по умолчанию                         |
| Worker/outbox regression              | Сохранить durable events и leases; совместимый worker; bounded replay/DLQ recovery                                        | Очистка outbox/queues, потеря attempts, неконтролируемый replay                     |
| Chat membership leakage               | Ограничить affected path по утверждённому плану; revoke/reconcile permissions, проверить read/send/fanout                 | Только UI hiding или стирание истории                                               |
| Push regression                       | Изолировать sending по approved scope; сохранить intents, endpoint/account ownership; reconciliation unknown outcomes     | Массовая повторная рассылка; SENT = устройство получило                             |
| Mobile regression после store rollout | При наличии разрешения остановить phased rollout; вернуть совместимый backend/feature behavior, подготовить signed hotfix | Предположение, что можно мгновенно downgrade все установленные клиенты              |
| DB несовместима с old binary          | Остановить автоматический application rollback, выбрать approved forward fix/restore plan                                 | Destructive restore без отдельной exact authority и reconciliation внешних операций |

## Обязательная rehearsal

В отдельно разрешённом disposable окружении воспроизвести: new schema + old binary; in-flight JOIN/payment во время app/worker switch; outbox commit без broker ACK; consumer crash после side effect; duplicate/late callback; client version N с backend N−1; повторный запуск recovery после потери ответа.

Assertions: число мест и состав участников сохранены, один commercial side effect на operation, деньги/usage согласованы с owner, outbox не теряется, tenant isolation соблюдается, сообщения восстанавливаются из HTTP history, notification preferences применяются при отправке. Проверить backup restore и измерить фактические recovery time/data loss относительно утверждённых RPO/RTO. В текущем аудите значения не измерялись.

WebSocket stream содержит recoverable hints, а не durable history: `apps/realtime/src/message-consumer.ts:155-229`, `apps/web/src/chat-realtime-client.ts:26-107`. Восстановление должно сверить sequence/cursor по HTTP. APNs `APNS_OUTCOME_UNKNOWN` нельзя автоматически превращать в success или безусловный retry.

## Закрытие инцидента

Сохранить exact before/after package identities, выполненные команды/receipts, DB/event compatibility и пользовательский smoke, provider reconciliation и observation. Успешный image rollback не отменяет migration или уже совершённый платёж. Решение закрыть инцидент принимает назначенный owner по фактическим business invariants, а не по зелёному health endpoint.

## Временное подавление automatic delivery при source merge

Если отдельно разрешённый flag cycle прерван, сначала прочитать variable, exact main/PR state,
main push CI и связанный delivery run. Не повторять неоднозначный merge и не делать безусловный
restore=true. При неразрешённой очереди/чужом drift оставить подтверждённый false, сообщить
точный hold владельцу и получить указание для изменившегося recovery scope. Если variable уже
изменена другим владельцем, не перезаписывать её. Revert main, workflow cancel/rerun/dispatch,
publication и host rollback этим планом не разрешаются. Восстановление исходного true разрешено
только в пределах одобренного цикла после доказанного skip и проверки quiescent main/delivery.
