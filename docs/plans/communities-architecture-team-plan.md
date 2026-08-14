# План выработки архитектуры и команды модуля «Сообщества»

- Дата: 2026-08-03
- Статус: approved; Architecture Runway started
- Цель: спроектировать и перенести «Сообщества» в новый ЛК без переноса legacy-архитектуры
- Нагрузочный контур: 20–100 тыс. DAU, до 1 000 read RPS, 150 command RPS и 20 тыс. realtime connections в расчётном burst
- Входной аудит: [Полный архитектурный аудит](../audits/2026-08-03-communities-full-architecture-audit.md)
- Техническая схема: [Целевая архитектура](../architecture/communities-target-architecture.drawio)
- Организационная схема: [Команда и архитектурные ворота](../architecture/communities-delivery-operating-model.drawio)

## Implementation status

- 2026-08-03: пользователь утвердил старт по Recommended team и указанному плану.
- Week 1 Gate A discovery завершён потоками Product/Domain, Backend/Data и
  AppSec/SRE/Performance; решения P0-A…P0-G вынесены владельцу продукта без выдуманных defaults.
- Architecture Definition Pack, реестр ADR и domain/context map собраны; Gate A остаётся
  `NO-GO / DECISION_NEEDED` для команд, зависящих от неизвестных продуктовых правил.
- Первый доказанный P1 fix завершён: `memberRank` сохраняется в canonical membership response.
- Устранён P0 privacy gap: legacy community URL с `phone`/`clientId` больше не попадает в HTTP spans,
  а query-параметры редактируются в telemetry.
- Реализован безопасный walking skeleton `pin/unpin my membership`: PadlHub JWT actor, optimistic
  revision, idempotency, tenant transaction, audit, outbox, OpenAPI и SDK. Он включается только в
  canonical `local` mode и fail-closed в `legacy`/`mock`.
- Массовый перенос UI и команды create/join/invite/roles/content/chat/moderation не начинаются до
  закрытия Gate A неизвестных правил.
- 2026-08-03: владелец продукта утвердил `A3/B3/C3/D2/E2/F2/G3`; для REMOVED rejoin требуется
  разрешение, moderation control plane — ЦУП.
- 2026-08-04: content lifecycle уточнён: author action архивирует, а не удаляет; архивное тело и
  immutable revisions хранятся пять лет от архивирования, restore доступен 30 суток, авторское
  редактирование опубликованного материала не ограничено по времени. Former OWNER становится ADMIN,
  unban переводит в LEFT, emergency transfer требует двух сотрудников ЦУП, причины и audit event.
  Gate A переведён в `CONDITIONAL-GO`: каждый slice стартует только после закрытия собственных
  неизвестных, без временных defaults.
- 2026-08-03: create-community slice получил Definition of Ready: любой active verified principal
  с `communities.create`, стандартные квоты 3 ACTIVE owned / 1 create per rolling 24h, явный ЦУП
  override вне User API, утверждённая access matrix, три обязательных publishing preset и UUID-only
  contract с title/optional description.
- 2026-08-03: create-community vertical slice реализован end-to-end: capability guard,
  strict User API contract, concurrency-safe quotas, ACTIVE community + sole ACTIVE OWNER,
  idempotency/audit/outbox, expand-safe migration, OpenAPI and retry-safe typed SDK. ЦУП override
  остаётся отдельным Admin slice и не открыт из User API.
- 2026-08-03: canonical detail/discovery slice реализован с field-level privacy:
  strict PUBLIC/LISTED_PRIVATE/ACTIVE DTO, HIDDEN indistinguishable 404, server-derived join action,
  query-bound keyset cursor, tenant/RLS SQL, trigram indexes, OpenAPI/SDK и web route shell.
  Invite preview и public member summaries остаются fail-closed до своих контрактов.
- 2026-08-03: non-invite membership vertical slice собран end-to-end: own state,
  instant join, JOIN/REJOIN request, cancel and non-owner leave; canonical join request history,
  optimistic revisions, idempotency, tenant RLS, audit/outbox, User OpenAPI/SDK and web actions.
- 2026-08-03: existing ЦУП подключён к tenant-wide bounded JOIN/REJOIN queue через
  PadlHub Admin API. Read and decide permissions are split; approve/reject cannot accept actor,
  user, community, role or target state from the browser.
- 2026-08-04: DIRECT invite runway implemented end-to-end behind a disabled feature flag: reusable
  seven-day HMAC-derived link, hash-only storage, issuer eligibility, BANNED/PENDING guards,
  optimistic redemption/revoke, User OpenAPI/SDK, fragment-safe web preview and staff link manager.
  Product policy is closed: any ACTIVE OWNER/ADMIN may revoke; PENDING is not mutated; standard
  issue is capped at five active links and twenty successful rolling-24-hour issues per community;
  CUP creates only a one-use 24-hour community grant with
  `communities.invite.quota.override`, `reasonCode` and `ticketId`; the next over-quota issue by an
  ACTIVE OWNER/ADMIN consumes it. Activation remains blocked on implementation verification,
  PostgreSQL race tests and staging smoke tests.

## 1. Предлагаемое решение

Архитектуру следует выработать за **четыре недели architecture runway**, после чего продолжить
короткими вертикальными срезами. Не нужно сначала строить всю платформу и только затем показывать
продукт. К концу четвёртой недели команда должна иметь:

1. подписанную capability map и продуктовые правила;
2. workload model с hot-community сценариями;
3. каноническую модель данных, API и каталог событий;
4. threat model и authorization matrix;
5. результаты технических spikes по ленте, chat/realtime и массовому fan-out;
6. десять обязательных ADR с назначенными владельцами;
7. один работающий end-to-end walking skeleton;
8. утверждённый план миграции, наблюдаемости, нагрузочной приёмки и rollback.

После runway рекомендуемый состав способен вывести controlled beta за **18–24 недели от старта**, а
production GA — ориентировочно за **26–32 недели**. Это плановая оценка, а не обещание: срок зависит
прежде всего от окончательного scope ленты, чата, рейтинга, медиа и объёма очистки legacy-данных.

## 2. Что именно мы проектируем

«Сообщества» — не одна страница. Это шесть разных классов нагрузки и консистентности:

| Контур             | Возможности                                   | Требование к консистентности     | Основной риск                          |
| ------------------ | --------------------------------------------- | -------------------------------- | -------------------------------------- |
| Community Core     | создание, профиль, privacy, ownership         | strong                           | split brain, потеря владельца          |
| Membership Graph   | join/request/invite, role, ban, leave         | strong                           | обход прав, hot membership list        |
| Content & Feed     | post, comment, reaction, attachment           | strong write + eventual counters | unbounded reads и fan-out              |
| Messaging          | history, sequence, read cursor, realtime      | durable ordered history          | polling, gaps, hot channel             |
| Discovery & Rating | directory, search, recommendations, snapshots | eventual/versioned               | тяжёлый синхронный расчёт              |
| Trust & Safety     | report, case, action, appeal, audit           | strong/audited                   | необратимое действие без доказательств |

### Технические ограничения текущей основы, которые входят в runway

Новый ЛК уже даёт правильное направление, но capacity нельзя считать доказанной. В discovery
обязательно проверить и закрыть:

- database pool сейчас имеет общий `application_name` и фиксированный `max: 20` для разных
  процессов; connection budget и pool wait должны проектироваться отдельно для API/worker/realtime;
- production outbox publisher держит PG transaction и row locks во время Rabbit publisher confirm;
  leased publisher нужно квалифицировать crash/replay-тестами до community bursts;
- tenant loops и разные классы jobs живут в одном worker runtime, поэтому возможен межтенантный
  head-of-line blocking; нужны отдельные deploy roles внутри того же modular monolith;
- realtime runtime пока доказывает ticket authentication и `connection.ready`, но ещё не реализует
  authorized subscribe, fan-out, heartbeat, resume, gap recovery, draining и slow-client isolation;
- community directory query plans, индексы и pool saturation пока не доказаны на 4 млн memberships
  и skewed hot-community dataset;
- текущие alerts сосредоточены вокруг outbox/DLQ; нужны API, PostgreSQL, consumer lag, Redis,
  realtime и object-storage SLI.

Эти пункты не означают смену базового стека. Они определяют обязательные spikes и production gates.

Первое архитектурное решение — утвердить, что входит в первую GA. Рекомендуемый scope:

- **GA-1:** mine/discovery/detail, создание и управление, membership, роли, лента, комментарии,
  реакции, изображения, moderation, notifications, community chat, read cursor;
- **GA-1.1:** рейтинг с versioned snapshots и расширенная аналитика;
- **позже по измерениям:** единая персональная лента, сложный recommendation graph, видео-транскодинг,
  thread tree большой глубины, federation и публичный bot platform.

## 3. Как использовать best practices рынка

Мы берём проверенные инварианты, но не копируем hyperscale-стек компаний с миллиардами пользователей.

| Рыночная практика                        | Что она решает                                                                    | Адаптация для PadlHub                                                              | Что не копируем сейчас                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Bounded server-side social graph queries | не передавать целые списки связей и не строить граф в клиенте                     | memberships как отдельные строки; keyset API; отдельные projection endpoints       | Meta TAO и глобальный graph cache                      |
| Strong core, eventual projections        | права и membership не могут быть «примерно верными», counters/feed могут догонять | одна PG transaction для state + audit + outbox; version/freshness в projections    | распределённые cross-region транзакции                 |
| Fan-out-on-read для community feed       | публикация не создаёт N копий по числу участников                                 | один post/feed entry, индекс по community/time/id; уведомления отдельно            | fan-out-on-write на 100 тыс. участников в HTTP request |
| Durable history + ephemeral realtime     | WebSocket может теряться, история и unread — нет                                  | PG sequence/read cursor; WS доставляет hint; REST восполняет gap                   | Redis Pub/Sub как единственная история                 |
| Hot-partition awareness                  | одно большое сообщество не должно положить весь контур                            | лимиты, keyset, backpressure, sequence buckets/partitioning только после evidence  | Cassandra/Scylla как стартовая база                    |
| Idempotent commands                      | сетевой retry не дублирует create/join/post/message                               | `Idempotency-Key`, request hash, сохранённый result, inbox dedupe                  | retry mutations на разные write endpoints              |
| Deny-by-default authorization            | защита закрытых сообществ и moderator actions                                     | actor только из JWT; tenant + membership + capability проверяются на каждый запрос | client-supplied actor/role/phone                       |
| Broker ack, bounded retry, DLQ           | side effect не теряется и не ретраится бесконечно                                 | outbox; RabbitMQ publisher confirm/manual ack; delivery limit и DLQ                | «exactly once» как недоказуемое обещание               |
| SLO/error-budget driven delivery         | скорость разработки соотносится с надёжностью                                     | несколько user-centric SLI; canary блокируется при burn rate                       | бессмысленные 100% availability targets                |

### Практические решения на старте

- PostgreSQL — source of truth для community, membership, content, messages, read cursors, audit и
  outbox.
- RabbitMQ — доставка событий между `apps/api`, `apps/worker` и `apps/realtime`; consumers
  идемпотентны, имеют manual ack, ограниченный prefetch, delivery limit и DLQ.
- Redis — cache, rate limit, presence и connection routing. Потеря Redis не теряет business state.
- S3-compatible storage/CDN — медиа; API выдаёт staged presigned upload, worker проверяет и
  финализирует объект.
- Модульный монолит остаётся одним deployable набором процессов и общих доменных пакетов.
- Search сначала PostgreSQL full-text/trigram. Отдельный search engine вводится только после
  измеренного провала качества или latency.
- Partitioning таблиц вводится по размеру и query plans, а не «на будущее». Схема и ID должны
  позволять это сделать без смены public API.

### Доменные инварианты, которые фиксируем сразу

- Membership имеет явную state machine `invited → requested/pending → active → left/removed/banned`;
  текущее состояние дополняется audit/history, а не перезаписывает доказательства перехода.
- В сообществе ровно один owner. Передача ownership — одна command transaction под lock/version;
  последний owner не может просто выйти или удалить себя.
- Authorization role и спортивный/display rank — разные поля и разные модели. В GA достаточно
  `OWNER / ADMIN / MODERATOR / MEMBER` + capability matrix без произвольных resource overrides.
- Feed v1 — reverse chronological с opaque keyset cursor и snapshot watermark, чтобы concurrent
  insert не давал дублей и пропусков. Ranking включается отдельным ADR после качественной telemetry.
- Message получает server sequence и client-generated `clientMessageId`; edit создаёт revision,
  delete — tombstone по retention policy. WebSocket event всегда содержит sequence.
- `last_read_seq` обновляется монотонно как `max(old, new)`; manual «пометить непрочитанным» —
  отдельное состояние. Не создаём boolean на каждую пару message × user.
- Moderation разделяет deterministic synchronous rule, async signal и human case. Permanent ban не
  применяет внешний ML/provider; emergency controls включают slow mode, invite freeze и read-only.
- Media notification считается at-least-once и может прийти не по порядку; finalize защищён revision
  и идемпотентностью. Публикация может ссылаться только на media в состоянии `READY`.
- Push является hint, а не подтверждением delivery/read. Канонические inbox/unread остаются на
  сервере; провайдерские retry/quotas не блокируют command transaction.
- Cache-aside имеет bounded TTL, negative caching, invalidation и request coalescing для hot keys;
  membership revision ограничивает время жизни authorization cache.

## 4. Продуктовые решения до фиксации архитектуры

Product Owner обязан закрыть эти вопросы в течение первой недели. Неопределённость по ним меняет
data model, permissions и стоимость эксплуатации.

1. Какие сообщества бывают: public, discoverable-private, invite-only, hidden?
2. Какие статусы membership нужны: requested, invited, active, muted, left, removed, banned?
3. Кто может назначать owner/admin/moderator и как происходит передача ownership?
4. Может ли последний owner выйти или быть заблокирован?
5. Кто видит список участников, историю постов, чат и рейтинг?
6. Нужны ли approval очереди для участников и публикаций?
7. Что значит удалить post/comment/message: hard delete, tombstone или moderator hide?
8. Можно ли редактировать сообщение, сколько времени и хранится ли revision history?
9. Каковы retention и legal/privacy правила для текста, медиа, audit и удалённых аккаунтов?
10. Какие события создают push/inbox notification и какие quiet-hour/preferences обязательны?
11. Что является источником рейтингового факта и когда рейтинг считается опубликованным?
12. Нужны ли в GA общий чат, отдельные каналы, threads, mentions, pin и attachments?
13. Какие лимиты допустимы: communities/user, members/community, post/message rate, media size?
14. Каков moderation SLA и кто является человеком, принимающим спорное решение?

Результат — одна capability/permissions matrix с состояниями UI, API command, policy и audit event.

## 5. Architecture runway: четыре недели

### Неделя 1 — продукт, домен и нагрузка

Работы:

- event-storming по create → discover → join → publish → discuss → moderate → leave/delete;
- feature inventory старого ЛК: keep/change/drop, включая все empty/error/forbidden states;
- определение aggregate boundaries и одного write owner для каждого домена;
- workload model: normal, launch burst, hot community, mass notification, abusive client;
- data classification, privacy/retention и первичный abuse/threat workshop;
- фиксация SLI/SLO и cost envelope.

Артефакты:

- capability map;
- state/transition и permissions matrix;
- source-of-truth map;
- workload model v1;
- список открытых решений с DRI и deadline.

**Gate A:** Product, Architecture, Security, QA и SRE используют одни названия состояний; P0-вопросов
без владельца и даты нет.

### Неделя 2 — контракты и модель данных

Работы:

- canonical ERD с tenant constraints, ownership invariant, uniqueness и lifecycle timestamps;
- User/Public/Internal OpenAPI, stable errors, cursor envelope и forbidden fields;
- command catalog с idempotency, authorization, version/`If-Match`, audit и outbox;
- event catalog с schema version, ordering key, producer, consumer и replay policy;
- feed, chat sequence/read cursor, notification и rating projection models;
- migration/reconciliation design: staging, reject, mapping, shadow, cutover unit.

Артефакты:

- ADR 01–06 в состоянии proposed;
- OpenAPI skeleton и fixtures;
- schema/index draft с representative queries;
- threat model и abuse cases;
- migration map legacy → canonical.

**Gate B:** для каждого GA-сценария известны request, transaction boundary, canonical rows, event,
projection, authorization и rollback behavior.

### Неделя 3 — технические spikes

Spikes должны быть удаляемыми, но исполняемыми и измеримыми:

1. **Feed:** 1 млн posts в synthetic dataset, community с 100 тыс. members, keyset pagination,
   concurrent inserts и moderation tombstones.
2. **Membership:** concurrent join/ban/leave/owner-transfer, уникальность active membership и RLS
   между двумя tenant.
3. **Messaging/realtime:** durable sequence, 2 тыс. connections в одном hot community, reconnect и
   REST gap recovery.
4. **Fan-out:** 100 тыс. notification intents, backpressure, preferences, retry, poison event и DLQ.
5. **Media:** presigned upload, content limits, quarantine, finalize/delete и orphan cleanup.
6. **Migration:** representative legacy extract, deterministic UUID mapping, reject report и повторный
   идемпотентный import.

**Gate C:** query plans и результаты теста укладываются в performance budgets либо ADR честно
фиксирует изменение решения. «Кажется, выдержит» не является результатом spike.

### Неделя 4 — решения и walking skeleton

Работы:

- утвердить ADR и удалить конкурирующие draft-решения;
- реализовать один вертикальный путь `mine/detail` через Web → SDK → API → PG → telemetry;
- реализовать одну тестовую command transaction `state + audit + outbox` и projector;
- подготовить dashboards, runbook, load harness и migration dry-run template;
- разбить дальнейшую работу на end-to-end slices, а не frontend/backend layers.

**Gate D:** Architecture Council подписывает baseline; walking skeleton проходит contract,
tenant-isolation, integration, browser и observability checks.

## 6. Обязательный набор ADR

| ADR  | Решение                                        | Accountable              | Критерий принятия                            |
| ---- | ---------------------------------------------- | ------------------------ | -------------------------------------------- |
| C-01 | scope и bounded contexts                       | Product + Architect      | нет общей «community service» свалки         |
| C-02 | identity, RBAC/ReBAC и capabilities            | AppSec + Backend Lead    | actor не приходит из клиента                 |
| C-03 | canonical data model и consistency map         | Architect + Data BE      | invariants доказаны constraints/tests        |
| C-04 | command/idempotency/audit/outbox boundary      | Backend Lead             | replay/concurrency tests                     |
| C-05 | feed/query/pagination/counter strategy         | Content BE               | hot-community query plans                    |
| C-06 | messaging sequence, cursor и realtime recovery | Realtime BE              | disconnect не теряет историю/unread          |
| C-07 | media lifecycle and safety                     | Platform + AppSec        | quarantine и cleanup доказаны                |
| C-08 | moderation, privacy, retention, appeal         | Product + Trust & Safety | каждое действие audited/reversible где нужно |
| C-09 | SLO, capacity, cache и partition triggers      | SRE                      | load/soak/failure gates формализованы        |
| C-10 | migration, ownership switch и rollback         | Architect + Data BE      | нет independent dual-write/split brain       |
| C-11 | frontend routes, state ownership, visual reuse | Frontend Lead            | нет god-component/client business rules      |

### Формат принятия решения

Каждый ADR содержит context, forces, 2–3 реальных alternative, decision, rejected options,
consequences, evidence, expiry/revisit trigger и owner. RFC review длится не более двух рабочих дней.
При отсутствии консенсуса решение принимает accountable DRI; Architecture Council не голосует
бесконечно.

## 7. Команда

### Рекомендуемый состав

| Роль                              |      FTE | Уровень        | Зона ответственности                                            |
| --------------------------------- | -------: | -------------- | --------------------------------------------------------------- |
| Product Manager / Product Owner   |      1.0 | senior         | scope, semantics, moderation policy, acceptance                 |
| Staff Engineer / Domain Architect |      1.0 | staff          | architecture DRI, domain boundaries, ADR, migration ownership   |
| Backend Engineer — Core/Data      |      1.0 | senior         | PG model, membership, authorization, transactions               |
| Backend Engineer — Content/Async  |      1.0 | middle+/senior | feed, media, outbox, projections, notifications                 |
| Backend/Realtime Engineer         |      1.0 | senior         | messaging, sequence, WebSocket, delivery recovery               |
| Frontend Lead                     |      1.0 | senior         | routes, state ownership, SDK, performance/accessibility         |
| Frontend Engineer                 |      1.0 | middle+/senior | visual migration and vertical slices                            |
| Data/Migration Engineer           |      1.0 | senior         | legacy profiling, mapping, backfill, quarantine, reconciliation |
| QA Automation / Performance       |      1.0 | senior         | contract, concurrency, E2E, load/soak and independent gates     |
| Platform/SRE                      |      1.0 | senior         | environments, observability, capacity, backup/restore, rollout  |
| Product Designer/Researcher       |      0.5 | shared         | visual inventory, states, usability, design QA                  |
| AppSec / Privacy                  | 0.25–0.5 | shared         | threat model, authorization, abuse/privacy review               |
| Data/Analytics                    | 0.25–0.5 | shared         | event taxonomy, product analytics, rating validation            |
| Trust & Safety / Support owner    | 0.25–0.5 | shared         | moderation operations, escalation and appeal workflow           |

Итого: **10 core FTE + 1.25–2 shared FTE**. Архитектор остаётся hands-on и не превращается в
отдельный согласующий слой. QA имеет независимое право выставить `NOT_ENOUGH_EVIDENCE` или NO-GO.
Tech Lead резервирует примерно 30–40% времени на ADR, cross-module review и устранение архитектурных
расхождений; он не должен быть единственным исполнителем всех critical-path backend-задач.

### Допустимые варианты

| Вариант     | Состав              | Реалистичный срок до controlled beta | Компромисс                                                       |
| ----------- | ------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Lean        | 6–7 core + shared   | 36–42 недели                         | один поток, урезанный scope, высокий bus factor                  |
| Recommended | 10 core + shared    | 18–24 недели                         | два параллельных потока + постоянная migration line              |
| Accelerated | 12–13 core + shared | 16–20 недель                         | требует второго TL и жёсткой ownership map; дальше отдача падает |

Не рекомендуется просто добавлять frontend-разработчиков: критический путь проходит через
продуктовые правила, data model, authorization, migration и operational evidence.

## 8. Организация работы и RACI

| Решение/результат                 | A             | R                  | C                       | I            |
| --------------------------------- | ------------- | ------------------ | ----------------------- | ------------ |
| GA scope и продуктовые правила    | Product       | Product + Designer | Architect, T&S, Support | команда      |
| Domain/data/API architecture      | Architect     | Backend leads      | SRE, AppSec, QA         | Product      |
| Authorization/threat model        | AppSec        | Core BE            | Architect, QA           | Product      |
| SLO/capacity/DR                   | SRE           | SRE + QA Perf      | Architect, Backend      | Product      |
| Visual reuse и frontend structure | Frontend Lead | FE team + Designer | QA, Architect           | Product      |
| Migration/cutover                 | Architect     | Core/Data BE + SRE | QA, Product             | Support      |
| Release verdict                   | Product       | SRE + QA           | Architect, AppSec       | stakeholders |

Ритм:

- daily 15 min по blockers, не status theatre;
- два раза в неделю 45 min Architecture Council: Architect, Backend/FE leads, SRE, QA, AppSec;
- еженедельный end-to-end demo на synthetic/canonical data;
- еженедельный risk review: top-10 risks, owner, evidence, mitigation date;
- раз в две недели product/technical scope checkpoint по реальным burn-up и SLO evidence.

После Wave A команда работает двумя потоками с общим integration branch discipline:

- **Core/Content:** membership, permissions, feed, moderation, media;
- **Messaging/Experience:** frontend routes, chat/realtime, unread, notifications.

Rating/discovery подключаются после стабилизации source events. Один aggregate в конкретный момент
имеет одного владельца; две команды не редактируют один transaction boundary параллельно.

## 9. Delivery roadmap после architecture runway

| Wave                         |                     Длительность | Результат                                   | Release gate                       |
| ---------------------------- | -------------------------------: | ------------------------------------------- | ---------------------------------- |
| 0. Runway                    |                         4 недели | ADR, contracts, spikes, walking skeleton    | Gate D                             |
| A. Truth & Directory         |                         3 недели | mine/discovery/detail, Home, source metrics | read load + visual parity          |
| B. Membership                |                         4 недели | create/edit/join/invite/roles/ban/audit     | race/security/idempotency          |
| C. Content & Moderation      |                         5 недель | posts/comments/reactions/media/cases        | hot feed + abuse paths             |
| D. Messaging & Notifications | 5 недель, частично параллельно C | durable chat/realtime/unread/push           | reconnect/fan-out/soak             |
| E. Rating & Migration        |                         4 недели | versioned rating, backfill, shadow parity   | reconciliation + cutover rehearsal |
| F. Hardening & Cohorts       |                       3–5 недель | restore, chaos, canary, operational handoff | GA checklist                       |

План не должен превращаться в 24 недели до первого пользовательского результата. Read-only Wave A
можно показать ограниченной группе уже примерно на 7-й неделе, membership — на 11-й. Write-функция
включается только когда весь её путь канонический.

## 10. Scale и production acceptance

### Расчётный envelope

| Показатель                |                                             Цель теста |
| ------------------------- | -----------------------------------------------------: |
| DAU model                 |                                                100 000 |
| Burst reads               |                                              1 000 RPS |
| Burst commands            |                                                150 RPS |
| Realtime connections      |                                           20 000 total |
| Hot community realtime    |                    8 000–10 000 concurrent connections |
| Hot community size        |                 100 000 active/history membership rows |
| Mass notification         |   100 000 intents, drain ≤5 min при доступном provider |
| Production-shaped fixture | 500 тыс. users, 10 тыс. communities, 4 млн memberships |
| Content corpus            |      ≥5 млн posts и skewed comments/reactions/messages |

### Предварительные SLO

- read availability: 99.9% monthly;
- acknowledged canonical write durability: zero lost committed writes;
- directory p95 ≤150 ms, detail ≤200 ms, feed ≤250 ms;
- command commit p95 ≤400 ms;
- realtime hint after commit p95 ≤1 s, при gap доступен REST recovery;
- outbox age warning >30 s, critical >5 min;
- RPO backup/PITR ≤5 min для disaster target, RTO ≤60 min, оба подтверждены rehearsal.

### Обязательные тесты

1. Baseline с production-like cardinality и skew, не с равномерными 1 000 строками.
2. Step test до saturation и выше, чтобы знать degradation curve и shedding behavior.
3. Spike: login/reconnect storm, viral post, 100 тыс. notification intents.
4. 8-hour pre-beta soak и 24-hour pre-100% soak с измерением memory, connections, DB bloat,
   autovacuum, queue lag и cache churn.
5. Hot-community isolation: один tenant/community не нарушает global SLO.
6. Redis loss/restart: деградация cache/presence без потери прав, сообщений и unread.
7. RabbitMQ outage/recovery: API commits сохраняются в outbox; replay не дублирует effect.
8. Worker poison event: ограниченный retry → DLQ → replay после fix.
9. API/realtime instance loss и broker leader election.
10. PostgreSQL restore/PITR плюс проверка counts, invariants и unpublished outbox.
11. Migration dry-run, delta catch-up, cohort cutover и rollback rehearsal.

**GO** возможен только при выполнении SLO в agreed envelope, отсутствии P0 security/correctness,
прошедшем restore и наличии дежурного runbook. До этих доказательств статус масштаба —
`NOT_ENOUGH_EVIDENCE`, даже если demo визуально работает.

## 11. Definition of Done вертикального среза

Срез готов только когда есть:

- утверждённое правило и acceptance examples;
- OpenAPI и typed SDK;
- server-derived identity/tenant/permission checks;
- idempotency/concurrency/tenant-isolation tests для command;
- atomic business state + audit + outbox;
- bounded keyset reads и query-plan evidence;
- browser-rendered mobile/desktop path с прежним визуалом;
- loading/empty/forbidden/not-found/degraded states;
- metrics, traces, structured/redacted logs, alert и runbook;
- migration/parity evidence, feature flag и tested rollback behavior;
- focused tests и `npm run check`.

## 12. Что намеренно не строим на первом этапе

- fleet микросервисов по одному на feed/chat/rating;
- Kafka event platform без измеренной потребности в long-retention multi-consumer log;
- Cassandra/Scylla/TAO-подобное graph storage;
- Elasticsearch только ради простого directory search;
- per-user копии каждого community post;
- polling chat/feed и client-local canonical unread;
- embedded массивы всех участников в community document/response;
- client-supplied actor, role, phone или Viva ID;
- independent dual-write в legacy Mongo и PostgreSQL;
- автоматическое table partitioning без size/query-plan trigger;
- обещание exactly-once вместо at-least-once delivery + idempotent effect.

## 13. Первые десять рабочих дней

1. Назначить Product Owner, Architecture DRI, Backend/FE leads, QA gatekeeper и SRE owner.
2. Провести kickoff и согласовать GA-1 capability list.
3. Закрыть 14 продуктовых вопросов из раздела 4.
4. Зафиксировать legacy feature/state/data inventory и запретить расширение legacy scope.
5. Собрать workload inputs: community/member/post/message/media cardinalities и реальные пики.
6. Провести event-storming, threat/abuse workshop и SLO workshop.
7. Создать ADR C-01…C-11 с владельцами и review deadlines.
8. Подготовить ERD/OpenAPI/event catalog drafts.
9. Поднять synthetic 100k-DAU dataset generator и первые feed/membership spikes.
10. На Gate B принять одно из решений: продолжить выбранный baseline, изменить спорный ADR или
    уменьшить GA scope. Переход к массовому UI coding до Gate B запрещён.

## 14. Источники рыночных практик

- Meta Engineering, [TAO: The power of the graph](https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/) — bounded server-side graph access и проблемы client-side whole-edge retrieval.
- Meta Engineering, [RAMP-TAO](https://engineering.fb.com/2021/08/18/core-infra/ramp-tao/) — необходимость stronger semantics для связанных изменений поверх eventual graph store.
- Meta Engineering, [Threads infrastructure](https://engineering.fb.com/2023/12/19/core-infra/how-meta-built-the-infrastructure-for-threads/) — разделение canonical graph state, counters, feed и search projections.
- Discord Engineering, [How Discord stores trillions of messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) — time-sortable IDs, channel/time partitioning и hot-partition lessons.
- Discord Engineering, [Maxjourney](https://discord.com/blog/maxjourney-pushing-discords-limits-with-a-million-plus-online-users-in-a-single-server) — отдельное тестирование крупнейшего hot community и устранение per-community bottlenecks.
- OWASP, [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — least privilege, deny by default и permission check на каждый запрос.
- Stripe API, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — безопасный retry mutation по key + request/result record.
- RabbitMQ, [Consumer acknowledgements and publisher confirms](https://www.rabbitmq.com/docs/next/confirms) и [Quorum queues](https://www.rabbitmq.com/docs/4.2/quorum-queues) — ответственность publisher/consumer, bounded redelivery и DLQ.
- Redis, [Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/) — Pub/Sub имеет at-most-once delivery и не заменяет durable history.
- PostgreSQL, [Table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — partitioning оправдан для действительно больших таблиц и измеренных access patterns.
- Google SRE, [Service Level Objectives](https://sre.google/sre-book/service-level-objectives/) и [Addressing cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) — user-centric SLI, percentiles, error budget, load до capacity limit и overload protection.

## 15. Решения, которые требуется утвердить сейчас

1. Принять **Recommended team: 10 core FTE + shared specialists** как базовый вариант.
2. Выделить четыре недели на architecture runway с Gate A–D.
3. Зафиксировать modular-monolith/PostgreSQL/outbox/RabbitMQ/Redis/S3 baseline.
4. Утвердить GA-1 scope либо явно отложить chat или rating, если срок важнее полноты.
5. Назначить Product Owner и Architecture DRI; без этих двух ролей план не стартует.
6. Разрешить перенос визуала только на новые route-level components и canonical API.
7. Не начинать legacy write proxy/dual-write как «временное» решение.
