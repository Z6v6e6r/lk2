# Контур «Чаты и оповещения»

Статус: целевая архитектура, expand-only фундамент, feature-gated in-app, Web Push/VAPID и ручная
отправка из ЦУП. Остальные публичные операции остаются закрытыми, пока не реализованы авторизация,
идемпотентность, аудит и обработчики соответствующего вертикального среза.

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

Регистрация/замена endpoint — авторизованная идемпотентная команда. У одного пользователя может
быть несколько установок. Logout может отвязать конкретную установку; reinstall, token refresh и
ответы `invalid/unregistered` атомарно инвалидируют старую запись. Endpoint payload шифруется
envelope key, а hash используется только для дедупликации.

`SENT` означает только принятие провайдером. `PROVIDER_DELIVERED` пишется лишь при наличии
достоверного receipt. `DISPLAYED` и `OPENED` приходят отдельными идемпотентными событиями клиента;
ни Web Push, ни APNs/FCM acceptance не трактуются как просмотр пользователем. Push payload содержит
notification UUID, безопасный preview и deep-link route; полный чувствительный текст клиент
получает из User API после авторизации.

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

Gateway держит connection registry в Redis только как эфемерную маршрутизацию. Если Redis или
RabbitMQ недоступен, история остаётся корректной, клиент восстанавливается через API.

## 5. Целевые API-поверхности

Это карта будущих контрактов, а не обещание уже работающих routes.

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
- `POST /{tenantKey}/realtime/tickets`

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
| `notifications.intent.created.v1`          | intentId, recipientUserId                    | delivery worker                                   |
| `notifications.inbox.created.v1`           | inboxItemId, recipientUserId                 | realtime                                          |
| `notifications.delivery.changed.v1`        | deliveryId, state, errorCode?                | ЦУП, metrics                                      |
| `notifications.delivery.receipt.v1`        | deliveryId, receiptType, platform            | ЦУП, analytics                                    |
| `notifications.read-cursor.updated.v1`     | recipientUserId, readThroughItemId           | home counters, analytics                          |
| `notifications.admin-campaign.accepted.v1` | campaignId, matchedCount, requestedChannels  | ЦУП, analytics                                    |
| `moderation.case.created.v1`               | caseId, source, severity                     | ЦУП moderation queue                              |
| `moderation.action.applied.v1`             | caseId, actionId, actionType, target IDs     | messaging, realtime, audit projection             |

Broker payloads не содержат body, attachment URLs, телефон, email, push token или внешний contact
ID. Версия является частью имени события; несовместимое изменение создаёт новую версию.

## 7. Авторизация, приватность и модерация

- Проверка доступа выполняется по текущему tenant-aware membership и политике контекстного домена.
  Наличие UUID или старого WebSocket subscription не даёт права чтения.
- Выход из игры/турнира/сообщества вызывает membership policy: доступ закрывается сразу либо после
  явно заданного grace/read-history правила. Решение фиксируется на уровне домена, не клиента.
- Direct chat учитывает user block policy до создания разговора и перед каждой отправкой.
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
   закрыты.
2. **Direct + contextual read/write:** HTTP history/send/read cursor, затем game/tournament/community
   membership policies.
3. **Realtime:** tickets, subscriptions, sequence-gap recovery; HTTP остаётся fallback.
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
