# Контур «Чаты и оповещения»

Статус: целевая архитектура, expand-only фундамент, feature-gated direct-chat
HTTP M1 и recoverable realtime M2 с Web UI, in-app, Web Push/VAPID и ручная отправка из ЦУП. Остальные публичные
операции остаются закрытыми, пока не реализованы авторизация, идемпотентность, аудит и
обработчики соответствующего вертикального среза.

Локально собранный direct-chat M1 включает User API, типизированный SDK и Web-маршруты
для list/create/history/send/read cursor. Каноническая пара PadlHub UUID дедуплицируется;
создание и отправка повторно проверяют current permission, active membership, active target и его
`chatPolicy`. Tenant gates по умолчанию выключены. Наличие кода не доказывает, что срез активирован
или проверен в целевой среде. Tenant-local directed block-list теперь закрывает DIRECT create/list/
history/send/read/realtime в обе стороны, но не удаляет историю и не меняет GAME roster policy.
Мутации block-list дополнительно закрыты глобальным
`MESSAGING_USER_BLOCK_COMMANDS_ENABLED=false`, пока все API/realtime readers не обновлены.
Tournament/station contextual chats, attachments, edit/delete, connectors и moderation в M1/M2 не
входят. Realtime M2 добавляет одноразовый session-bound ticket, повторную проверку сессии/прав/
membership/active target/privacy, identifier-only fanout и HTTP gap recovery. Web подключает
realtime для загруженных DIRECT и GAME; GAME subscription/fanout дополнительно перепроверяют
`games.play` и текущую `ACTIVE` participation, а 5-секундный HTTP polling остаётся fallback. Все
команды и каноническая история остаются в HTTP/PostgreSQL. Durable booking reminder scheduler
реализован отдельно и default-off; он не
заменяет отсутствующий authoritative booking event producer и сам по себе не разрешает активацию.

Переход из Games в GAME chat переносит только одноразовую, tenant/user-bound подсказку позиции
истории без body сообщения; Web использует её лишь после успешной текущей HTTP-авторизации.
Холодный bookmark очень старого диалога, отсутствующего в первых 50 summaries, не имеет
authoritative newest-sequence lookup в текущем контракте и остаётся вне beta closure до появления
backward/selected-summary API.

Следующий feature-gated slice реализует только `GAME`: canonical `games.games.id`, актуальная
`games.participations(state='ACTIVE')` и `games.play` повторно проверяются перед list/history/send/
read cursor. Tournament остаётся закрыт без identity-linked canonical roster; Station остаётся
закрыт без утверждённой membership/privacy модели и не добавляется в enum разговоров. Матрица
доказательств и открытые вопросы: [contextual-chats-evidence-2026-08-03.md](../plans/contextual-chats-evidence-2026-08-03.md).

Реализованный in-app срез включает rule/template consumer, транзакционные intent/inbox/delivery,
RabbitMQ inbox-дедупликацию, tenant gate, `GET /notifications`, идемпотентный `PUT
/notifications/read-cursor` и типизированный SDK. Реализованный Web Push срез добавляет
зашифрованные subscription endpoint, capability/register/revoke API, браузерный service worker,
PUSH delivery jobs, VAPID adapter, bounded retries, circuit breaker и инвалидирование 404/410.
Ручной срез ЦУП добавляет отдельный `phub-admin` JWT audience, tenant-scoped permission
`notifications.manage`, поиск получателей по телефону без сохранения входных номеров,
идемпотентную кампанию и прямую транзакционную проекцию в inbox/Web Push deliveries. APNs/FCM и
клиентские `DISPLAYED`/`OPENED` receipts остаются следующими этапами.

Пользовательская лента перепроверяется при возврате фокуса/видимости вкладки и каждые 15 секунд,
поэтому новые inbox items появляются без ручной перезагрузки. Системное уведомление вне вкладки
остаётся отдельной Web Push доставкой и требует поддерживаемый браузер, разрешение пользователя и
активную `PushSubscription`.

Шапка Главной читает `unreadCount` из того же notifications API: колокольчик ведёт на
`/notifications`, показывает красную точку и запускает ненавязчивую анимацию при непрочитанных
элементах. Счётчик перепроверяется отдельно от Home projection, не смешивая агрегаты.

## 1. Граница продукта

Контур показывается в клиентах отдельным разделом **«Чаты и оповещения»**, но внутри состоит из
двух агрегатов и отдельного модуля контроля:

| Агрегат         | Что хранит                                                                     | Чего не делает                                      |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `messaging`     | разговоры, участников, сообщения, вложения, правки, курсор прочтения           | не управляет push/SMS/email и правилами триггеров   |
| `notifications` | шаблоны, триггеры, персональные intents, inbox, предпочтения, доставки         | не добавляет записи в историю чата автоматически    |
| `moderation`    | жалобы, версии политик, очередь кейсов и неизменяемые решения                  | не отдаёт право изменения чатов внешнему провайдеру |
| `integration`   | коннекторы, внешние контакты/thread/message IDs, зашифрованные endpoint-адреса | не владеет сообщениями и статусом прочтения         |

В Web/iOS/Android пользователь видит вкладки «Чаты» и «Оповещения». В ЦУП контур включает support
inbox, триггерные рассылки, состояние доставок и отдельную очередь модерации/внешнего контроля.

Поддерживаются пять видов разговоров:

| Вид          | Создание                                   | Участники и доступ                                            |
| ------------ | ------------------------------------------ | ------------------------------------------------------------- |
| `DIRECT`     | идемпотентная команда по двум PadlHub UUID | только два пользователя; пара нормализуется, дубль невозможен |
| `GAME`       | обработчик события создания игры           | действующие участники игры и уполномоченные модераторы        |
| `TOURNAMENT` | обработчик события создания турнира        | участники/организаторы турнира по политике турнира            |
| `COMMUNITY`  | команда владельца сообщества               | активные участники сообщества по ролям                        |
| `SUPPORT`    | первый входящий контакт или команда ЦУП    | внешний контакт, назначенные агенты и руководители поддержки  |

Один контекстный агрегат получает один основной чат `(tenant, kind, context_id)`. Если позже
потребуются несколько комнат, это вводится отдельной сущностью channel, а не снятием уникальности
без миграционного плана.

## 2. Владение данными и модель хранения

PostgreSQL — единственный источник истины. Во всех строках есть `tenant_id`, cross-table связи
используют составные tenant-aware foreign keys, RLS включён и принудителен для владельца таблиц.

Основные сущности:

- `messaging.conversations`: вид, контекст, состояние и следующий монотонный `sequence`;
- `messaging.direct_conversations`: нормализованная пара пользователей для защиты от дублей;
- `messaging.user_blocks` и `user_block_commands`: directed pair policy и durable idempotency;
- `messaging.conversation_members`: внутренний пользователь, внешний контакт или system actor,
  роль, состояние, mute/notification policy и `last_read_sequence`;
- `messaging.messages`: неизменный ID, порядковый номер внутри разговора, тип, текущий body/payload,
  reply, edit/delete timestamps;
- `messaging.message_revisions`: неизменная история предыдущих версий;
- `messaging.message_attachments`: закрытый object key, hash, размер и статус проверки;
- `notifications.templates` и `notifications.trigger_rules`: версионированный контент и политика;
- `notifications.intents`: дедуплицированное решение доставить конкретному получателю;
- `notifications.inbox_items`: долговечная лента оповещений приложения;
- `notifications.deliveries` и `notifications.delivery_attempts`: состояние канала и история попыток;
- `notifications.booking_notification_projection_fences` и `booking_reminder_schedules`:
  монотонная lifecycle revision, текущий canonical booking snapshot, два leased reminder window и
  terminal state без зависимости от браузерной booking projection;
- `notifications.booking_reminder_recipients`: ordered recipient set с составным
  tenant/user foreign key; raw cross-tenant UUID array в schedule не хранится;
- `notifications.delivery_receipts`: раздельные provider accepted/delivered, client displayed и
  user opened факты;
- `notifications.admin_campaigns`, `admin_campaign_recipients` и `admin_campaign_commands`:
  ручная отправка из ЦУП, внутренние получатели и durable idempotency без хранения введённых
  телефонных номеров;
- `moderation.policies`, `moderation.reports`, `moderation.cases` и `moderation.actions`: правила,
  входные жалобы/сигналы, очередь рассмотрения и неизменяемые решения;
- `integration.messaging_*` и `integration.notification_*`: только адаптерные данные и внешние IDs.
- `integration.moderation_*`: аккаунты внешнего контроля и дедуплицированные signal IDs без права
  прямого изменения бизнес-состояния.

Provider accounts (`WEB_PUSH`, `APNS`, `FCM` и будущие email/SMS adapters) хранят только ссылку на
секрет в secret manager, app ID, окружение и operational state. Endpoint установки ссылается на
provider account и хранит зашифрованный subscription/token; credential и endpoint не смешиваются.

Тело сообщения хранится в PostgreSQL; файлы — в приватном S3-compatible storage. Redis содержит
только TTL-состояние presence/typing, маршрутизацию активных соединений, rate limits и короткие
locks. RabbitMQ содержит транзитные события/retry/DLQ и не используется для восстановления истории.

## 3. Команды и транзакционные инварианты

### Отправка сообщения пользователем или агентом ЦУП

1. API проверяет PadlHub JWT, tenant, членство/роль, блокировки, лимиты и размер контента.
2. Команда требует `Idempotency-Key`; клиент также передаёт стабильный `clientMessageId`.
3. В одной транзакции API блокирует строку разговора, берёт `next_sequence`, увеличивает его,
   записывает сообщение, audit и `messaging.message.created.v1` в outbox.
4. Ответ возвращается после commit. Успех WebSocket или внешнего коннектора не входит в HTTP SLA.
5. Повтор с тем же ключом/`clientMessageId` возвращает исходный результат, а не создаёт сообщение.

Порядок определяется только серверным `sequence`, не клиентским временем. Для edit/delete
применяется optimistic predicate по текущей версии; удаление создаёт tombstone и не переиспользует
sequence.

### Входящее сообщение коннектора

1. Webhook ingress проверяет подпись, timestamp/replay window, лимит тела и connector account.
2. `(connector_account_id, external_message_id)` дедуплицирует повторную доставку.
3. Адаптер находит PadlHub conversation/contact по таблицам `integration`; при первом обращении
   создаёт `SUPPORT` conversation и membership.
4. Нормализованное сообщение и outbox фиксируются одной транзакцией; HTTP 2xx выдаётся только
   после commit.
5. Raw payload не пишется в логи. Если он нужен для разбора инцидента, используется отдельное
   зашифрованное quarantine-хранилище с коротким retention и аудитом доступа.

### Исходящее сообщение в коннектор

Worker получает identifier-only событие, создаёт/захватывает delivery job, читает канонический
контент из PostgreSQL и вызывает connector adapter с provider idempotency key. Таймауты, retry и
circuit breaker ограничены. Успех фиксируется в `integration.messaging_message_links`; после
исчерпания попыток запись уходит в DLQ и ЦУП показывает стабильный error code и действие retry.

### Триггерное оповещение

1. Домен публикует факт, например `game.starting_soon.v1`, без телефона, токена устройства и
   готового текста.
2. Worker выбирает активную версию rule/template и строит recipient set по tenant-aware query.
3. На каждого получателя создаётся intent с уникальным `dedupe_key`. Предпочтения, quiet hours и
   обязательность категории определяют каналы.
4. Рендерится неизменный snapshot. In-app item и channel deliveries создаются в одной транзакции с
   outbox; адреса разрешаются только перед вызовом provider adapter.
5. Повторы события не создают повторных intents. Delivery attempts сохраняют только стабильные
   коды результата; provider response/body и адрес получателя не логируются.

### Durable booking reminder scheduler

Расписание формируется только из принятого canonical `booking.confirmed.v1` или
`booking.changed.v1`. В одной PostgreSQL-транзакции notification projector фиксирует inbox claim,
монотонный booking fence и две строки `HOURS_24`/`HOURS_2`. Более новая revision полностью заменяет
snapshot, due time, event UUID и lease; replay/stale/conflict расписание не меняют. Принятый
`booking.cancelled.v1` под тем же booking advisory lock закрывает все ещё pending reminders и
сбрасывает claims. `booking.upcoming_booking_projection`, браузерный Viva snapshot и Redis никогда
не являются producer или repair source.

Отдельный tenant-fair worker cycle захватывает due-строки короткой арендой и перед эмиссией под тем
же booking advisory lock повторно проверяет claim token, tenant gate, текущую fence revision и
отсутствие cancellation. `booking.reminder.due.v1` с заранее сохранённым event UUID и перевод
schedule в `EMITTED` коммитятся одной транзакцией; outbox доставляется at-least-once с тем же event
ID. Crash до finalize оставляет reclaimable lease, а rollback finalize не может оставить только
outbox или только terminal state.

Выключенный tenant gate не меняет `PENDING` даже после expiry. После включения expired
terminalization и due claims делят один bounded batch и используют `FOR UPDATE SKIP LOCKED`.
Process scheduler metrics несут `service.instance.id` и freshness heartbeat, а потерянные
окна обнаруживаются DB-derived `latest MISSED` timestamp, а не только process counter.

Tenant activation принимает только provisioned canonical ruleset `booking.ru-ru.v3`: ровно один
активный `booking.reminder.default`, template `booking.reminder` v2/`ru-RU` с каноническими
category, audience, content, deep link и каналами. Effective channels обязаны пересекаться с
желаемым включённым IN_APP/Web Push transport. Provisioner и activation используют один
content-addressed contract и общий tenant runtime advisory lock, поэтому old/custom/extra rule,
template drift, отсутствие provision journal или несовместимый канал fail closed до изменения
tenant gate. V3 расширяет fingerprint до каждого поля template/rule/event definition; существующий
v2 provision journal не является доказательством v3 и требует нового preview/apply с новым
idempotency key. Tenant runtime row связывает `booking_reminders_enabled=true` с exact v3
ruleset version/hash; OFF хранит только `false/null/null`. Scheduler проверяет binding до expired
sweep/claim и повторно перед finalize. Старый/чужой hash не меняет schedule, после claim приводит к
commit lease release без outbox и отмечает tenant cycle failed.

Eligibility использует время PostgreSQL и полуоткрытое окно `due_at <= now < expires_at`:

- `HOURS_24`: `expires_at = min(due_at + max24, starts_at - 2 hours)`;
- `HOURS_2`: `expires_at = min(due_at + max2, starts_at)`.

На границе `expires_at` запись атомарно становится `MISSED` без outbox. Глобальный
`BOOKING_REMINDER_SCHEDULER_ENABLED` и tenant-local `booking_reminders_enabled` по умолчанию
выключены. Staging/production не запускают scheduler без двух явно заданных max-lateness values;
все worker replicas одного окружения обязаны использовать одинаковые значения и exact contract
binding. Tenant ON запрещён, пока хотя бы один worker игнорирует version/hash; rollback сначала
записывает tenant `false/null/null` текущей командой, затем выключает global scheduler. Пока write owner
бронирований не публикует lifecycle event в одной транзакции с authoritative change, booking
notifications остаются NO-GO независимо от наличия scheduler-а.

### Ручная кампания из ЦУП

1. ЦУП получает только короткоживущий PadlHub JWT с audience `phub-admin`. Токен выдаётся лишь
   пользователю с ролью `admin` и permission `notifications.manage`; обычный `phub-api` токен не
   принимается Admin API.
2. `POST /admin/api/v1/{tenantKey}/notifications/recipients/resolve` нормализует до 100 телефонов,
   разрешает только однозначно найденных активных PadlHub users и возвращает masked номера.
   Введённые номера не сохраняются в кампании, audit или broker payload.
3. Команда кампании требует `Idempotency-Key`. API ещё раз разрешает получателей внутри tenant
   transaction, проверяет runtime/provider gates и отклоняет APNs/FCM, пока соответствующий adapter
   не реализован.
4. Campaign, recipient rows, intents, inbox items, pending Web Push deliveries, audit и outbox
   записываются в одной PostgreSQL transaction. RabbitMQ получает только campaign/intent/delivery
   UUID и безопасные счётчики, но не title/body/phone/endpoint.
5. Повтор того же запроса и ключа возвращает исходный campaign ID. Пользовательские preferences
   `ADMIN_MESSAGE` соблюдаются; отсутствие активной Web Push установки фиксируется как suppression,
   а не как ложная отправка.

### Web, iOS и Android push

Push — три реализации одного delivery port, а не один «универсальный токен»:

| Платформа | Регистрация                                                        | Доставка         | Клиентская механика                                                         |
| --------- | ------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------- |
| Web       | `PushSubscription` endpoint + `p256dh/auth`, зашифрованные целиком | Web Push с VAPID | service worker показывает notification и обрабатывает `notificationclick`   |
| iOS       | APNs device token, bundle/app ID и `sandbox/production`            | APNs HTTP/2      | Capacitor/native bridge регистрирует token, показывает/открывает deep link  |
| Android   | FCM registration token и app ID                                    | FCM HTTP v1      | Capacitor/native bridge обновляет token и передаёт displayed/opened receipt |

Регистрация/замена endpoint — авторизованная идемпотентная команда. Число живых Web Push установок
ограничено server-owned quota (по умолчанию 5). Физическая подписка имеет одного живого владельца
в `(tenant, provider account, address hash)`: перенос между аккаунтами отзывает старую строку и
создаёт/активирует строку нового пользователя, не меняя owner у endpoint, на который уже могут
ссылаться старые deliveries. Logout отвязывает конкретную установку; reinstall, token refresh и
ответы `invalid/unregistered` атомарно инвалидируют старую запись. Endpoint payload шифруется
envelope key, а hash используется только для дедупликации и сериализации, не как credential.
Полный URL Web Push endpoint один раз канонизируется до шифрования, command hash и address hash;
эквивалентные записи host case и явного `:443` не создают новую физическую идентичность.

Нарушение exact-origin/connect-time public-egress policy завершает текущую delivery и переводит
endpoint в обратимый `SUSPENDED_POLICY`, а не в provider-invalid. Projector создаёт delivery только
для `ACTIVE`; claimant отправляет провайдеру только `ACTIVE`, а `INVALID`/`REVOKED` забирает лишь для
локальной terminalization без decrypt/provider call. `SUSPENDED_POLICY` остаётся pending для
обратимого review. Повторная валидная регистрация может вернуть endpoint в `ACTIVE`; перед этим
оператор проверяет retained pending backlog и причину policy denial. `INVALID` и `REVOKED` такой
политикой автоматически не оживляются.

`SENT` означает только принятие провайдером. `PROVIDER_DELIVERED` пишется лишь при наличии
достоверного receipt. `DISPLAYED` и `OPENED` приходят отдельными идемпотентными событиями клиента;
ни Web Push, ни APNs/FCM acceptance не трактуются как просмотр пользователем. Push payload содержит
notification UUID, безопасный preview и deep-link route; полный чувствительный текст клиент
получает из User API после авторизации.

Один общий atomic finalizer фиксирует результат любого push delivery port. Он проверяет не только
`attempt_count`, но и непросроченный lease, а stale worker не может добавить attempt, receipt,
provider link или outbox. Необязательный внешний message ID хранится только в tenant-scoped
`integration.notification_provider_links`; конфликт ID для уже связанной delivery завершает
delivery как `DEAD` со стабильным безопасным кодом без provider ID в audit, outbox или логах;
точный replay той же связи остаётся идемпотентным. APNs/FCM смогут использовать этот finalizer, но
их adapters, encrypted token lifecycle и native client bridges в текущем срезе отсутствуют и
остаются выключенными.

MAX является messenger connector, а не push platform. Для него определён отдельный delivery-port
boundary, но network adapter отсутствует: в PadlHub пока нет подтверждённых bot account settings и
tenant-scoped согласованного mapping пользователя на MAX `user_id`/`chat_id`. До появления этих
входов MAX остаётся fail-closed. Текущая evidence/readiness matrix находится в
[плане каналов доставки](../plans/push-delivery-readiness-wave-2026-08-03.md).

### Внешний контроль и модерация

Источники: жалоба пользователя, правило PadlHub, действие сотрудника ЦУП или signed signal
внешнего moderation provider. Поток:

1. Signal/report дедуплицируется и создаёт либо дополняет `moderation.case`.
2. Автополитика может только разрешённые reversible actions: скрыть preview, временно
   quarantine message или ограничить отправку до `expires_at`.
3. ЦУП показывает исходный объект по отдельному permission, risk/reason codes, историю решений и
   SLA. Контент не копируется в логи или внешний task tracker.
4. Модератор принимает `DISMISS`, `REDACT/RESTORE_MESSAGE`, `WARN`, `MUTE/UNMUTE_MEMBER`,
   `REMOVE/RESTORE_MEMBER`, `CLOSE/REOPEN_CONVERSATION`, `BLOCK/UNBLOCK_USER` или
   `QUARANTINE/RELEASE_QUARANTINE`. Команда требует permission, `Idempotency-Key`, reason, audit и
   optimistic case version.
5. Действие записывается неизменяемо и в той же транзакции создаёт outbox. Messaging применяет
   только PadlHub action ID; внешний provider не вызывает message delete/block напрямую.
6. Ошибка/недоступность внешнего контроля не блокирует сохранение сообщения. В зависимости от
   tenant policy сообщение сразу доступно, временно quarantined либо попадает в post-moderation.

Интеграция внешнего контроля использует mTLS или короткоживущий service JWT, signature, replay
window, timeout, circuit breaker и redacted telemetry. Режим аккаунта всегда `SIGNAL_ONLY` или
`RECOMMEND_ONLY`; authoritative mode запрещён контрактом и ограничением данных.

## 4. Realtime-протокол

Клиент получает у API короткоживущий одноразовый ticket и аутентифицирует WebSocket первым
сообщением. Ticket не находится в URL. После подключения:

- `conversation.subscribe {conversationId, afterSequence}` проверяет актуальное membership в БД;
- сервер отправляет `message.created|updated|deleted` с `conversationId`, `messageId`, `sequence`
  и минимальным безопасным preview;
- `notification.created|updated` несёт `notificationId`, но не push token/адрес доставки;
- `moderation.case.created|updated` доставляется только соединениям ЦУП с permission;
- `typing` и `presence` имеют TTL, не сохраняются и не используются для бизнес-решений;
- при разрыве sequence или reconnect клиент вызывает HTTP `GET messages?afterSequence=...`;
- отправка/редактирование/удаление сообщений всегда идёт через HTTP command API, а не WebSocket.

Gateway держит connection registry в памяти своего процесса; Redis хранит только
короткоживущие one-time ticket markers. Если Redis или
RabbitMQ недоступен, история остаётся корректной, клиент восстанавливается через API.

Текущий M2 использует exclusive fanout queue на каждый realtime instance, `prefetch(1)` и keyed
serialization по conversation. Потеря ephemeral queue закрывается HTTP gap recovery, а не хранением
истории в RabbitMQ. Невалидные envelope создают publisher-confirmed запись в
`phub.realtime.messaging.quarantine.v1` только с hash/reason, без raw body; transient projection failure снимает readiness и
запускает bounded reconnect. Событие остаётся hint: пропуск, дубль или reconnect
закрываются HTTP-чтением по `sequence`. Каждый process держит bounded event-ID dedupe cache,
сохраняемый между Rabbit reconnect внутри процесса. Глобальный dedupe запрещён: он подавил бы
broadcast на другие realtime instances; после restart идемпотентность обеспечивает conversation sequence.

## 5. Целевые API-поверхности

Первые четыре direct-chat операции и read cursor реализованы за выключенными tenant
gates; остальной список — целевая карта.

### User API

- `GET /{tenantKey}/conversations`
- `POST /{tenantKey}/conversations/direct`
- `GET /{tenantKey}/conversations/{conversationId}/messages?afterSequence=`
- `POST /{tenantKey}/conversations/{conversationId}/messages`
- `PATCH|DELETE /{tenantKey}/conversations/{conversationId}/messages/{messageId}`
- `PUT /{tenantKey}/conversations/{conversationId}/read-cursor`
- `GET /{tenantKey}/notifications`
- `PUT /{tenantKey}/notifications/read-cursor`
- `GET|PATCH /{tenantKey}/notification-preferences`
- `GET /{tenantKey}/notification-endpoints/web/config`
- `POST /{tenantKey}/notification-endpoints/web`
- `DELETE /{tenantKey}/notification-endpoints/web/{installationId}`
- `POST|DELETE /{tenantKey}/notification-endpoints` для будущих iOS/Android установок
- `POST /{tenantKey}/notification-deliveries/{deliveryId}/receipts`
- `POST /{tenantKey}/conversations/{conversationId}/messages/{messageId}/reports`
- `POST /{tenantKey}/messaging/realtime-ticket`
- `PUT|DELETE /{tenantKey}/messaging/users/{otherUserId}/block`

### Admin API / ЦУП

- `GET /admin/api/v1/{tenantKey}/notifications/capabilities`: эффективная готовность Web
  Push/iOS/Android/in-app;
- `POST /admin/api/v1/{tenantKey}/notifications/recipients/resolve`: masked preview по телефонам;
- `POST /admin/api/v1/{tenantKey}/notifications/campaigns`: аудируемая идемпотентная ручная
  кампания;
- inbox: список support conversations, фильтры connector/status/assignee/unread;
- conversation: история, ответ, назначение агента, закрытие/повторное открытие, internal notes;
- templates/rules: list/create-version/activate/deactivate/preview;
- deliveries: поиск по correlation/intent/user, безопасный статус, retry/dead-letter action;
- moderation: удалить сообщение, ограничить участника, получить audit trail по разрешению.
- external control: список signals/cases, назначение, PadlHub decision, срок временного ограничения,
  appeal/reopen и безопасное отключение конкретного provider account.

Connector webhook ingress — отдельная проверяемая machine boundary без user/admin JWT. Для каждого
провайдера обязательны signature verification, replay protection, allowlisted content types,
timeout и redacted telemetry.

Внешняя система контроля использует отдельную service API boundary: submit signal, update
recommendation и revoke signal. Она не получает user/admin JWT, не может читать произвольные чаты и
не имеет command для удаления сообщения/блокировки пользователя.

## 6. Стабильные события

| Событие                                    | Минимальный payload                          | Потребители                                       |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| `messaging.conversation.created.v1`        | conversationId, kind, contextId?             | realtime, analytics                               |
| `messaging.message.created.v1`             | conversationId, messageId, sequence          | realtime, connector delivery, notification policy |
| `messaging.message.updated.v1`             | conversationId, messageId, sequence, version | realtime                                          |
| `messaging.message.deleted.v1`             | conversationId, messageId, sequence          | realtime, connector policy                        |
| `messaging.member.changed.v1`              | conversationId, memberId, state              | realtime, authorization cache invalidation        |
| `messaging.user-block.changed.v1`          | otherUserId, action, changed                 | authorization cache invalidation, audit analytics |
| `notifications.intent.created.v1`          | intentId, recipientUserId                    | delivery worker                                   |
| `notifications.inbox.created.v1`           | inboxItemId, recipientUserId                 | realtime                                          |
| `notifications.delivery.changed.v1`        | deliveryId, state, errorCode?                | ЦУП, metrics                                      |
| `notifications.delivery.receipt.v1`        | deliveryId, receiptType, platform            | ЦУП, analytics                                    |
| `notifications.read-cursor.updated.v1`     | recipientUserId, readThroughItemId           | home counters, analytics                          |
| `notifications.admin-campaign.accepted.v1` | campaignId, matchedCount, requestedChannels  | ЦУП, analytics                                    |
| `booking.confirmed.v1`                     | bookingId, revision, recipientUserIds        | notification policy                               |
| `booking.changed.v1`                       | bookingId, revision, recipientUserIds        | notification policy                               |
| `booking.cancelled.v1`                     | bookingId, revision, recipientUserIds        | notification policy                               |
| `booking.reminder.due.v1`                  | bookingId, revision, recipientUserIds        | notification policy                               |
| `moderation.case.created.v1`               | caseId, source, severity                     | ЦУП moderation queue                              |
| `moderation.action.applied.v1`             | caseId, actionId, actionType, target IDs     | messaging, realtime, audit projection             |

Broker payloads не содержат body, attachment URLs, телефон, email, push token или внешний contact
ID. Версия является частью имени события; несовместимое изменение создаёт новую версию.

Booking events используют только PadlHub UUID: envelope `aggregateId` равен payload
`bookingId`, `revision` содержит монотонную ревизию авторитетного booking aggregate, а
`recipientUserIds` — дедуплицированный ограниченный список PadlHub user UUID. Viva booking IDs и
browser-derived projections в этот контракт не входят.

Notification projector хранит tenant-scoped booking fence в PostgreSQL. Lifecycle-событие может
перейти только на строго большую revision; семантически одинаковый replay той же revision не
создаёт второй intent, а конфликт одной revision уходит в DLQ. Напоминания не двигают lifecycle:
`HOURS_24` и `HOURS_2` имеют независимые fingerprint-слоты только для текущей revision, а reminder
впереди lifecycle повторяется bounded retry. Fence и все notification/outbox/audit записи входят в
одну транзакцию. Это не заменяет сериализацию в авторитетном booking write owner.

## 7. Авторизация, приватность и модерация

- Проверка доступа выполняется по текущему tenant-aware membership и политике контекстного домена.
  Наличие UUID или старого WebSocket subscription не даёт права чтения.
- Выход из игры/турнира/сообщества вызывает membership policy: доступ закрывается сразу либо после
  явно заданного grace/read-history правила. Решение фиксируется на уровне домена, не клиента.
- Direct chat учитывает user block policy до создания/чтения разговора, перед каждой отправкой и
  при realtime subscribe/fanout. Те же realtime checks повторно проверяют current permission,
  active peer и `chatPolicy` peer-а; старый socket/subscription не обходит `NOBODY`. Любая directed запись
  закрывает пару для обеих сторон; удаление
  A→B не отменяет существующий B→A block. Сообщение, committed до block transaction, сохраняется,
  но история недоступна, пока хотя бы один block активен.
- Вложения загружаются по короткому signed URL, проверяются по MIME/размеру/hash и malware scan;
  download URL выдаётся только после авторизации на конкретный conversation.
- Soft delete сохраняет sequence и audit. Legal hold/retention задаются tenant policy. Hard purge
  выполняется отдельной проверяемой процедурой, не обычным API endpoint.
- Поиск и аналитика не получают raw message content по умолчанию. Логи содержат только tenant,
  IDs, sequence, outcome, latency, release и correlation ID.
- Push endpoint payload, VAPID subscription keys, APNs/FCM tokens и moderation evidence шифруются;
  ЦУП показывает их только как masked metadata/статус.
- Внешнему moderation provider передаётся минимальный policy-approved content window с opaque
  PadlHub case ID. Телефон, email, push token, Viva/external IDs и лишний контекст исключаются.

## 8. Ошибки, метрики и SLO

Стабильные ошибки первой версии: `CONVERSATION_NOT_FOUND`, `CONVERSATION_ACCESS_DENIED`,
`MESSAGE_DUPLICATE`, `MESSAGE_VERSION_CONFLICT`, `MESSAGE_TOO_LARGE`, `ATTACHMENT_NOT_READY`,
`CONNECTOR_UNAVAILABLE`, `DELIVERY_RETRY_EXHAUSTED`, `NOTIFICATION_SUPPRESSED`.
`PUSH_ENDPOINT_INVALID`, `MODERATION_CASE_CONFLICT`, `MODERATION_ACTION_FORBIDDEN`,
`EXTERNAL_SIGNAL_DUPLICATE`.

Минимальные метрики:

- command latency/outcome и сообщения в секунду по tenant без текста;
- outbox age, consumer lag, retry/DLQ depth;
- WebSocket connections, reconnects, gap recoveries;
- connector/provider latency, circuit state, delivery success по каналу;
- notification intent-to-delivery latency, suppressed count, unread age;
- push endpoint registrations/invalidations и accepted/displayed/opened conversion по платформе;
- moderation queue age, auto-quarantine age, decision/reversal counts и external-signal latency;
- attachment scan latency/rejections.

Начальные цели: HTTP message commit p95 < 500 ms без учёта внешнего провайдера; realtime fanout
p95 < 2 s после commit; 99.9% intent либо доставлен хотя бы в один разрешённый канал, либо имеет
объяснимое terminal state в течение 15 минут.

## 9. Поэтапное включение и rollback

1. **Foundation:** expand-only таблицы, RLS, domain interfaces, события и feature flags; routes
   закрыты. В текущей release-линии `/chats` и `/chats/new` не публикуются;
   game/profile DTO fail closed без смонтированного messaging route.
2. **Direct + contextual read/write:** direct HTTP list/create/history/send/read cursor и directed
   block policy реализованы за tenant gates; GAME использует current roster, а tournament/community
   membership остаются следующими подэтапами.
3. **Realtime:** DIRECT и GAME используют session-bound tickets, авторизованные subscriptions и
   sequence-gap recovery; HTTP остаётся канонической историей и fallback.
4. **CUP support + один connector:** inbound/outbound dedupe, assignment, retry/DLQ.
5. **In-app notifications:** templates, rules, intents, preferences и inbox. Пользовательский срез
   и ручная отправка из ЦУП реализованы и закрыты tenant/admin gates; управление версиями
   templates/rules остаётся следующей задачей.
6. **Web/iOS/Android push:** Web Push endpoint API, шифрование, VAPID adapter, retry/circuit и
   provider-acceptance receipt реализованы за выключенными global/tenant/provider gates. APNs/FCM,
   quiet hours и клиентские display/open receipts остаются следующими подэтапами.
7. **Moderation/control:** reports, ЦУП queue, reversible auto-policy, immutable decisions и затем
   один external provider в `SIGNAL_ONLY` режиме.

Каждый этап включается per tenant. Rollback выключает producer/consumer feature flags и возвращает
предыдущий immutable image digest; expand-only таблицы остаются совместимыми и не удаляются в
аварийном откате. Перед production обязательны backup, миграционная проверка, smoke send/recover,
connector sandbox, DLQ replay test и проверка отсутствия контента/адресов в telemetry.
Для push добавляются platform sandbox tests и token invalidation; для модерации — replay сигнала,
reversal/quarantine-expiry и проверка, что внешний provider не может применить действие напрямую.
Пошаговый операторский порядок закреплён в
[runbook](../runbooks/chats-notifications-moderation.md).

## 10. Не входит в первый срез

Групповые произвольные комнаты, сквозное E2E-шифрование, полнотекстовый поиск по всем сообщениям,
voice/video calls, bot marketplace, reactions/threads и federation между tenants. Эти возможности
не должны менять базовые инварианты tenant isolation, server ordering и PostgreSQL source of truth.
