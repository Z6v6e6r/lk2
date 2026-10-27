# Триггерные рассылки LK2 / ЦУП

Блок расширяет `notifications` (LOCAL_ONLY). ЦУП управляет сценариями;
Worker принимает подтверждённые факты, сохраняет персональные запуски, проверяет актуальность и
создаёт существующие intents/inbox/deliveries. PostgreSQL — источник состояния, RabbitMQ — доставка
фактов с повторами. Новый workflow engine, Event Catalog V2 и provider abstraction не создаются.

## Доступные источники

- `BOOKING_CONFIRMED`, `BOOKING_CHANGED`, `BOOKING_CANCELLED` используют существующий booking contract.
- `BOOKING_STARTS` отсчитывает минуты от startsAt подтверждённой/изменённой записи. Отрицательные
  напоминания истекают к началу; нулевые/положительные смещения используют заданный TTL после dueAt.
- `GAME_STARTS` отсчитывает минуты от startsAt канонической SCHEDULED-игры и адресуется только
  текущим ACTIVE-участникам с активным достижимым аккаунтом. Закрытые игры включены: видимость
  discovery не является признаком участия. Каждый настроенный сценарий создаёт не более одного
  фактического напоминания на игру и получателя за всю жизнь игры. До создания intent перенос может
  обновить тот же run; после queue/inbox/provider fence новая roster/source revision не создаёт
  повтор. Новый участник и другой настроенный сценарий имеют собственные ключи. Общий суточный лимит
  рекомендаций на напоминания об играх не распространяется.
- `FRIEND_GAME_PUBLISHED` принимает только `game.published.v1`. Сегодня этот факт публикуется при
  немедленном создании публичной локальной игры. Legacy imports и позднее provider provisioning не
  входят в этот источник. Контекст ждёт актуальную card projection; импорт истории не запускает
  приглашения задним числом.
- `SUBSCRIPTION_ENDS`, `BIRTHDAY`, `TRAINING_ATTENDED` используют отдельные подтвержденные Viva snapshots;
  ограничения источников и согласий описаны ниже.
- Первая тренировка и общий matching registry недоступны до подтверждённых owner contracts. `game.finished.v1` не доказывает посещение, а Home
  subscription projection не является основанием для рассылок. ЦУП показывает причины недоступности.

## Сценарий и получатель

`POST/PUT /admin/api/v1/{tenantKey}/notifications/scenarios[/id]` требует `phub-admin`, platform
`cup-admin`, текущие роль admin и `notifications.manage`, tenant и Idempotency-Key. Repository
повторно читает хранимый доступ. Save создаёт новую immutable версию с expectedVersion; retry того
же ключа/тела возвращает исходную версию, другой body — конфликт. Неопределённый ответ в ЦУП
сохраняет исходную команду/ключ. Редактор не принимает SQL, arbitrary event names, телефоны,
endpoint-адреса, внешние URL или mandatory override. Предпросмотр использует вымышленные данные
и не отправляет сообщения. Это предпросмотр текста, а не симуляция реальной аудитории.

До 100 сценариев на tenant. В версии фиксируются шаблон, триггер, смещение, TTL, упорядоченные
каналы, поведение тихих часов, частота и необязательная цель. Ссылки назначает сервер: `/bookings`
или `/games/{UUID}`. Журнал возвращает последние 100 запусков и отдельные состояния доставки/цели.
Тексты и endpoints отсутствуют в событиях/audit metadata/logs. Контент хранится только в обычных
защищённых notification tables; политика хранения существующего контура сохраняется.

При новой версии/паузе ожидающие запуски отменяются, PENDING deliveries подавляются. Событие,
изменение сценария, постановка в доставку и финальная проверка сериализуются tenant-admin lock;
это осознанное ограничение объёма первого среза. После финальной проверки провайдер уже может
обрабатывать запрос: пауза не отзывает такой внешний вызов. Версии и результаты не удаляются.

Для legacy-игр `GAME_STARTS` использует отдельный выключенный по умолчанию primary/majority источник
и notification-owned mirror. Он не вызывает общий importer, не создаёт игры, пользователей или
профили и не публикует обычные game events. В пилот попадают только уже сопоставленные канонические
игры в режиме `MIRROR`; остальные source rows считаются `skipped_unmapped`, поэтому включение требует
отдельного coverage admission и не означает покрытие всех legacy-игр. Получатель обязан иметь уже
сохранённую immutable verified-привязку legacy player → LK2 user; совпадение телефона и синтетический
import user не используются. В reminder-only snapshot входят только raw-участники со строгим
статусом `PAID`; inactive/pending/cancelled/неизвестный или malformed участник не попадает в
аудиторию и не может вытеснить более позднего PAID-участника из capacity. Для legacy/MIRROR игры
isolated source является источником состояния и времени; устаревшие canonical lifecycle/startsAt
не перекрывают свежий source. Исчезновение legacy mapping при оставшемся MIRROR/source блокирует
dispatch как `SOURCE_STALE`, а не переключает аудиторию на native participations.

Перед каждым provider read поколение атомарно переводится в unhealthy. Только полный bounded window
и exact read всех уже отслеживаемых source IDs, а затем обновление всех затронутых `GAME_START`
contexts в одной транзакции переводят его в healthy: поэтому удаление, отмена и перенос за горизонт
обнаруживаются. Обычные queue/provider readers не могут читать preparing generation; внутренний
reader принимает только точный generation id внутри finalize-транзакции. Ошибка/неполный page/
неизвестная строка или ошибка любого context refresh оставляют весь legacy dispatch в HOLD;
промежуточного healthy окна нет. Tenant-admin lock берётся первым и удерживается только на bounded
пилотном наборе до `LEGACY_GAME_REMINDERS_LIMIT`, затем healthy фиксируется compare-and-set для того
же поколения. Старый snapshot не разрешает отправку только по TTL. `source_updated_at` не может
регрессировать, одинаковое время с другой source revision — конфликт. Изменение source/получателей
повышает isolated revision, подавляет старую доставку и создаёт новую только из актуального состояния.
Stale source откладывается короткими интервалами до expiry и никогда не считается доставкой.

Последняя проверка получателя и состояния игры выполняется под блокировкой цели непосредственно
перед транспортом и фиксирует durable dispatch fence. До fence отмена/выход гарантированно подавляют
вызов; после fence внешний провайдер уже может принять запрос, поэтому результат может остаться
UNKNOWN и не должен автоматически переотправляться или считаться доставленным. Reconciliation
использует журнал попыток/причин, а не создаёт повторную рассылку без нового решения оператора.

Для приглашения требуется текущая дружба с организатором, активный достижимый аккаунт с games.play,
существующая запись booking preferences с recommendFriends=true, публичная SCHEDULED future игра
с актуальной проекцией, без legacy redirect и test courts. Используется существующая
`projectGameCard` policy: только viewerRelation NONE и действие JOIN (waitlist не приглашается).
При заданном диапазоне нужен известный подходящий уровень; явно выбранные станции и временные
окна — обязательные фильтры. Это узкий friend-сценарий, не копия ранжирования discovery feed.
Проверка повторяется перед доставкой. Один адресат/игра не получает повторное приглашение в течение
24 часов; общий лимит рекомендаций — min(настройка сценария, 3) за скользящие 24 часа.

## Доставка и цель

Сохраняется inbox, если выбран/разрешён IN_APP. Затем выбирается один активный endpoint первого
доступного внешнего канала в заданном порядке с точным app/environment/provider. Ни один сценарий
не обходит предпочтения пользователя. Web/Android/iOS используют существующую общую настройку PUSH;
отдельных пользовательских переключателей по платформам этот срез не добавляет. Рекомендации
имеют собственную категорию GAME_RECOMMENDATION. Доступные категории читаются из сценариев только
при включённом runtime gate, поэтому прежний preferences API работает без новой схемы.

При отсутствии PUSH-строки новой категории наследуется последнее сохранённое окно тихих часов
пользователя; enabled остаётся политикой соответствующей категории.

Inbox не прерывает пользователя и сохраняется независимо от тихих часов внешних каналов. DEFER
переносит push/email до конца окна, SKIP пропускает внешнюю отправку. Отложенная доставка ограничена expiry и перепроверяет
аккаунт, настройки, версию, цель и источник перед provider call. UTC-minute traversal учитывает
полночь и DST. Неподходящее/устаревшее сообщение получает объяснимый terminal reason.

Android FCM и iOS APNs показывают общее уведомление и открывают центр уведомлений; поэтому мобильный
push обязательно требует IN_APP, где находится полный текст и ссылка. Email и внутренние обращения
ЦУП подключаются отдельными gate; SMS/Telegram остаются заглушками. Приём провайдером не означает доставку, показ или чтение.
Результаты идут через существующие attempts/receipts; новых обещаний exactly-once provider delivery
нет. Автоматический межканальный fallback после неопределённого ответа не добавляется.

Сценарий с целью требует выбранный, разрешённый и включённый IN_APP: это даёт
долговечное уведомление и начало окна цели независимо от задержки push. При отключённом inbox
такой запуск пропускается. Окно цели ограничено сроком актуальности сообщения.

GAME_JOINED засчитывается по `game.participation.confirmed.v1` и сохранённой owner participation
с точным tenant/user/game/participation, временем после queuedAt и внутри goalDeadline. Поздно
пришедший факт может завершить уже истёкшее окно, если occurredAt попал внутрь него. Участие,
существовавшее до отправки, исключает приглашение. Открытие push — отдельный факт, не конверсия;
постфактум-конверсия также не доказывает причинное влияние рассылки.

## Схема, включение и откат

`0100_notification_scenarios.sql` добавляет пять tenant/RLS таблиц, append-only версии,
идемпотентные команды, контексты и запуски. Deferred FK связывает head с существующей версией.
`runs.intent_id` — явный составной FK к intent; render_data дополнительно содержит scenarioRunId
для проверки транспорта. Новая nullable `deliveries.scenario_available_at` не меняет старые строки.
Scenario deliveries всегда имеют legacy next_attempt_at=infinity. Старый/выключенный worker их
не выбирает. Новый включённый worker использует coalesce(scenario_v2_available_at,scenario_available_at) только с canonical run join;
retry/circuit/quiet deferral сохраняют infinity. Очередь сортируется по фактическому due time.
Финальная проверка продлевает принадлежащий ей lease на 60 секунд перед bounded provider call.

Ветка интегрирована с main, содержащим 0099 (password reset); новая 0100 следует за ней.
CI проверяет цепочку 0099→0100→0101 на пустой одноразовой базе и no-op повтор по полному ledger. Перед релизом нужна отдельная
проверка окончательной цепочки и ledger целевой среды. Frozen delivery manifests/guards
не расширяются автоматически: тест подтверждает, что расширенный каталог по-прежнему отвергается.

Миграция — исходный файл, не разрешение применить её. ADD nullable column и NOT VALID check не
переписывают delivery rows; check действует на новые записи. Partial index существующей таблицы
требует production-sized rehearsal; lock_timeout 5s и statement_timeout 30s ограничивают неудачный
транзакционный запуск. Owner/default ACL/RLS проверяются штатным post-migration verifier, дополненным
пятью таблицами. Перед реальным apply отдельно проверяются ledger, объём deliveries, locks, backup
и recovery. API не запускает миграции при старте.

`NOTIFICATION_SCENARIOS_ENABLED=false` по умолчанию. Владелец — notifications. Назначение — отдельно
включить consumer/scheduler после schema/role/functional acceptance; пересмотреть флаг после первого
пилота. Истинное значение требуется API для настройки категорий и Worker для обработки. Existing
transport global/tenant/provider gates остаются обязательными. Source merge, publication,
migration, включение флага и provider acceptance — разные переходы.

Порядок пилота: окончательная цепочка миграций и проверка ролей → gate-safe API/worker на всех
репликах → один подготовленный сценарий и проверка условий на synthetic fixture → отдельно
разрешённое включение tenant/transport/runtime и проверка результата. До включения убедиться, что
старые booking reminder rules не создают нежелательное дублирование пользовательского сценария;
существующие mandatory lifecycle уведомления не отключаются автоматически.

`GAME_START` не имеет mixed-worker compatibility со старым Worker. До миграции и определения
`GAME_STARTS` все notification/scenario/legacy-source флаги остаются OFF. Под exclusive rollout
lease сначала блокируются API/UI-команды, способные создать `GAME_STARTS`; затем старые provider
workers останавливаются и drain, readback доказывает отсутствие in-flight вызовов и leases. После
этого новый совместимый binary разворачивается на всех Worker replicas и проверяется по runtime
identity. Только после полного readback можно разрешить API/UI, создать сценарий и отдельно включить
source/runtime flags. Автоматический overlap старого и нового binary запрещён.

Binary rollback безопасен только при readback нулевых `GAME_STARTS` definitions, `GAME_START`
contexts/runs и связанных deliveries. После создания любой `GAME_STARTS` definition recovery —
только roll-forward на новом совместимом binary: flags OFF, сценарий paused, новый provider worker
stop/drain, накопленные facts/queued/UNKNOWN состояния сохраняются. Старый binary нельзя запускать
до отдельной проверенной cleanup/compatibility migration; удаление queued rows не является штатным
rollback. Перед активацией source facts читаются заново, старый readiness snapshot не переиспользуется.

Для остановки выключить сценарии/глобальный флаг. Для совместимых 0101 workloads новые infinity
deliveries остаются припаркованными и при откате на старый worker, поэтому потеря новой проверки не
открывает отправку. Это не разрешает старый binary для `GAME_START`: после создания definition
действует запрет и roll-forward protocol выше. Уже начатые provider calls проверяются отдельно; их
нельзя отозвать SQL rollback. Additive schema/history сохраняются, destructive down не предусмотрен.
После стабилизации нужны наблюдение за lag/ошибками нового consumer, journal reasons и размером
append-only истории; автоматическая очистка не включена.

## Lifecycle и каналы: расширение 0101

Текущий владелец — VivaCRM; будущий владелец — ЦУП. Клиент не выбирает источник. Смена владельца
требует отдельного server-side контракта/ownership transition; dual-write нет. LK1 контракты:
`src/utils/apiClient.ts`, `src/components/games/splitSubscriptionAvailability.ts`,
`scripts/sync_training_visits_from_viva.mjs`. Home/history projections не доказывают срок/посещение.

- SUBSCRIPTION_ENDS: полный `subscriptions?includeFinished=true` с проверкой страниц. ACTIVE с
  activation/expiration дает напоминание; EXPIRED с уже наступившим окончанием — follow-up. HOLD,
  REFUNDED, NO_VISITS, NEW, неизвестный статус и любой freeze/hold подавляют запуск. Дата окончания
  включительна в Europe/Moscow: якорь — начало следующего локального дня. Before-message истекает
  к якорю. Продление/заморозка/смена факта отменяют pending-доставки; отсутствие не доказывает окончание.
- BIRTHDAY: профиль делегированного пользователя; только месяц/день, без хранения года рождения.
  Якорь — 10:00 Europe/Moscow; 29 февраля только в високосные годы. Явное согласие именно BIRTHDAY
  требуется для каждого пользовательского канала и birthday staff task. Наследование quiet window
  не дает согласия. Сохранение факта повторно проверяет согласие в одной транзакции под блокировкой
  настроек; при отсутствии согласия birthday anchor и его fingerprint удаляются из рабочего контекста.
  Отзыв согласия прекращает сбор новых фактов и будущие отправки; уже накопленная история запусков
  и inbox сохраняется по действующей политике хранения уведомлений. Это не команда удаления персональных
  данных: её обработка требует отдельного privacy/retention процесса. Один occurrence на пользователя/год; переданный запуск не повторяется.
- TRAINING_ATTENDED: закончившаяся тренировка разрешенных type/studio и явный visitConfirmed /
  visited / attended / checked-in / present либо строгий подтвержденный статус. False имеет
  приоритет. Отмена/refund/waitlist/no-show/неоплата исключены; COMPLETED/запись не доказывают визит.
  Только verified VIVA/viva_profile map tenant, без поиска по телефону. История старше 24ч не рассылается.

Owned source проверяет профиль по verified map, использует существующий encrypted delegation и
его единственный refresh lock; orphan Home/photo sync не включается. Attendance требует отдельный
mounted read-token с expiresAt/providerTenantKey; legacy VIVA_API_KEY не подключается. Истекший токен
блокирует чтение. Фиксированный официальный origin, GET без redirect, timeout/retry/circuit и общий
budget: 30с, 32 HTTP попытки, 8MiB, 2000 строк, 30 упражнений. Неполный/большой snapshot не сохраняется.
Реальный response contract и credentials требуют PROVIDER acceptance; fixtures ее не заменяют.

Contexts хранят PadlHub UUID, hash source/scope, revision и checkedAt. Raw Viva IDs не входят в
API/events. Старый snapshot не откатывает свежий. Queue/send повторно проверяют revision/valid и
свежесть до 10 минут. Stale запрещает отправку; уже начатый provider call не отзывается snapshot.
DailyLimit lifecycle-категории действует за 24ч. Новый источник ЦУП пока не пишет эти проекции.

EMAIL — фиксированный smtp.yandex.ru:465, TLS 1.2+, text-only, без HTML/вложений/URL/file loading
или SMTP debug logs. From/envelope — auth corporate mailbox. Только ACTIVE verified адрес из
identity.local_email_credentials, шифрование и повторная ownership-проверка перед send. Отдельная
per-category настройка EMAIL: отсутствует — false. Тихие часы/TTL обязательны.

IOS_PUSH — APNs ES256, fixed Apple origin/environment/topic/credential_ref; generic alert и
/notifications без PII на lock screen. Keychain journal хранит token/installation и hash проверенной
native session identity. Durable revoke/epoch устанавливаются до ожидания in-flight enable; разные
аккаунты имеют независимые tombstones. После transfer/logout journal читается заново. Старый
консервативный tombstone может остаться до следующего входа прежнего аккаунта и canonical not-found.
Native bridge разрешает только фиксированные inbox/preferences/register/revoke/read-cursor операции;
произвольных URL и refresh cookies в JS нет. Build/backend/provider/OS permission gates обязательны.

STAFF_TASK — atomic internal-only support ticket + internal SYSTEM message + run link. Owner выдача,
quota и notifications исключают internal tickets. Restrictive RLS скрывает их и от старого API без
transaction capability; новый staff reader проверяет support.read/manage. Visibility immutable;
run/ticket tenant и пользователь совпадают. Autoclose/24-month retention получают внутренний capability.
SMS/TELEGRAM — UNAVAILABLE заглушки: без успешных attempts/receipts; stub-only run получает
SUPPRESSED/STUB_CHANNEL_UNAVAILABLE. Atlassian не используется.

APNs/SMTP фиксируют durable dispatch marker и 60с lease перед bounded call. Потеря ответа/timeout
после возможной отправки или crash дают DEAD + *_OUTCOME_UNKNOWN без auto-resend/PROVIDER_ACCEPTED.
Журнал показывает неизвестный результат; это не доказанная недоставка. Message-ID/apns-id не дают
exactly-once. Только явный rejection допускает retry с очисткой marker; circuit не расходует попытку.

0101 защищает mixed-fleet: extended head active=false/extended_active, run EXTENDED_PENDING,
delivery scenario_v2_available_at при scenario_available_at=NULL/next_attempt_at=infinity. Старые
workers их не выбирают; старый writer не меняет extended head. История/schema сохраняются. Schema
down после активации запрещен: disable writers + совместимый reader либо пауза extended work на
старой версии с сохранением restrictive policy/0101. До apply нужны ledger/size/locks/backup/rehearsal;
blocking indexes ограничены lock_timeout=5s/statement_timeout=30s. CI-only PostgreSQL fixtures проверяют
FORCE RLS, old discovery, private-ticket denial, renewal/freeze и unknown crash recovery.

Новые flags по умолчанию false: NOTIFICATION_LIFECYCLE_VIVA_ENABLED,
LEGACY_GAME_REMINDERS_SOURCE_ENABLED, APNS_ENABLED, SMTP_ENABLED,
NOTIFICATION_STAFF_TASKS_ENABLED; PADLHUB_IOS_PUSH_ENABLED — сборка. Owner notifications/mobile,
цель — отдельный пилот после 0101/consent/provider/device acceptance; review/remove после пилота.
Lifecycle требует явный NOTIFICATION_VIVA_TENANT_ID, iSkq6G binding и существующий delegation key.
Attendance: NOTIFICATION_VIVA_ADMIN_CREDENTIAL_FILE и NOTIFICATION_TRAINING_TYPE_IDS/STUDIO_IDS.
APNs/SMTP: private credential file, endpoint keyring, точный APNS_CREDENTIAL_REF/SMTP_CREDENTIAL_REF.
Canonical absolute file, owner-only 0600, без symlink/hardlink. JSON APNs: teamId/keyId/privateKey;
SMTP: login/password (app password корпоративного Яндекс-ящика); Admin: accessToken/expiresAt/
providerTenantKey. Секреты выдает/меняет владелец; они не входят в Git/env/UI/logs. Реальная iOS Push
capability/entitlement/signing не включается этим source change. Merge, publication, миграция,
deploy, flags и реальные сообщения — отдельные разрешенные переходы.
