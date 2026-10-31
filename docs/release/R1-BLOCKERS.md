# LK2 R1 — приоритетные блокеры

## Текущие P0 остатки

- **B03 BLOCKED:** LK#2733678c039 fixed-quarter nonbinding preparation source/CI green. Не найдена authoritative dictionary artifact→publication→CREATE producer цепочка; нужны concrete dictionary proof и immutable привязка одной organizer booking к доле1/4, затем trusted actor/draft target/preflight/reserve/original-create receipt. Допустим минимальный вариант quarter-price target + existing FREE_ENTITLEMENT; новый generic discount mode не обязателен. Whole-price fraction нельзя повторно применять к разделённой цене; daily-limit fallback не должен менять1/4 contract. Existing v1/LK1 reserve/replay сохраняются.
- **B04 PARTIAL:** #521 terminal no-dispatch recovery реализован; currente1d781 CI41234847565/native41234847625 SUCCESS:7361passed/126skipped и SELF PG9/9 после test-only count fix. Денежные CURRENCY/DEPOSIT cancellation commands уже есть в LK1; не хватает attributable game settlement/credit proof и безопасного LK2 consumer, organizer/native/provider acceptance.
- **B05 PARTIAL:** #520 training Web/API consumer0107 green, включая6physicalPG; native/paid/CUP-managed/LEAVE/provider acceptance не закрыты. CUP#61 nonbinding owner preparation green, включая physical Mongo; CUP#62 gender admission source/physicalCI41240145187 green; LK2 consumer и полный canonical admission/provider loop ещё отсутствуют. MALE/FEMALE требует profileM/F; явный MIXED не ограничивает пол. Missing tournament rule не считается MIXED; raw rule и fresh exact actor identity должны проверяться до записи.
- **B07 PARTIAL:** #518 synthetic iOS DIRECT5/5 native CI passed; четыре обязательных chat contexts не приняты. Для station community решено: одно официальное на станцию, auto-membership после confirmed game/training. Existing CUP STATION association/LK autojoin найдены; exactly-one selection, confirmed training station binding и generation/opt-out-safe producer/send ещё нужны.
- **B10 PARTIAL:** #522ada66c50 CI41233392220 SUCCESS:27physical game lifecycle/communications/broker +8guard cases, zero skips; fresh reports и owned-fixture cleanup receipt проверены. #523CI41235695070 также подтвердил8notification physical cases и cleanup. Android native build/JVM16 подтверждены#526CI41238685334, но полная device/provider matrix остаётся открытой; synthetic simulator5/5 не заменяет physical-device evidence.

Baseline и CI: [R1-READINESS](R1-READINESS.md), 2026-10-31. P0 означает блокер обязательного release scope, а не утверждение о severity уязвимости. Владельцы A–G — роли из программы; персональные DRI ещё не назначены. Ниже текущие остатки после ограниченной реализации; закрытие одного source/CI шага не означает закрытие полного release blocker.

| ID  | Приоритет / тип                                           | Факт и влияние                                                                                                                                                                                                                                                                            | Владелец / зависимости                             | Проверяемый критерий закрытия                                                                                                                                                                                                         |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | P0 / BLOCKED                                              | `packages/config/src/index.ts:774-815,857-859` запрещает production games reads/commands, commercial CREATE и policy registry                                                                                                                                                             | A+B+C; B02–B06, B10                                | Документированные production gates удовлетворены; отдельное reviewed изменение eligibility с negative tests. Не удалять guards до acceptance                                                                                          |
| B02 | P0 / PARTIAL                                              | Quote nonBinding; reservation recheck обязателен. Точные policy/instance/target/usage refs и LK1 parity не приняты целиком                                                                                                                                                                | B; базовый actor/target contract; оценить #503     | Concurrent reserve не превышает лимит; stale/wrong-instance/foreign-tenant/expired/frozen quote отклоняется; timezone/day/week/month и отмена дают правильный ledger; C/G подтверждают same contract                                  |
| B03 | P0 / BLOCKED                                              | CREATE owner advisory (`game-create-commercial-runtime.ts:75-148`); BOOKED_OPERATION отключён. LK receiver принимает только JOIN_GAME+USE_SUBSCRIPTION                                                                                                                                    | C+B; B02; отдельный LK owner task до LK2 consumer  | CREATE получает authoritative booking/receipt, draft становится SCHEDULED только после подтверждения; response loss/retry не создаёт второй booking/charge; rollback/outbox invariants проверены                                      |
| B04 | P0 / PARTIAL FREE/SERVICE SELF; monetary/provider BLOCKED | LK2#519 FREE/SERVICE SELF source/physical CI принят; monetary LEAVE/CANCEL, organizer и native/provider loop не завершены; unsupported-key recovery остаётся                                                                                                                              | B+C; B02/B03                                       | Каждый поддерживаемый monetary/subscription mode: pay/confirm/leave/cancel/refund или visit return. Один writer, один terminal outcome; late callback/partial failure/ambiguous reply reconciled, деньги и usage проверены у provider |
| B05 | P0 / PARTIAL                                              | Training Web/API#520 source/CI принят; tournament consumer отсутствует, #61 даёт только nonbinding owner observation                                                                                                                                                                      | C; own actor/owner contract; B02 for managed modes | API+UI signup/cancel используют canonical owner; last-seat race, duplicate signup, level/category/date limits и compensation проверены для обоих типов                                                                                |
| B06 | P0 / BLOCKED                                              | Android nativeSections исключает mandatory routes (`App.tsx:870-888`); iOS game cards readOnly (`IOSCabinet.tsx:335,516`)                                                                                                                                                                 | C + F mobile; B03–B05; D/E для social/push         | Все mandatory journeys доступны на обеих платформах; session/return URL/deep link/offline/process death не создают повторные команды; экран показывает authoritative pending/confirmed/failed                                         |
| B07 | P0 / MISSING + UNKNOWN                                    | CommunityThread read-only (`CommunityChats.tsx:181,350`); tournament binding не подтверждён; iOS DIRECT/GAME text consumer #513 имеет LOCAL/CI pass; CUP STATION association/LK autojoin существуют; uniqueness и confirmed game/training producer/replay fence не завершены              | D; B05 для membership producers; F native; B10     | Personal/game/tournament/community chat и station membership доступны обоим клиентам; denied member cannot read/send; removal/reconnect/replay/unread consistent; physical DB/broker cases не skipped                                 |
| B08 | P0 / PARTIAL source, runtime acceptance BLOCKED           | #509 `8639d396` реализует ordinary iOS APNs projection/delivery и safety checks; шесть physical scenarios passed; combined #511 `ed3854c3` CI `41207679072` success                                                                                                                       | E; B09; event producers B03–B05/D; B10             | Physical CI без failures/skips, затем authorized provider/device receipt, rotation/logout/account switch, opt-out/quiet hours, dedup/retry/unknown-outcome recovery                                                                   |
| B09 | P0 / PARTIAL unsigned CI, BLOCKED release/store           | #510 `22303758` имеет unsigned native CI `41203337199` и full CI `41203337054` success; signing/material/device/store acceptance не выполнены                                                                                                                                             | F; B06–B08; #504 отдельный signing candidate       | Подписанные AAB/IPA с source/hash/version/certificate, physical install/upgrade и store prerequisites; keys/upload/publication только по отдельной authority                                                                          |
| B10 | P0 / PARTIAL physical evidence, BLOCKED full E2E          | #58 `cab33ce`: four-client canonical Mongo ledger/rollback/response-loss CI `41201269983` passed; #59 TTL readback physical CI `41204278865` passed; #509 APNs physical CI 6/6 passed в #511; #60 preflight/no-write/replay physical CI passed. Полной native/provider journey matrix нет | G; B02–B09                                         | Каждый required case реально executed на нужном уровне без silent skips; конкретный Mongo pass не закрывает остальные PG/broker/device/provider cases                                                                                 |
| B11 | P0 / UNKNOWN production custody                           | Нет выбранного полного release package→target→backup/restore→rollback→runtime acceptance. Первый snapshot Web delivery RANGE_INELIGIBLE; после #508 source-only merge downstream skipped без steps                                                                                        | F+A; финальный source и B10/B12                    | Канонический immutable manifest, свежие target/schema/roles/backup restore/rollback inputs, согласованный маршрут; rollout и activation только по exact approval                                                                      |
| B12 | CLOSED high dependency blocker / VERIFIED main CI         | #508 merged `14ebdca6`; main CI `41201792854` success. #503 combined `39feed0c` full CI `41202183068` success. Systeminformation high исправлен; 16 moderate остаются отдельно                                                                                                            | F; сохранять dependency gate финального source     | High finding закрыт source+CI evidence; не объявлять zero vulnerabilities и не заменять финальный source gate историческим run                                                                                                        |

## Не превращать историю PR в автоматическую очередь merge

- #503 — B02 local fail-closed foundation, текущий `39feed0c` combined CI success после merged #508. Owner v2 и provider acceptance остаются открытыми; B12 high gate закрыт на main и этом head.
- #504 — кандидат для части B09, checks зелёные; нет signing-material/store activation authority.
- #467 — acceptance additions вне main и red; сначала сравнить с текущими API/fixtures, удалить дублирование в собственной task branch, затем bounded acceptance change.
- #453/#466 и старые #355/#359/#361/#388/#391/#392 пересекаются с уже merged JOIN/notification code. Нужна классификация residual delta, а не merge всех по порядку номеров.
- ph-admin #5/#6/#7/#9 остаются open, но main уже содержит lifecycle services. Для каждого выбрать adopt residual / superseded / independent; закрытие PR не входит в аудит.
- LK installed-baseline PRs с пометкой «not for main merge» не могут служить обычными интеграционными ветками R1.

## P1 / дополнительные неизвестные

1. Branch API сообщает `protected=false` во всех трёх repo; проверить rulesets, обязательные checks/reviews и environment protections read-only до release. Ничего не менять автоматически.
2. У store аккаунтов, privacy/data safety, support URL, in-app account deletion, age/content ratings и review access нет проверенного owner acceptance. Не выводить состояние кабинетов из Git.
3. Действующие dashboards/alerts, restore SLA/RPO/RTO, on-call и полный target topology не проверены. Source monitoring files лишь показывают подготовленные механизмы.
4. Production secret/config custody и актуальная writer ownership не исследованы на hosts; не использовать исторические values и не создавать новые секреты для снятия UNKNOWN.

Не расширять R1 на generic framework, Event Catalog V2 или масштабирование communities. Сохранять LK1 API, канонического writer и существующие safeguards.

## Исторические checkpoint

Ниже сохранены прежние этапы. Актуальные статусы — в таблице и списке выше; старые pending/отсутствует формулировки не отменяют новых результатов.

## Owner compensation prerequisite — 2026-10-31

ph-admin #57 (`d5000a4d`) устраняет подтверждённый source-дефект: strict release обходил owner proof,
а terminal replay не связывал причину и booking. LOCAL negative/retry/recovery checks прошли.
Оба exact-head CI workflow success (runs 41190093733 / 41190093707). B02/B04 остаются PARTIAL/BLOCKED по исходным exit criteria. Новая обязательная
зависимость до strict activation: LK owner подписывает только подтверждённую отмену либо
определённый отказ без созданного booking; таймаут не считается отказом. Подпись
сама по себе не доказывает provider outcome — требуется sandbox readback acceptance.

LK #264 (`de95b8cc`) добавил durable original rejection и post-TTL readback #59: exact CUP
`FAILED / APPLIED / PROVIDER_REJECTED / null` позволяет только локальный CAS→RELEASED.
Нет нового proof, продления TTL или повторного provider POST. Неприменённый CUP release после TTL
остаётся pending. LOCAL 213 passed / 1 existing skip; independent review clear; CI `41204447158` success.
ph-admin #58 physical canonical Mongo evidence passed (`41201269983`), #59 новый TTL readback physical CI
`41204278865` success, provider writes=0, skipped=0; все четыре workflow green. Это не полный B02/B04: owner v2, local pre-write abort, provider/native acceptance
и runtime key/crypto custody остаются открытыми. Порядок: #57 → #58 → #59 → LK #264; opt-in отдельно.

## Уточнение B02/B07 после нового evidence

CUP #60 `730e3f4c` закрыл source preflight/optional reserve expectations/replay guards с physical CI
`41208902447` success. B02 остаётся PARTIAL до совместимых LK owner v2 и LK2 consumer,
включая explicit LEGACY selection, selector drift, immutable replay и authoritative receipt.
B03–B06 по-прежнему зависят от этого контракта; зелёный CUP CI не включает provider acceptance.

B07 больше не означает полное отсутствие iOS source: #513 реализует существующие DIRECT/GAME
text chats, LOCAL/CI passed (7265 passed /126 skipped; PG 4 passed). Android community history #512 CI success, debug build
passed. Полные четыре контекста, device acceptance нового личного диалога #516, station mapping/membership и
physical-device acceptance не закрыты. Для station implementation ожидаются ответы владельца
о числе сообществ на станцию и добровольном/автоматическом membership; названия станций не
используются как identity, membership не создаётся неявно.

## Остаток после JOIN v2 и SELF LEAVE source packets

B02: LK #267 `72688c66` имеет green CI; LK2 #515 `b55bd4d2` реализован, но CI выявил два physical PG replay/receipt failures; исправление b55bd4d2 прошло LOCAL 186/static/review, CI `41216151985` success (7267 passed /126 skipped, managed JOIN PostgreSQL3/3). Explicit authoritative LEGACY, immutable original tuple, receipt/usage checks и recovery-only contract больше не являются отсутствующим source. Physical PostgreSQL JOIN tests, paired runtime/provider/map freshness и выбор совместимых release heads остаются exit gates.

B04: LK #269 `8d46b9b5` добавляет только managed SELF subscription compensation, LOCAL/review passed, CI `41215625582` / `41215625485` success. Денежные refund, organizer CANCEL, LK2 paid consumer и provider acceptance остаются открытыми. Старые managed rows без durable tenant provenance и tokenless background retry намеренно pending; автоматический backfill или impersonation не добавлены.

B03 не снят: нет trusted producer canonical court/station/provider location relation. Raw alias или CUP EVIDENCE_ONLY preview недостаточны. B05/B06 нельзя завершать обходом этой authority.

B07: #516 `3e9c566a` добавил source/LOCAL нового DIRECT из профиля участника; CI `41216456571` / native `41216456863` success. Полные community/tournament contexts и station choices этим не закрыты.

B04 consumer audit: #269 — internal compensation tail, не готовый LK2 leave transport. Canonical SELF ingress определяет текущую membership generation и не использует внешний SELF operationId; bookingId меняет режим на organizer target. Обычный retry после rejoin может затронуть другую generation. Кроме того, LK2-only JOIN не гарантирует LK1 roster row. До consumer нужен restrictive authenticated owner admission, связанный с original booking/usage/generation, и доказанный canonical ingress/recovery; напрямую вызывать internal release bridge нельзя.
