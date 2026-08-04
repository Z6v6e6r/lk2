# Полный архитектурный аудит блока «Сообщества»

- Дата: 2026-08-03
- Область: текущий LK (`/Users/zver/Desktop/project-fixed 6`) и новый PadlHub LK (`/Users/zver/Documents/Приложение ПаделхАБ`)
- Целевая нагрузка: 20–100 тыс. DAU по всему контуру «Сообщества»
- Решение: **NO-GO для переноса старого кода и старых API; GO для переноса визуала поверх нового канонического контура**
- Диаграмма: `docs/architecture/communities-target-architecture.drawio`

## 1. Итог для руководителя

Старый блок нельзя переносить в новый ЛК компонент-за-компонентом или endpoint-за-endpoint. Он совмещает в одном UI и одном Node-RED контуре каталог, граф связей, членство, приглашения, роли, ленту, реакции, комментарии, чат, рейтинг, игры, турниры, медиа и локальный unread state. Его главные проблемы не визуальные, а системные:

1. Браузер сообщает серверу, кем является пользователь: передаёт `phone`, `clientId`, `member`, `actor`, `creator` и `role`. Эти данные нельзя считать основанием для авторизации.
2. Критические команды не имеют обязательной идемпотентности. Клиент повторяет/fallback-ит mutation-запросы, поэтому сетевой таймаут после успешной записи может породить дубль.
3. Node-RED выполняет несколько Mongo-записей параллельными ветками без общей транзакции и может отправить HTTP-ответ независимо от результата остальных веток. Возможны частично созданные сообщества, потерянные события, рассинхрон рейтинга и счётчиков.
4. `CommunitiesSection.tsx` — 6 354 строки, 73 `useState` и 32 `useEffect`; `communityApi.ts` — 2 196 строк и 19 API-функций. Старый `communities.js` собран одним IIFE с inline dynamic imports, поэтому функциональность нельзя эффективно подгружать по маршрутам.
5. Список возвращает встроенные массивы участников и связи между сообществами; graph fallback вычисляется из участников. Это растёт как минимум пропорционально сумме участников, а граф связей — близко к `O(C²)` по числу сообществ пользователя/каталога.
6. Чат опрашивается каждые 7 секунд, а unread/read state рассчитывается в браузере и хранится в `localStorage`. Это не работает как единое состояние между устройствами и создаёт постоянную фоновую нагрузку.
7. Новый PadlHub контур уже правильно закладывает UUID, tenant RLS, server-owned identity, keyset pagination и Home projection, но реализует пока только read-only каталог. Создание, detail, join/invite, управление участниками, лента, рейтинг, чат и модерация ещё отсутствуют.
8. В новом каталоге есть конкретный дефект: `memberRank` читается из БД/legacy и разрешён схемой, но теряется при построении ответа `CommunityMembershipPage`.
9. Community Home sync ошибочно связан с `HOME_VIVA_SYNC_ENABLED`, Viva delegation и profile-photo S3 store. Сообщества объявлены `LOCAL_ONLY`, поэтому их синхронизация не должна зависеть от готовности Viva Home.

Правильная цель — не «сделать свой VK». Для 100 тыс. DAU достаточно существующей стратегии modular monolith: отдельные процессы API/worker/realtime, PostgreSQL как source of truth, RabbitMQ/outbox для асинхронных проекций, Redis только для TTL/cache/rate limits/presence, private S3 для медиа. Нужны строгие доменные границы и подготовленные read models, а не раннее дробление на микросервисы.

## 2. Что именно было проверено

### Старый LK

- `src/components/cabinet/CommunitiesSection.tsx`
- `src/utils/communityApi.ts`
- `src/components/communities/CommunityJoinPage.tsx`
- `src/communities.tsx`, `vite.config.communities.ts`
- `scripts/patch_nodered_communities_flow.mjs`
- Node-RED community flow snapshots
- `src/services/community-rating/*`
- `docs/COMMUNITY_RATING_RECALCULATION.md`

### Новый PadlHub LK

- `apps/web/src/CommunitiesPage.tsx`, Home community carousel и gateway
- `apps/api/src/communities/*`
- `packages/communities/*`
- `packages/database/src/community-repository.ts`
- migrations `0018`, `0019`, `0020`, `0043`, `0047`
- worker community Home/logo sync
- OpenAPI User API v1
- messaging/notifications/moderation foundation
- deploy/observability topology и ADR modular monolith

### Ограничения доказательств

- Исходники и локальные тесты проверены на текущем рабочем состоянии 2026-08-03.
- Отдельный read-only поток команды снял фактический `/root/.node-red/flows.json` 2026-08-03. Локальная копия: `/private/tmp/community-audit-live-flows-20260803.json`, SHA-256 `ffe6020341a50755f8f83c35e3099cac87d3b9a6a3aaea6c8c8e9cc26a195ec4`. Production не изменялся.
- Измерение production API `GET /lk/communities?view=summary` около 6.97 с и bundle 914 313 байт получено в отдельной live-диагностике 2026-07-15. Это важный исторический факт, но не повторный замер сегодняшнего production.
- Живые данные и write-команды не изменялись.

## 3. Карта возможностей: старый и новый контур

| Возможность               | Старый LK                                     | Новый PadlHub                             | Решение для переноса                                        |
| ------------------------- | --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Мои сообщества            | Есть, но browser identity и тяжёлый summary   | Реализован защищённый `/communities/mine` | Сохранить новый контракт, исправить defects                 |
| Каталог/поиск             | Смешан с memberships и graph                  | Нет                                       | Новый независимый read model                                |
| Карточка сообщества       | Есть внутри god-component                     | Нет                                       | Отдельный route и detail contract                           |
| Создание/редактирование   | Browser actor + Node-RED fan-out              | Нет                                       | Канонические PG-команды                                     |
| Join/request/invite       | Browser member; raw invite                    | Нет                                       | Server principal, hashed invite, state machine              |
| Роли/модерация участников | Client sends actor/role                       | Только foundation role/status             | Server RBAC и audit                                         |
| Лента                     | Mongo posts + embedded compatibility payloads | Нет                                       | PG posts/feed read model                                    |
| Реакции/комментарии       | Несколько коллекций и счётчики                | Нет                                       | Уникальная реакция + transactional delta/projected counters |
| Чат                       | Polling + browser read state                  | Messaging foundation есть                 | Использовать `messaging` COMMUNITY conversation             |
| Непрочитанное             | `localStorage`/загруженный кусок сообщений    | В summary пока всегда 0                   | Durable cursor + projection                                 |
| Рейтинг                   | Mongo facts/aggregates/snapshots              | В membership только nullable rank         | Отдельный versioned projector                               |
| Медиа                     | JSON data URL и legacy URLs                   | Private object storage pattern есть       | Presigned staged upload + validation                        |
| Жалобы/moderation         | UI-форма и legacy event path                  | Moderation foundation есть                | Единый moderation case contour                              |
| Realtime                  | Нет, polling                                  | Отдельный runtime существует              | Auth topics + resume by sequence                            |
| Tenant isolation          | Не является полным инвариантом legacy         | RLS + composite keys                      | Только новый контур                                         |

## 4. Реестр рисков

### P0 — блокируют перенос и запуск write-функций

#### P0.1. Клиент управляет идентичностью и ролью

Evidence:

- Старый список/деталь/лента/чат/рейтинг добавляют `phone` и `clientId` в query: `src/utils/communityApi.ts:1351-1418`, `1664-1707`, `1872-1896`, `2013-2049`, `2118-2148`.
- Mutation payload строится из client-owned `id`, `phone`, `role`, `levelScore`: `src/utils/communityApi.ts:1279-1288`.
- Create/update/member moderation/comments/reactions/chat передают `creator`, `actor` или `member`: `1437-1505`, `1593-1644`, `1915-1988`, `2069-2091`.
- Node-RED community flow сопоставляет участника по полям из request query/body, а не по verified PadlHub principal.

Impact: impersonation, role escalation, чтение закрытого сообщества, действия от чужого имени, раскрытие PII.

Correction:

- Любой User API получает actor только из проверенного PadlHub JWT `sub` и tenant context.
- В body запрещены `actor`, `creator`, `member.phone`, `member.role` для self-service команд.
- Target user для модерации — только PadlHub UUID в path/body; полномочие вычисляет сервер из canonical membership.
- Телефон, Viva ID и legacy ID не входят в публичный community contract.

#### P0.2. Нет атомарности команд и одного write owner

Evidence:

- Create community в Node-RED расходится параллельно в `lk_communities`, `lk_community_feed`, `lk_community_rankings`, `lk_community_events` и HTTP response.
- Join/member manage/post/reaction повторяют тот же fan-out pattern.
- Старый Mongo path не доказывает общую транзакцию, rollback или CAS версии агрегата.

Impact: частичные success, ложные `200`, потеря/дубли событий, неверные counters, невозможность безопасного retry.

Correction:

- Один aggregate command фиксирует business state, command/idempotency record, audit и outbox в одной PostgreSQL transaction.
- Feed/rating/notification/search projections обновляются асинхронно из outbox.
- HTTP success возвращается только после commit source-of-truth state.
- Внешние side effects не входят в HTTP transaction; worker повторяет их ограниченно и отправляет в DLQ.

#### P0.3. Нет идемпотентности critical commands

Evidence:

- Старый клиент делает `retries: 1` и перебирает несколько mutation base URLs при network/404/405/5xx: `src/utils/communityApi.ts:1242-1276`.
- Create/join/post/comment/reaction/chat не требуют `Idempotency-Key`.

Impact: один пользовательский tap может создать два объекта или применить действие дважды, особенно если первый сервер commit-нул, но ответ потерялся.

Correction:

- Все create/update/join/leave/invite/moderate/post/comment/reaction/message/media-finalize команды требуют `Idempotency-Key`.
- Ключ scoped как `(tenant, actor, operation)` и связан с request hash + saved result.
- Retry безопасен только через тот же public API endpoint; клиент не выбирает альтернативный write owner.

#### P0.4. Legacy Node-RED route drift

Evidence:

- Сохранённый flow содержит по два набора `/lk/communities` routes.
- Предыдущая live-проверка также видела несколько `GET /lk/communities` handlers на 147.

Impact: неопределённый активный handler, разные contract/security rules, неочевидный rollback.

Correction:

- До migration freeze снять live inventory route → node ID → source SHA → owner.
- Удалить дубли после read-only shadow parity, не путать repo artifact и live runtime.
- Новый LK никогда не вызывает legacy write routes.

#### P0.5. Канонический scope пока неполный

Evidence: `docs/domains/communities.md:14-18` прямо фиксирует, что creation, detail, join/invite, member moderation, feed, full rating и chat history — будущие vertical slices.

Impact: включение нового UI поверх текущего API неизбежно вернёт небезопасные legacy writes или создаст смешанный aggregate.

Correction: переносить по завершённым вертикальным срезам; UI action включается только когда его read и write paths полностью канонические.

#### P0.6. Фактические live Mongo reads не имеют server-side bounds

Read-only snapshot активного `LK Communities` содержит 208 nodes, 24 HTTP endpoints и 69 `mongodb4` nodes. Для Mongo-узлов `maxTimeMS=0`; list/feed/chat/rating paths используют `toArray`, а сортировка/ограничение часто происходят после materialization.

Impact:

- медленный/зависший запрос удерживает Node-RED и Mongo resources без deadline;
- feed дополнительно читает comments/reactions, chat — history, rating fallback — несколько collections;
- добавление Node-RED replicas не устраняет full scans, hot documents и unbounded memory;
- один hot community способен ухудшить весь runtime.

Correction:

- legacy runtime оставить только как ограниченный источник backfill/shadow evidence;
- для временного containment добавить indexed server-side filters, keyset sort/limit, `maxTimeMS`, response size limits и per-route rate limits;
- production target строить только на canonical PostgreSQL read models.

### P1 — исправить до public beta

#### P1.1. `memberRank` теряется в новом API

Evidence:

- Repository возвращает `memberRank`: `packages/database/src/community-repository.ts:164-173`.
- Schema его разрешает: `packages/communities/src/index.ts:7-17`.
- Service mapping не копирует его в response: `packages/communities/src/index.ts:191-199`.
- Локальный executable probe передал `memberRank: 7`, а результат его не содержал.
- Текущие focused tests проходят, потому что service test не включает rank в fixture.

Correction: вернуть optional `memberRank` в mapping и добавить contract/service/API/UI regression tests.

#### P1.2. Community Home sync связан с Viva Home

Evidence:

- `runCommunitySyncCycle` выходит, если выключен `HOME_VIVA_SYNC_ENABLED` или отсутствует profile-photo store: `apps/worker/src/main.ts:493-505`.
- Кандидаты на community sync требуют активную Viva delegation: `apps/worker/src/community-home-repository.ts:52-80`.
- Communities domain объявлен `LOCAL_ONLY`: `packages/database/migrations/0018_communities_foundation.sql:82-93`.

Impact: блок Сообществ может быть unavailable у канонического пользователя только потому, что Viva Home/delegation не активны.

Correction:

- Выделить `COMMUNITY_HOME_SYNC_ENABLED`, interval, batch size и отдельный `CommunityMediaObjectStore`.
- В local mode кандидаты определяются canonical memberships/active users, не Viva delegation.
- Legacy mode может использовать identity bridge, но ownership и readiness community cycle остаются независимыми.

При текущих default `batch=20` и `interval=120s` теоретический проход 100 000 пользователей даже при нулевой работе занимает `100000 / 20 × 120s = 600000s`, то есть около **6.94 суток**. Нужны event-driven dirty keys и leased claims (`FOR UPDATE SKIP LOCKED`), а не последовательный periodic full user scan.

#### P1.3. Тяжёлый list/summary и `O(C²)` graph

Evidence:

- Старый list response содержит `communities` и `connections`; при отсутствии connections браузер строит их из всех members: `CommunitiesSection.tsx:1773-1801`.
- Исторический live response: 56 communities, 416 connections, TTFB около 6.9 с.
- Legacy bridge ограничивает source до 1 000 communities и фактически загружает/нормализует source list перед server-side slicing.

Correction:

- Разделить endpoints: `mine`, `discover`, `detail`, `connections`.
- `mine` не возвращает members/connections.
- Все списки — keyset cursor, `limit + 1`, projection-ready rows.
- Connections — отдельная optional feature/read model с лимитами; не блокирует первый экран.

#### P1.4. God-component и единый bundle

Evidence:

- `CommunitiesSection.tsx`: 6 354 строки, 73 `useState`, 32 `useEffect`.
- `communityApi.ts`: 2 196 строк, 19 exported async API functions.
- `vite.config.communities.ts:17-31`: IIFE, `cssCodeSplit: false`, `inlineDynamicImports: true`.
- В old `src` нет community-specific test/spec files.

Correction:

- Routes: directory, detail, feed, members, rating, chat, settings.
- Отдельные feature modules и query keys; route-level lazy loading.
- Визуальные presentational components не знают API/identity/source.
- Typed SDK генерируется/проверяется OpenAPI.
- Contract, state-machine, component и browser tests обязательны по vertical slice.

#### P1.5. Chat polling и browser-owned read cursor

Evidence:

- Chat refresh идёт каждые 7 000 мс: `CommunitiesSection.tsx:2425-2453`.
- Последнее прочтение/непрочитанное вычисляется из загруженного куска и localStorage: `1574-1581`, `3235-3274`, `3604-3638`.

Impact: постоянный RPS на открытых вкладках, неверный unread после pagination, несогласованность между устройствами.

Correction:

- Community chat — `messaging.conversations(kind=COMMUNITY, context_id=community_id)`.
- Messages имеют server sequence; membership — durable `last_read_sequence`.
- Realtime доставляет identifier + sequence; REST cursor восполняет пропуски.
- Polling остаётся только degraded fallback с backoff/visibility gate.

#### P1.6. Feed cursor и counters недостаточно устойчивы

Evidence: legacy feed использует только `beforeTs`, а реакции хранятся отдельно и обновляют counters отдельной Mongo write-веткой.

Impact: timestamp collision, пропуски/дубли страниц, lost update counters.

Correction:

- Opaque cursor содержит `(published_at, id)` или monotonic sequence.
- Unique reaction key `(tenant_id, post_id, user_id)`; изменение reaction и counter delta — одна transaction либо counter — async projection.
- Comment count/like count считаются projection; бизнес-право не зависит от eventual counter.

#### P1.7. Media upload через base64 JSON

Evidence: old client отправляет `dataUrl` и `thumbDataUrl` в JSON `POST /lk/media/community-logo`: `src/utils/communityApi.ts:1524-1541`.

Impact: ~33% base64 overhead, большой heap на client/API, риск oversized payload, нет прозрачного scan/finalize lifecycle.

Correction:

- `POST media/uploads` создаёт intent/presigned upload.
- Client загружает бинарный объект напрямую в quarantine bucket.
- Worker проверяет MIME/magic bytes, размер/пиксели, удаляет metadata, создаёт variants.
- `finalize` атомарно привязывает immutable object key к aggregate.

#### P1.8. Новый route/interaction contour содержит битые пути

Evidence:

- Router нового web распознаёт точный `/communities`, но не `/communities/{uuid}`.
- API уже возвращает `route: /communities/{uuid}`, а Profile также строит detail links.
- Карточки `/communities` и Home сейчас рендерятся как неинтерактивные containers и route не используют.

Impact: перенос визуала без route contract приведёт к not-found и ложным affordances.

Correction: сначала реализовать canonical detail route/loader/error states, затем сделать cards ссылками; search icon не должен называться «Найти», пока endpoint discovery отсутствует.

#### P1.9. Invite flow допускает слабый token и небезопасный return URL

Legacy invite suffix строится через `Math.random`, а `cabinetUrl/returnUrl` может попасть в navigation без строгого server-owned allowlist.

Correction:

- минимум 128-bit cryptographic token, hash at rest, expiry, max uses, revocation, tenant/community scope и rate limit;
- return destination — server-issued relative route или строгий allowlist origin/path;
- redemption требует idempotency и audit.

#### P1.10. Realtime и community notification fan-out пока не реализованы на требуемом уровне

- `apps/realtime` подтверждает ticket/connection, но community subscribe authorization, durable sequence catch-up, backpressure, heartbeat, draining и reconnect-storm limits ещё не образуют готовый contour.
- Notification audience сейчас ориентирован на единичного event user; последовательные inserts/deliveries нельзя механически расширить до 100 тыс. recipients.

Correction:

- durable audience job + immutable audience version;
- chunks 500–1 000 recipients, batch inserts, provider-specific queues, controlled concurrency/checkpoints;
- WebSocket остаётся best-effort transport, HTTP/DB — recovery source.

#### P1.11. Горизонтальный worker scale и observability не готовы

- Core worker последовательно обходит tenants; community cycle не leased/sharded.
- Production-qualified leased outbox/worker roles должны быть доказаны до feed/notification load.
- Нужны отдельные worker roles одного image: outbox, projections, audience, delivery, media, rating.
- Текущих общих outbox/DLQ метрик недостаточно: нужны community API latency/error, projection backlog/staleness, feed/chat lag, WS connections/drop/catch-up, audience progress, moderation queue, cache hit ratio и DB pool saturation.
- Backup existence/`pg_restore --list` недостаточен без test restore/PITR drill.

#### P1.12. Cursor precision и last activity semantics требуют исправления

- PostgreSQL `timestamptz` превращается в JavaScript `Date` перед cursor encoding, поэтому микросекунды теряются. Сравнение continuation с полным DB timestamp может пропускать/дублировать rows на одинаковых миллисекундах.
- Current sort uses `greatest(community.updated_at, membership.updated_at)`, а не подготовленную `last_activity_at` из post/event projection.

Correction: хранить canonical cursor ordering key без потери precision, включать deterministic UUID tie-breaker; желательно HMAC-bind cursor к tenant/user/filter/schema version/expiry.

### P2 — до 100 тыс. DAU

1. In-process legacy caches должны иметь строгий maximum/eviction; rank cache и external ID map не должны расти без bounds.
2. Directory `Cache-Control: private` допустим, но membership invalidation должна быть event-driven; нельзя полагаться только на TTL.
3. Search/discovery сначала строится на PostgreSQL FTS/trigram + read model. Elasticsearch/OpenSearch вводится только по измеренному пределу.
4. High-volume tables должны иметь правильные composite indexes и lifecycle/retention. Partitioning вводится по фактическому объёму, не заранее для малых таблиц.
5. Realtime gateway нуждается в connection quotas, heartbeat, resume token/sequence, per-user/per-community limits и graceful shedding.
6. Notification fan-out нельзя выполнять синхронно в post transaction; нужны batched intents, preference filtering, retry/DLQ.
7. Нужны load, soak и failure tests; unit tests не доказывают outbox lag, connection capacity и hot-community behaviour.
8. Legacy bridge не должен создавать `external_entity_map` writes на GET. Mapping preallocation/backfill выполняется отдельно; read path остаётся read-only.
9. Outbound telemetry должна redaction-ить `phone`, `phoneE164`, `clientId`, `authorPhone`, `mobile` и query URLs legacy bridge либо заменяться безопасными custom metrics.
10. Ranking generation публикуется атомарным generation pointer. Последовательные delete/upsert facts/aggregates/snapshots не должны быть видны читателю частично.
11. Current owner constraint гарантирует «не более одного active OWNER», но не «ровно один»; create/transfer/archive commands обязаны сохранять owner invariant transactionally.
12. `ranking_position` в membership без period/version/freshness — только display cache, не source of truth рейтинга.

### P3 — после стабильного канонического релиза

1. Персональные рекомендации сообществ.
2. Внешний полнотекстовый search cluster.
3. Hybrid fan-out для единой персональной ленты, если fan-out-on-read достигнет измеренного предела.
4. Отдельный service extraction. До этого modular monolith дешевле и надёжнее.

## 5. Целевая архитектура

### 5.1. Базовый принцип

Сохраняется один deployable modular monolith с тремя процессами:

- `apps/api`: auth, commands, queries;
- `apps/worker`: outbox publish, projections, media, notifications, rating;
- `apps/realtime`: authorized WebSocket topics, presence и resume.

Домены разделены пакетами и PostgreSQL schemas, но не превращаются в fleet микросервисов.

### 5.2. Доменные границы

| Модуль            | Владеет                                                        | Не владеет                                       |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Communities Core  | community, membership, role, join policy, request, invite, ban | messages, notification delivery, games           |
| Community Content | posts, comments, reactions, feed read models                   | chat history, rating formula                     |
| Messaging         | COMMUNITY conversation, messages, read cursor                  | community roles/policy source                    |
| Moderation        | reports, cases, actions, policy versions                       | прямое изменение community rows без command port |
| Community Rating  | facts, aggregates, versioned snapshots                         | feed post как source-of-truth результата         |
| Notifications     | recipient intents, inbox, deliveries/preferences               | community business state                         |
| Media             | upload intents, object validation, variants, GC                | community authorization decision                 |

### 5.3. Consistency model

| Данные                            | Consistency                  | Почему                                     |
| --------------------------------- | ---------------------------- | ------------------------------------------ |
| Membership/role/ban               | Strong transactional         | Определяет доступ и права                  |
| Owner transfer                    | Strong + row lock/version    | Нельзя оставить active community без owner |
| Invite redemption/use count       | Strong + idempotent          | Ограничения и защита от replay             |
| Post/comment/message creation     | Strong source row + outbox   | Пользователь должен получить стабильный ID |
| Reaction uniqueness               | Strong                       | Один reaction пользователя на post         |
| Counters/feed cards/search/rating | Eventual projection          | Можно обновлять асинхронно                 |
| Presence/typing                   | Ephemeral Redis              | Не бизнес-истина                           |
| Notification delivery             | Eventual with durable intent | Провайдер вне HTTP transaction             |

### 5.4. Target data model

Минимальный canonical набор:

- `communities.communities`: tenant UUID, PadlHub UUID, slug, title, description, visibility, join policy, status, owner/version timestamps.
- `communities.memberships`: current role/status, joined/left timestamps, notification policy, optimistic version.
- `communities.join_requests`: explicit state, decision actor/reason/time.
- `communities.invites`: token hash, creator, expires, max uses/use count, revoke state. Raw token возвращается только один раз.
- `communities.bans`: target user, scope, reason code, expires, actor, state.
- `community_content.posts`: author UUID, kind, body/payload schema version, lifecycle, published/edited timestamps, aggregate version.
- `community_content.post_media`: private object key, variant, hash, scan state.
- `community_content.comments`: post/community FK, author, one-level parent if нужен, lifecycle/version.
- `community_content.reactions`: unique `(tenant, post, user)` with reaction type.
- `community_content.post_stats`: projected counters.
- `community_content.feed_entries`: prepared, keyset-addressable community feed.
- `community_content.read_cursors`: optional feed sequence cursor per membership/device-independent user.
- `messaging.*`: уже спроектированные conversation/messages/members/read sequence.
- `community_rating_facts`, `community_rating_player_aggregates`, `community_rating_snapshots`: versioned projection, migrated under canonical UUIDs.
- `moderation.*`, `notifications.*`, `audit.*`, `integration.external_entity_map`: повторно используются, не дублируются.

Все таблицы tenant-owned, имеют composite tenant-aware FK и forced RLS. External/legacy IDs остаются только в `integration`.

### 5.5. Target API shape

#### Reads

- `GET /user/api/v1/{tenantKey}/communities/mine?limit&cursor`
- `GET /user/api/v1/{tenantKey}/communities?query&city&tags&limit&cursor`
- `GET /user/api/v1/{tenantKey}/communities/{communityId}`
- `GET /user/api/v1/{tenantKey}/communities/{communityId}/members?role&limit&cursor`
- `GET /user/api/v1/{tenantKey}/communities/{communityId}/feed?limit&cursor`
- `GET /user/api/v1/{tenantKey}/communities/{communityId}/posts/{postId}/comments?limit&cursor`
- `GET /user/api/v1/{tenantKey}/communities/{communityId}/rating?period&tab&cursor`
- Chat использует messaging API, а не новый community message store.

#### Commands

- create/update/archive community;
- request/cancel/approve/reject join;
- redeem/revoke invite;
- leave/remove/ban/unban/change role/transfer owner;
- create/edit/delete post/comment;
- set/remove reaction;
- create/finalize media upload.

Каждая critical command:

- требует PadlHub JWT, tenant, permission и `Idempotency-Key`;
- не принимает actor identity от клиента;
- использует PadlHub UUID;
- пишет audit + outbox;
- возвращает stable error code и resource version;
- поддерживает `If-Match`/expected version там, где конфликт редактирования значим.

### 5.6. Feed strategy

Для community feed нужен **fan-out-on-read** по `community_id`: post создаёт одну каноническую запись и одну prepared feed entry, а не копию на каждого участника. Это оптимально для 20–100 тыс. DAU и hot communities.

Уведомления о post — отдельный async fan-out по preferences. Если позже появится единая персональная лента из сотен подписок, её strategy выбирается по измерениям; заранее создавать per-user feed copies не нужно.

### 5.7. Realtime strategy

- WebSocket subscription только после JWT/tenant/membership authorization.
- Topics: `community:{uuid}:feed`, `conversation:{uuid}`, user inbox.
- Payload содержит event ID, resource ID, version/sequence и безопасный preview; canonical content клиент перечитывает по API.
- При reconnect клиент передаёт last sequence; gap восполняется REST cursor.
- Redis хранит connection routing/presence, но сообщения и read cursors — в PostgreSQL.

### 5.8. Rating strategy

- Game/tournament/visit domain events — источник фактов; feed publication не является подтверждением результата.
- Worker строит immutable facts, aggregates и versioned snapshots.
- Snapshot содержит `calculationVersion`, `sourceVersion`, `dataThrough`, freshness state.
- Формула меняется новой версией и full backfill; API переключается только после готовности новой версии.
- Рейтинг не блокирует каталог, feed или membership commands. Если snapshot не готов, возвращается локальный degraded state/stable error, а не тяжёлый synchronous calculation.
- Facts/aggregates новой версии пишутся в отдельное generation, после чего одной атомарной операцией переключается published generation; читатель никогда не видит наполовину пересчитанный набор.

## 6. Capacity model для 100 тыс. DAU

Это sizing envelope, а не обещание без load test.

### Assumptions

| Параметр                              |     Значение |
| ------------------------------------- | -----------: |
| DAU                                   |      100 000 |
| Sessions/user/day                     |            3 |
| Peak-hour доля sessions               |          15% |
| Read requests/session                 |           20 |
| Write actions/session                 |            2 |
| Burst factor поверх peak-hour average |           3x |
| Одновременные realtime connections    | 5 000–20 000 |

### Производная нагрузка

- 300 000 sessions/day.
- Peak-hour: 45 000 sessions/hour ≈ 12.5 session starts/s.
- Read average в peak-hour: ≈ 250 RPS; design burst: **750–1 000 RPS**.
- Write average в peak-hour: ≈ 25 RPS; design burst: **75–150 RPS**.
- Chat/realtime delivery не переводится в polling RPS; gateway должен выдерживать 20 тыс. connections и burst event fan-out.
- Media traffic идёт через object storage/CDN, не через API heap.

### Почему этого достаточно

100 тыс. DAU — не масштаб VK/Facebook/Telegram. Две stateless API-ноды, отдельный worker/realtime, PostgreSQL с индексированными keyset queries, Redis и object storage имеют достаточный запас, если нет full scans, embedded member arrays, synchronous fan-out и polling. Scale-out добавляется горизонтально на API/realtime/worker без изменения public contract.

### Performance budgets

| Операция                            |          p95 |             p99 |          Payload budget |
| ----------------------------------- | -----------: | --------------: | ----------------------: |
| Mine/directory                      |      ≤150 ms |         ≤350 ms |            ≤100 KB/page |
| Community detail                    |      ≤200 ms |         ≤450 ms |                 ≤100 KB |
| Feed/comments page                  |      ≤250 ms |         ≤600 ms | ≤250 KB excluding media |
| Command commit                      |      ≤400 ms |         ≤800 ms |              small JSON |
| Realtime publish after commit       |     ≤1 s p95 |        ≤3 s p99 | identifier/preview only |
| Home community projection freshness | ≤60 s normal | ≤5 min degraded |            10 summaries |

Для массовых notifications дополнительный target: 100 тыс. получателей за 5 минут требует не менее ~333 accepted deliveries/s с backpressure и provider quotas; HTTP-команда публикации не ждёт завершения fan-out.

### Availability and durability

- Read APIs: 99.9% monthly initially.
- Critical commands: 99.9%, zero acknowledged lost writes.
- RPO: 0 for committed PostgreSQL business state under normal node loss; backup/PITR RPO ≤5 min for regional disaster target.
- RTO: ≤60 min initially, validated restore/runbook.
- Outbox oldest age alert: warning >30 s, critical >5 min.
- Projection DLQ >0: actionable alert.

## 7. Index and query requirements

Minimum examples:

- memberships mine: `(tenant_id, user_id, status, pinned_at DESC, updated_at DESC, community_id)`.
- active member authorization: `(tenant_id, community_id, user_id)` primary/unique current row.
- directory: partial active index by `(tenant_id, updated_at DESC, id)` plus search index.
- feed: `(tenant_id, community_id, published_at DESC, id DESC)` partial visible.
- comments: `(tenant_id, post_id, created_at, id)`.
- reactions: unique `(tenant_id, post_id, user_id)` and count index only if measured.
- conversations: unique `(tenant_id, kind, context_id)`; messages `(tenant_id, conversation_id, sequence)`.
- outbox: unpublished/lease indexes already follow shared infrastructure.

Запрещены:

- offset pagination на mutable feed;
- `SELECT *` community с embedded members для списка;
- N+1 rank/member/logo calls;
- synchronous connections graph calculation на Home/directory;
- Redis как единственная копия unread, role, ban или message.

## 8. Frontend migration without visual redesign

Визуал можно перенести практически 1:1, но компоненты должны стать presentation layer.

### Proposed routes/modules

- `/communities`: mine + discovery shells;
- `/communities/:communityId`: overview/feed;
- `/communities/:communityId/members`;
- `/communities/:communityId/rating`;
- `/communities/:communityId/chat`;
- `/communities/:communityId/settings`.

Каждый route загружает только свой bundle и query. Старые визуальные части stories, graph, ranking, news, composer, chat переносятся как отдельные компоненты. Они не должны:

- строить actor/member identity;
- выбирать source/base URL;
- хранить canonical unread/role/membership;
- нормализовать десятки вариантов legacy payload;
- вычислять rating/graph business data;
- напрямую связывать communities с Viva identifiers.

### UI state rules

- URL/route хранит выбранное сообщество и tab.
- Server-state cache хранит pages с query keys и abort/cancellation.
- Form state локален feature component.
- Optimistic UI разрешён для reaction/read cursor только с rollback по stable error.
- Skeleton показывается сразу; empty, unavailable, forbidden и not-found — разные состояния.
- Все interactive cards имеют нормальную keyboard/focus semantics и deep links.

## 9. Миграция данных и переключение

### Phase 0 — freeze и inventory

1. Зафиксировать список всех live routes, Node-RED node IDs, Mongo collections/indexes, release SHA.
2. Зафиксировать feature inventory и визуальные snapshots каждого состояния.
3. Запретить новые community features в legacy, кроме срочных fixes.
4. Снять per-tenant/community counts, duplicates, invalid IDs, member role/status distribution, orphan posts/comments/reactions/chat/rating.

Exit gate: один подписанный source map, нет неизвестного write route.

### Phase 1 — canonical expand

1. Добавить canonical tables/constraints/indexes и OpenAPI для одного vertical slice.
2. Реализовать server principal/RBAC/idempotency/audit/outbox.
3. Исправить `memberRank` mapping и отвязать Community Home sync от Viva.
4. Добавить observability и load harness до feature activation.

Exit gate: `npm run check`, migration validation, contract tests, focused load baseline.

### Phase 2 — deterministic backfill

1. Reuse existing `integration.external_entity_map` UUID.
2. Импортировать communities/memberships/invites/posts/comments/reactions/chat/rating через staging и reject tables.
3. Не переносить raw PII/legacy actor snapshot как authoritative identity.
4. Нормализовать identities через explicit mappings; ambiguous rows — quarantine, не heuristic merge.
5. Media копировать в private storage content-addressed objects.

Exit gate: counts/checksums per tenant/community, owner invariant, no orphan active rows, media sample verification.

### Phase 3 — shadow reads, не mixed reads

1. Legacy остаётся write owner.
2. Canonical shadow строится через controlled importer/CDC/event capture.
3. API может сравнивать результаты server-side, но один user operation получает ровно один source/version.
4. Сравниваются memberships, roles, visible posts, reaction uniqueness, chat sequence, rating snapshot freshness.

Exit gate: agreed parity threshold несколько дней, zero P0 mismatch.

### Phase 4 — cohort cutover

1. Cutover unit: tenant или целое community aggregate, не отдельные поля.
2. Короткое read-only окно для final delta.
3. Атомарно переключить ownership/source router на `LOCAL_PRIMARY`/`LOCAL_ONLY`.
4. После переключения все writes только PostgreSQL; legacy становится read-only evidence.
5. Включать UI actions по feature flags только для cutover cohort.

Exit gate: browser → API → DB → outbox → projector → realtime/postcheck доказан для create/join/post/reaction/comment/chat/moderation.

### Phase 5 — scale and retire

1. Нагрузочный тест 1 000 read RPS, 150 write RPS, 20 тыс. realtime connections в agreed envelope.
2. 2–4 hour soak, hot-community scenario, worker lag/DLQ, Redis loss, one API node loss, broker outage/recovery.
3. Удалить legacy bridge только после client adoption и retention window.
4. Архивировать Node-RED routes и Mongo collections с backup/restore proof.

Capacity status до этой фазы: **NOT_ENOUGH_EVIDENCE**. Статические P0 и live flow topology доказаны; production cardinalities, index selectivity, cache hit ratio, real peak concurrency и end-to-end 100k capacity ещё не измерены.

## 10. Rollback rules

До первого local write rollback прост: отключить cohort flag и вернуть read routing на legacy после проверки compatibility.

После первого canonical local write **нельзя** просто вернуть legacy write owner: это создаст split brain и потерю новых данных. Допустимы только:

- rollback приложения на предыдущий совместимый image digest при сохранении PostgreSQL ownership;
- временное отключение конкретной команды/read-only mode;
- forward fix и replay outbox;
- отдельный, заранее спроектированный reverse migration — только как emergency procedure.

Каждый rollout требует backup, sequential nodes, smoke, owner/source read-back и tested rollback command.

## 11. План реализации по вертикальным срезам

### Wave A — P0 truth and directory

- Исправить rank mapping.
- Отвязать community Home sync от Viva/delegation/photo store.
- Canonical mine/detail/discovery reads.
- Source ownership/readiness metrics.
- Directory load tests и UI skeleton/error semantics.

### Wave B — membership commands

- Create/update/archive.
- Join/request/invite/leave.
- Roles, owner transfer, remove/ban.
- Idempotency, RBAC, audit, outbox, notification intents.

### Wave C — content/feed/media

- Post/comment/reaction lifecycle.
- Presigned media pipeline.
- Keyset feed projections and counters.
- Moderation reports/tombstones.

### Wave D — messaging/realtime

- COMMUNITY conversations.
- Durable sequence/read cursor.
- WebSocket authorization/resume.
- Inbox/Web Push triggers with preferences.

### Wave E — rating and discovery graph

- Canonical source events and versioned snapshots.
- Historical backfill/shadow parity.
- Connections/recommendations как отдельный bounded projection, не list side effect.

## 12. Acceptance gates

Фича не считается перенесённой, пока не выполнены одновременно:

1. OpenAPI contract + generated/typed SDK.
2. Server-derived principal и tenant isolation tests.
3. Idempotency conflict/replay/concurrency tests.
4. Transaction proves business + audit + outbox atomicity.
5. Keyset pagination tests under concurrent inserts.
6. Browser-rendered mobile/desktop journey с прежним визуалом.
7. Load baseline и query plan/index evidence.
8. Metrics/SLO dashboard, alerts, DLQ/runbook.
9. Backfill parity report и rollback rehearsal.
10. Никаких phone/Viva/legacy IDs в browser contract/logs.

## 13. Что не делать

- Не переносить `CommunitiesSection.tsx` в новый repo целиком.
- Не проксировать legacy write API из нового PadlHub API.
- Не делать независимый dual-write Mongo + PostgreSQL.
- Не смешивать canonical community с legacy members/feed/rating в одном response.
- Не вычислять graph/rating в browser или synchronous request.
- Не создавать отдельный микросервис на каждый community concern до измеренной необходимости.
- Не считать HTTP 200 от Tilda/Node-RED доказательством persistence/outbox/realtime.
- Не проводить bulk apply/backfill без dry-run, reject report, backup и explicit approval.

## 14. Проверки этого аудита

- Focused current-repo tests: 5 files, 12 tests — PASS.
- Draw.io structural validation: 0 errors, 0 warnings.
- Дополнительный executable probe подтвердил потерю `memberRank`.
- Community-specific tests в старом `src` не найдены.
- Production writes/backfill/deploy не выполнялись.

## 15. Архитектурное решение

Рекомендуется утвердить этот документ как basis для нового ADR «Full Communities social contour» и начать Wave A. Перенос визуала разрешён только через route-level components и новые contracts. Перенос старой runtime архитектуры, client identity, Node-RED fan-out и Mongo embedded model запрещён.

Статус readiness:

- визуальная база: **готова к повторному использованию**;
- canonical directory foundation: **частично готова, есть P1 defects**;
- canonical write contour: **не готов**;
- feed/chat/rating/moderation end-to-end: **не готов**;
- 100k DAU readiness: **не доказана до реализации Wave A–D и load/soak gate**.
