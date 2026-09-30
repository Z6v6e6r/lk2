# КЯ-00 — проект клиентского ядра

Статус: **Proposed**. Основание и доказательства — [AUDIT.md](AUDIT.md). Принятые ADR 0001/0002/0004/0005/0008/0019 и [`docs/domains/profiles.md`](../../domains/profiles.md) сохраняют силу. КЯ-01 должен явно согласовать расхождение с черновиком ph-admin `docs/migration/viva-to-cup/canonical-model-and-ownership.md`: один стабильный `identity.users.id` платформы, без второго клиентского UUID в ЦУП.

## Граница и размещение

```mermaid
flowchart LR
  LK1[ЛК1] --> U[LK2 User API]
  LK2[ЛК2 Web/mobile] --> U
  T[Tilda] --> U
  CUP[Действующий ph-admin ЦУП] --> A[LK2 Admin API]
  U --> C[Customer identity/profile modules]
  A --> C
  C --> PG[(PostgreSQL tenant RLS)]
  C --> O[Transactional outbox]
  O --> W[LK2 worker import/reconcile]
  W --> V[@phub/viva-adapter]
  C --> D[Booking/commerce/rating/support read contracts]
```

Модульный монолит: `apps/api/src/auth`, `apps/api/src/profile`, будущие узкие customer routes в `apps/api/src`, доменные типы в `packages/auth`/`packages/domain`, PostgreSQL repositories/migrations в `packages/database`, Viva только через `packages/viva-adapter`, reconciliation в `apps/worker`. API, worker и realtime — процессы общей платформы. ЦУП вызывает Admin API, не пишет таблицы и не обслуживает consumer login. `apps/cup-admin` остаётся существующей ограниченной административной UI; первый клиентский раздел планируется в действующем `ph-admin/client-sdk/phab-admin-panel.js` после проверки навигации/ownership. Второй редактор клиентов не создавать.

Клиент может иметь `identity.users` и локальную карточку без login binding. Импорт не выдаёт доступ. Три независимые оси: **data quality** (`EMPTY/PARTIAL/RECONCILED/CONFLICT`), **login readiness** (`NONE/PENDING_PROOF/READY/SUSPENDED`), **business owner** (`VIVA_PRIMARY/SHADOW_COMPARE/LOCAL_PRIMARY/LOCAL_ONLY` по уже существующему `integration.domain_ownership` для каждого домена). Первые две — факты состояния, третья — существующий переключатель владельца; их нельзя сворачивать в один флаг. Смена входа не переносит расписание, деньги или абонементы.

Один профильный агрегат читается из одной согласованной версии. `GET /profile` при отсутствии полной Home-проекции уже даёт явный локальный срез; это следует развить в локальный профиль. Карточка клиента может показывать отдельные блоки `subscriptions/payments/bookings/rating/support` с `source`, `asOf`, `completeness`, но их команды принадлежат своим доменам. `unknown` остаток не равен нулю и не даёт списания. Redis только challenge/rate-limit/lease; PG — истина.

## Переиспользование и минимальные дополнения

| Сущность | Назначение, связь и tenant | Уникальность, версия, аудит |
| --- | --- | --- |
| `identity.users` | Корень клиента `id` UUID, `tenant_id`, `status`; может быть без входа. | Уже `(tenant_id,id)`; добавить optimistic `version`/происхождение изменённых полей, audit actor/correlation в command log. Не менять UUID. |
| `integration.external_identity_map` и `external_entity_map` | `(issuer,subject)` и Viva profile ID → тот же user UUID, только серверная интеграция. | Существующие tenant-уникальные mapping; конфликт в карантин, не автоматический merge. Версия/last seen для импорта. |
| `identity.refresh_sessions` | Хеш refresh credential, family, rotation, revoke; user FK. | Существующие tenant FK и уникальный hash; аудит create/rotate/revoke уже частично есть, добавить безопасный list/revoke API и device metadata без raw token. |
| `profile.user_summaries`, `profile.privacy_settings` | Существующие summary/privacy; self profile должен иметь собственный snapshot version. | `user_summaries.phone_e164` **сейчас уникален** в tenant (0091) и используется для login lookup. Его нельзя использовать для общих контактов. |
| `legal.document_acceptances`/intents | Версии оферты и политики ПДн с user/tenant и source. | `(tenant,user,kind,version)` и correlation уже есть; новые kinds/sources — только после contract/migration review. |
| **Предлагается** `identity.login_methods` + `identity.password_credentials` | Привязки локального пароля и подтверждённых внешних subjects к user; hash/algorithm/rotation metadata отдельно от контакта. | Unique `(tenant, method, issuer, subject)` для активного login, не по contact phone. `version`, created/changed/revoked actor/time, audit event. Password hash никогда не возвращается. |
| **Предлагается** `profile.contacts` | Несколько телефонов/email как контакты; независимые `verified_at`, `verification_source`, `source_updated_at`. | Unique только `(tenant,user,type,normalized_value)` для дедупликации внутри карточки; **нет** unique на `(tenant,value)`. Контакт сам по себе не login. Версия и локальный verification provenance защищают от Viva overwrite. |
| **Предлагается** `identity.recovery_challenges`/commands | Короткоживущая попытка доказательства и повторяемый результат, без открытого секрета в PG. | Tenant/user/method, hash nonce, expiry/attempts/consumed, `Idempotency-Key`, audit. Redis может хранить ephemeral lease, durable transition в PG. |
| **Предлагается** `integration.customer_import_runs`/conflicts | Checkpoint, source version, count/hash, quarantine и операторское решение. | Unique `(tenant,source,source_record_id,source_version)`; run revision, actor, correlation, retention policy. Не хранить бессрочные raw PII. |

Разделение контакта от входа требует **expand/migrate/contract**, потому что текущий `user_summaries` phone unique и auth lookup используют один столбец. В КЯ-01 сначала добавить новую модель и переходное чтение без второго writer, затем в отдельном инкременте перевести login lookup на уникальный `login_methods`; лишь после проверки убрать старое ограничение. Пока это не сделано, общий контакт допустим только в новой contact-таблице и не может занять старый login phone. Один общий контакт не должен выбирать аккаунт для входа: клиенту с таким контактом нужен иной однозначный привязанный метод или контролируемое восстановление; если его нет, `login readiness=PENDING_PROOF`, даже при полной карточке.

## Матрица владения полями

| Данные | Источник сейчас | Целевой владелец | Кто меняет в переходе | Конфликт | Условие переключения |
| --- | --- | --- | --- | --- | --- |
| UUID/status | LK2 `identity.users`; Viva linked через map | LK2 Identity | LK2 auth/import по доказанному mapping | UUID никогда не заменять; неоднозначность в quarantine | Полная сверка ID и race/tenant tests |
| Login subject/password | Viva OAuth/OTP, PadlHub session | LK2 Identity | Viva на `VIVA` binding; LOCAL после enrollment | Явное доказательство связи; запрет phone/email auto-merge | LOCAL provider, recovery, negative tests, tenant switch |
| Контактный phone/email | Viva profile → `user_summaries` | LK2 Profile contacts | Viva import для непроверенного, self для локально проверенного | Локально проверенное побеждает; shared contact допустим, login binding отдельно | Versioned import + contact verification + conflict UI |
| Имя/фото/profile prefs | Viva/Home projection и локальные privacy/photo | LK2 Profile | По field provenance; self/local privacy уже owner | Одна snapshot version; локальное изменение не перетирается поздней Viva delta | Local read coverage, reconciliation |
| Согласия | LK2 legal acceptances | LK2 Legal | Только подтверждённый consumer; staff не имитирует согласие | Append-only по версии документа | Показ текущих/исторических версий и audit |
| Абонементы/платежи/записи | Viva и отдельные текущие домены | Соответствующие commerce/booking домены, не ядро | Текущий единственный owner по `domain_ownership` | Копия read-only, `source/asOf/unknown`; без dual-write | Отдельный domain cutover, не КЯ-04 |
| Рейтинг/сообщения/support | CUP/LK2 отдельные домены | Их текущие владельцы | Их собственные команды | Карточка только разрешённая read-сводка | Отдельное согласование mapping/scope |

## API-предложения (контракт не изменён)

Существующие `GET /user/api/v1/{tenantKey}/context`, `GET /profile`, `GET/PUT /profile/privacy`, `POST /auth/challenges`, `POST /auth/challenges/{id}/verify`, `POST /auth/session/refresh`, `DELETE /auth/session` переиспользовать. Открытый PR #244 предлагает `POST /profile/phone/challenges` и `.../verify` для подтверждённого login phone; после интеграции переиспользовать именно их, а общий контакт вести отдельно. Предлагаемые расширения ниже подлежат отдельному OpenAPI/SDK compatibility review. Consumer audience из `JWT_AUDIENCE` и staff `phub-admin` проверяются сервером; tenant из claims/path сверяется, station/role/capability staff выводится из доверенной identity, не из browser body. Все команды принимают `Idempotency-Key` и `X-Correlation-ID`, пишут редактированный audit, ожидают version/CAS и стабильный error code; 401/403 не раскрывают существование чужого аккаунта.

| Команда / сценарий | Actor и scope/право | Идемпотентность, audit, конкурентность, ошибка/совместимость |
| --- | --- | --- |
| `GET /profile` (есть), `PATCH /profile` (предложение) | Consumer self, verified user/tenant; поля allowlist | `GET` одна snapshot; `PATCH` key+expectedVersion, audit `PROFILE_UPDATED`, CAS 409, 422 forbidden field; additive DTO и старый GET. |
| Подтверждение общего контакта (предложение); для login phone переиспользовать pending `POST /profile/phone/challenges` и `.../verify` из #244 | Consumer self; повторное подтверждение при смене primary/login | key+challenge purpose/owner binding, TTL/attempt limit, audit без кода, single consume; 409 conflict, 410 expired, нейтральный ответ на abuse. Контактная аттестация не создаёт login binding или session. |
| `POST /auth/password/setup`, `POST /auth/password/login`, `POST /auth/recovery/start`, `.../complete` (предложение) | Consumer либо unauthenticated с доказательством; setup требует свежую сильную сессию | key + hash request, одноразовый proof, bounded attempts, CAS, audit; одинаковый внешний ответ для unknown user, 401 invalid, 409 replay/conflict, 429; выдавать только PadlHub session, не пароль. |
| `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `POST /auth/sessions/revoke-all` (предложение) | Consumer self; sensitive revoke-all требует step-up | key для DELETE/POST, семейная revocation и audit в транзакции; CAS/replay, 404 для чужого ID, текущий `DELETE /auth/session` сохранён. |
| `POST /auth/methods/link`, `DELETE /auth/methods/{id}` (предложение) | Consumer self, свежая сессия + проверенный new method; нельзя удалить последний usable method без recovery | key + unique subject/CAS, audit link/unlink, 409 already linked/last method, 403 proof invalid; существующие Viva mappings не переписывать по телефону. |
| `GET /admin/api/v1/{tenantKey}/customers`, `GET .../{userId}` (предложение) | Staff `customers.read`, tenant+station scope из staff claims/delegation | Search минимизирует PII, audit sensitive read, bounded pagination, 403 scope/404 чужой tenant, `source/asOf` по блокам; существующий notification resolver не считать customer search. |
| `PATCH .../{userId}`, `POST .../{userId}/recovery`, `POST .../{userId}/sessions/revoke`, `GET .../{userId}/conflicts/history` (предложение) | Staff отдельные `customers.correct/recovery/session-revoke/audit.read`, reason/ticket, station membership и step-up | key + expectedVersion, audit actor/reason/old-new redacted, CAS 409, 403 scope, 422 forbidden; recovery запускает клиентский proof, staff не видит пароль/код; read history bounded. |

Никакого параллельного подтверждения одного кода у Viva и LOCAL и скрытого fallback. Владение телефоном не доказывает владение ранее созданным аккаунтом (решение review PR #242); link требует доказательства старого аккаунта и нового метода, а merge двух аккаунтов — отдельного проекта. Прямые Яндекс ID, Сбер ID, Т-ID — отдельные будущие provider integrations: сначала договор/протокол, issuer/audience/subject/claims, кнопка, условия и recovery; Viva-обёртка Яндекса не доказывает переносимость subject. Один рабочий LOCAL способ входа достаточен для первого независимого релиза.
