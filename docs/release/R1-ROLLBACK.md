# LK2 R1 — rollback и recovery readiness

Статус: **PARTIAL source procedures / UNKNOWN свежая rehearsal готовность**. На первом этапе rollback, restore, flags и runtime не менялись. Позднее отдельно одобрен только repository delivery-flag cycle для source-only merge #508; production flags, rollback/restore, worker, возвраты и stores не затрагивались. Этот документ — требования к подготовке, не разрешение операций.

Каноническая основа: [application rollback](../runbooks/rollback.md), [Timeweb runtime](../runbooks/timeweb-lk2-beta.md), [publication custody](../runbooks/timeweb-amd64-image-publication.md). Выбранные target, previous digests, backup receipt и совместимый mobile/backend floor должны быть заполнены release owner до GO.

## Что требуется сохранить до rollout

| Объект              | Необходимое доказательство                                                                                           | Статус этого аудита                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Backend package     | Canonical manifest/checksum, source/tree/run, пять компонентов, предыдущие runtime digests                           | UNKNOWN selected package                                 |
| Database            | Exact schema/ledger, compatible old binary, owned backup, successful isolated restore, роли/ACL                      | UNKNOWN fresh target proof                               |
| Business operations | Durable attempts/idempotency keys/receipt states, unresolved payment/refund/booking list в защищённом evidence store | UNKNOWN runtime; не выгружалось                          |
| Outbox/realtime     | Event schema compatibility, consumer checkpoint/lease, lag и DLQ baseline                                            | PARTIAL source mechanisms                                |
| Native builds       | Released build/version/hash/signing identity, minimum compatible API/event versions                                  | Unsigned CI #510 verified; signing/native parity BLOCKED |
| Operations          | Incident owner, rollout/rollback authority, target/lease, RPO/RTO, observation thresholds                            | UNKNOWN selected release                                 |

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

## Durable rejection и canonical readback

Compatibility order: CUP #57 → #58 → #59 → LK #264. Исторический LK worker видит durable
`PRECREATE_RECONCILIATION_REQUIRED` и оставляет reconciliation pending; он не должен возобновлять
CREATE. Не удалять marker или переписывать original observedAt ради retry. Exact local RELEASED
может вернуть прежний результат без signer/CUP request. Если локальный ACK потерян и TTL истёк,
новый consumer читает canonical CUP receipt и завершает только прежний full-marker CAS при
`FAILED / APPLIED / PROVIDER_REJECTED / null`. Endpoint unavailable, foreign/malformed receipt,
неприменённая компенсация или незавершённый CUP release сохраняют pending. Это не новый release,
proof refresh, refund или provider POST.

#58 physical canonical transaction/rollback/lost-response и #59 post-TTL readback CI passed
(`41201269983`, `41204278865`); новый LK consumer CI `41204447158` success. Эти результаты не являются
rehearsal rollback выбранного production target. Rollback не должен выключать strict validation
ради компенсации; secret/config/source transitions требуют собственного exact approval.

Завершённый source-only cycle #508: false 12:34:48 UTC → main `14ebdca6`, CI `41201792854` success
→ delivery `41202697617` standard-web SKIPPED, steps=[] → исходный true восстановлен/readback
12:49:05 UTC. Delivery, publication и host rollback не выполнялись; новое выполнение этого цикла
не разрешено исторической записью.

## Совместимость новых подготовленных пакетов

- CUP #60: expectations optional для прежних callers, прежний absent fingerprint сохраняется.
  После начала bound operations нельзя откатывать на receiver, игнорирующий expectations:
  остановить новые managed admissions и сохранить readback/replay до завершения операций.
  Старый ответ без строгой binding формы downstream обязан отвергать, а не принимать как legacy.
- #512 Android community history меняет только native GET allowlist; откат consumer не меняет
  membership или backend data. Debug APK не является rollback artifact установленной production версии.
- #513 iOS existing chats можно revert как отдельный consumer commit поверх #511, восстановив
  unavailable route/default-deny. Уже принятые сервером сообщения/read cursors остаются canonical.
  Pending send только в памяти mounted thread: нет обещания восстановления draft после process death.
- #511 test-only process termination fix не меняет production scripts. Ни один из этих source
  rollback планов не означает разрешение выполнить runtime rollback или изменение shared data.

## Recovery floor для новых bound operations

- #267/#515: после появления v2 bound operation сохранять compatible receipt/readback/recovery-only обработчики до её terminal outcome. Остановка новых admissions допустима только отдельным runtime решением; v1 или отсутствие instance не могут стать fallback. Original request tuple, fingerprint и canonical usage identity не переписывать.
- #269: после CUP compensation, но потерянного local ACK восстановление выполняется exact readback и CAS исходной operation/generation. Не повторять visit return или денежный refund ради локального состояния. Original proof timestamp не продлевается; post-TTL uncompensated operation остаётся pending.
- Старые managed leave rows без stored tenant требуют отдельного доказанного recovery/backfill решения; source rollback не добавляет им authority. Не удалять additive proof/receipt поля при откате consumer. Все описанные runtime действия требуют отдельного exact-target разрешения.

#516 можно откатить отдельным consumer revert до создания новых DIRECT, сохранив #513 existing chat reader. Уже созданные server conversations остаются canonical; удалять их для rollback нельзя. Незавершённый create key хранится в памяти authenticated cabinet; после process death новый запрос полагается также на server unique pair, а не обещанное восстановление памяти.
