# LK2 R1 — зависимости и критический путь

## Android tournament checkpoint — 2026-11-01

CUP#64 → LK2#5293041f0d9 (fullCI/iOSgreen) → Android#5304406a3b2 (LOCAL/review;CIpending) → approved native build integration#526 and device acceptance. iOS tournament capability is a separate bounded consumer. Android changes overlap pending TRAINING in App/auth-gateway/MobileApp/native-api-fetch/AndroidSessionPolicy; only the approved integration owner resolves them. No existing integration request is bypassed.

## Community message prerequisite — 2026-11-01

Durable LK community message owner/commit receipt → stable authenticated message read contract → LK2 Web/native send and original-key recovery → realtime/unread/reconnect and device acceptance. Existing station membership packets do not supply this message owner. Tournament chat also needs a concrete canonical membership consumer; the database enum alone is insufficient.

## Concrete consumer dependency — 2026-11-01

CUP#64 `9d728414` → LK2#529 `40d450c0` Web/API/0109 consumer (LOCAL/review accepted; corrected-head fullCI41251823614 SUCCESS) → compatible native consumers → coordinated runtime and device acceptance. Migration0109 follows0108 and retains the operation journal on rollback. #529 is based on#528; it supplies no authority or workaround for the pending#528/#525 local integrations. Paid/provider tournament ownership remains a separate prerequisite.

## New bounded P0 paths — 2026-11-01

1. CUP#61 preparation → #62 canonical gender → **#64 LOCAL_ONLY owner (CI41246247607 SUCCESS)** → LK2 authenticated tournament command/read/recovery consumer → native journey and tournament membership acceptance. Provider-backed and monetary paths require separate attributable owner/compensation contracts; do not downgrade them into LOCAL_ONLY.
2. LK#273 nonbinding quarter observation + **CUP#65 publication4/target2 proof (LOCAL and CI41247998877 accepted)** → strict schema4 projector/readiness and bounded FULL_RECONCILIATION → authenticated LK target producer → original-CREATE durable owner/reserve/receipt → LK2 CREATE consumer. Preserve every old instance's purchase-time policy. A new publication clears the reconciliation fence; replaying INITIAL_FULL is not a checkpoint refresh. Existing sale-binding accepts trusted payment readback and is not itself a provider purchase writer.

The quarter descriptor is an approved mapping, not a live provider observation. The full authoritative instance snapshot still requires endpoint/pagination/normalization/payment/identity evidence. Implementing schema4 support does not authorize importing a real snapshot, buying a subscription or changing a flag.

Updated quarter chain: #65 `5812113c` fullCI41247998877 SUCCESS → #66 `5eb4fe04` bounded instance reconciliation (LOCAL/review accepted, CI41248667293 SUCCESS, including full typecheck/build/artifact gates and the actual Mongo reconciliation/race fixture) → authoritative snapshot and authenticated LK producer → durable original-CREATE owner/recovery/receipt → LK2 CREATE. Sale/import concurrency is serialized by the existing projection fence; mixed old writers are not supported and must be drained before activation.

Further SOURCE audit: LK has no approved clientRefHash handoff; CUP computes it from verified identity and intentionally omits it from runtime-context. Current intake UUID-only configured tenant and CUP actor tenantKey are different namespaces. The next coordinated CREATE packet must derive actor/tenant/hash inside a versioned variant of the existing CUP intake, preserve context privacy, and connect it to an actual LK CREATE owner. Existing CREATE prospective target has null base price, old policy gate requires60/90/120, and timeout/409 room-time lookup cannot attribute creation. Pin the original quarter tuple and persist the ID from the original successful provider response; ambiguous creation remains UNKNOWN without a second POST or adoption of a found exercise.

## Station critical path — 2026-11-01

`LK#275 + CUP#63 → LK#276 → LK2#527/#528 physical CI → reviewed0108 migration/signing/coordinated writer package → separately approved runtime/device acceptance`.

LK#275/#276 and CUP#63 CI are green. #527 corrected head3143ffbe has fullCI41244545169 SUCCESS (managedJOIN PG10/10, required27physical+8guards zeroSKIP). #52826c5ceaa is source-reviewed with54 LOCAL cases, but needs exact approved local synchronization with parent3143 before PR CI can start. This is independent of the still-pending local #525 update request; no merge is inferred from a development request. All production transitions remain separately gated.

Training uses authoritative providerStudioId from its verified original capsule and validated receiptId as generation. It does not depend on GAME court-binding0105. Legacy NULL and pre-adoption GAME snapshots stay excluded; no retrofit/backfill. Current subscription training actor/target fence remains until a real training LEAVE/rejoin contract exists.

## Текущий dependency-aware critical path

1. Source-only merge/flag cycle #511 завершён: mainCI41230249442 success, delivery41231241175 SKIPPED/steps=[], true восстановлен18:50:31 UTC; остальные candidates интегрировать только после отдельного exact-head разрешения. Green CI и source merge не разрешают публикацию/deploy.
2. CUP#60 → LK#267 → LK2#515: accepted source/physical CI managed JOIN; отдельная совместная PROVIDER/native acceptance остаётся.
3. LK#269 → LK#270 → LK2#519 → #521: FREE/SERVICE SELF и restrictive terminal non-dispatch recovery. #521currente1d781 CI41234847565/native41234847625 SUCCESS, SELF physicalPG9/9. Затем native/provider acceptance.
4. #517 mapping0105 → LK#273 fixed-quarter preparation (source/CI green) → trusted server producer и versioned actor/draft-bound CUP target/preflight/reserve → original-create owner/receipt → LK2 CREATE. Existing v1/LK1 semantics сохраняются; проверить actual applied1/4 benefit после daily-limit policy. Nonbinding observation/hash не заменяет producer authority или lost-ACK attribution.
5. LK#271 → LK2#5200107 → #524477404e7: Web/API source/CI green, включая6physicalPG; Android catalogue/registration#524477404e7 source/fullCI41237803621/native41237803616 SUCCESS; отдельный #52630598d97 AndroidCI41238685334 подтвердил actual unsignedAPK и16JVM, егоfullCI41238685061 SUCCESS:7411passed/126skipped+PG4/4. Далее device и owner/provider capacity acceptance. CUP-managed/paid/trial/LEAVE отдельны; CREATE не prerequisite этой цепочки.
6. CUP#61 fresh nonbinding owner preparation → CUP#62 authoritative actor gender + MALE/FEMALE check/MIXED unrestricted (source/physicalMongoCI41240145187 green) → exact owner admission/capacity/WAITLIST/original generation → LK2 tournament consumer → tournament chat membership. Нельзя выбрать LK writer по отсутствующей custom link или dual-write CUP/LK roster.
7. LK1 monetary commands уже существуют. Их original-booking/generation/options/CAS/readback → attributable payment/refund/credit evidence → bounded LK2 pending/settled consumer → separately approved financial acceptance. Booking cancellation/REQUESTED не доказывают деньги. Затем solo-organizer cancellation; bulk scope не подразумевается.
8. Одно official community per station + automatic membership после confirmed game/training registration: existing CUP STATION binding + exactly-one selection/write owner → event/generation-fenced membership producer → permission-safe chat/read/unread/native entry. Pending booking не считается вступлением; support chats не заменяют community. CANCEL сохраняет membership; voluntary leave запрещает replay того же факта, новая confirmed registration может вернуть; REMOVED/BANNED не возвращаются автоматически.
9. #516 → #518 synthetic iOS native5/5 уже CI verified; следующий уровень — physical device/real session/push. #522ada66c50 CI41233392220 подтвердил27 ранее skipped game lifecycle/PG/Rabbit physical cases +8guard, zero skips и cleanup только собственных fixtures. #523f5c33149 добавил8notification physical cases, CI41235695070 SUCCESS/zero skips. Общий device/provider E2E gate остаётся.
10. #525eb993ff6 — source integration четырёх frozen green heads #517/#521/#520/#522, LOCAL226 +typed closure passed, integratedCI41236564284 SUCCESS:7497passed/126skipped, frozenPG4/4; #523notification и#524Android companion остаются отдельно. После green exact tree потребуется отдельное source-only merge authority. Затем immutable package → approved staging/provider/device acceptance → signing/store/restore evidence → новое GO/NO-GO → отдельные owner approvals на каждый live transition.

## Исторические схемы и прежние checkpoint

Уточнение B03 после проверки CUP#61/LK#273: готового authoritative dictionary artifact→publication→prospective CREATE producer нет. `annual-subscription-policy-v2-candidate.ts` создаёт candidate revision с `dictionaryEvidenceRef:null`; publication проверяет только формат evidence reference, runtime сравнивает revision strings. Копирование revision из policy в target не доказывает station/direction4588/type1613 mapping. Текущий `LK_NODE_RED_ANNUAL_BOOKING_V1` publication adapter разрешает FREE_ENTITLEMENT. Это не требует нового discount mode: возможен target с базой wholePrice/4 и FREE_ENTITLEMENT только на одну organizer booking. Пока отсутствует immutable связь divisor4/selector/price/booking/generation в reserve и recovery; zero price не доказывает покрытую долю. Применять PARTIAL1/4 к уже разделённой базе нельзя. LK1 выбирает2или4доли и допускает1или2списания visits в зависимости от длительности; ни capacity, ни count сами не доказывают1/4. До CUP quarter preflight/reserve нужны проверяемый dictionary artifact и эта точная target/receipt связь, без ослабления legacy adapter. #273 остаётся завершённым nonbinding observation; новый неиспользуемый intake не создаётся.

Ниже сохранён исходный dependency audit. Актуальные product decisions, heads и завершённые source результаты — в списке выше и [READINESS](R1-READINESS.md); старые pending формулировки не являются текущими решениями.

## Критический путь

```mermaid
flowchart TD
  A[Аудит main и residual PR delta] --> B[Actor / target / policy / usage contract]
  B --> C[Canonical CREATE owner + JOIN parity]
  B --> D[Paid cancellation / refund compensation]
  B --> E[Existing training / tournament owners and consumers]
  C --> M[Native command and payment handoff]
  D --> M
  E --> M
  A --> S[Social membership / reconnect / iOS consumer]
  A --> P[APNs / FCM / campaigns acceptance]
  A --> F[Signing + dependency triage + release custody]
  A --> Q[Required E2E harness without silent skips]
  M --> U[Cross-repo physical DB / sandbox / device acceptance]
  S --> U
  P --> U
  F --> U
  Q --> U
  U --> G[Production eligibility review + frozen package]
  G --> H[Owner approval of exact release target/package]
  H --> R[Controlled rollout / store transitions]
```

Коммерческий путь: **B02 → B03/B04 → B06 → B10 → B01/B11 → owner decision**. Existing-target B05 training/tournament развивается от своего actor/owner contract параллельно CREATE и monetary refund; их завершение не является prerequisite для nonmonetary registration. Signing/B09 и social/push B07/B08 идут параллельно и должны завершиться до device acceptance; B12 high finding уже устранён на main; свежий dependency gate остаётся требованием финального source. Это граф зависимостей, не разрешение выполнить live шаги.

## Bounded task packets после аудита

| Пакет / роль             | Один результат                                                     | Repo / предполагаемая write ownership                                                       | До начала / acceptance                                                                         |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A1 Release Auditor       | Зафиксировать baseline, остаточные PR deltas, evidence ledger      | Только семь `docs/release/R1-*.md`                                                          | Этот audit artifact; runtime implementation не принадлежит A                                   |
| B1 Core & Commerce       | Авторитетный policy/usage binding + reservation recheck            | LK2 subscription adapter; ph-admin policy/lifecycle — отдельный согласованный packet/branch | Сначала residual review #503; owner C не меняет эти refs; LK1 parity negative/concurrent tests |
| C1 Booking owner         | CREATE reserve/confirm/readback на существующем canonical writer   | LK Node-RED booked-operation receiver и его tests                                           | B1 contract freeze; совместимость существующего JOIN сохраняется                               |
| C2 Booking consumer      | LK2 завершает CREATE по authoritative receipt                      | LK2 game-create-commercial modules                                                          | C1 accepted contract; replay/response-loss/outbox tests                                        |
| B2 Commerce compensation | Paid LEAVE/CANCEL возвращает визит/деньги один раз                 | Canonical owner LK, затем отдельный LK2 consumer packet                                     | B1/C1; одна saga, terminal provider readback; provider writes отдельно                         |
| C3 Training              | Законченный training signup/cancel path                            | LK2 training API/consumer                                                                   | B1/B2; capacity/eligibility/recovery                                                           |
| C4 Tournaments           | Законченный tournament signup/cancel path                          | LK2 tournament API/consumer                                                                 | Та же owner contract; права organizer и participant                                            |
| D1 Social                | Все четыре chat contexts + station membership/reconnect acceptance | LK2 messaging/realtime/community modules                                                    | B/C владеют business event producers; D — membership projection/authorization                  |
| E1 Engagement            | Device tokens + scenario delivery проходят recovery acceptance     | LK2 notifications/worker/native push                                                        | F согласует capabilities; без массовой рассылки и real audiences                               |
| F1 Dependencies          | Устранить/квалифицировать current dependency gate failure          | Root dependency graph/lockfile                                                              | Единственный platform owner, full gate; отдельно от mobile signing packet                      |
| F2 Mobile release        | Review/adopt остаток #504, завершить iOS signed build contract     | Mobile build/workflow/signing docs                                                          | Не создавать ключи/секреты; реальные signing/store операции только owner-authorized            |
| F3 Native journeys       | Доступные native commercial/social screens                         | Mobile/native bridge и platform route gating                                                | B/C/D contract stable; не снимать allowlist до безопасного handoff                             |
| G1 Required acceptance   | Candidate-bound automated E2E matrix без silent skips              | Тестовые файлы; CI wiring согласуется с F                                                   | Сначала audited disposable fixture ownership; никаких live defaults                            |
| F4 Release custody       | Проверяемый package/target/backup/rollback plan                    | Существующие release tools/runbooks                                                         | Финальный source; никакого dispatch/deploy на этапе подготовки                                 |

Внутри каждого пакета один write owner, одна outcome branch и PR. Cross-repo изменения оформляются отдельными PR с явной contract dependency; нет общей ветки, смешивающей все домены. Одновременно не более четырёх task branches, только одна platform task меняет workflows/deploy/root dependencies. B1, F1, C1, G1 могут начинаться независимо после согласования общей contract surface; если G1 требует workflow изменения, их проводит F или ставит G1 в очередь.

## PR disposition и интеграция

Полная таблица открытых PR находится в READINESS. Перед использованием кандидата сравнить actual diff с новым main: title/checks не доказывают ни отсутствия, ни завершения функции. Record: adopt residual / superseded / independent / installed-baseline-only. Не закрывать и не сливать чужие PR автоматически.

Одна интеграционная партия объединяет 2–4 готовых совместимых head; общий integration owner разрешает конфликты один раз. Обязательные зависимости upstream owner → downstream consumer должны быть приняты прежде, чем включать consumer. Merge остаётся отдельной границей. Проверки сохраняются, пока source/dependencies/command/environment/inputs/acceptance target неизменны.

## Evidence handoff для каждой задачи

Передать commit/PR/head, touched contract, focused/full checks с результатами и skips, fixture/environment identity, provider-write count, known limitations, rollback/recovery state. Для terminal booking/payment нужен receipt/readback, а не только HTTP 200. Для mobile нужен build identity + physical-device outcome. G собирает результаты; A не повышает их уровень.

## Решения владельца, которые понадобятся до live acceptance

- Поддерживаемые payment/subscription modes, refund/late-cancel правила и authoritative timezone/usage semantics; текущую LK1 семантику нельзя незаметно менять.
- Production topology и один канонический deploy route; target, tenant/station scope, writers, rollback floor, RPO/RTO.
- Изолированные test accounts/devices и разрешённые provider sandbox operations/notification recipients.
- Apple/Google account owner, approved signing identities, privacy/deletion/store obligations.

Эти неизвестные не препятствуют завершению аудита и безопасной реализации локальных bounded tasks; они блокируют зависимые provider/production/store переходы.

## Выполненные первые пакеты и следующий переход

- B02 local guards: #503 `39feed0c`, combined CI `41202183068` success. F1 high dependency fix #508 уже merged в `14ebdca6`, main CI `41201792854` success. B12 high blocker закрыт; owner v2 и provider acceptance этим не приняты.
- Следующий коммерческий packet — exact owner contract LK1/ph-admin: binding decision/usageRef,
  admission/delegation/receipt schemas, stable retry identity, reserve/confirm/release/compensate.
  Существующие advisory quote v1 и 17-field receipt не являются этим контрактом.
- После owner implementation подключить dormant LK2 consumer и пройти physical DB/provider
  sandbox acceptance; затем CREATE, paid LEAVE/CANCEL и training/tournament consumers.
- Signing, social, push и required E2E infrastructure сохраняют параллельные dependency lanes;
  закрытие локальных guards не разрешает отключать production guards.

## Уточнение owner critical path после compensation audit

1. ph-admin #57 (`d5000a4d`) — strict release proof/replay prerequisite на существующем ledger; confirmation v1 и strict-off legacy contract сохранены.
2. ph-admin #58 (`cab33ce`) — four-client physical Mongo reserve/confirm/release, rollback и committed-response-loss/child replay. CI `41201269983` success, все четыре workflow green.
3. ph-admin #59 (`70d3820c`) — actor/tenant/operation/instance-scoped primary-majority readback, семь полей, без owner proof или business write. Новый physical TTL case CI `41204278865` success: lost response после provider-rejection commit → read-only recovery beyond TTL; provider writes=0, skipped=0. Все четыре workflow green.
4. LK #264 (`de95b8cc`) — opt-in signer, durable original rejection, fresh-TTL retry и post-TTL readback только уже завершённого CUP release. LOCAL 213 passed / 1 skip; CI `41204447158` success. Неприменённый release после TTL остаётся pending; timestamp не обновляется.
5. Принять exact compatible heads, затем отдельно разрешённые runtime configuration / sandbox acceptance. Общий secret/config предусмотрен; создание, установка и активация сейчас не разрешены.
6. Runtime acceptance owner v2 #267/#515 и authoritative CREATE consumer остаются коммерческим критическим путём; затем paid cancellation/signup/native journeys. Этот compensation slice их не заменяет.

Dependency order: **ph-admin #57 → #58 → #59 → LK #264**. Merge не включает strict mode.
До runtime acceptance проверить Node-RED crypto injection, согласованные closed flags и оставшиеся
local pre-write abort paths. Не снимать production guards; полного B02/B04 acceptance ещё нет.

Параллельные lanes: #509 ordinary iOS APNs source реализован, physical CI 6/6 passed в combined #511;
#510 unsigned native CI и full CI success, signing/device/store acceptance отдельно. После этих
пакетов B08/B09 остаются PARTIAL, B06/B07 и полный B10 не закрыты.

## Уточнение CREATE target и social contracts — 2026-10-31

B03: `games.games.station_id/court_id` — канонические LK2 UUID; importer хранит associations
`game_station/game_court` под `LK_LEGACY_SNAPSHOT`. Sanitized identifiers необратимы, raw aliases
не обязательны, а migration 0042 допускает несколько aliases. Первый попавшийся alias не является
доверенным Viva ID для записи. Следующий CREATE-specific adapter должен читать organizer draft и
revision из одной версии, разрешать однозначное server-owned write mapping и повторно проверять
room/studio у LK owner. Missing/ambiguous mapping означает отказ до POST, не `LIMIT 1`.

Текущий admission receiver принимает JOIN+USE_SUBSCRIPTION с уже существующим exercise. CREATE
admission route возвращает 503, transport reserve не сохраняет reservation в итоговом PENDING,
confirm не связан с orchestration. Ни #503, ни #264 не закрывают этот consumer. Не расширять JOIN
claims фиктивным exercise ID; нужен отдельный CREATE action/target binding к существующему split
preflight/attempt/recovery, без второго usage ledger. Provider mapping/write authority и sandbox
acceptance остаются зависимостями, production guards сохраняются.

B04: LK split leave уже имеет actor/organizer authorization, durable claim/retry/CAS и provider
cancellation/readback. Однако просмотренный daily-limit route освобождает локальную allowance,
а bridge к CUP canonical entitlement release отсутствует. Согласовать этот шаг с одним owner;
cleanup scheduler не считать actor-authorized CANCEL API автоматически.

B07: Android уже отображает directory/history UI, но native session policy не разрешает существующий
GET `/community-views/:uuid/chat`. Это отдельный узкий read-access fix с negative native policy tests.
Он не завершает writable chat: community endpoint только GET, generic message repository разрешает
DIRECT/GAME, canonical community/tournament-to-conversation binding не найден. iOS дополнительно
требует Swift/TS session validation и controller/UI. #330 не добавляет community sending; #453/#466
затрагивают Android policy для GAME JOIN, поэтому будущий read-access PR должен объявить порядок
интеграции. Нельзя обойти membership checks клиентским вызовом generic send.

## Текущие отдельные исходные пакеты

1. Source integration #511 (`ed3854c3`) объединяет ровно #503/#509/#510/#507 и test-only
   Linux process-state regression fix. Combined CI и unsigned iOS success. Merge и отдельный
   temporary delivery suppression cycle ещё не одобрены; source freeze не меняется новыми задачами.
2. CUP #60 (`730e3f4c`) поверх #59: read-only canonical preflight + exact reserve expectations;
   physical CI success. Следом LK managed JOIN v2 owner поверх #264 и отдельный LK2 consumer
   поверх #511. Общие operation ID и v1 wire сохраняются; managed/legacy определяется одним
   server selector, не отсутствием instance. До consumer activation нужен verified compatible owner.
3. Android community history #512 (`96723a30`) — самостоятельный green candidate. iOS existing
   DIRECT/GAME chats #513 (`7b2213a0`) — отдельный stacked candidate на #511; LOCAL passed,
   CI `41210366790` и unsigned `41210366803` success. После разрешённого merge #511 retarget последующих PR на main без добавления
   пятого head в исходную integration batch.
4. Станционные сообщества ждут material cardinality/membership choices и canonical mapping owner.
   Нельзя подменить их support-dialog rows или объединить LOCAL membership с LEGACY chat writes.
5. После JOIN v2 идут canonical CREATE, paid cancellation/compensation, training/tournament
   consumers и native journeys. Provider/device/signing/restore acceptance остаются обязательными,
   а exact live/package authority запрашивается лишь для подготовленного конкретного перехода.

## CREATE target prerequisite из текущего source

Raw `booking.studioId`/`roomId` есть до sanitizer в LegacyGames Mongo adapter, но importer
сохраняет raw/pseudonymous aliases с одинаковой ролью. Migration 0042 разрешает несколько
`LK_LEGACY_SNAPSHOT/game_station,game_court` aliases на один internal UUID. Поэтому reverse
выбор первого alias не может дать authority на provider CREATE. Текущий draft resolver не
связывает court со station и не возвращает exact provider location.

До CREATE admission нужен versioned canonical location producer и resolver с явной связью
public court → station и provider room → studio, tenant/organizer/draft revision checks и
отказом при missing/ambiguous/conflicting evidence. LK уже имеет authoritative room/studio GET
проверку и durable precreate CAS, но это не заменяет LK2 mapping. Provider exercise ID должен
появиться только из actual create/readback; синтетический ID недопустим. Пакет пока не реализован.

## Текущая цепочка новых коммерческих кандидатов

1. CUP #60 `730e3f4c` поверх #59 — canonical preflight/reserve expectations/readback.
2. LK #267 `72688c66` поверх #264 — v2 owner, strict selector и immutable recovery. CI green; совместимая capability проверяется до dispatch. CI kernel fix #268 включён, production Mongo не меняется.
3. LK2 #515 `b55bd4d2` поверх #511 — v2 consumer; CI выявил два physical PG replay/receipt failures; исправление b55bd4d2 LOCAL 186/static/review passed, CI `41216151985` success (7267 passed /126 skipped, managed JOIN PostgreSQL3/3). Не входит дополнительным head в уже замороженный #511.
4. LK #269 `8d46b9b5` поверх #267 — managed SELF compensation; LOCAL/review passed, CI `41215625582` / `41215625485` success. Затем отдельный exact LK2 cancellation consumer и physical/provider acceptance, не денежный refund по предположению.
5. CREATE mapping producer/resolver → CREATE owner/admission → LK2 CREATE consumer → training/tournament consumers. Подготовленный JOIN нельзя переименовать в CREATE: новый exercise должен появиться из canonical provider result/readback.

Параллельный iOS packet добавляет OTHER profile → новый DIRECT поверх #513; source/review готовятся отдельно, completion и device acceptance пока не заявлены. Station product choices остаются pending. Ни одна зависимость не даёт merge/live authority.

CREATE producer audit уточнил: старый roster sync разрешён только local/staging. Новый узкий default-off цикл в существующем worker должен читать отдельное backend-only Mongo lineage evidence, проверять exact Viva room/studio через @phub/viva-adapter с собственной credential REF authority, и атомарно публиковать binding с CAS/audit/outbox. Весь historical alias/source cohort и reverse collisions проверяются без first-alias selection. TTL 5 минут, refresh60с, ambiguity/overflow/timeout закрывают новый CREATE. Source packet начат отдельно; migration/live credential/activation не выполнялись.

Перед LK2 SELF LEAVE consumer требуется owner admission для original generation: существующий SELF endpoint выводит текущую generation и не является safe replay transport для LK2. Проверить также наличие LK1 roster для LK2-only JOIN; простой proxy на текущий endpoint не принимается.
