# LK2 R1 — release preparation и controlled handoff

## Текущие решения и интеграция — 2026-11-01

Владелец разрешил обе точные локальные интеграции; они выполнены и отправлены в свои Draft PR. [#525](https://github.com/Z6v6e6r/lk2/pull/525) `f042389bb09703a75b502e793b28985028cc1f54` включает согласованные #52630598d97 (с #524) и #523f5c33149. LOCAL302 функциональных и22 delivery-contract проверки,54 изменённых TS файла с зависимостями:0 diagnostics. Guard suite:48PASS и один отдельно повторённый PASS после временной ошибки разбора Darwin ps; это составное evidence, не полный повтор49. Android41274690263 SUCCESS:16 обязательных JVM cases, unsigned release APK artifact13070946919 (ZIP SHA256 `207921dd54feadf82e42ff3e84750617a412a0c9ee1692ab6ba70af591facbd6`, expires2026-11-15). iOS41274690260 SUCCESS:30PASS/1app-hosted Keychain SKIP и unsigned simulator build; full41274690282 SUCCESS:7555PASS/126SKIP; SELF PG9, managedJOIN PG3, TRAINING PG6, closedPG4. Required35physical+8guards zeroSKIP (lifecycle13/comms10/Rabbit4/notificationPG4/notificationRabbit4); static/security/deployment и все пять Docker builds PASS. Независимое review и exact outgoing scans PASS.

[#528](https://github.com/Z6v6e6r/lk2/pull/528) `cd4b3d27b156b56923fb0a96dfadad8f9b92b19f` содержит разрешённый parent#5273143ffbe. Итоговое дерево `9dd1d57c2a087d1a418a31bd92f6437cfc04bfeb` побайтно совпадает с прежним26c5ceaa: TRAINING bundle сохранён, исправление JOIN fixture уже присутствовало. Предыдущие54 LOCAL проверки переиспользованы; merge-custody review и outgoing scan PASS. Конфликт снят. Initial fullCI41274959565:7546PASS/126SKIP, TRAINING PG11 и managedJOIN PG10 PASS; один устаревший current-inventory testFAIL. Test-only `fbf29562bd5f359031f1ff6cda0be7b4ed4e712d` меняет только +9→+10 и список с0108, frozen ledger и rejection сохраняются. LOCAL1PASS/27 name-filteredSKIP, review/scans PASS; corrected fullCI41275879957 SUCCESS наfbf29562:7547PASS/126SKIP, TRAINING PG11/11, managedJOIN PG10/10, closedPG4/4, required27physical+8guards zeroSKIP; static/security и все пять Docker builds PASS. Прежние сообщения об ожидающих разрешениях или заблокированном запуске CI ниже являются историческими.

Правило турнирного чата подтверждено владельцем: **профиль организатора явно назначается в CUP; до назначения доступ только у текущих участников**. Product choice закрыт. Реализация отдельного проверенного canonical-profile lookup и назначения/отзыва с tenant/station scope, revision CAS и журналом операции ещё не завершена. Существующие subscription credentials ограничены своей целью и не дают такого права. Новая конфигурация остаётся отключённой до отдельного согласованного runtime-перехода; ключи не создавались. Organizer assignment само по себе не доказывает готовность chat send/read/realtime ACL.

[#538](https://github.com/Z6v6e6r/lk2/pull/538) `0dfc0458879a7ed1eece423713bbbce215ab4046`: bounded NO_PAYMENT organizer CANCEL реализован для Web/Android/iOS с серверной canonical capability, original-principal fence на SDK retry и GET-only восстановлением неоднозначного результата. LOCAL/review/scans прошли; unsigned iOS41274254446 SUCCESS, static и пять Docker builds PASS. Full41274254490:unit7872PASS/127SKIP и closedPG4PASS; required physical gate остановился на новом fixture: started case нарушал существующий SQL constraint join_cutoff_at<=starts_at. Test-only `7faff1b698d0424c284a41754445fcdb6866fac4` исправляет согласованность fixture timestamps/cancellation metadata, assertions неизменны; LOCAL6PASS/14CI-onlySKIP/typeslint0, independent review/scans PASS. Corrected full41275758102 и iOS41275758096 SUCCESS на7faff1b6:7872PASS/127SKIP, quarterPG12/closedPG4, required28physical+8guards zeroSKIP, включая новую capability fixture; static/security и все пять Docker builds PASS. Native local CANCEL SOURCE/CI завершён; устройство/runtime не приняты.

Решение R1 остаётся **NO-GO**. Эти операции — локальные разрешённые merge и task-branch push; новых merge в main, публикаций, deploy, real DB/provider writes, signing/store activation не было. Этот раздел имеет приоритет над более ранними checkpoint ниже.

## Текущий статус — 2026-11-01: закрытые SOURCE/CI проверки

[LK#283](https://github.com/Z6v6e6r/lk/pull/283) `19e66ee0161f240dceb38853e6a9c6654168f4d3` (runtime784cea38, base#270) закрыл bounded SOURCE/CI защиту monetary SELF dispatch: полный [CI41272659955](https://github.com/Z6v6e6r/lk/actions/runs/41272659955) и [Mongo41272659903](https://github.com/Z6v6e6r/lk/actions/runs/41272659903) SUCCESS. Mongo27/27, включая шесть физических conflict/recovery cases, zeroSKIP; inherited owner28/28 и worker22/22. LOCAL145PASS/6CI-onlySKIP, test-only historical current-source rebind3/3, independent R3 review и staged/outgoing PII/secret scans PASS. Baseline SERVICE и dispatch marker сохраняются до HTTP; ACK-loss и graph observer не дают повторной отправки. Money остаётся UNVERIFIED; crash-before-HTTP может удерживать прежний game-wide gate. Это не settlement/provider/runtime acceptance.

**Release NO-GO; SOURCE/CI и runtime acceptance разделены.** Нативный quarter CREATE [#533](https://github.com/Z6v6e6r/lk2/pull/533) `d57e3e7dde5593f16cf1151587d058d2b8b83e21`: full41264822510 и iOS41264822518 SUCCESS. Quality7748PASS/126SKIP, quarterPG12/12, closedPG4/4, required27physical+8guards zeroSKIP; source/static/dependency/deployment/secret и пять Docker builds прошли. Исправления после runtime2aabc692 затрагивают только тесты: obsolete casts, ожидание bounded quarter route и архивный fixture исторического controller pin. Текущему изменённому blob старый controller по-прежнему отказывает. Android APK/device acceptance не получены.

Web station chat [#535](https://github.com/Z6v6e6r/lk2/pull/535) `de952dc4e882dd3ebf332300c4c9edb81cb97793`: 45 reviewed files, SOURCE/LOCAL verified, initial full41265870441:7802PASS/126SKIP/1FAIL (test ожидал callback до завершения WebCrypto), iOS41265870267 SUCCESS. Test-only2c4becf8a242366fb964eb3da53dd1c48ad11378 усиливает ожидание и custody assertions;8LOCALPASS/typeslint0/review/scans PASS. Corrected full41266782435 и iOS41266782380 SUCCESS:7803PASS/126SKIP,quarterPG12/12,closedPG4/4,required27physical+8guards zeroSKIP; source/static и пять Docker builds PASS. Сервер получает проверенный user-scoped LK Bearer; actor/session/mapping refusals не открывают общий circuit breaker. UUID+hash сохраняются до POST, reload только GET, нет повторного POST/fallback; ACL denial очищает историю, logout закрывает поздний ACK. LOCAL17suites/130PASS плюс изменённые subsets (не суммировать), types/lint/OpenAPI и synthetic390/1280 прошли. Web-only: native composer намеренно недоступен, device/delivery acceptance не заявлены.

Неиспользованный reserve expiry: [CUP#69](https://github.com/Z6v6e6r/ph-admin/pull/69) `e8e16b2dc79c0970f99100ff698affcc2465297d` → [LK#281](https://github.com/Z6v6e6r/lk/pull/281) `70fd376bfd37bed3e69b3ff432cb09381ea2df90` → [LK2#536](https://github.com/Z6v6e6r/lk2/pull/536) `63bd45ffc1abe9a192a2164c83b23d47181dbaee`. 26 reviewed files; LOCAL LK79PASS/7MongoSKIP, legacy114PASS/1SKIP и split29PASS; CUP lifecycle/preflight/readback PASS, physical import types0; LK2 72PASS/20PGSKIP, types/lint0. LK Mongo41266210816 выявил test-only ошибку: после скачка времени fixture повторно использовал истёкший actor JWT; runtime правильно отказал. Test-only7f375a31c427b7c7e820a771ec9b941875b7fad2 сохраняет refusal и проверяет recovery с новым actor proof; LOCAL1PASS/7CI-onlySKIP, review/scans PASS. CUP CI отсутствовал из-за фильтра base branch; CI-only764e809e5a2cb652faf8cdaf81ea3d8557bf7fd9 добавляет ровно базу #67, пять CI guards/review/scans PASS. Исправленный LK Mongo41266536638 SUCCESS:87/87 включая7physical, zeroSKIP; worker22/22. Фактический LK CI использовал mongo:8.0 (проверено по pull/create в логе), а не Mongo7 из предварительного handoff. CUP full41266419414 SUCCESS: реальная replica-set гонка confirm/release в обоих порядках, loser zero mutation, lost ACK/post-TTL; entitlement skipped=0/provider writes=0. LK full41266536635 SUCCESS. LK2 full41266216875 SUCCESS:7755PASS/126SKIP,quarterPG20/20,closedPG4/4,required27physical+8guards zeroSKIP, source/static и пять Docker builds PASS. Полный snapshot и Mongo-clock CAS должны доказать отсутствие dispatch до signed release; ATTEMPTING остаётся UNKNOWN. Сначала canonical RELEASED и исходный schema2 receipt с checksum, затем reclaim. Все staged/outgoing secret scans прошли без исключений; source manifest SHA2563d3cd929f60a5553b0050b2c9d314101200ca54fbd8a4a9e18b22af0a76a7159. Собранный LK2 runtime bundle byte-identical HEAD854147ab, generated файл не менялся.

Station history v2: [LK#282](https://github.com/Z6v6e6r/lk/pull/282) `f6520b031e29db90845bda4b9b56492f2520185f`, full [41268575186](https://github.com/Z6v6e6r/lk/actions/runs/41268575186) и Mongo [41268575195](https://github.com/Z6v6e6r/lk/actions/runs/41268575195) SUCCESS. 20/20 history cases, включая четыре физических Mongo8, zeroSKIP; worker22/22. Guarded graph composer отвергает broad/ambiguous catch/complete observers до добавления приватных read nodes; исходные auth ingress и v1 сохранены. Первое full CI остановилось на синтетическом phone literal в negative fixture; test-only correction проверяет phone-only и foreign-ID с совпадающим телефоном ACTIVE member. Exact configured added-line PII scan и Gitleaks PASS без исключений, runtime/scanner неизменны.

[LK2#537](https://github.com/Z6v6e6r/lk2/pull/537) history head `8651a0db4ccc5362ca9eed0437fb8c89c1179fd3` прошёл full [41267653658](https://github.com/Z6v6e6r/lk2/actions/runs/41267653658) и iOS41267653681:7826PASS/126SKIP,closedPG4/4,required27physical+8guards zeroSKIP,static и пять Docker builds. Actual LK helper fixture SHA256 `50e02af00ef28ad2163f6d7909bd748c3741bbac251da3c4f7581ddce4f0440a` принят реальным LK2 parser. Строгий tuple cursor, duplicate-only continuation и repeated-cursor rejection проверены. Текущий continuation `5f8cf40798129f5d9d591121060ad70dae9e5734` добавляет station first-page GET на online/focus/visible, coalescing, cleanup fence и restart cursor; SOURCE/R3 CLEAR, LOCAL77PASS (Chats69+Composer8), types/lint0. Его full [41269740593](https://github.com/Z6v6e6r/lk2/actions/runs/41269740593) и iOS41269740624 SUCCESS:7835PASS/126SKIP,quarterPG12/12,closedPG4/4,required27physical+8guards zeroSKIP; static/dependency/deployment/secret gates и выбранные Web/API Docker builds PASS.

Полное восстановление и unread остаются открытыми: owner использует reservedAt как createdTs; поздняя публикация может оказаться позади прочитанного cursor. История COMMITTED может появиться до event proof; CONFIRMED status проверяет оба. Свежая первая страница не является gap-free catch-up. Нужны согласованные owner acceptance sequence, непрерывная подтверждённая граница публикации и current-epoch read marker; timestamp/Date.now и чужой PG last_read_sequence их не заменяют. Никакой такой migration/backfill не выполнен. Browser acceptance недоступна: repository local:status подтвердил отсутствие reachable local Linux Docker engine; DB/containers не создавались.

До включения v2 reader установить matched LK#282 с сохранённым auth ingress, current-actor/final ACL и проверкой graph observers. Проверить реальный legacy count≤2000, retained identity/BSON time, projection support, indexes/query timing/capacity и старые writers; projected string bound <78MB не является измерением RSS или concurrency capacity. Затем frozen LK2#537 head и проверка full CI. No fallback на неподтверждённый старый graph. Для будущего unread сначала coherent writer installation/drain и явная исходная граница без выдуманного sequence backfill. Production/provider/device smoke требует отдельной authority и не заменяется current synthetic CI.

Ни один из новых PR не merged/activated. Production configuration, provider, shared DB, signing и stores не изменялись. Следующие разделы сохраняют историю; при расхождении приоритет у этой контрольной точки.

Перед установкой нового expiry контракта заморозить совместимые CUP/LK/LK2 heads и проверить полное paired CI. #535 требует exact LK#279 station-message.v1, actor-specific token delegation и существующее однозначное LK_LEGACY mapping; не создавать mapping на запросе. Consumer acceptance требует установленного matched owner, затем ACL/recovery/session проверки. Никакой runtime activation не разрешён текущими Draft PR.

Station consumer prerequisite LK#279952031f7 требует distinct `/message-requests` POST/GET и exact `station-message.v1`, проверенного Bearer actor и текущего ACL. Source/CI прошли; реальную установку и отсутствие внешнего route shadow необходимо проверять отдельно. Клиент не должен пробовать старый `/messages` как fallback. GET не запускает recovery; статус CONFIRMED означает только наблюдённые message/event, без delivery/read guarantee.

## Monetary SELF dispatch fence: prerequisites

[LK#283](https://github.com/Z6v6e6r/lk/pull/283) требует exact source/graph review и полного CI, исходного authoritative Mongo store с проверенными topology/write concern/journaling/retention и совместимого deployed HTTP node без скрытых повторов/redirects. Завершить old in-flight writers до атомарной установки; патчер отвергает иной вход ACK/gate/HTTP и опасные observers/links. Подтвердить operational resolution для UNKNOWN: прежний game-wide membership gate может удерживаться до DONE. Crash после marker CAS, но до HTTP, не разрешает повторный DELETE. Money settlement и реальные provider формы остаются отдельной acceptance boundary; текущий PR не разрешает apply или финансовые операции.

## Quarter CREATE candidate custody

Кандидаты: #53296be6b4d Web/API, #5332aabc692 native, #534fd2f87fd station producer и LK#280bfacff70 receiver. Companions имеют SOURCE/LOCAL/R3 evidence. #534 full41262584637 SUCCESS; #533 corrected iOS41263018206 SUCCESS, final full41263945947 ещё выполняется (test-onlyc69fe2c2 после устаревшего MobileApp route fixture;9affected testsPASS). Интеграция должна сохранить#530/#531 tournament routes,#526 packaging и Web href fix; отдельные Draft PR не являются готовым единым release artifact.

Перед отдельно разрешённой активацией#534: установить exact receiver contract, выполнить одобренную0111 миграцию после lock/scan rehearsal, обеспечить согласованные API/worker и drain старых in-flight writers. Старый binary может создавать NULL; schema не заменяет writer floor. Проверить custody исходного admission/hash/generation, atomic receipt/outbox, receiver claim retention и queue recovery. Не переименовывать GAME/TRAINING payload в CREATE. Проверки provider, signed artifacts, device/store и backup/restore остаются отдельными gates; source CI их не заменяет.

## Дополнение кандидата: station-message owner — 2026-11-01

LK#278 `0de4cf4b` и CUP#68 `16fa3e5c` имеют зелёный SOURCE/CI, но не входят в активированный release. При подготовке конкретного пакета сохранить их родителей #276/#63 и совместимость административных записей с private message outbox. Worker package включает `stationMessageOwner.mjs` и `stationMembershipLifetime.mjs`; упаковка проверена локально и в CI.

Перед отдельно разрешённой установкой подтвердить завершение старых выполняющихся graph-запросов, текущие ACL/epoch writers, отсутствие очистки исходных candidate/receipt/outbox и Mongo read/write concern/failover. Новых секретов, индексов, TTL или services этот пакет не создаёт. Все STATION sends в новом graph идут через owner; это обязательная часть установки, а не переключение нового runtime-флага. Никакая установка данным отчётом не разрешена.

## iOS tournament source checkpoint — 2026-11-01

iOS#53199f5d942 has native compilation/tests and unsigned simulator build evidence from41254366026; fullCI41254366038 SUCCESS (7670passed/126skipped, tournamentPG7/7, required27physical+8guards zeroSKIP). Before release, integrate its exact shared Session/Plugin/IOSCabinet changes with DIRECT/TRAINING once, then validate real Keychain logout/process death, WKWebView storage/Web Locks/randomUUID and original-operation recovery on devices. This does not authorize signing, store publication or runtime activation.

## Paired quarter CREATE source checkpoint — 2026-11-01

CUP#67 `802ed017` and LK#277 `59d3880c` must pass their exact-head automatic CI and remain paired with #65/#66 and existing LK owner sources before artifact selection. Do not activate until the installed graph matches the reviewed composer; actor credential purpose, original expiry, schema4 adoption and runtime TTL/cleanup retention are verified; all canonical writers are coherent and old in-flight writers are drained. Dedicated target credential provisioning is a separate owner action. LK2 consumer/import/station prerequisites remain open. The PRs authorize no merge, graph import, migration or provider call.

Ниже сохранены предыдущие контрольные точки; текущие статусы — в разделах выше.

## Android tournament checkpoint — 2026-11-01

Android#5304406a3b2 is a source candidate only. Before native release require fullCI, authorized integration with#526 unsigned build lane, an APK/AAB tied to finalsource and physical install/upgrade/offline/account-switch acceptance. Public tournament reads remain exact first-party/tenant and credential-free; empty text/plain is accepted only for the existing bodyless retry. Do not dispatch the release-only Android workflow or widen generic native transport to bypass a missing package gate.

## Tournament consumer activation prerequisites — 2026-11-01

LK2#529 `40d450c0` pairs only with compatible CUP#64. Require clean fullCI and physical PostgreSQL evidence, integration with0108 before0109, exact owner identity configuration and separately approved migration/runtime activation. `TOURNAMENT_LOCAL_COMMANDS_ENABLED` remains false. Public status exposes command availability; unavailable status must not create new browser attempts. Unsupported/ambiguous attempts retain their original key; HTTP404/409 is not proof of no dispatch. Native/paid/provider/WAITLIST paths must remain unavailable until their own acceptance.

## Additional source prerequisites — 2026-11-01

CUP#64 `9d728414` has green CI41246247607 including six physical Mongo cases. Keep TOURNAMENT_LOCAL_OPERATIONS_ENABLED disabled until a matched LK2 consumer and runtime acceptance are approved. Admit only explicit LOCAL_ONLY nonmonetary targets; the 512-entry permanent journal reserves terminal LEAVE capacity. Adopted targets reject legacy roster/payment/admin replacement and restore even with the flag off. This conservative metadata freeze is an activation constraint, not a verified production behavior.

CUP#65 `5812113c` is a separate quarter-proof prerequisite, CI41247998877 SUCCESS (full build and physical quarter target/reserve/replay case). Before any quarter activation require strict schema4 instance adoption, a current full reconciliation checkpoint, authenticated LK producer, durable CREATE owner and original receipt recovery. Provider observations and instance snapshots must be attributable; fixtures and publication approval do not prove provider execution. No production configuration, migration, payment, signing or publication is authorized by these source packets.

CUP#66 `5eb4fe04` supplies reviewed source for strict schema4 FULL_RECONCILIATION; CI41248667293 SUCCESS, including full typecheck/build/artifact gates and the actual Mongo reconciliation/race fixture. Before any real apply require exact target/input/plan attestation, complete attributable provider snapshot, coherent upgraded writers and draining old in-flight sale transactions. A schema4 guard cannot fence an old transaction already in progress. No actual import or sale was executed.

## Station preparation addendum — 2026-11-01

Source packet consists of LK#275/#276, CUP#63, LK2#527/#528. Require their exact-head CI and coordinated integration before selecting release artifacts. #528 currently has an unresolved parent bundle conflict and no PR CI; local merge approval is pending. No main merge, feature activation or delivery authorization is supplied by these Draft PRs.

Before activation: approved0108 migration with bounded locks and backup/old-binary acceptance; existing private signing issuer/key with separate station audience; all roster/moderation/create/delete writers honoring the epoch barrier; immutable original admissions/generation claims; retained outbox and bounded quorum retry/DLQ procedure. Validate GAME and TRAINING original facts, cancellation retention, LEFT/new-generation return, admin block and ACK-loss recovery. No automatic historical enrollment/backfill. Subscription training target fencing remains until its own leave/rejoin contract exists.

## Текущие prerequisites

#525eb993ff6 — конкретный source integration candidate четырёх heads#517/#521/#520/#522, с успешными integratedCI41236559609/41236564284 и native41236564207, без merge authority. Перед возможным source-only merge нужны exact-head checks, свежий main и отдельно разрешённое подавление automatic delivery. #523/#524 и cross-repo owners не входят в эту партию; её source merge не разрешает их runtime activation.

#522ada66c50 required physical CI принят: lifecycle/communications/Rabbit27+8guard cases, zero skips, owned fixtures cleanup подтверждён вCI41233392220. При будущей интеграции этот обязательный step и его fail-closed report/ownership проверки должны сохраниться. Это не разрешение на shared database/broker или provider тесты.

LK#2733678c039 preparation source/CI green, но unsigned observation не является CUP producer authority. До CREATE acceptance нужны versioned actor/draft-bound trusted target, actual applied1/4 check, original-create receipt и сохранение v1/LK1 replay. Station membership требует original pre-dispatch admission epoch и confirmed generation; поздний replay после voluntary leave не должен возвращать пользователя.

#511 source-only integration разрешена отдельно от delivery; её flag cycle завершён: mainCI41230249442 SUCCESS, delivery41231241175 SKIPPED/steps=[], исходныйtrue восстановлен18:50:31 UTC. Остальные merge требуют отдельных exact-head approvals.

Training LK#271→LK2#520 и FREE/SERVICE SELF LK#270→LK2#519 имеют source/CI evidence. SELF terminal-refusal recovery#521e1d781 CI41234847565/native41234847625 green, physicalPG9/9; native/provider paths ещё нужны. CUP#61 даёт только nonbinding dated owner observation; admission обязан проверить raw rules, actual owner, original generation и capacity/WAITLIST. MALE/FEMALE проверяют exact actor profileM/F, MIXED без gender restriction; missing rule не unrestricted.

Денежные LK1 cancellation commands существуют. До LK2 monetary activation требуются attributable game settlement/credit, ambiguous-write recovery и отдельная financial acceptance. #518 имеет actual synthetic simulator5/5 и full CI green; physical devices, real OTP/Keychain/APNs/provider и stores этим не приняты. Quarter-court CREATE и station community decisions зафиксированы в READINESS, их server write contracts ещё не завершены.

**Текущее решение NO-GO. Этот документ не разрешает dispatch, публикацию, deploy, provider writes или store upload.** Он связывает R1 критерии с существующими executable runbooks; не создаёт новый deploy process. Baseline/блокеры: [READINESS](R1-READINESS.md), [BLOCKERS](R1-BLOCKERS.md).

## 1. Закрыть source и product gates

- A фиксирует actual main и residual open-PR delta всех трёх repo; B–G закрывают bounded tasks из [DEPENDENCIES](R1-DEPENDENCIES.md).
- Сохранить LK1 canonical writer и публичную совместимость; ни parallel dual-write, ни обвод production guards.
- Изменения identity/payment/contracts/schema/native transport проходят соответствующий specialist review и full applicable gate. Документационный audit не требует запускать runtime stack.
- Интеграция только готовых совместимых heads по [delivery-batches](../runbooks/delivery-batches.md). Merge требует owner authority; исходный запрос на аудит его не даёт.
- Для финального source обязательны main CI, актуальный dependency gate и результаты required suites без silent skips. [E2E matrix](R1-E2E-MATRIX.md) должна иметь per-case evidence.

## 2. Определить exact release package и target

Release owner записывает LK2/LK/ph-admin SHAs и contract versions, Git trees, source CI run/attempt, выбранные компоненты, mobile build numbers, feature scope, target topology/tenant/station и canonical writer. Указывает active operation owner/lease и rollback floor. Сейчас эти поля не заполнены — release package ещё не выбран.

Для Timeweb применяется [immutable publication runbook](../runbooks/timeweb-amd64-image-publication.md): exact current main, source/workflow identity, canonical `PHUB_TIMEWEB_RELEASE_MANIFEST_V2`, checksum и полный пятикомпонентный набор. Проверять актуальный контракт при выборе source. Исторический successful run или чужой manifest нельзя переиспользовать как новое разрешение.

[Release lanes](../runbooks/release-lanes.md) — target contract, пока platform plan не реализован; действующий strict path остаётся исполнительным. `RANGE_INELIGIBLE` Web route не обходить и не rerun без новой гипотезы/разрешения; выбрать разрешённый full package route.

## 3. Принять staging/provider/device evidence

- Зафиксировать отдельное разрешённое окружение, synthetic accounts, owned disposable fixtures и ограниченный список provider sandbox операций/получателей.
- Выполнить Q01–Q22 на candidate-bound runtime и обоих мобильных клиентах; сохранять readback и failures, не только screenshots/HTTP status.
- Проверить concurrency, outbox/broker recovery, payment ambiguity, cancellation compensation, tenant isolation, membership revoke, chat recovery, quiet hours и opt-out.
- Проверить observability: readiness/error rate, booking/payment invariants, queue/outbox age, retries/DLQ, invalid endpoints, worker lag. Наличие YAML alert не равно проверенному alert delivery.
- Любая запись в общую БД, provider request или реальная отправка требует явно разрешённого exact scope. Read-only audit не даёт такого разрешения.

## 4. Подготовить mobile artifacts

F принимает reviewed signing pipeline. #510 `22303758` имеет successful unsigned native CI `41203337199` и full CI `41203337054`; это не signed/archive/store acceptance. #504 остаётся отдельным Android signing candidate. Approved certificates/profiles/capabilities, signed artifacts и stores ещё требуется принять отдельным пакетом. Не создавать ключи или credentials в процессе аудита.

Для каждой платформы сохранить source SHA, dependency lock, toolchain, app ID, version/build, artifact SHA-256, approved signing certificate fingerprint и verification result. На iOS проверить provisioned entitlements/APNs environment/topic; на Android Firebase app/provider scope и release signing. Debug APK и simulator build не заменяют release artifact.

Проверить install/upgrade/logout, native commands/payment return, background/terminated push, deep links, offline recovery и совместимость с rollback backend. Владелец store подтверждает privacy/data safety, account deletion, support/privacy URLs, age/content ratings, screenshots, review access, экспортные декларации по применимости. Состояние кабинетов сейчас UNKNOWN.

## 5. Production preflight и decision

Использовать выбранный действующий runbook — [Timeweb](../runbooks/timeweb-lk2-beta.md) либо иной явно назначенный canonical production route. Наличие `deploy-production.yaml` не означает, что он соответствует выбранному target; в этом workflow API не обнаружено runs.

До утверждения нужны immutable source/artifact identities, совместимый schema/roles/ownership ledger, проверенный backup **с restore proof**, предыдущие image digests и [R1-ROLLBACK](R1-ROLLBACK.md), target identity, secrets custody metadata без секретных значений, observability/on-call и заполненный [GO-NOGO](R1-GO-NOGO.md).

Owner одобряет конкретные package/target и перечисленные переходы. Publication, shared migration, routing/provider configuration, app activation и store publication не выводятся из CI или предыдущего merge. Нельзя использовать этот документ как blanket approval. При изменении target/source/risk требуется новое решение; при неизменном явно утверждённом переходе повторный запрос не нужен, но preflight свежий.

## 6. После отдельно разрешённого перехода

Исполнитель соблюдает canonical order и bounds, затем фиксирует фактический artifact/runtime readback, readiness, пользовательский smoke, business invariants и observation. App rollout выполняется последовательно, worker — после compatibility checks. Provider acceptance и device receipt записываются раздельно.

При ambiguous write — остановить повторную отправку и выполнить предусмотренный authoritative readback; при failed gate/drift — остановить переход. Rollback не является универсальным разрешением менять БД/платежи. Не объявлять PRODUCTION success до фактической приемки этого уровня.

Store upload/internal testing, review submission и public rollout — разные состояния. Записать соответствующее owner approval и фактический store receipt для каждого исполненного перехода; отсутствие ответа от store не означает approval.

## Merge без неявной доставки

Fresh GitHub read 2026-10-31: repository variable `LK2_STANDARD_DELIVERY_ENABLED=true`;
`timeweb-standard-delivery` environment имеет branch policy без required reviewers. Workflow
`timeweb-standard-delivery.yaml` реагирует на завершённый успешный push/main CI и вызывает
production operator. Поэтому разрешение merge нельзя автоматически трактовать как разрешение
на этот вызов. Исторический RANGE_INELIGIBLE не является защитой от самого operator invocation.

Для согласованного source-only merge требуется отдельное разрешение на конкретный временный
цикл repository variable либо другой уже утверждённый способ изоляции. Предложенный цикл:
проверить исходный value/updated_at и отсутствие незавершённых main CI, delivery/publication/deploy
runs; установить false и подтвердить readback; повторить inventory; проверить exact PR head/main;
merge только разрешённого head; проверить resulting main SHA/tree и его push CI; дождаться
соответствующего workflow_run с terminal `standard-web: skipped` без transport steps. Перед
restore повторно проверить main, отсутствие outstanding main-CI/delivery runs и свой false,
затем вернуть исходный true и проверить readback. Любое чужое изменение требует переоценки.

Variable проверяется при admission job: false не останавливает уже запущенную/допущенную задачу.
Не отменять такие задачи и не переключать flag автоматически. Не восстанавливать true в finally:
поздно завершившийся main CI способен вызвать delivery. Отсутствие run или прошедшее время не
доказывает skip. Этот документ описывает процедуру, но не предоставляет authority; временный цикл и merge #508 одобрены отдельно. False установлен в 12:34:48 UTC и merge `14ebdca6` выполнен;
main CI `41201792854` success, downstream `41202697617`/`standard-web` SKIPPED без steps.
После quiescence/main/false readback исходный true восстановлен и проверен в 12:49:05 UTC.
Никакие transport, publication или deploy steps в этом цикле не исполнялись.

## Cross-repo compensation/readback prerequisite

До зависимого runtime opt-in принять compatible heads в порядке **ph-admin #57 → #58 → #59 → LK #264**.
#58 `cab33ce` physical ledger CI `41201269983` и #59 `70d3820c` physical TTL readback CI
`41204278865` success; это конкретные synthetic CI persistence cases. LK #264 `de95b8cc`
LOCAL 213 passed / 1 existing skip, CI `41204447158` success. Receipt readback возвращает ровно
семь полей после actor/tenant/operation/instance-scoped primary-majority read. Только уже завершённый
`FAILED / APPLIED / PROVIDER_REJECTED / null` позволяет local exact-marker CAS после исходного TTL.
Новый release, подпись или обновление observedAt не допускаются; незавершённое освобождение остаётся
pending. До наличия endpoint или при ошибке consumer остаётся pending, сохраняя совместимость.

Отдельно принять runtime HTTP path, Node-RED crypto/key custody, closed flags и provider sandbox
semantics; не включать producer/strict mode автоматически после merge. Этот пакет не разрешает
B02 owner v2, B03 CREATE, B04 paid cancellation, B05 signup или B06 native guards. #509/#510
нужны для push/build lanes, но не заменяют physical-device acceptance. B12 high исправлен на main;
финальный выбранный source всё равно требует собственного зелёного dependency/full gate.

## Приёмка последующих кандидатов

#511 `ed3854c3` имеет green combined CI, но не разрешение merge. Новый cycle delivery flag
нельзя выводить из уже завершённого approval #508: необходимы exact head и отдельная authority.
Перед каждым разрешённым source-only cycle повторить quiescence/current main/flag checks;
после merge дождаться exact main CI и corresponding delivery SKIPPED без executed steps,
затем проверить отсутствие новых relevant runs и только тогда восстановить исходный flag.

CUP #60 добавляет read-only preflight и optional expectations поверх #59. До использования
managed JOIN v2 принять совместимые owner/consumer heads и selector drift/replay tests;
не подменять explicit LEGACY отсутствующим instance. #512 debug APK и #513 unsigned iOS
проверяют build/consumer slices, но не открывают signed/store/device gates. Эти PR не входят
в source integration #511 и не активируются вследствие её merge автоматически.

## Установка совместимого owner v2 / SELF compensation

До отдельного runtime approval сверить CUP #60, LK #267 и LK2 #515 exact heads и законченный CI. Выполнить отдельную paired runtime приёмку selector/preflight/admission/receipt/recovery без конфигурационного downgrade. Проверить actual Node-RED crypto injection, closed opt-in flags, actor-scoped calls и provider mapping provenance; ключи и live config в этой программе не создавались.

Для #269 устанавливать только полный совместимый graph: bridge, owner authority read, lease reclaim и capability3 вместе. Самостоятельное включение probe запрещено контрактом: успешная capability без actual handler дала бы ложную совместимость. Fresh actor retry обязателен; background token не сохраняется. До rollout подтвердить exact canonical compensation и lost-response recovery на разрешённом target. Старые tenantless rows остаются pending; автоматической миграции нет.

#268 меняет только CI fixture runner для Mongo8. Его green monthly run не доказывает исправность production kernel/Mongo и не является разрешением менять production runtime.

#516 зависит от #513 и существующих server profile/direct-create permissions. Перед native acceptance проверить participant UUID route, OTHER projection, privacy denial, same-key retry и account-switch на реальном устройстве. Unsigned build и browser mock не являются подписанным IPA или device acceptance.

Android native CI#526 создаёт только unsigned verification APK: JDK21/SDK36, actual JVM report gate, appId/unsigned check и SHA256. Он не разрешает signing/store; APK не устанавливался на устройство и не считается релизом.
