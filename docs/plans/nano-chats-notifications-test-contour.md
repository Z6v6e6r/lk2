# Nano-контур чатов и оповещений для тестирования

- Статус: архитектурный baseline для реализации и staged enablement
- Контур: Jetson Nano staging
- Тестовый tenant: `local-padel`
- Дата фактической проверки: 2026-07-26

## 1. Цель

Подготовить на Nano ограниченный, наблюдаемый и обратимый контур, в котором внутренняя команда
может проверить:

1. durable in-app уведомление;
2. Web Push в sandbox-профиле;
3. direct chat двух PadlHub-пользователей;
4. восстановление истории после разрыва realtime;
5. tenant isolation, идемпотентность, аудит, outbox и DLQ.

Nano остаётся ARM64 staging-узлом, а не build host и не production. Образы собираются CI один раз,
публикуются для `linux/arm64` и запускаются на Nano только по digest.

## 2. Подтверждённый baseline

На момент проверки публичный Nano:

- отдаёт release `dea4443827e41fb85b52e980b08b1ff6b8f00f06` через `/manifest.json`;
- отвечает `200` на `/health/live`;
- отвечает `200` и `{"status":"ready","database":true,"auth":true}` на `/health/ready`;
- имеет защищённый User API уведомлений: анонимный запрос к
  `/user/api/v1/local-padel/notifications` получает стабильный `401 AUTH_REQUIRED`;
- не имеет User API чатов: запрос к `/user/api/v1/local-padel/chats` получает
  `404 ROUTE_NOT_FOUND`;
- проксирует `/realtime/*`, но realtime-приложение реализует только WebSocket handshake.

Текущий checkout и Nano используют один release SHA. В репозитории уже есть:

- expand-only PostgreSQL-схемы `messaging`, `notifications`, `moderation` и integration mappings;
- RLS и `FORCE RLS` для tenant-owned таблиц;
- tenant-gated in-app inbox/read cursor;
- Web Push endpoint API, шифрование endpoint, VAPID delivery worker, retry/circuit и service worker;
- ручная кампания из Admin API с отдельным `phub-admin` audience и
  `notifications.manage`;
- RabbitMQ topology, outbox publisher, DLQ и content-free operational metrics;
- Nginx ingress к API и realtime на Nano.

Не реализованы:

- repository и User API для conversations/messages/read cursor;
- выдача одноразового realtime ticket;
- `conversation.subscribe`, membership recheck и fan-out message/notification events;
- UI списка чатов, истории и отправки сообщений;
- APNs и FCM adapters;
- рабочая очередь модерации и external moderation service boundary;
- connector ingress/outbound delivery.

Следовательно, schema presence не считается готовностью чата.

## 3. Граница первого Nano-среза

### Включаем

- один внутренний tenant;
- от двух до пяти тестовых PadlHub UUID;
- direct conversations только между активными tenant users;
- текстовые сообщения до 8 000 символов;
- список conversations, HTTP history/send/read cursor;
- server-issued monotonically increasing `sequence`;
- outbox-события без body и персональных данных;
- realtime notification после commit и HTTP gap recovery;
- in-app notification и Web Push sandbox;
- ручную тестовую кампанию из ЦУП для заранее разрешённых операторов;
- пользовательский report на сообщение и ручную, обратимую quarantine-заглушку только после
  отдельного теста audit trail.

### Не включаем

- произвольные group rooms;
- game/tournament/community membership automation;
- attachments;
- edit/delete сообщения;
- connector support chat;
- APNs и FCM;
- автоматические moderation actions;
- внешний moderation provider;
- production push credentials;
- массовые кампании и реальные пользовательские аудитории.

Это не удаляет будущие возможности из модели. Они остаются выключенными transport/provider gates.

## 4. Размещение на Nano

Все компоненты остаются процессами модульного монолита:

| Компонент  | Ответственность в тестовом срезе                                                     |
| ---------- | ------------------------------------------------------------------------------------ |
| Nginx      | Единственный публичный ingress; `/user/api/*`, `/admin/api/*`, `/realtime/*`         |
| `web`      | Inbox, Web Push lifecycle, chats UI и HTTP gap recovery                              |
| `api`      | Auth/tenant/membership, commands, history, realtime ticket, audit/outbox transaction |
| `worker`   | Outbox publication, notification projection, Web Push delivery, retries/DLQ          |
| `realtime` | Ticket auth, subscribe, membership recheck, identifier-only event fan-out            |
| PostgreSQL | Единственный source of truth для messaging/notifications/moderation                  |
| RabbitMQ   | At-least-once identifier-only events, retry/DLQ                                      |
| Redis      | Только connection registry, presence/typing TTL и rate limits                        |
| MinIO      | Не используется первым chat-срезом; остаётся закрытым для будущих attachments        |

Новые микросервисы, новые публичные порты и отдельная база для чатов не создаются.

Редактируемая схема: [nano-messaging-notifications-test.drawio](../architecture/nano-messaging-notifications-test.drawio).

## 5. Runtime gates

Любой gate отсутствует или выключен по умолчанию.

| Gate                | Хранилище                                                    | Первый Nano-профиль           |
| ------------------- | ------------------------------------------------------------ | ----------------------------- |
| in-app notification | `notifications.tenant_runtime_settings.in_app_enabled`       | `on`                          |
| Web Push global     | `/etc/phub/staging.env: WEB_PUSH_ENABLED`                    | `on`, только sandbox          |
| Web Push tenant     | `notifications.tenant_runtime_settings.web_push_enabled`     | `on`                          |
| Web Push provider   | `integration.notification_provider_accounts`                 | один `ACTIVE` sandbox account |
| messaging HTTP      | новая `messaging.tenant_runtime_settings.http_enabled`       | `on`                          |
| direct chats        | новая `messaging.tenant_runtime_settings.direct_enabled`     | `on`                          |
| messaging realtime  | новая `messaging.tenant_runtime_settings.realtime_enabled`   | `on` после HTTP smoke         |
| contextual chats    | новая `messaging.tenant_runtime_settings.contextual_enabled` | `off`                         |
| connectors          | provider account status                                      | `off`                         |
| iOS/Android push    | notification tenant/provider gates                           | `off`                         |
| moderation provider | moderation provider account status                           | `off`                         |

Новая runtime-таблица messaging должна быть expand-only, tenant-scoped, с RLS/`FORCE RLS`,
`updated_by`, `updated_at` и операторской dry-run/apply командой. Глобальный
`MESSAGING_ENABLED=true` допустим только как process-wide kill switch; он не заменяет tenant gate.

## 6. Минимальный chat-контракт

User API сохраняет принятые ранее пути:

- `GET /user/api/v1/{tenantKey}/conversations`;
- `POST /user/api/v1/{tenantKey}/conversations/direct`;
- `GET /user/api/v1/{tenantKey}/conversations/{conversationId}/messages?afterSequence=`;
- `POST /user/api/v1/{tenantKey}/conversations/{conversationId}/messages`;
- `PUT /user/api/v1/{tenantKey}/conversations/{conversationId}/read-cursor`;
- `POST /user/api/v1/{tenantKey}/realtime/tickets`.

Первая версия:

- принимает только PadlHub UUID, никогда Viva ID;
- требует актуальный tenant-aware membership на каждом read/write/subscribe;
- требует `Idempotency-Key` и `clientMessageId` для send;
- в одной транзакции блокирует conversation, выделяет `sequence`, пишет message, audit и outbox;
- возвращает исходный результат при точном idempotent replay;
- возвращает `409 IDEMPOTENCY_KEY_REUSED` при повторном ключе с другим payload;
- не передаёт body в RabbitMQ, Redis, логи, traces или metrics;
- выдаёт историю строго по `sequence`;
- не считает WebSocket источником истины.

Прямой conversation создаётся как упорядоченная пара `left_user_id < right_user_id`. Повторная
команда возвращает существующий conversation. До создания и перед каждой отправкой проверяются
active user, tenant equality, `chat.direct.create` и block policy.

## 7. Realtime-контракт

API выдаёт JWT ticket:

- audience `phub-realtime`;
- scope `realtime.connect`;
- tenant ID/key и PadlHub user ID;
- TTL не более 60 секунд;
- одноразовый `jti`, погашаемый атомарно в Redis;
- ticket передаётся первым WebSocket message, а не в URL.

После `connection.ready` клиент отправляет:

```json
{
  "type": "conversation.subscribe",
  "conversationId": "<padlhub-uuid>",
  "afterSequence": 41
}
```

Realtime повторно проверяет membership. Broker event содержит только
`tenantId/conversationId/messageId/sequence`. Gateway отправляет безопасный event marker; клиент
загружает canonical message через HTTP. Если `sequence > afterSequence + 1`, клиент немедленно
выполняет HTTP gap recovery. Send/edit/delete через WebSocket запрещены.

До реализации ticket + subscribe + fan-out realtime gate остаётся `off`, даже если handshake
endpoint отвечает.

## 8. Нагрузочный профиль Nano

Первый gate ограничивается:

- 5 тестовыми пользователями;
- 20 одновременными WebSocket connections;
- 5 messages/s кратковременно и 1 message/s длительно;
- 100 Web Push доставками за тестовое окно;
- текстом без attachments;
- одним экземпляром API, worker и realtime.

Это не capacity claim. Цель — проверить корректность и наблюдаемость на ARM64. Расширение блокируется
при росте outbox age, RabbitMQ lag/DLQ, reconnect/gap recovery failures, provider retry storm,
PostgreSQL saturation или памяти Nano.

## 9. Последовательность вывода в тест

### N0 — baseline и уведомления

1. Подтвердить manifest SHA, API/worker/realtime readiness и backup.
2. Подтвердить применённые migrations и RLS/`FORCE RLS`.
3. Проверить DLQ depth и outbox age.
4. Включить in-app tenant gate через существующую dry-run/apply команду.
5. Настроить стабильный VAPID sandbox key и endpoint-encryption key только в Nano secret storage.
6. Включить provider account, затем Web Push tenant gate.
7. Провести один in-app и один user-granted browser Web Push smoke.

### M1 — direct chat по HTTP

1. Доставить expand-only messaging runtime migration.
2. Доставить repository, OpenAPI, API и web UI с gates `off`.
3. Включить `http_enabled` и `direct_enabled` для одного tenant.
4. Два тестовых пользователя создают один direct conversation.
5. Проверить send replay/conflict, ordered history, read cursor и cross-tenant denial.

### M2 — realtime

1. Доставить ticket, one-time `jti`, subscribe и RabbitMQ consumer.
2. Включить `realtime_enabled` только для того же tenant.
3. Проверить live delivery, disconnect, пропущенные сообщения, reconnect и HTTP recovery.
4. Остановить realtime и подтвердить, что HTTP chat остаётся корректным.

### M3 — ручная модерация

1. Добавить report endpoint и CUP queue.
2. Проверить permission, immutable action/audit и reversal/expiry.
3. Внешний provider и auto-enforcement оставить выключенными.

## 10. Критерии допуска тестировщиков

Контур считается доступным для внутреннего теста только если одновременно:

- Nano manifest равен одобренному commit SHA;
- API, worker и realtime healthy;
- backup создан и проверен через `pg_restore --list`;
- migrations соответствуют release;
- business tables имеют RLS и `FORCE RLS`;
- два пользователя проходят полный HTTP chat journey;
- повтор send не создаёт дубль;
- sequence gap восстанавливается через HTTP;
- удалённый member немедленно теряет HTTP и realtime доступ;
- один source event создаёт один inbox item;
- read cursor replay не меняет результат;
- Web Push endpoint зашифрован, revoke работает, 404/410 инвалидирует endpoint;
- RabbitMQ payload и telemetry не содержат message body, phone, endpoint или Viva ID;
- DLQ пуст, outbox age возвращается к нулю;
- rollback gates и предыдущие image digests записаны.

## 11. Rollback

1. Выключить новый tenant producer gate.
2. Для realtime-инцидента выключить только `realtime_enabled`; оставить HTTP history/send.
3. Для push-инцидента выключить `web_push_enabled`; оставить in-app.
4. Дождаться stable state или lease expiry уже взятых jobs.
5. Последовательно вернуть API, worker и realtime на записанные digests.
6. Не удалять expand-only таблицы и не редактировать сообщения/deliveries вручную.
7. Проверить outbox, DLQ, canonical history и notification terminal states.
