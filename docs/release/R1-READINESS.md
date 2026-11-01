# LK2 R1 — аудит готовности к production release

## Обновление source/CI — 2026-11-01

Native station v3 [LK2#542](https://github.com/Z6v6e6r/lk2/pull/542) `c6a03c212e98371be59c25988cd5df1087809da8`: full CI41283587337 и iOS41283587178 SUCCESS. Full8053PASS/127SKIP, closedPG4, required28physical+8guards zeroSKIP, static/security/dependency/deployment и5Docker builds PASS; Swift49PASS/1app-hosted KeychainSKIP, unsigned simulator App build. LOCAL112Vitest/11JVM, actual Android/iOS component390/1280, independent review CLEAR28files. Read custody восстанавливает исходный GET; только v3 history имеет3MiB cap. Android APK/device acceptance этого head отсутствует.

Tournament API/Web [LK2#543](https://github.com/Z6v6e6r/lk2/pull/543) `89b4c7b950fbf3a9e307b3b5638b89b1354a2c44`: source34files/review CLEAR, LOCAL60PASS/5CI-onlyPGSKIP, types/lint/OpenAPI/bundle/render3901280 PASS. Исправлены leading BOM, invalid UTF8 и duplicate message IDs между страницами/сохранёнными rows. Full41284562173/iOS41284562172 SUCCESS:8079PASS/127SKIP, actor-contextPG5/5, closedPG4, required28physical8guards zeroSKIP, static5DockerPASS; Swift44PASS/1KeychainSKIP и unsigned simulator App build. Native tournament entry явно запрещён до Stage B; realtime/read/unread не заявляются.

Новый source audit B08: station285 и tournament71 не имеют подтверждённой связи с LK2 notification outbox/recipient ACL. Ordinary FCM/Web после claim не перепроверяли текущего endpoint owner, пользователя, opt-out/quiet hours и policy; исправление завершено в SOURCE/CI пакете #544 на базе525f042389b. Это реальные SOURCE gaps, а не только отсутствие device evidence. Монетарный settlement по-прежнему BLOCKED: Swagger недоступен, attributable refund/credit proof отсутствует.

Ordinary FCM/Web policy [LK2#544](https://github.com/Z6v6e6r/lk2/pull/544) `259c7bf872513af6290b5d098bbf8a9911d43dba`: SOURCE11/review CLEAR, LOCAL143PASS, types/lint/format0; full CI41285469025 SUCCESS:7644PASS/126SKIP; новыеPG17/17 и existingFCM2/2, closedPG4, required35physical8guards zeroSKIP; static/worker Docker PASS. Current endpoint/recipient/policy проверяются после lock waits; suppression/intent/outbox атомарны, busy ordinary claims не расходуют попытку. Existing uncertain ordinary retries не изменены; social recipient/ACL bridge этим пакетом не реализован.

SOURCE-защита возвратов [LK#286](https://github.com/Z6v6e6r/lk/pull/286) `a644b521fec1aef533a8247e0f3104b04437e9fa`: новый managed SELF CUP release из aggregate-only observation запрещён на daily/canonical/in-flight путях; historical exact APPLIED/replay сохранены. Review CLEAR6files; LOCAL42+234+8PASS,1existing fixtureSKIP. Mongo CI41286439266 SUCCESS:29cases, включая4physical и новый контрпример атрибуции, zeroSKIP; inherited monetary27/worker22 PASS. Full41286439267 SUCCESS. Это исправляет unsafe SOURCE authority, но не создаёт attributable provider return contract и не завершает фактический возврат.

Station notification feed: локально подготовлены 15 файлов и 54 unit/contract cases, отдельные 2 release-packaging tests PASS; 6 физических Mongo cases пока CI-only. Независимое review нашло P0 в зависимости CUP#72 `6a6301197cecbc90cb6ba37f55c520f3d39564c1`: STATION→FRIENDS→REMOVE/APPROVE→STATION сохраняет старый membership epoch и может снова разрешить старого получателя. Feed не считается готовым. Исправление CUP должно запретить type flip после adoption и атомарно закрыть гонку type update/adoption; уже несогласованное состояние не ремонтировать автоматически. Затем нужны повторное review и physical CI. Downstream LK2 import/outbox/dispatch ACL ещё не реализованы.

## Предыдущая контрольная точка — 2026-11-01

Fresh GitHub main readback 2026-11-01 07:30 UTC: LK2 `a37c05a2b2a28c8d53cb14447d357ad9a96bda1f`, LK `608ebe20689e74749fcd8cea6ab97d35c335f214`, CUP `83b1c17bc4c5edaec65387b25b5695e48337c3cf` — без drift. Проверены новые открытые PR; LK#284 относится к отдельному FPR UI и не включён в R1 batch. Все новые R1-пакеты ниже остаются Draft вне main.

Station ordering/unread owner: [LK#285](https://github.com/Z6v6e6r/lk/pull/285) `19e48d4efe99e2ee7f606328cb100b833762b688` и [CUP#72](https://github.com/Z6v6e6r/ph-admin/pull/72) `6a6301197cecbc90cb6ba37f55c520f3d39564c1` — полный CI41281309321, Mongo41281309359 и CUP41281323024 SUCCESS. Stream27PASS включает4 физических Mongo cases; CUP lifetime3physicalPASS включает новый frontier/baseline/restore case, zeroSKIP. Contiguous publication, исходный READ receipt и baseline нового ACTIVE epoch проверены; старые writers отвергают lifetime/outbox v2. Исправлена гонка stale READ после worker cleanup и более новой отметки. Это SOURCE/CI, без adoption или runtime-активации.

Tournament message owner: [CUP#71](https://github.com/Z6v6e6r/ph-admin/pull/71) `cb413d41c59e0dd14b400884ea71c154fb4520dc`, CI41280695379 SUCCESS: owner17/actor4/readiness3 и9 физических Mongo subcases (TAP10 с parent), zeroSKIP. Dedicated actor assertion, текущая JOIN generation или явно назначенный organizer, original request receipt, contiguous publication и read-only history/status реализованы. Исправлена повторная acceptance после очистки исходного intent. LK2 пользовательский API/Web consumer ещё в работе; native, directory/realtime/read/unread и runtime acceptance этим пакетом не закрыты.

Web stream consumer: [LK2#541](https://github.com/Z6v6e6r/lk2/pull/541) `e38dd886e6c3b8629b02ae415712f5314fb9a76e`, LOCAL262 различных текущих случаев (с переиспользованием неизменённых проверок), Node/Web types/lint/format и synthetic390/1280 PASS. Независимое R3 review финальных33 файлов CLEAR; стандартный bundle пересобран. Исходный GET recovery, запрет read-through через непоказанный gap, изоляция token errors от общего breaker, очистка private view при401/403 и обе очередности ACK/history dedup проверены. Full41281893990 и iOS41281893820 SUCCESS:8014PASS/127SKIP, closedPG4, required28physical+8guards zeroSKIP, static/security/dependency/deployment и все5Docker builds PASS; iOS44PASS/1app-hosted KeychainSKIP и unsigned simulator build. Native пока использует прежний v2; native v3 и общая интеграция остаются обязательными.

Владелец разрешил обе точные локальные интеграции; они выполнены и отправлены в свои Draft PR. [#525](https://github.com/Z6v6e6r/lk2/pull/525) `f042389bb09703a75b502e793b28985028cc1f54` включает согласованные #52630598d97 (с #524) и #523f5c33149. LOCAL302 функциональных и22 delivery-contract проверки,54 изменённых TS файла с зависимостями:0 diagnostics. Guard suite:48PASS и один отдельно повторённый PASS после временной ошибки разбора Darwin ps; это составное evidence, не полный повтор49. Android41274690263 SUCCESS:16 обязательных JVM cases, unsigned release APK artifact13070946919 (ZIP SHA256 `207921dd54feadf82e42ff3e84750617a412a0c9ee1692ab6ba70af591facbd6`, expires2026-11-15). iOS41274690260 SUCCESS:30PASS/1app-hosted Keychain SKIP и unsigned simulator build; full41274690282 SUCCESS:7555PASS/126SKIP; SELF PG9, managedJOIN PG3, TRAINING PG6, closedPG4. Required35physical+8guards zeroSKIP (lifecycle13/comms10/Rabbit4/notificationPG4/notificationRabbit4); static/security/deployment и все пять Docker builds PASS. Независимое review и exact outgoing scans PASS.

[#528](https://github.com/Z6v6e6r/lk2/pull/528) `cd4b3d27b156b56923fb0a96dfadad8f9b92b19f` содержит разрешённый parent#5273143ffbe. Итоговое дерево `9dd1d57c2a087d1a418a31bd92f6437cfc04bfeb` побайтно совпадает с прежним26c5ceaa: TRAINING bundle сохранён, исправление JOIN fixture уже присутствовало. Предыдущие54 LOCAL проверки переиспользованы; merge-custody review и outgoing scan PASS. Конфликт снят. Initial fullCI41274959565:7546PASS/126SKIP, TRAINING PG11 и managedJOIN PG10 PASS; один устаревший current-inventory testFAIL. Test-only `fbf29562bd5f359031f1ff6cda0be7b4ed4e712d` меняет только +9→+10 и список с0108, frozen ledger и rejection сохраняются. LOCAL1PASS/27 name-filteredSKIP, review/scans PASS; corrected fullCI41275879957 SUCCESS наfbf29562:7547PASS/126SKIP, TRAINING PG11/11, managedJOIN PG10/10, closedPG4/4, required27physical+8guards zeroSKIP; static/security и все пять Docker builds PASS. Прежние сообщения об ожидающих разрешениях или заблокированном запуске CI ниже являются историческими.

Правило турнирного чата реализовано отдельным SOURCE/CI пакетом: явное назначение профиля в [LK2#539](https://github.com/Z6v6e6r/lk2/pull/539) `1de0ef602708a4413f2ea99cd3b21d8b88fd0cbd` и [CUP#70](https://github.com/Z6v6e6r/ph-admin/pull/70) `5291e2aba00869f0fb543fea982232353b208753`. Full CI41277973675 и CI41278160399 SUCCESS, включая новые PostgreSQL3 и Mongo8 physical cases. Dedicated readonly lookup, tenant/station authorization, revision CAS, постоянный original receipt и GET-only восстановление прошли независимое review. Исправлены позднее открытие редактора после logout и приём невозможного revision receipt. Конфигурация отключена; ключи не создавались. Это **не** реализация tournament chat send/read/realtime ACL.

Native station consumer [LK2#540](https://github.com/Z6v6e6r/lk2/pull/540) `ce1b9249f0a824ce01a8136776f7f372b0469143`: full CI41278040418 и iOS41278040429 SUCCESS. Android shared UI и отдельный iOS entry используют исходный UUID; при pending native ручной Send и reload выполняют только GET. LOCAL/review/secret-PII scans прошли. Детальные counts и ограничения — в [R1-READINESS.md](R1-READINESS.md). Exact unread/gap-free catch-up реализованы в новых source-пакетах выше; native adoption, source integration и device acceptance остаются открыты. Все три PR — Draft, без main merge или live activation.

Evidence новой пары: LK2#539 — 9 файлов, LOCAL24 route PASS; полный CI7862 PASS/126 SKIP, новые organizer PG3, closed-game PG4, required27 physical+8 guards zeroSKIP; static/security/dependency/deployment и пять Docker builds PASS. Standard runtime bundle пересобран побайтно прежним: generated diff отсутствует. CUP#70 — 13 source/test/doc файлов и один workflow; LOCAL service10/client3/UI16/inherited owner15, types PASS, actual component 390/1280. Mongo CI: восемь физических subcases (TAP9 с enclosing parent), zeroSKIP, включая competing assignment/revoke/JOIN, lost ACK, expiry clock, stale editor, restore/redaction. Все source hashes зафиксированы в SOURCE3 manifest `cd98463767be0ddaed78f7eb01d7322de014c7cbc5f12df51bda3b771a7f082f`; scoped security/reliability/compatibility review CLEAR.

Evidence native#540 — 28 файлов, SOURCE2 manifest `6144173c9b1e020505babf5eef6eda13c3a774ff864de2bb0caef0c62ad9e647`, R3 review CLEAR. LOCAL173 tests первоначального closure и26 перекрывающихся final delta tests (не суммировать), JVM12, Swift Debug/Release по44 PASS/1 existing Keychain SKIP, types/lint/format и component390/1280. Full CI7920 PASS/127 SKIP, closedPG4 и required28 physical+8 guards zeroSKIP, пять Docker builds PASS. iOS CI44 PASS/1 Keychain SKIP и unsigned simulator app build PASS. Новый Android APK и physical device/process-death acceptance отсутствуют. Preview/browser остановлены. Task-branch staged/outgoing scans Gitleaks и узкий added-line PII scan PASS без исключений; это не полный PII scanner.

[#538](https://github.com/Z6v6e6r/lk2/pull/538) `0dfc0458879a7ed1eece423713bbbce215ab4046`: bounded NO_PAYMENT organizer CANCEL реализован для Web/Android/iOS с серверной canonical capability, original-principal fence на SDK retry и GET-only восстановлением неоднозначного результата. LOCAL/review/scans прошли; unsigned iOS41274254446 SUCCESS, static и пять Docker builds PASS. Full41274254490:unit7872PASS/127SKIP и closedPG4PASS; required physical gate остановился на новом fixture: started case нарушал существующий SQL constraint join_cutoff_at<=starts_at. Test-only `7faff1b698d0424c284a41754445fcdb6866fac4` исправляет согласованность fixture timestamps/cancellation metadata, assertions неизменны; LOCAL6PASS/14CI-onlySKIP/typeslint0, independent review/scans PASS. Corrected full41275758102 и iOS41275758096 SUCCESS на7faff1b6:7872PASS/127SKIP, quarterPG12/closedPG4, required28physical+8guards zeroSKIP, включая новую capability fixture; static/security и все пять Docker builds PASS. Native local CANCEL SOURCE/CI завершён; устройство/runtime не приняты.

Решение R1 остаётся **NO-GO**. Эти операции — локальные разрешённые merge и task-branch push; новых merge в main, публикаций, deploy, real DB/provider writes, signing/store activation не было. Этот раздел имеет приоритет над более ранними checkpoint ниже.

## Текущий статус — 2026-11-01: закрытые SOURCE/CI проверки

[LK#283](https://github.com/Z6v6e6r/lk/pull/283) `19e66ee0161f240dceb38853e6a9c6654168f4d3` (runtime784cea38, base#270) закрыл bounded SOURCE/CI защиту monetary SELF dispatch: полный [CI41272659955](https://github.com/Z6v6e6r/lk/actions/runs/41272659955) и [Mongo41272659903](https://github.com/Z6v6e6r/lk/actions/runs/41272659903) SUCCESS. Mongo27/27, включая шесть физических conflict/recovery cases, zeroSKIP; inherited owner28/28 и worker22/22. LOCAL145PASS/6CI-onlySKIP, test-only historical current-source rebind3/3, independent R3 review и staged/outgoing PII/secret scans PASS. Baseline SERVICE и dispatch marker сохраняются до HTTP; ACK-loss и graph observer не дают повторной отправки. Money остаётся UNVERIFIED; crash-before-HTTP может удерживать прежний game-wide gate. Это не settlement/provider/runtime acceptance.

**Release NO-GO; SOURCE/CI и runtime acceptance разделены.** Нативный quarter CREATE [#533](https://github.com/Z6v6e6r/lk2/pull/533) `d57e3e7dde5593f16cf1151587d058d2b8b83e21`: full41264822510 и iOS41264822518 SUCCESS. Quality7748PASS/126SKIP, quarterPG12/12, closedPG4/4, required27physical+8guards zeroSKIP; source/static/dependency/deployment/secret и пять Docker builds прошли. Исправления после runtime2aabc692 затрагивают только тесты: obsolete casts, ожидание bounded quarter route и архивный fixture исторического controller pin. Текущему изменённому blob старый controller по-прежнему отказывает. Android APK/device acceptance не получены.

Web station chat [#535](https://github.com/Z6v6e6r/lk2/pull/535) `de952dc4e882dd3ebf332300c4c9edb81cb97793`: 45 reviewed files, SOURCE/LOCAL verified, initial full41265870441:7802PASS/126SKIP/1FAIL (test ожидал callback до завершения WebCrypto), iOS41265870267 SUCCESS. Test-only2c4becf8a242366fb964eb3da53dd1c48ad11378 усиливает ожидание и custody assertions;8LOCALPASS/typeslint0/review/scans PASS. Corrected full41266782435 и iOS41266782380 SUCCESS:7803PASS/126SKIP,quarterPG12/12,closedPG4/4,required27physical+8guards zeroSKIP; source/static и пять Docker builds PASS. Сервер получает проверенный user-scoped LK Bearer; actor/session/mapping refusals не открывают общий circuit breaker. UUID+hash сохраняются до POST, reload только GET, нет повторного POST/fallback; ACL denial очищает историю, logout закрывает поздний ACK. LOCAL17suites/130PASS плюс изменённые subsets (не суммировать), types/lint/OpenAPI и synthetic390/1280 прошли. Web-only: native composer намеренно недоступен, device/delivery acceptance не заявлены.

Неиспользованный reserve expiry: [CUP#69](https://github.com/Z6v6e6r/ph-admin/pull/69) `e8e16b2dc79c0970f99100ff698affcc2465297d` → [LK#281](https://github.com/Z6v6e6r/lk/pull/281) `70fd376bfd37bed3e69b3ff432cb09381ea2df90` → [LK2#536](https://github.com/Z6v6e6r/lk2/pull/536) `63bd45ffc1abe9a192a2164c83b23d47181dbaee`. 26 reviewed files; LOCAL LK79PASS/7MongoSKIP, legacy114PASS/1SKIP и split29PASS; CUP lifecycle/preflight/readback PASS, physical import types0; LK2 72PASS/20PGSKIP, types/lint0. LK Mongo41266210816 выявил test-only ошибку: после скачка времени fixture повторно использовал истёкший actor JWT; runtime правильно отказал. Test-only7f375a31c427b7c7e820a771ec9b941875b7fad2 сохраняет refusal и проверяет recovery с новым actor proof; LOCAL1PASS/7CI-onlySKIP, review/scans PASS. CUP CI отсутствовал из-за фильтра base branch; CI-only764e809e5a2cb652faf8cdaf81ea3d8557bf7fd9 добавляет ровно базу #67, пять CI guards/review/scans PASS. Исправленный LK Mongo41266536638 SUCCESS:87/87 включая7physical, zeroSKIP; worker22/22. Фактический LK CI использовал mongo:8.0 (проверено по pull/create в логе), а не Mongo7 из предварительного handoff. CUP full41266419414 SUCCESS: реальная replica-set гонка confirm/release в обоих порядках, loser zero mutation, lost ACK/post-TTL; entitlement skipped=0/provider writes=0. LK full41266536635 SUCCESS. LK2 full41266216875 SUCCESS:7755PASS/126SKIP,quarterPG20/20,closedPG4/4,required27physical+8guards zeroSKIP, source/static и пять Docker builds PASS. Полный snapshot и Mongo-clock CAS должны доказать отсутствие dispatch до signed release; ATTEMPTING остаётся UNKNOWN. Сначала canonical RELEASED и исходный schema2 receipt с checksum, затем reclaim. Все staged/outgoing secret scans прошли без исключений; source manifest SHA2563d3cd929f60a5553b0050b2c9d314101200ca54fbd8a4a9e18b22af0a76a7159. Собранный LK2 runtime bundle byte-identical HEAD854147ab, generated файл не менялся.

Station history v2: [LK#282](https://github.com/Z6v6e6r/lk/pull/282) `f6520b031e29db90845bda4b9b56492f2520185f`, full [41268575186](https://github.com/Z6v6e6r/lk/actions/runs/41268575186) и Mongo [41268575195](https://github.com/Z6v6e6r/lk/actions/runs/41268575195) SUCCESS. 20/20 history cases, включая четыре физических Mongo8, zeroSKIP; worker22/22. Guarded graph composer отвергает broad/ambiguous catch/complete observers до добавления приватных read nodes; исходные auth ingress и v1 сохранены. Первое full CI остановилось на синтетическом phone literal в negative fixture; test-only correction проверяет phone-only и foreign-ID с совпадающим телефоном ACTIVE member. Exact configured added-line PII scan и Gitleaks PASS без исключений, runtime/scanner неизменны.

[LK2#537](https://github.com/Z6v6e6r/lk2/pull/537) history head `8651a0db4ccc5362ca9eed0437fb8c89c1179fd3` прошёл full [41267653658](https://github.com/Z6v6e6r/lk2/actions/runs/41267653658) и iOS41267653681:7826PASS/126SKIP,closedPG4/4,required27physical+8guards zeroSKIP,static и пять Docker builds. Actual LK helper fixture SHA256 `50e02af00ef28ad2163f6d7909bd748c3741bbac251da3c4f7581ddce4f0440a` принят реальным LK2 parser. Строгий tuple cursor, duplicate-only continuation и repeated-cursor rejection проверены. Текущий continuation `5f8cf40798129f5d9d591121060ad70dae9e5734` добавляет station first-page GET на online/focus/visible, coalescing, cleanup fence и restart cursor; SOURCE/R3 CLEAR, LOCAL77PASS (Chats69+Composer8), types/lint0. Его full [41269740593](https://github.com/Z6v6e6r/lk2/actions/runs/41269740593) и iOS41269740624 SUCCESS:7835PASS/126SKIP,quarterPG12/12,closedPG4/4,required27physical+8guards zeroSKIP; static/dependency/deployment/secret gates и выбранные Web/API Docker builds PASS.

Исторический gap v2 (новый SOURCE/CI owner285/72 и consumer541 описаны выше; runtime ещё не активирован): прежний owner использует reservedAt как createdTs; поздняя публикация может оказаться позади прочитанного cursor. История COMMITTED может появиться до event proof; CONFIRMED status проверяет оба. Свежая первая страница не является gap-free catch-up. Нужны согласованные owner acceptance sequence, непрерывная подтверждённая граница публикации и current-epoch read marker; timestamp/Date.now и чужой PG last_read_sequence их не заменяют. Никакой такой migration/backfill не выполнен. Полная runtime browser E2E недоступна: repository local:status подтвердил отсутствие reachable local Linux Docker engine; DB/containers не создавались.

Свежие main проверены 2026-11-01: LK2 `a37c05a2b2a28c8d53cb14447d357ad9a96bda1f`, LK `608ebe20689e74749fcd8cea6ab97d35c335f214`, CUP `83b1c17bc4c5edaec65387b25b5695e48337c3cf`; новые результаты относятся к Draft heads. B07 PARTIAL: station send/history SOURCE/CI есть, точный unread, полное восстановление, tournament chat и native station остаются открытыми. CUP #64 имеет authoritative LOCAL_ONLY roster, но поля createdBy и allowedManagerPhones не доказывают principal организатора. Явное назначение профиля организатора в CUP согласовано; реализация identity/assignment ещё в работе, имя/телефон механики права не дают.

Ни один из новых PR не merged/activated. Production configuration, provider, shared DB, signing и stores не изменялись. Следующие разделы сохраняют историю; при расхождении приоритет у этой контрольной точки.

Текущая классификация: B03 PARTIAL — source и локальное восстановление резерва подготовлены, paired CI прошёл; интеграция/provider acceptance открыты; B07 PARTIAL — station Web send/status/history подготовлены; точный unread, полное восстановление, native и все четыре chat contexts ещё не закрыты. B04 monetary settlement, B08 device/provider push, B09 signing/store и B11 backup/restore остаются release blockers.

## Актуальная карта R1: main и подготовленные Draft PR

Статус относится к полному требованию. VERIFIED SOURCE/CI для отдельного пакета не означает VERIFIED runtime. Свежие main SHA и точные CI перечислены выше; неизменённые Auth/Profile/trigger foundations переиспользуют предыдущий source audit и общий CI, отдельная новая runtime-проверка не проводилась.

| Требование                          | Статус R1 | Подтверждённая часть                                                                                       | Остаток                                                                                |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Auth / Profile                      | PARTIAL   | Existing self-only/session/tenant/revoke tests; общий CI                                                   | Login/refresh/logout/privacy на двух устройствах и выбранном runtime                   |
| Subscriptions / entitlement / usage | PARTIAL   | CUP#57–#60, #65–#69; LK owner и LK2 reserve/recovery пакеты, physical CI                                   | Согласованная интеграция, полный catalogue/target parity, provider acceptance          |
| Game CREATE                         | PARTIAL   | Quarter-only60min/4places/organizer1: LK277/281, CUP67/69, LK2532–534/536 SOURCE/CI                        | Runtime canonical convergence, coherent writer rollout, provider/device                |
| Game JOIN                           | PARTIAL   | Managed owner/consumer#515/#527 и исходная generation, physical PG/Mongo                                   | Интеграция native, production guards/provider acceptance                               |
| Game LEAVE / CANCEL                 | PARTIAL   | FREE/SERVICE SELF#519/#521, managed compensation LK269; monetary fence LK283; native NO_PAYMENT CANCEL#538 | Monetary settlement, paid organizer/provider/device acceptance                         |
| Viva payments / refunds             | PARTIAL   | LK1 CURRENCY/DEPOSIT mechanics и LK283 original-booking dispatch fence SOURCE/CI                           | Attributable original-payment credit/refund proof, recovery и native acceptance        |
| Training registration               | PARTIAL   | #520/#528 и LK271/276; physical PG11 в exact-head#528                                                      | Paid/provider, integration и native/device acceptance                                  |
| Tournament registration             | PARTIAL   | CUP64 LOCAL_ONLY owner, LK2529/530/531 Web/Android/iOS SOURCE/CI, PG7                                      | Paid/provider/WAITLIST, common integration и device                                    |
| Eligibility / restrictions          | PARTIAL   | Server rules, exact bindings, CUP62 MALE/FEMALE profile checks; MIXED unrestricted                         | Все способы участия, real profile/catalogue и usage parity                             |
| Personal / game chats               | PARTIAL   | Existing owner/realtime; bounded native candidates512/513/518                                              | Common native integration, reconnect/offline/device acceptance                         |
| Community / tournament chats        | PARTIAL   | Station owner285/72 and tournament owner71 SOURCE/CI; Web541 full/iOS CI SUCCESS; organizer539/70 CI       | Tournament consumer, native v3/common integration, runtime/device acceptance           |
| Basic station communities           | PARTIAL   | Exactly-one station, confirmed GAME/TRAINING/CREATE producers; LEFT generation rules SOURCE/CI             | Coherent rollout/drain, legacy adoption boundaries, both-device acceptance             |
| Push / trigger campaigns            | PARTIAL   | APNs/FCM/outbox/retry/preferences foundation, physical CI#511/#523                                         | Real provider/device receipt, opt-out/quiet hours/token lifecycle acceptance           |
| iOS / Android release artifacts     | BLOCKED   | Unsigned Android integration525 and iOS531/533/538/540 simulator builds; no release signing                | Common source integration, signed artifacts/install/upgrade/stores                     |
| Deployment / backup / rollback      | UNKNOWN   | Source runbooks и immutable artifact contracts                                                             | Selected integrated package, fresh target/backup restore proof, exact release approval |

## Quarter CREATE Web/API/native/station — 2026-11-01

**PARTIAL, release NO-GO.** Web/API [#532](https://github.com/Z6v6e6r/lk2/pull/532) имеет проверенный core1da1dd4b и green head90b2ba2b (full41259758605, iOS41259758618:7711passed/126skipped, quarterPG12/12, required27physical+8guards zeroSKIP). Текущий96be6b4d исправляет только ссылку на фактический `/games/new?quarterCreate=1`; LOCAL29form tests/types/lint PASS, iOS41261792563 и full41261792576 SUCCESS:7711passed/126skipped, quarterPG12/12, closedPG4/4, required27physical+8guards zeroSKIP.

Нативный [#533](https://github.com/Z6v6e6r/lk2/pull/533), runtime `2aabc6924459851a3319d1b684b1f81bcce92a5a`, current `c69fe2c2ed5037e2ef841b428da383e98522f6d3`, реализует Android/iOS CREATE на 1/4 корта через пять ограниченных authenticated routes. Исходный body/key сохраняется до отправки; reload только читает, reconcile ручной, logout закрывает principal до cleanup. SOURCE/LOCAL/R3 review verified; iOS41262561148 SUCCESS:36 Swift tests, один явный macOS Keychain SKIP, пять новых quarter cases PASS, unsigned simulator App BUILD SUCCEEDED. Initial full41262561020 выявил две лишние casts в существующем custody test. Test-only8dbc8ec6 удаляет их:10affected tests/types/lintPASS; second full41263018207 завершился с7747PASS/126SKIP и одним старым MobileApp denied-route fixture failure. Test-onlyc69fe2c2 исправляет ожидание boundedquarter при сохранении zeroCREATE/payment assertions; MobileApp9/types/lintPASS, final full41263945947 ожидается; device acceptance отсутствует.

Station producer [#534](https://github.com/Z6v6e6r/lk2/pull/534), `fd2f87fd4e9862f7e1f326505568a7f8f42efff4`, сохраняет исходный station intent до dispatch, после подтверждения атомарно пишет receipt/marker/outbox и проверяет исходную generation в worker. SOURCE/LOCAL/R3 review verified; quality-full41262584637/job124718764395 SUCCESS:7734passed/126skipped,quarterPG18/18,closedPG4/4,required27physical+8guards zeroSKIP; source-quality/dependency/deployment/secret и5Docker SUCCESS. JSONB key-order regression воспроизведена и исправлена;91composite LOCAL PASS,18PG SKIP, bundle2/currentinventory1 PASS. Исторические NULL не переусыновляются. Receiver [LK#280](https://github.com/Z6v6e6r/lk/pull/280) bfacff70 уже green full/Mongo:34station cases,9physical zeroSKIP.

Остаток: corrected fullCI#533, согласованная интеграция с tournament/native ветками, expired reserve-only reconciliation, receiver/API/worker rollout и drain старых writers, PROVIDER/device acceptance. Подготовленные миграции не выполнялись; production configuration и flags неизменны. Новых merge/activation/live действий нет.

## Текущая контрольная точка: сообщения станции — 2026-11-01

[LK #279](https://github.com/Z6v6e6r/lk/pull/279), `952031f79789748645fbcfb2210ef68f9eb32d03`, добавляет отдельные versioned send/status routes с проверенным actor и текущим ACL. FullCI41259421753 и MongoCI41259421752 SUCCESS:24/24message cases, включая четыре физических, zeroSKIP; worker release22/22. GET исходного запроса не создаёт и не восстанавливает записи; только точное message/event proof позволяет CONFIRMED. UNKNOWN/403/404 не разрешают замену ключа. Независимое R3 review и оба secret scans прошли. Это SOURCE/CI prerequisite для LK2 consumer, не завершённый пользовательский чат.

[LK #278](https://github.com/Z6v6e6r/lk/pull/278), `0de4cf4bcf8c990fa902de906e9174b89c2550b6`, и [CUP #68](https://github.com/Z6v6e6r/ph-admin/pull/68), `16fa3e5ca042167a3e91bbe3c99f36d80b8b5928`: **VERIFIED SOURCE/CI**, общий B07 остаётся **PARTIAL**. Независимое review подтвердило принятие сообщения через атомарную проверку прав и эпохи, сохранение исходного запроса и восстановление после потери ответа. Конкурентная смена типа или бан закрыты проверкой полного снимка перед отправкой по старому пути.

LK full CI [41257193838](https://github.com/Z6v6e6r/lk/actions/runs/41257193838) и Mongo CI [41257193822](https://github.com/Z6v6e6r/lk/actions/runs/41257193822) успешны: 16/16 проверок сообщений, включая три физических MongoDB-сценария, без пропусков; worker release — 22/22. CUP CI [41257209136](https://github.com/Z6v6e6r/ph-admin/actions/runs/41257209136) успешен: две физические проверки актуального сервиса, включая сохранение сообщения при административных изменениях, без пропусков; build/artifact gates прошли. Оба PR остаются Draft, не merged и не активированы.

Остаток: клиентский путь LK2, стабильная пагинация/непрочитанные/reconnect, все четыре контекста чата, native/device acceptance, согласованная установка, retention и фактическая долговечность MongoDB. Серверный SOURCE/CI не заменяет эти уровни. Общий release — **NO-GO**.

Ниже сохранены предыдущие контрольные точки; текущие статусы — в разделах выше.

## iOS tournament source checkpoint — 2026-11-01

[LK2#531](https://github.com/Z6v6e6r/lk2/pull/531) `99f5d942d4a05e468698f256732bc7f7d5372c64` supplies the reviewed concrete iOS LOCAL_ONLY tournament journey over#530. LOCAL96regression/final22overlap, types/lint/render and independent15-file review passed. NativeCI41254366026 SUCCESS: Swift37total/1explicit Keychain simulator-only skip/0failures, six tournament tests passed, unsigned simulator build succeeded. FullCI41254366038 SUCCESS:7670passed/126skipped, tournamentPG7/7, closed-migrationPG4/4, required27physical+8guards zeroSKIP and all five Docker/static/dependency/deployment gates. Outer logout fence is process-local before push cleanup; durable Keychain intent retains its existing timing. No device/WKWebView/process-death/provider/store acceptance is claimed.

## Paired quarter CREATE source checkpoint — 2026-11-01

[CUP#67](https://github.com/Z6v6e6r/ph-admin/pull/67) `802ed017b98b20f7b5e89b7c3899ffcc21e1d5e2` and [LK#277](https://github.com/Z6v6e6r/lk/pull/277) `59d3880c0ce6f1dfa1b4eecb2ff31bafe8795f65` supply the previously missing actor-bound target producer and durable original quarter CREATE owner. CUP derives private tenant/client identity internally; LK pins whole/quarter evidence before reserve, persists original successful CREATE ID before organizer booking, and never repeats an ambiguous CREATE. LOCAL LK229PASS/5SKIP; CUP23 actor cases plus paired actual service/legacy/quarter/trusted/runtime/lifecycle suites and typechecks passed. Independent paired R3 review verified33source+2workflow hashes. Outgoing scanners passed; LK needed one independently classified exact synthetic-fixture fingerprint exclusion, with no repository scanner change. LK Mongo41254002352 passed56/56 including all four actual Mongo cases. Initial LK full41254002381 failed a stale current-source hash; test-only59d3880c preserves historical pins, passes29 LOCAL cases and review, and current full41254342434 SUCCESS. CUP41253980880 failed a duplicated synthetic publication key; test-only802ed017 namespaces that fixture, preserves the unique index/runtime and passes scoped noEmit/scanner. Corrected CUP fullCI41254507939 SUCCESS, including build and actual v3 target/preflight/reserve/lost-ACK replay, zero skips. These are unmerged SOURCE candidates, not provider/runtime acceptance.

Remaining CREATE path: exact LK2 consumer/canonical projection and original-operation recovery; receipt/import convergence; CREATE-specific station enrollment; expired reserve-only reconciliation; LK2 consumer physical CI and installed graph/retention/provider acceptance. A private successful receipt alone does not make an LK2 draft a canonical scheduled game.

## Android tournament checkpoint — 2026-11-01

[LK2#530](https://github.com/Z6v6e6r/lk2/pull/530) `4406a3b2032394af4d666442370a26de130a4e7e` adds the reviewed Android source consumer over#529: concrete tokenless public discovery, authenticated JOIN/LEAVE/status/retry, synchronous logout fence and narrow empty-text POST compatibility. LOCAL209regression/67focused/final41subset (overlap, not summed), JVM12, transitive types/lint and rendered390/1280 passed; independent review/scanner CLEAR. FullCI41252711408 and iOS41252711403 SUCCESS. Quality job124689447401:7651passed/126skipped; tournamentPG7/7, trainingPG11/11, closed-migrationPG4/4; required27physical+8guards with zero skips. All five Docker and static/dependency/deployment gates passed. No APK/AAB or device acceptance: unsigned Android CI remains dependent on approved#526 integration; no workflow dispatch/copy or pending integration bypass occurred.

## Web tournament consumer — 2026-11-01

[LK2 #529](https://github.com/Z6v6e6r/lk2/pull/529), head `3041f0d946df3dc98be6d0e11610cc6cc151419f` (runtime source `40d450c0`), supplies the default-off Web/API consumer for CUP#64 LOCAL_ONLY nonmonetary tournaments. JOIN, original-generation LEAVE and explicit retry retain the original actor, request and owner operation in PostgreSQL0109; roster ownership remains CUP. Browser custody survives offline/reload and rejects late logout/account responses. Disabled/unready status prevents new commands. Native and paid/provider/WAITLIST journeys remain open.

LOCAL119 tests passed; all seven physical PostgreSQL cases passed in CI41250686400. Scoped types/lint/OpenAPI and rendered390/1280 synthetic UI passed; the generated runtime bundle passed two byte/import/direct-execution checks. Independent source4/bundle review and exact outgoing secret scan passed. Full local check stopped on12 unchanged sparse-checkout/ignored-preview files, with no changed-source lint failure; this is not a full local pass. Initial fullCI41250686400 passed7621tests/126skipped but failed only the stale current-directory migration inventory expectation; all seven tournament and11training PostgreSQL cases passed. Full static checks, all five Docker builds and iOS41250686445 passed. Test-only3041f0d9 updates the current count/list for0108/0109 while retaining the frozen approved ledger and its rejection; focused LOCAL test passed. Corrected-head fullCI41251823614 and iOS41251823658 SUCCESS. Quality job124686843274:7622passed/126skipped, tournamentPG7/7, trainingPG11/11, closed-migrationPG4/4 and required27physical+8guards with zero skips. Diagnostics artifact13061488859 (ZIP SHA256932caa56158270e494bec1ceb7d6faeb81cbf3563f0e4edd132f6d2719d189f2). #529 is stacked on#528 and does not resolve its separate parent conflict. No merge, migration, activation or deployment occurred.

Training evidence reuse: #529 run41250686400 executed all11 `training-registration-postgres.test.ts` cases successfully. Git diff from#52826c5ceaa to#5293041f0d9 is empty for the training API/runtime/repository/test files,0108 migration and station worker files. This is physical CI evidence for those unchanged sources from the descendant run, not a green overall#528 run or resolution of#528 parent conflict.

## Tournament and quarter CREATE checkpoint — 2026-11-01

[CUP #64](https://github.com/Z6v6e6r/ph-admin/pull/64), head `9d728414428bd5f02f7acbad5d07b1cff8e59d17`: **VERIFIED source/CI for the explicit LOCAL_ONLY nonmonetary subset**. CI [41246247607](https://github.com/Z6v6e6r/ph-admin/actions/runs/41246247607) SUCCESS, including full typecheck/build/artifact gates and six actual MongoDB cases. Private authenticated JOIN/LEAVE/read preserve the original actor, operation and generation; roster, receipt and audit use one majority CAS. Permanent adoption fences protect against legacy writers and restore even when disabled. LOCAL:24 focused cases and11 compatibility scripts. The default-off owner now has the #529 Web/API source candidate; runtime acceptance remains absent; paid, subscription and Viva-backed tournament participation remain outside this result.

[CUP #65](https://github.com/Z6v6e6r/ph-admin/pull/65), head `5812113c13ff3e30d0e0f87c8f62d09f067b987f`: **PARTIAL source prerequisite for CREATE**. Opt-in publication4 binds approved station/service mapping; target2 binds authenticated actor, original CREATE and draft to observed whole-court price. CUP computes whole/4 once and requires FREE60/usage1/daily1. Legacy target/binary downgrade is rejected, ordinary publication3 remains compatible. LOCAL nine suite commands, two typechecks and independent review passed. CI41247998877 SUCCESS (full build and physical quarter target/reserve/replay case); its existing Mongo suite includes the new physical storage/lost-ACK case. Native outgoing secret scan passed after independent classification and one exact temporary exclusion of a synthetic idempotency-key false positive; no repository scanner rules changed.

Remaining SOURCE critical path: strict schema4 instance adoption and checkpoint reconciliation → authenticated LK producer → durable original-CREATE owner/recovery/receipt → LK2 CREATE consumer. CUP#66 supplies reviewed schema4 projector/readiness support; manually seeded synthetic instances are not production adoption proof. Existing instances must retain their purchase-time policy pins. B03/B05 and the overall release remain PARTIAL/NO-GO; no new merge, runtime activation or live mutation occurred.

CUP [#66](https://github.com/Z6v6e6r/ph-admin/pull/66), head `5eb4fe04d8fe5b6dfaaeb1bf8bbbcc731e87ac16`, adds the bounded schema4 instance-adoption source path over #65: full approved snapshot plus exact old-row/checkpoint pins, immutable old instances, atomic new instances/checkpoint/fence and serialized sale insertion. Twelve LOCAL suite commands and full-source/owned-test noEmit passed; independent review and outgoing scanner CLEAR. CI41248667293 SUCCESS, including full typecheck/build/artifact gates and the actual Mongo reconciliation/race fixture. This is an unmerged candidate, not normal production adoption or full CREATE.

Further SOURCE audit: LK has no approved clientRefHash handoff; CUP computes it from verified identity and intentionally omits it from runtime-context. Current intake UUID-only configured tenant and CUP actor tenantKey are different namespaces. The next coordinated CREATE packet must derive actor/tenant/hash inside a versioned variant of the existing CUP intake, preserve context privacy, and connect it to an actual LK CREATE owner. Existing CREATE prospective target has null base price, old policy gate requires60/90/120, and timeout/409 room-time lookup cannot attribute creation. Pin the original quarter tuple and persist the ID from the original successful provider response; ambiguous creation remains UNKNOWN without a second POST or adoption of a found exercise.

## Station communities checkpoint — 2026-11-01

**NO-GO сохраняется.** Свежий GitHub main: LK2 `a37c05a2b2a28c8d53cb14447d357ad9a96bda1f`, LK `608ebe20689e74749fcd8cea6ab97d35c335f214`, CUP `83b1c17bc4c5edaec65387b25b5695e48337c3cf`. Перечисленные ниже изменения — отдельные Draft PR, не main/runtime. Этот checkpoint уточняет историческое состояние B07 ниже.

| Packet                                                            | Evidence                                                                                                                                                          | Remaining boundary                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [LK #275](https://github.com/Z6v6e6r/lk/pull/275) `741543d2`      | CI41243766263/41243766274 SUCCESS; immutable admission, generation claims, lifecycle writer fences; prior identical-runtime physical suite 6 Mongo cases          | Default-off, signer/coordinated writers/runtime acceptance                                                                     |
| [CUP #63](https://github.com/Z6v6e6r/ph-admin/pull/63) `1abc9150` | CI41242978082 SUCCESS, actual Mongo lifetime/deletion case; specialist CLEAR                                                                                      | No live ACL/data changes or activation                                                                                         |
| [LK #276](https://github.com/Z6v6e6r/lk/pull/276) `62e32f7b`      | CI41244133042/41244132874 SUCCESS; station suite28/28 includes new physical TRAINING kind/replay/LEFT/generation case                                             | Owner source only; depends on #275                                                                                             |
| [LK2 #527](https://github.com/Z6v6e6r/lk2/pull/527) `3143ffbe`    | LOCAL337 + bundle2 PASS; review/scanner CLEAR. CI41244545169 SUCCESS:7529passed/126skipped; managedJOIN PG10/10; frozenPG4/4; required27physical+8guards zeroSKIP | Prior81a18f15 CI failed2 invalid PG fixtures and stale generated bundle; corrected in3143, physical PostgreSQL accepted on3143 |
| [LK2 #528](https://github.com/Z6v6e6r/lk2/pull/528) `26c5ceaa`    | LOCAL54 distinct focused cases, owned types0, lint, two specialist reviews and scanner PASS;11 trainingPG cases CI-only,5new                                      | Parent bundle conflict blocks PR CI; exact local parent-merge approval requested, not performed                                |

B07 is now **PARTIAL source/CI**, not a completed station runtime feature. GAME producer covers newly adopted managed JOIN; TRAINING consumer covers the concrete subscription registration path. Legacy/unadopted operations never gain membership retroactively. One official community per station is resolved by owner policy; missing/ambiguous association is immutable no-enrollment. Cancellation keeps membership; LEFT needs a new operation/generation; removed/banned users cannot auto-return. Community/tournament chat consumers, remaining native routes and cross-repository delivery acceptance remain separate gaps.

TRAINING0108 stores nullable private admission state. A durable INTENT pins the original preparation before owner POST, including studio/actor/request identity; retries cannot refresh it. Claim-time identity, JSONB canonicalization, exact persisted confirmation and original receiptId protect recovery. No schema execution, provider/payment calls, flags, publication, deploy or store actions occurred.

## Текущий checkpoint — 2026-10-31

Решение: **NO-GO для полного production release iOS + Android**. Свежие refs: LK2 `a37c05a2b2a28c8d53cb14447d357ad9a96bda1f`, LK `608ebe20689e74749fcd8cea6ab97d35c335f214`, ph-admin `83b1c17bc4c5edaec65387b25b5695e48337c3cf`. Полная инвентаризация ниже — датированный исходный аудит; новые результаты в этом разделе имеют приоритет над историческими checkpoint.

По точному разрешению владельца #511 (`ed3854c384b88a023f4d88f0fd4a379598721396`, включает #503/#509/#510/#507) merged в `a37c05a2` в18:36:31 UTC. Цикл флага COMPLETE; exact main CI success, delivery SKIPPED/steps=[], исходный true восстановлен в18:50:31 UTC (receipt ниже). Остальные перечисленные новые candidates остаются отдельными Draft PR; их зелёный CI не означает merge или установленный runtime.

| Кандидат            | Проверенный результат                                                                                                                                                                                               | Граница результата                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| LK2 #517 `63486325` | CI41221114711 SUCCESS:7141passed/126skipped, location PostgreSQL6/6, отдельный frozen migration4/4                                                                                                                  | Default-off court/station mapping0105 и CREATE readiness; нет CREATE price/admission                                                                  |
| LK#270 `7abe118b`   | CI41221550586:28/28, включая3physical Mongo и2graph; enforcement41221550594 SUCCESS                                                                                                                                 | Original-JOIN-bound FREE/SERVICE SELF owner; не денежный settlement                                                                                   |
| LK2#519 `59c1f0ee`  | CI41225798035:7320passed/126skipped, SELF PostgreSQL4/4 и frozen4/4, native41225797986 SUCCESS; LOCAL Web390/1280 recovery/logout                                                                                   | Consumer0106; unsupported refusal может удерживать key. Отдельное recovery-исправление в работе; native/provider SELF acceptance отсутствует          |
| LK#271 `63cc8077`   | CI41224989024/41224989019 SUCCESS; receiver82passed/17conditional skips, включая29training cases                                                                                                                    | Existing group training + canonical legacy/nonmanaged subscription, без денег; training owner CAS synthetic, не physical provider                     |
| LK2#520 `c8804cf5`  | [CI41229302637](https://github.com/Z6v6e6r/lk2/actions/runs/41229302637) SUCCESS:7360passed/126skipped, training PostgreSQL6/6 и frozen4/4, пять Docker builds                                                      | Default-off Web/API training consumer0107, original-key/capsule recovery. Нет native route, CUP-managed/paid/trial/LEAVE или provider acceptance      |
| CUP#61 `00a46932`   | [CI41229595631](https://github.com/Z6v6e6r/ph-admin/actions/runs/41229595631) SUCCESS, новый Mongo projection/no-mutation case1/1, existing payment/entitlement/type/build/artifact gates                           | Authenticated nonbinding exact-date owner preparation, не admission/lease/signed receipt                                                              |
| LK2#518 `f3102c2a`  | [Native41229015147](https://github.com/Z6v6e6r/lk2/actions/runs/41229015147):5passed/0failed/0skipped; [full41229015245](https://github.com/Z6v6e6r/lk2/actions/runs/41229015245):7304passed/126skipped и frozen4/4 | Synthetic iOS simulator DIRECT flow. Normal Debug/Release исключают оба test symbols. Нет physical-device/Keychain/OTP/APNs/provider/store acceptance |
| LK2#514 `a81ca786`  | CI41227577958 и native41227577937 SUCCESS; предшествующий test-only cleanup fix be740d70 CI41226464356:7211passed/126skipped и migration4/4                                                                         | Семь отчётов и два test-only исправления; не product acceptance                                                                                       |

#520 сохраняет PREPARING до nonbinding prepare, dispatch fence до owner admission и исходный capsule при uncertain outcome. Только exact owner refusal или DB-clock never-dispatched CAS разрешают новый выбор;404/timeout/отсутствующая строка не разрешают забыть ключ. Исторический completed operation отделён от свежего состояния участия. LOCAL full static/build/import gates passed; composite tests7148passed/338skipped после исправления исключительно локального dependency-path mismatch. CI выше отдельно исполнил шесть физических PostgreSQL cases. Synthetic Web390/1280 и specialist review CLEAR; no local database provisioning.

#61 читает complete bounded primary/majority evidence и требует успешный explicit dated snapshot. Missing/stale/partial source, malformed raw parent shape, cross-field collision и lookup failure возвращают UNKNOWN. Mongo projection с computed type sentinels не выдаёт roster/PII и не создаёт indexes; физический тест подтвердил неизменность synthetic documents/indexes. Возвращаемые digest/owner observation не дают права записи.

#518 xcresult artifact13053775455 содержит четыре inspected synthetic PNG. Profile, error/retry и thread отображаются; thread screenshot ещё показывает recovery. Logout screenshot blank, поэтому rendered logout acceptance не заявлен, хотя DOM/credential/late-response assertions прошли. Owned shutdown/read/delete завершены; post-delete inventory не заявлен. Предыдущие failed native runs сохранены как история, текущие5/5 относятся только к exactf310 test scope.

### Завершённый source-only merge #511

Разрешённый exact head `ed3854c384b88a023f4d88f0fd4a379598721396` merged в main `a37c05a2b2a28c8d53cb14447d357ad9a96bda1f` (tree `82500700a959ecf571a18beacb26c64bf6a4865d`) в18:36:31 UTC. `LK2_STANDARD_DELIVERY_ENABLED` был временно false с18:36:00 UTC. [Main CI41230249442](https://github.com/Z6v6e6r/lk2/actions/runs/41230249442) SUCCESS; связанный [delivery41231241175](https://github.com/Z6v6e6r/lk2/actions/runs/41231241175), job124625756504 `standard-web`, terminal SKIPPED, `steps=[]`. Перед восстановлением свежий main совпал, все пять nonterminal status queries вернули0, flag сохранил ожидаемые false/timestamp. В18:50:31 UTC исходный **true восстановлен и readback подтверждён**. Цикл COMPLETE; публикации/deploy/store activation не было. Разрешение относится только к #511, не к следующей партии.

### Принятые продуктовые решения

- Одно официальное сообщество на станцию; автоматическое вступление после подтверждённой записи на игру или тренировку. Это требование ещё не реализовано; support chats не заменяют station communities.
- По подписке CREATE допускает только **1/4 корта**. Неизвестность базы доли снята; authoritative service/dictionary mapping и original-create receipt всё ещё нужны. Client selector и room/time match не дают booking authority.
- Для MALE/FEMALE проверяется пол игрока; для MIXED пол/баланс не ограничивают допуск. Авторитетный серверный источник пола и fail-closed admission ещё проверяются.

### Уточнение денежных отмен после повторного аудита LK1

**CURRENCY/DEPOSIT cancellation commands уже реализованы в LK1 main608ebe20.** SELF `fn_split_leave_router.js:191–233` читает свежие cancellationOptions и отправляет EndUser DELETE с выбранным refundMethod. Solo-organizer cleanup имеет scoped Admin PUT/EndUser DELETE и original booking/generation recovery. `fn_split_cleanup_router.js:2329–2449` проверяет отмену записи; `refundStatus=REQUESTED` не утверждает settlement. UI refundSum — предложение суммы, не доказательство зачисления.

Оставшийся B04: attributable game financial receipt с original transaction/booking/payer, фактической суммой/валютой/назначением и pending/partial/terminal semantics; повтор после ambiguous write требует доказанного provider idempotency/readback. Shared VIVA_REFUND_ENTITY_LINK_V1/annual subscription evidence относится к другому aggregate и не доказывает game DEPOSIT credit. Не писать новый generic refund API и не объявлять существующие LK1 refunds отсутствующими. Повторный аудит был read-only, без provider/DB/PII calls.

### Уточнения source audit и lifetime policy

Повторная проверка LKmain608ebe20 нашла пригодный server selector для ограниченного CREATE: `fn_onboarding_stations.js:111–151` и действующий `gateway_hooks.js:108–142` содержат одинаковые восемь station→master/subService пар. Hub price GET проверяет exactURL/status/positive integer total для полного окна. Новый fixed-quarter owner может использовать только эти подтверждённые пары, room/catalog checks и exact-divisible price/4; нельзя переносить client selectors, singles/shareCount2, cache fallback неизвестного происхождения или дважды делить частичную льготу. Текущий precreate recovery target ещё не закрепляет service/divisor/price evidence. Это найденная реализация для следующего bounded owner task, не принятый CREATE consumer.

Canonical STATION association уже есть в CUP `community-policy.ts:55,67–70` (`typeSettings.stationId`), а LK `communityPolicyProjection.mjs:61–75,174–180` выполняет atomic autojoin с ban/counter rules. Пробел уточнён: нет гарантии единственного community на station; projector допускает GAME/TOURNAMENT, но не confirmed TRAINING. LK2#520 confirmed outbox пока не связывает station. PostgreSQL-local и LK-Mongo membership имеют разных write owners; нельзя писать оба. Generic community foundation не требуется.

Владелец подтвердил lifetime: отмена регистрации сохраняет membership; добровольный выход блокирует повтор от того же старого confirmed факта, новая confirmed registration может вернуть; REMOVED/BANNED запрещают auto-return. Existing LK scan может повторно вступить по старому событию после leave — нужен durable generation/event fence, а не простое добавление TRAINING в фильтр.

Native training требует initial PadlHub catalogue read: `auth-gateway.ts:2174–2176` сейчас отклоняет native listEventCatalog; существующий Web startup использует client-assisted schedule job, а v2 GET продолжает уже подготовленный cursor. Одного расширения nativeSections/HTTP allowlist недостаточно; прямой provider handoff не разрешён. Источник — #520c880, без native/provider выполнения.

### Новые source и CI результаты

- CUP [#62](https://github.com/Z6v6e6r/ph-admin/pull/62), `41c744d5163ec2e7e4fab9792d96eadc76d98087`, stacked#61: MALE/FEMALE fresh admission проверяет exact actor profileM/F; explicit MIXED без sex lookup/баланса. Raw gender+исходныйupdatedAt входят в reservation/participant/waitlist CAS; paid/pending recovery не получает новый gender gate. Restricted legacy Energy/free-linked Viva без durable admission отказывают до provider POST; MIXED legacy provider race остаётся. Energy unverified JWT claims больше не подмешиваются в verified identity. LOCAL configured build/regressions +independent specialist CLEAR; outgoing nativeGitleaks8.30.1 two commits/43387bytes PASS. InitialCI41239749876 failed на старой raw-rule fixture; test-only correction сохранила BOOKING_FAILED/zero provider-write assertions. CurrentCI41240145187 SUCCESS, в том числе реальные Mongo CAS для reserve/participant/waitlist при изменении пола с тем же timestamp и revision с тем же полом. Native/provider/tournament consumer не закрыты; timestamp не является monotonic ABA generation.
- LK2 [#524](https://github.com/Z6v6e6r/lk2/pull/524), `477404e79e04027a9fa25065ef9dcfc5fed7cec5`, stacked#520: Android TRAININGS получает initial authenticated PadlHub catalogue и существующие original-key registration/status routes. Полные bounded day reads, strict malformed/partial handling, tenant/actor binding, absolute cursor expiry и Moscow calendar; public DTO без provider credentials/IDs. LOCAL composite290TS tests, hostJVM12/12, typed/lint0, actual UI390/1280/reload/logout passed; source2 manifest`e3aa2256a69606ce08872b4627601315128694023b8b244e8a9709c91f9a2d79`, independent CLEAR, outgoingGitleaks1commit/61296bytes. Прежний fullCI41236344692 failed только на blanket retirement assertion. Test-only correction477404e79e04027a9fa25065ef9dcfc5fed7cec5 сохраняет legacy-source запрет и проверяет actor-bound training composition:22LOCAL passed, independent CLEAR. Обновлённые fullCI41237803621/native41237803616 SUCCESS:7400passed/126skipped, frozenPG4/4; outgoingGitleaks2commits/62177bytes PASS. HostJVM reference JSON runtime и browser QA не доказывают APK/Android device; существующий Android workflow не запускается на PR.
- LK2 [#526](https://github.com/Z6v6e6r/lk2/pull/526), `30598d974eb5a380d2b326b9007e885b1823aa7d`, stacked#524: автоматический exact-head Android native CI, JDK21/SDK36, actual Gradle JVM tests и unsigned release APK без Firebase/signing/provider/store. LOCAL11 guard tests +scoped lint/type/diff PASS; independent CLEAR manifest27caab9e3d0693106671de041b4f70837d6b10a35bf49592e02e7bf016b0693a, outgoingGitleaks1commit/12967bytes PASS. AndroidCI41238685334 SUCCESS:16JVM(7JOIN/5training/3callback/1baseline), zero skips/failures/errors, assembleRelease и unsigned/appId verification passed. Artifact13056541812 ZIPsha256cac8376e18d2e7e9fc6cb7f6cddee8eddfcb5f537bb8e39d8ae0bac0dc93530f; ZIP и четыре XML reports проверены локально после завершённой загрузки; APKsha2561dd4cd204c01758d8f7a988f34d69799b84ecbb149f1b55a47a464ee7ef3356a совпадает с manifest. FullCI41238685061 SUCCESS:7411passed/126skipped и frozenPG4/4. Device/FCM/store acceptance отсутствует.
- LK2 [#525](https://github.com/Z6v6e6r/lk2/pull/525), `eb993ff671b49d10f6db4664a28cfac8af576876`, tree`b3de3aa7833288620177ea136c0b593ee1de466e`: временная integration branch от свежегоmaina37 объединяет четыре green heads #51763486325 → #521e1d781ad → #520c8804cf5 → #522ada66c50. Конфликты gateway/SDK/каталога миграций разрешены с сохранением обеих функций; только test inventory8→9 дополнительно. SQL0105–0107 и frozen closed108 package не изменены. LOCAL226 tests across7files, generated combined user contract,36typed source files+closure0diagnostics, independent integration CLEAR, outgoingGitleaks16commits/645602bytes. Integrated pushCI41236559609/PR41236564284/native41236564207 SUCCESS; PR full7497passed/126skipped и frozenPG4/4, required physical step SUCCESS; #523/#524/#514 и LK/CUP PR не включены. Merge в main не разрешён и не выполнялся. Локальное обновление этой integration-ветки heads#52630598d97/#523f5c33149 отклонено automatic approval review; запрошено точное разрешение только на эту локальную операцию, источники пока не включены.

- LK2 [#523](https://github.com/Z6v6e6r/lk2/pull/523), `f5c33149275d9aa9b5bbef1712909600eb8f091c`, stacked#522: восемь существующих notification resilience PostgreSQL/RabbitMQ cases добавлены к тому же required runner с отдельными owned fixtures. LOCAL49synthetic harness tests, scoped repo TypeScript/ESLint/format/diff, independent review и outgoing Gitleaks1commit/4493bytes PASS. CI41235695070 SUCCESS:7261passed/126skipped, frozenPG4/4, затем required35physical+8guard PASS/zero skips. Artifact13056330994 SHA256b697780b63d23907b52ace2a09cb401b56df577400284637a704e02f32cc8472: пятьreports19/11/5/4/4 и cleanup3ownedDB/2vhost проверены; every child exit0/no timeout/orphan. Нет новых services/dependencies/workflow config/runtime/provider writes.

- LK2 [#522](https://github.com/Z6v6e6r/lk2/pull/522), `ada66c500c3fc01917412b3fc58267bf88852641`: [CI41233392220](https://github.com/Z6v6e6r/lk2/actions/runs/41233392220) SUCCESS. Полный suite7254passed/126skipped, frozenPG4/4; затем отдельный обязательный step реально исполнил lifecycle13, communications10 и RabbitMQ4 физических cases плюс8guard cases, **35passed/0failed/0skipped**. ZIP artifact13054683153 SHA256`1ef81b4ae719835bdc0a26d03bfd068d0a5d73303271c8de2a279a7160883eef` проверен; три JSON reports19/11/5 и ownership receipt подтвердили удаление обеих собственных БД и vhost, без timeout/orphan. Это снимает конкретные27 silent skips, но не всю device/provider E2E matrix.
- LK [#273](https://github.com/Z6v6e6r/lk/pull/273), `3678c0397ec417c6caa2dfdb6d2dd4886e39ea37`: CI41233465468 и41233465624 SUCCESS. Receiver94passed/17conditional skips включает12 новых preparation/graph cases; LOCAL33/33. Private exact-actor/draft/revision request, восемь проверенных station/service mappings, шесть bounded provider GET и точное whole-price/4 observation. Ответ nonbinding, TTL60s: нет CREATE, reserve, price lock, установленного route или provider acceptance. Unsigned evidence digest не является authority для CUP intake.
- LK2 [#521](https://github.com/Z6v6e6r/lk2/pull/521), current `e1d781ad6ab47375e91bd8c95d9275df24d36e4d`: restrictive original-key reconciliation и durable NOT_DISPATCHED proof реализованы. Предыдущий head110885 CI41233189026 прошёл static/build/imports и SELF PostgreSQL9/9; full suite7360passed/126skipped/1failed из-за ожидаемых11 вместо12команд. Test-only correction сохраняет все idempotency/response checks; LOCAL4/4, specialist CLEAR, outgoing Gitleaks3commits/55871bytes. Current exact-headCI41234847565 и native41234847625 SUCCESS:7361passed/126skipped, SELF PostgreSQL9/9, separate frozenPG4/4; static/build/imports и пятьDocker builds passed.
- #514 latest committed `124db9e789026a72feebdd14cbbe9de47cd453e2`: CI41231462478/native41231462512 SUCCESS. Checkpoint4e123fe1 full run41239709419 failed только на Markdown formatting R1-GO-NOGO; native41239709414 SUCCESS. Следующее обновление исправляет форматирование и добавляет новые факты; CI документации не является product acceptance.

Station lifetime audit нашёл canonical `participationId` и confirmed outbox, но существующий legacy bridge теряет эти поля, а native JOIN его не вызывает. Timestamp сравнения недостаточно: community-owner должен сохранить immutable original-operation admission с membership epoch **до dispatch**, а confirmed generation потребить его атомарно только при том же epoch. LEFT/REMOVE/BAN/explicit restore меняют epoch; CANCEL его не меняет. Старый operation без admission не обновляется при replay; missing/full owner storage даёт NO_ENROLLMENT, booking не откатывается. Это предложенный узкий контракт, не реализованный transport или lifetime fence.

### Следующие ограниченные задачи

SELF recovery#521 exact-headCI green; Android training consumer#524 source/fullCI green, #526 actual unsignedAndroid build/JVM16 passed; реализация включает initial server-owned PadlHub catalogue, original-key registration/recovery и узкую native policy. Далее trusted CREATE producer → versioned actor/draft-bound CUP preflight/reserve → original-create owner/receipt; текущий v1/LK1 contract сохраняется. CUP gender admission#62 source/physicalCI green; LK2 tournament consumer и generation-safe owner integration остаются. Station owner lifetime находится в реализации, producer/confirmed-fact transport ещё не готов. Training и monetary lanes независимы от CREATE mapping. Runtime/provider/signing/restore/store acceptance — отдельные gates. Публикации, deploy, реальные миграции/платежи/push/store activation не выполнялись.

## Исторические checkpoint и исходный inventory

Ниже сохранены прежние snapshots и результаты попыток. Их фразы «pending», «не merged» и старые main SHA описывают дату соответствующего checkpoint; актуальное состояние приведено выше. Они не являются новыми разрешениями или текущими blockers.

## Checkpoint совместимых кандидатов — 2026-10-31

Свежий readback main: LK2 `14ebdca6a7553e35c274e9fce77d953e066467cf`,
LK `608ebe20689e74749fcd8cea6ab97d35c335f214`, ph-admin
`83b1c17bc4c5edaec65387b25b5695e48337c3cf`. Это обновление трёх refs и перечисленных
кандидатов, не повтор всей исторической инвентаризации веток/PR ниже. LK main изменился
frontend tournament discount пакетами #265/#266; owner source #264 ими не заменён.

| Кандидат                                                                            | Commit и доказательство                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Ограничение                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LK2 [#511](https://github.com/Z6v6e6r/lk2/pull/511), интеграция #503/#509/#510/#507 | `ed3854c384b88a023f4d88f0fd4a379598721396`; [PR CI 41207679072](https://github.com/Z6v6e6r/lk2/actions/runs/41207679072), [push CI 41207675161](https://github.com/Z6v6e6r/lk2/actions/runs/41207675161), [unsigned iOS 41207679048](https://github.com/Z6v6e6r/lk2/actions/runs/41207679048) success; 7211 passed /126 skipped, отдельно PG 4 passed и APNs 6/6                                                                                                                                                            | Draft, не merged. Один test-only fix корректно отличает Linux zombie от живого процесса; production timeout script не менялся. Предыдущий failed run сохранён как история.                                                                                                                         |
| ph-admin [#60](https://github.com/Z6v6e6r/ph-admin/pull/60)                         | `730e3f4c30e31b31a5425a4be77dd4ae10a1a7d3`; [physical binding CI 41208902447](https://github.com/Z6v6e6r/ph-admin/actions/runs/41208902447) и остальные три workflows success. Read-only canonical preflight, exact optional reserve expectations, original-operation replay до текущей policy/target проверки; auth/tenant/actor/instance binding. Physical preflight оставляет все существующие коллекции неизменными, stale expectations не списывают usage, старый exact replay проходит. Provider writes=0, skipped=0. | Зависит от #59, включает #57/#58; LK2↔LK owner v2 подготовлен в #267/#515. Optional expectations absent сохраняет legacy fingerprint. Runtime/provider acceptance отсутствует.                                                                                                                     |
| LK2 [#512](https://github.com/Z6v6e6r/lk2/pull/512)                                 | `96723a304e941f40c8292d989f1a6724f466fa42`; [CI 41207269591](https://github.com/Z6v6e6r/lk2/actions/runs/41207269591) success. Android native allowlist разрешает только authenticated community history GET с ограниченным query. LOCAL full 6898 passed /319 skipped; JVM 15/15, Gradle assembleDebug passed. Debug APK SHA256 `ffaee809128ab5e06a801f0341213782d73134983d5ed8f9ed681ea0ec65e844`.                                                                                                                        | Четыре файла, no community writes. Debug APK не установлен на устройство; не signing/store acceptance.                                                                                                                                                                                             |
| LK2 [#513](https://github.com/Z6v6e6r/lk2/pull/513)                                 | `7b2213a089b6fefb80b42f4ccc3c2f0183226e01`; existing DIRECT/GAME iOS text chats. LOCAL full 7066 passed /325 skipped; Swift 36 passed /1 intentional skip; unsigned simulator build success. Browser mock list/thread/send/error/retry/logout и mobile hit-testing passed; independent security/mobile/reliability review clear.                                                                                                                                                                                            | CI `41210366790` / unsigned `41210366803` success: 7265 passed /126 skipped, отдельно PG 4 passed. Stacked на #511; не входит пятым head в его партию. Pending send только в памяти текущего thread; новых диалогов/media/community/tournament writes нет; physical-device acceptance отсутствует. |

Следующий commercial contract сохраняет один authoritative selector из LK: server product
allowlist + подтверждённая дата покупки. Managed preflight возвращает binding; только явный
проверенный `LEGACY` сохраняет старый путь. Отсутствующий CUP instance, ошибки, timeout и
неоднозначная identity не означают legacy. LK2-v1 перед новым managed reserve должен отказать
при изменении selector; существующая attempted operation восстанавливается без нового reserve.
Этот контракт реализован в кандидатах #267/#515 ниже; runtime/provider v2 acceptance ещё не выполнено.

Среди перечисленных R1 candidates merged только #508. #511 approval pending; его head и
временный delivery-flag cycle требуют отдельного разрешения. Source/CI readiness не закрывает
B01–B11 и не даёт authority на publication/deploy/provider/store операции.

## JOIN v2 и SELF LEAVE — следующий source checkpoint

- LK [#267](https://github.com/Z6v6e6r/lk/pull/267), `72688c66ced99f7bcd3f7a5f3a710b998bab9979`: canonical selector/preflight/admission/receipt v2, immutable recovery context и restrictive recovery-only retry. CI `41213677959` и `41213678058` success. LOCAL final owner closure 175 passed /18 conditional skips; critical matrix 1342 passed /48 skipped. Independent payment/security/reliability review CLEAR. Physical monthly Mongo tests относятся к community lifecycle, не являются managed JOIN acceptance.
- LK [#268](https://github.com/Z6v6e6r/lk/pull/268), `cc1811a2f74276bd7878ff268e3fc873c1c5f9ec`: CI MongoDB 8 fixture перенесён на ubuntu-22.04 после fatal kernel incompatibility до checkout. CI `41213583643` и `41213583406` success. Mongo version, production configuration и тестовые команды не менялись. Hosted label остаётся mutable; runner retirement требует последующего пересмотра.
- LK2 [#515](https://github.com/Z6v6e6r/lk2/pull/515), `b55bd4d213f232d8f7001438ebb2a911c41a1ed3`: managed JOIN consumer поверх #511, exact v2 receipt/usage binding и replay до нового preflight. LOCAL static gate PASS; corrective closure 480 passed /6 skipped. Это составное evidence после 11 environment/bundle failures исходного полного прогона, не утверждение об одном чистом `npm run check`. CI `41214688574` failed: 7258 passed /126 skipped, два новых physical PostgreSQL replay/receipt cases упали с `GAME_PAID_JOIN_BINDING_REFS_INVALID`, last-seat case passed. Причина — смешение persisted local eligibility decisionId и commercial refs; исправление `b55bd4d2` прошло LOCAL 186 tests/static/review, CI `41216151985` success: 7267 passed /126 skipped, physical managed JOIN3/3 и отдельно PG4/4.
- LK [#269](https://github.com/Z6v6e6r/lk/pull/269), `8d46b9b53a1baa0b06bca6e127950b6845d08d65`: managed SELF RETURN_VERIFIED завершается только после exact CUP COMPENSATED/APPLIED/BOOKING_CANCELLED readback. Foreground retry с новым actor token может забрать истёкший local-apply lease без нового cancellation/visit-return POST. LOCAL configured suites, lint/typecheck и final clean-tree release fixtures 10/10 PASS; compatibility correction 126 PASS. Independent review CLEAR. CI `41215625582` / `41215625485` success; monetary refund, organizer CANCEL и LK2 paid consumer в этот пакет не входят.

- LK2 [#516](https://github.com/Z6v6e6r/lk2/pull/516), `3e9c566a397d0627f7c0bd8d3c323f931747c05f`: participant → OTHER profile → new DIRECT через server capability, stable key и HTTP reconcile до manual retry. LOCAL static PASS; composite 682 files passed /31 skipped (исходно 32 failed files, 6391 tests passed /324 skipped /23 failed; corrective 32 files, 711 tests passed /4 skipped после исправления TMPDIR/discovery). Swift37 passed /1 skipped; unsigned simulator build PASS. Browser390/1280, security/mobile/UI review и Gitleaks passed. CI `41216456571` success: 7286 passed /126 skipped, отдельно PG4/4; unsigned native `41216456863` success; physical device/store не проверены. Stacked отдельно поверх #513.

Общий v2 fixture SHA256 `82f7b918275c86fd357283abd67bc7c727427a3680dfe9906b2d560eea3c0171` совпадает у issuer/receiver. Shared fixture и source tests не заменяют совместную runtime/provider приёмку. Все пять PR — Draft, не merged. Ветка #269 содержит reviewed CI correction и текущий upstream #267; проверенное source tree при ancestry merge не изменилось.

## Реализация после аудита — 2026-10-31

| Пакет               | Изменение и commit                                                                                                                                                                                                                                                                   | Доказательство                                                                                                                                                                                                                                                                                                                                                                                                             | Остаток                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| B02 local safety    | [Draft #503](https://github.com/Z6v6e6r/lk2/pull/503), `39feed0c36c109e8cea582f1345041f92a02440b` (business fix `d51e5c9c`, dependency fix принят из #508): strict persisted refs, отказ bound JOIN до dispatch, запрет v1 confirmation/replay для bound snapshot, CREATE units echo | LOCAL: 207 коммерческих тестов; финальный повтор с bundle/Git verifier 269 passed. Независимый payment/security/reliability review approved. Secret scan passed. [CI full success](https://github.com/Z6v6e6r/lk2/actions/runs/41202183068): 7165 passed / 126 skipped; отдельно PostgreSQL suite 4 passed. Все gates нового combined head success; предыдущий dependency failure — исторический результат.                | PARTIAL: owner v2 подготовлен в отдельных #267/#515; v1 не превращён в binding wire. Нет provider/device acceptance. |
| F1 / B12 dependency | [Merged #508](https://github.com/Z6v6e6r/lk2/pull/508), `18061aa8`: только systeminformation 5.31.16 → 5.33.16 в lockfile                                                                                                                                                            | LOCAL: clean install, import, 9 observability tests; audit high gate exit 0 (0 high/critical, 16 moderate). [CI dependency-security success](https://github.com/Z6v6e6r/lk2/actions/runs/41188184138/job/124499477726), весь workflow success: source-quality, quality-full и пять Docker builds. CI tests: 7087 passed / 126 skipped; отдельно PostgreSQL migration suite 4 passed. Independent security review approved. | Merged по отдельному approval: main `14ebdca6`; новый main CI `41201792854` success. Moderate findings не закрыты.   |

Дополнительный owner compensation packet: [ph-admin Draft #57](https://github.com/Z6v6e6r/ph-admin/pull/57),
`d5000a4d207bd078a776902c918b9d35a13a7f77` от main `83b1c17b`. Воспроизведён дефект:
strict-режим принимал release без owner proof. Теперь отдельная подпись `release-v1` связывает
operation/reason/booking/time; confirmation v1 не подходит для release. Terminal replay проверяет
сохранённую причину, booking и завершённую компенсацию. Strict-off exact legacy replay сохранён.
LOCAL: verifier/lifecycle, полная configured subscription suite, runtime-contracts,
trusted-shadow-adapter, auth-rbac, обе конфигурации TypeScript и build passed. Final recovery
regressions passed; независимое security/payment/reliability review approved; gitleaks passed.
CI: [subscriptions-binding-promotion](https://github.com/Z6v6e6r/ph-admin/actions/runs/41190093733)
и [CUP immutable runtime](https://github.com/Z6v6e6r/ph-admin/actions/runs/41190093707) завершились success
на exact head `d5000a4d`: subscription regressions, TypeScript/build и deterministic artifact attestation passed. Это часть B02/B04, не закрытие блокеров: signer и physical Mongo evidence добавлены следующими пакетами ниже; authoritative provider acceptance и полный LK2 paid LEAVE/CANCEL остаются открытыми.
Strict-mode activation и изменения секретов не выполнялись.

Первый checkpoint LK owner producer: [Draft #264](https://github.com/Z6v6e6r/lk/pull/264),
`453e8459f713e75d2fee006a394c7d222da6f227` от main `788fdb96`. Opt-in producer формирует
confirm v1 и release-v1 после exact actor/target/subscription/booking readback. Recovery не
перезаписывает другой booking до проверки доказательства и сохраняет исходный timestamp Viva.
Явно активная запись не получает cancellation proof даже при противоречивом cancelled flag.
Timeout/conflict/throttling, пустая сверка, generic/local/split abort без provenance остаются pending.
LOCAL: final gateway/custody 102 passed / 1 skipped (live-flow fixture); related closure имел
135 passed / 2 failed, затем source pin исправлен и проверен, loopback EPERM case прошёл с
разрешённым локальным listener. Это составное evidence, не один чистый aggregate run.
Actual ph-admin #57 verifier принял три LK wire формата на synthetic data; lint 0 errors /
467 warnings, полный production/dev build с inert URL passed. Независимое review и secret/PII
сканирование passed. [CI LK](https://github.com/Z6v6e6r/lk/actions/runs/41198689845) success на exact head `453e8459`: critical
subscription matrix 1322 passed / 48 skipped, candidate/drift, compatibility/custody, typecheck, lint,
full inert build и required gate passed. Skipped external fixtures не приняты как выполненные.
Producer выключен по умолчанию; crypto/key runtime custody и provider acceptance не проверены.

CI документационного #507 `2e1d005f`, [run 41190654423](https://github.com/Z6v6e6r/lk2/actions/runs/41190654423):
source-quality, quality-full, deployment-contract и secret-scan success; общий gate failed только
из-за dependency-security. `npm audit --omit=dev --audit-level=high`: 16 moderate / 1 high
(systeminformation <=5.33.15). #508 содержал отдельный fix и позднее merged; в этом историческом run его ещё нет. Новых dependency изменений
в owner producer или отчётах нет.

Для B02 полный LOCAL `npm run check` выполнил static/build/runtime-import stages, но первоначальный
source-test run дал 116 failed / 6835 passed / 340 skipped (705 files) в Node 26 sandbox.
Разобраны все 13 failed suites: Node native webstorage, запрет loopback/Docker, macOS TMPDIR alias,
и одна реальная новая module-shim regression в hash закреплённого bundle. Последняя исправлена без
изменения generated deploy artifact. Все failed suites повторно прошли на изолированном Node
22.23.4 с каноническим TMPDIR и разрешёнными disposable fixtures; это составное LOCAL evidence,
а не утверждение об одном чистом полном прогоне. На прежнем head source-quality/quality-full прошли, а workflow #503 был failed из-за dependency-security. После интеграции #508 новый combined CI `41202183068` success; прежний failed run не переименован. Skipped DB/
broker cases остаются пропусками, не runtime acceptance.

Обновление source/CI после первого snapshot:

- LK2 #508 merged по отдельному owner approval: main `14ebdca6a7553e35c274e9fce77d953e066467cf`,
  tree `0d1f67d7dee3f5623d6ef8364d959832714dea1c`, только lockfile +4/-4. Main CI `41201792854`
  завершился success. Разрешённый временный цикл `LK2_STANDARD_DELIVERY_ENABLED`: true → false выполнен
  в 12:34:48 UTC до merge; downstream `41202697617` завершился SKIPPED, job `standard-web` без steps.
  Исходный true восстановлен в 12:49:05 UTC и подтверждён readback. Других main/release runs
  в окне restore не было; выполнялся только несвязанный PR CI #503. Публикация/deploy не выполнялись.
- #503 обновлён в собственной ветке до `39feed0c` с этим dependency fix; business source неизменён
  относительно `d8af48b2`. Exact-head [CI `41202183068`](https://github.com/Z6v6e6r/lk2/actions/runs/41202183068) success: 7165 passed / 126 skipped, отдельно PostgreSQL 4 passed; прежние CI результаты не переименованы.
- Исторический checkpoint LK #264 `53732cd6` добавил bound split CREATE rejection. Exact-head CI `41200538848` success:
  critical matrix 1325 passed / 48 skipped. Fresh local split/custody closure:196 passed /1 skipped.
- ph-admin #58 `cab33ce7345a14a7cb347de616849d0daa13496f` зависит от #57. Все четыре automatic
  workflow success; physical suite в `41201269983` исполнила independent-client reserve/confirm/release,
  proof/ownership negatives, final-outbox rollback и separate-process response-loss replay,
  skipped=0. Runtime provider/HTTP/device acceptance не проводился. Первый failed fixture run
  `41200668400` сохранён в E2E matrix вместе с причиной и исправлением.

- LK2 [#510](https://github.com/Z6v6e6r/lk2/pull/510), `22303758cfcd0e54bcdb907a4ed20677387e66e8`: unsigned native CI [41203337199](https://github.com/Z6v6e6r/lk2/actions/runs/41203337199) и full CI [41203337054](https://github.com/Z6v6e6r/lk2/actions/runs/41203337054) success. LOCAL: 6900 passed / 319 skipped; Swift 31 tests / 1 skipped / 0 failures; native builds passed. Это build/test evidence B09, не signed artifacts, physical devices или stores; B06 остаётся открытым.
- LK2 [#509](https://github.com/Z6v6e6r/lk2/pull/509), `8639d3967021bd1d13177b4da01e7cd452839bb9`: ordinary iOS chat APNs projection/delivery реализованы в source, включая endpoint binding, preferences, unknown-dispatch fence и token-rotation CAS. В source шесть physical scenarios. Первый CI дал 5 pass / 1 fixture failure; fixture исправлен по parked-инварианту migration 0101. Exact-head [CI 41204346650](https://github.com/Z6v6e6r/lk2/actions/runs/41204346650) завершился failure только из-за соседнего built-export timeout; все шесть APNs physical cases passed. Полный combined CI #511 ниже success. LOCAL full на `b82ec`: 6928 passed / 325 skipped; business source с тех пор не менялся, это reused LOCAL evidence, не новый CI pass. B08 остаётся PARTIAL до physical/device/provider acceptance.
- ph-admin [#59](https://github.com/Z6v6e6r/ph-admin/pull/59), `70d3820c4fe906e3efdea8b4a2617544b3ae15dd`: read-only `POST /api/internal/subscriptions/entitlements/readback`, exact seven fields, actor/tenant/operation/instance scope и primary-majority read. Новый physical post-TTL readback case: [CI 41204278865](https://github.com/Z6v6e6r/ph-admin/actions/runs/41204278865) success; все четыре workflow green. Физические concurrent lifecycle, final-outbox rollback, separate-process response loss и provider-rejection commit/lost-response → read-only recovery beyond TTL прошли; provider writes=0, skipped=0.
- Текущий LK [#264](https://github.com/Z6v6e6r/lk/pull/264), `de95b8cca9cb0fd02a16d1300de969b972b631eb`: durable original rejection marker и восстановление после TTL через readback #59. Только уже завершённый CUP `FAILED / APPLIED / PROVIDER_REJECTED / null` разрешает exact-marker local CAS→RELEASED. Новый proof не создаётся, `observedAt`/TTL не обновляются, provider POST/release не повторяются; незавершённое CUP освобождение после TTL остаётся pending. LOCAL: 213 passed / 1 existing live-fixture skip; independent review clear. Exact-head [CI 41204447158](https://github.com/Z6v6e6r/lk/actions/runs/41204447158) success: critical matrix 1382 tests / 1334 passed / 48 skipped / 0 failed.

Owner dependency order: **ph-admin #57 → #58 → #59 → LK #264**; runtime opt-in, secrets/config custody и provider acceptance — отдельные разрешённые переходы. B12 high finding устранён на main и combined #503; это не закрывает 16 moderate findings. B02 owner/consumer runtime acceptance, B03 CREATE, B04 paid cancel, B05 signup, B06 native journeys и B07 social остаются открытыми.

NO-GO полного R1 сохраняется. Baseline ниже — исходный snapshot первого аудита; последующие
source/CI изменения перечислены выше, а не выданы за повторный полный inventory.

## Зафиксированный baseline

| Репозиторий                                     | Main SHA первого snapshot                  | Git tree                                   | Ветки / открытые PR |
| ----------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------- |
| [lk2](https://github.com/Z6v6e6r/lk2)           | `d6a0458a1ae79aac3efccb0396486444d27d73e7` | `7623734ef91099186595600d51a483d6e15519db` | 511 / 33            |
| [lk](https://github.com/Z6v6e6r/lk)             | `788fdb96b3efd60fb09e4187b4ca4b5b00e2daaa` | `c0c66ce7c6b7a27858b6b90d54af1be32b8f30d0` | 272 / 34            |
| [ph-admin](https://github.com/Z6v6e6r/ph-admin) | `83b1c17bc4c5edaec65387b25b5695e48337c3cf` | `cfffdce4d5c69f0da7c50fbc90527bf00894d0fa` | 60 / 5              |

GitHub refs прочитаны заново; branches полностью пагинированы. Открытые PR перечислены ниже, checks прочитаны для их точных head SHA. Количество веток не означает количество активных задач: среди веток есть исторические, merged и installed-baseline artifacts. Рабочий checkout LK2 содержал 103 изменённых tracked-файла; они исключены из baseline и сохранены. Локальный ph-admin был устаревшим; аудит выполнен по свежему SHA в отдельном checkout.

Ссылки на LK2 source ниже относительные к этому репозиторию; номера строк относятся к указанному baseline. Для LK/ph-admin применяются их SHA из таблицы. После изменения baseline требуется перепроверять затронутые выводы, а не автоматически повторять весь аудит.

## Значение статусов и доказательств

- **VERIFIED**: указанная узкая проверка имеет наблюдаемый результат и SHA/run/artifact. Это не общий статус всего продукта.
- **PARTIAL**: реализация и часть проверок есть, обязательная часть acceptance отсутствует.
- **MISSING**: конкретная обязательная часть отсутствует в проверенном пути.
- **BLOCKED**: известен препятствующий guard, незавершённый контракт или failed gate.
- **UNKNOWN**: нет достаточного актуального доказательства; это не утверждение об отсутствии функции.

Уровни: source inspection описывает код; **LOCAL**, **CI**, **STAGING**, **PROVIDER**, **PRODUCTION** не взаимозаменяемы. Test source не равен успешному выполнению. Полная production-готовность ни одного пользовательского пути этим аудитом не подтверждается.

## Исходная карта main первого аудита (история)

| Требование                               | Статус полного R1                                        | Реализация и тесты на main                                                                                                                                                                                                  | Что не закрыто                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth / session                           | PARTIAL                                                  | [auth-service](../../apps/api/src/auth/auth-service.ts); `access-session-routes.test.ts:65-150`, `access-session-postgres.test.ts:126-194,284-410,488`: tenant/user/session binding, revoke, refresh reuse, RLS             | Login → refresh → logout/revoke на обоих физических устройствах, выбранный provider/session runtime                                                  |
| Profile / privacy                        | PARTIAL                                                  | [profile-view tests](../../apps/api/src/profile/profile-view.test.ts):23-129; `profile-contact-routes.test.ts:100-399`: self-only, cross-tenant denial, redaction                                                           | Native acceptance, актуальное сопоставление личности и refresh                                                                                       |
| Subscriptions / entitlement / usage      | BLOCKED                                                  | [subscription adapter](../../packages/subscription-runtime-adapter/src/index.ts):149-152 — nonBinding quote + reservation recheck. ph-admin lifecycle `reserve:90`, `confirm:224`, `release:315`, CAS/ledger/outbox:408-415 | Production policy registry запрещён; точный policy/instance/target/usage binding, конкурентный reserve и LK1 parity — B01/B02                        |
| Eligibility / restrictions               | PARTIAL                                                  | [participation eligibility tests](../../packages/domain/src/participation-eligibility.test.ts):49-148; ph-admin `test/subscriptions-entitlement-lifecycle.test.ts` — limits, replay, release                                | Enforcement на всех реальных CREATE/JOIN/training/tournament путях; timezone, freeze/expiry, разные подписки                                         |
| Game CREATE                              | BLOCKED                                                  | [commercial runtime](../../apps/api/src/games/game-create-commercial-runtime.ts):75-148 — advisory; local/free transaction path и тесты присутствуют                                                                        | Реальный CREATE reserve/confirm/release owner отсутствует в этом пути — B03                                                                          |
| Game JOIN                                | BLOCKED для production; PARTIAL implementation           | [commercial JOIN tests](../../apps/api/src/games/game-commercial-join.test.ts):164-615; durable attempt, frozen receipt, readback, no replacement POST                                                                      | Production guard, native route, provider-backed terminal receipt и LK1 compatibility — B01/B02/B06                                                   |
| Game LEAVE / CANCEL                      | MISSING paid-path; PARTIAL free-path                     | [roster](../../packages/database/src/game-roster-repository.ts):2455 и [game repository](../../packages/database/src/game-repository.ts):1174 запрещают paid operation; бесплатные права/locking/outbox реализованы         | Owner-backed возврат визита/денег и компенсация — B04                                                                                                |
| Viva payments / refunds                  | PARTIAL foundations; UNKNOWN native acceptance           | ph-admin `src/integrations/viva/viva-admin.service.ts:838-877,1623-1688`; LK `fn_split_cleanup_router.js:1012-1167` содержат payment/refund mechanics                                                                       | Полный LK2 native pay → confirm → cancel/refund, поздние callbacks, exact money/usage readback — B04                                                 |
| Training registration                    | MISSING в проверенном LK2 consumer                       | [TrainingsPage](../../apps/web/src/TrainingsPage.tsx), [recommendation source](../../packages/viva-adapter/src/exercise-recommendation-source.ts):427-430 — catalog/link back                                               | Исполняемая signup/cancel команда, capacity, payment/entitlement — B05                                                                               |
| Tournament registration                  | MISSING в LK2 UI                                         | [TournamentDetailPage](../../apps/web/src/TournamentDetailPage.tsx):251-254 — кнопка без handler; [summary routes](../../apps/api/src/tournaments/tournament-summary-routes.ts) — reads                                     | Безопасный signup/cancel consumer и приемка — B05                                                                                                    |
| Game/tournament/community/personal chats | BLOCKED полный набор; PARTIAL personal/game              | Canonical DIRECT/GAME, realtime и тесты присутствуют; community consumer read-only; tournament binding не найден в проверенной composition                                                                                  | Community send, tournament lifecycle, native iOS и reconnect/membership acceptance — B07                                                             |
| Basic station communities                | PARTIAL generic membership / UNKNOWN station association | Community join/request/leave и read foundations присутствуют                                                                                                                                                                | Station-specific association не доказана; support dialogs не заменяют communities; native entry points и authorization/unread parity — B07           |
| Push APNs/FCM                            | PARTIAL; ordinary iOS source в #509                      | APNs HTTP/2 adapter, FCM delivery, native token lifecycle присутствуют                                                                                                                                                      | #509 добавляет ordinary IOS/APNS; physical CI 6/6 passed в #511; signed capability, sandbox→physical device receipt, logout/account switch — B08/B09 |
| Trigger campaigns                        | PARTIAL                                                  | Scenario engine, outbox, retries, preferences и tests присутствуют                                                                                                                                                          | Реальная delivery/recovery цепочка, quiet hours/opt-out на выбранном target — B08                                                                    |
| iOS/Android release artifacts            | BLOCKED                                                  | iOS read-only cabinet; Android native allowlist; signing workflow/Gradle ниже                                                                                                                                               | #510 unsigned native CI success; обязательные native actions, reproducible signed artifacts и store readiness — B06/B09                              |

Наличие открытых foundation PR не доказывает отсутствие функциональности: существенная JOIN custody уже в main; ph-admin reserve/confirm/release реализованы. Нельзя целиком вливать старые branches по названию.

## Наблюдаемый CI — первый snapshot 2026-10-31

Ниже исторические runs исходного аудита; текущие exact-head результаты перечислены в начале документа.

| Repo / SHA             | Доказательство                                                                                                                                                                                                                        | Результат и предел                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LK2 `d6a0458a`         | [40576042384](https://github.com/Z6v6e6r/lk2/actions/runs/40576042384)                                                                                                                                                                | VERIFIED CI: quality-full, source-quality, dependency-security, secret-scan, deployment-contract, пять no-push Docker builds, provenance probes, pr-gate success |
| LK2 тот же SHA         | [quality-full job](https://github.com/Z6v6e6r/lk2/actions/runs/40576042384/job/122442888809)                                                                                                                                          | **7 087 passed / 126 skipped**, 695 files passed / 9 skipped. Отдельный migration step: 4 passed. Это не native/provider E2E                                     |
| LK `788fdb96`          | [41032694816](https://github.com/Z6v6e6r/lk/actions/runs/41032694816)                                                                                                                                                                 | VERIFIED CI: exact-head enforcement gate success. Delivery runs 41033437302 и 41033430637 skipped                                                                |
| ph-admin `83b1c17b`    | [40451185434](https://github.com/Z6v6e6r/ph-admin/actions/runs/40451185434), [40451185414](https://github.com/Z6v6e6r/ph-admin/actions/runs/40451185414), [40451185401](https://github.com/Z6v6e6r/ph-admin/actions/runs/40451185401) | VERIFIED CI: runtime artifact/recovery, subscriptions-binding-promotion, traffic-quarantine success; не доказательство установленного runtime                    |
| LK2 PR #503 `6d140606` | [40819637475](https://github.com/Z6v6e6r/lk2/actions/runs/40819637475)                                                                                                                                                                | dependency-security/pr-gate failure: npm audit 12 findings, включая 1 high в systeminformation. Остальные quality jobs success                                   |

Исходный baseline lock содержит `systeminformation 5.31.16` (`package-lock.json:10565`) и `fastify 5.12.4`; более поздний audit на PR #503 требует переоценки dependency gate. Исторический green main не является свежим vulnerability verdict. Эксплуатируемость этого пакета в продукте аудитом не доказана.

В том же quality-full job **реально прошли** `access-session-postgres.test.ts` (16), `messaging-concurrency-postgres.test.ts` (10), `notification-scenarios-postgres.test.ts` (14), `game-commercial-join.test.ts` (37), `extended-notification-adapters.test.ts` (12), `profile-view.test.ts` (7). Эти результаты VERIFIED на уровне CI соответствующих suites, не provider/device acceptance. Нельзя распространять пропуски одних PG suites на все integration tests.

Фактические пропуски critical suites из main CI:

| Suite                                          | Пропущено | Причина/граница                                                                      |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `game-lifecycle-http-postgres.test.ts`         | 13 из 19  | `GAME_LIFECYCLE_HTTP_TEST_DATABASE_URL`; 6 guard tests не заменяют physical DB cases |
| `game-create-recovery-postgres.test.ts`        | 13 из 13  | `GAME_CREATE_RECOVERY_TEST_DATABASE_URL`                                             |
| `game-commercial-create-warn-postgres.test.ts` | 3 из 3    | `GAME_COMMERCIAL_CREATE_TEST_DATABASE_URL`; даже pass доказывает WARN, не payment    |
| `game-comms-integration-postgres.test.ts`      | 10 из 11  | Physical integration absent in this run                                              |
| `game-messaging-membership-rabbitmq.test.ts`   | 4 из 5    | Broker acceptance absent in this run                                                 |
| `notification-resilience-postgres.test.ts`     | 4 из 4    | Physical persistence/recovery absent                                                 |
| `notification-resilience-rabbitmq.test.ts`     | 4 из 4    | Broker recovery absent                                                               |
| `community-direct-invite-postgres.test.ts`     | 4 из 4    | Physical membership acceptance absent                                                |

Переменные трёх game PG suites не назначены в проверенных CI/scripts. Исторические LOCAL результаты в committed docs не заявляются как повторно выполненные. Полная матрица: [R1-E2E-MATRIX](R1-E2E-MATRIX.md).

## Platform / mobile / deployment — исходный snapshot

Последующий #510 добавил unsigned native CI evidence, а #508 merged с доказанным suppression delivery; см. текущую сводку выше. Это не signed/store или production acceptance.

- [Web delivery 40577880952](https://github.com/Z6v6e6r/lk2/actions/runs/40577880952/job/122449060764) на main первого snapshot остановлен на eligibility: **RANGE_INELIGIBLE**. GitHub deployment `7369536612` имеет failure. Это корректный отказ неподходящему диапазону, не runtime crash и не доказательство необходимости ослабить gate.
- Последняя найденная в recent inventory успешная immutable publication [40543119379](https://github.com/Z6v6e6r/lk2/actions/runs/40543119379) относится к **4a3734a3**, не к текущему main. Её пять successful publication deployment records не равны установленным приложениям. Digest/custody/target readback этого аудита нет.
- [mobile-ios workflow](../../.github/workflows/mobile-ios.yaml):24-25 содержит `echo` вместо archive/sign/upload. [mobile-android](../../.github/workflows/mobile-android.yaml):24 вызывает `bundleRelease`; [Gradle](../../apps/mobile/android/app/build.gradle):20-25 не содержит release signing config. PR #504 предлагает fail-closed signing wiring; он открыт, не принят и не активирован.
- API истории workflows вернул **0 runs** для `mobile-ios.yaml`, `mobile-android.yaml`, `deploy-production.yaml`. Это отсутствие доказательств именно этих workflows, а не утверждение, что никогда не было ручного build/deploy.
- `deploy-staging.yaml`: 169 runs; последние относятся к `96e0b154`, 2026-09-22, последний failure, предыдущий success. Они не принимают текущий candidate.
- LK и ph-admin deployments API вернул пустые списки. Реальные host deployments могли выполняться иным способом; их состояние **UNKNOWN**.
- Все три branches/main API вернули `protected=false`. Дополнительные rulesets/environment protections этим не установлены; governance follow-up, не разрешение обходить review.
- [rollback runbook](../runbooks/rollback.md), [Timeweb publication](../runbooks/timeweb-amd64-image-publication.md), monitoring alerts и backup guards существуют. Свежий restore/rollback proof выбранного production target отсутствует в исследованных источниках.
- [release-lanes](../runbooks/release-lanes.md) прямо помечает упрощённые lanes как target contract до реализации platform plan. Для R1 нельзя подменять действующий strict executable path будущей схемой.

## Social и Engagement: границы реализации

Social gaps ниже остаются открытыми. Описание ordinary iOS push относится к исходному main: source gap исправлен в #509, но этот PR не merged; шесть physical CI cases прошли в #511, device/provider acceptance ещё не завершён.

Personal и game messaging имеют command/client-message dedupe, монотонную sequence и transactional writes (`packages/database/src/messaging-repository.ts:1918-2114`); read cursor защищён от future/stale sequence (`:2232-2302`). Game send проверяет текущий canonical roster (`:1908`). Realtime tests проверяют one-use tickets, revoked session/member и tenant isolation (`apps/realtime/src/app.test.ts:140,174,214,413,577`).

Однако community thread прямо read-only: [CommunityChats](../../apps/web/src/chats-ui/CommunityChats.tsx):181-182,350; [community experience routes](../../apps/api/src/communities/community-experience-routes.ts):153 предоставляет read. Тест `CommunityChats.test.tsx:205` подтверждает это намеренное ограничение. В проверенном messaging repository/composition найдены DIRECT/GAME, не подтверждено связывание tournament→conversation. Поэтому tournament chat — UNKNOWN до доказательства mapping, community send — MISSING. Community membership routes существуют (`community-routes.ts:417,544,663`), но station association отдельно не подтверждена.

iOS [cabinet](../../apps/mobile/src/ios/IOSCabinet.tsx):475-535 не содержит social routes, unsupported paths показывают unavailable. Android разрешает chats, но не community pages. История восстанавливается через HTTP sequence после reconnect (`chat-realtime-client.ts:26-107`); realtime очередь exclusive/auto-delete (`apps/realtime/src/message-consumer.ts:155`). Гарантия — durable history + recoverable hints, не exactly-once WebSocket delivery.

APNs действительно реализован: [adapter](../../apps/worker/src/apns-adapter.ts):18-48,113-152,185-204 и runtime wiring `main.ts:1199-1211`. FCM — data-only opaque payload с explicit UNREGISTERED handling, bounded retries и circuit breaker. Native installation/account/revoke state и Swift/Android tests есть. При этом ordinary [notification projector](../../apps/worker/src/notification-projector.ts):574-588 выбирает только WEB/WEB_PUSH и ANDROID/FCM. [APNs delivery](../../apps/worker/src/extended-scenario-delivery.ts):87 работает только со scenario_v2 deliveries, source keys scenario engine не включают chat events. Это конкретный iOS chat-push gap; credentials его не устраняют.

Сценарии покрывают booking confirmed/changed/cancelled/starts, game starts, friend-game, subscription ends, birthday, training attended (`packages/domain/src/notification-scenarios.ts:3-13`). FIRST_ATTENDANCE/MATCHING_GAME объявлены недоступными (`:118-126`); они не добавлены в mandatory scope автоматически. Quiet-hour/DST/opt-out tests есть; server-owned mandatory notifications имеют намеренный bypass. Outbox ждёт broker confirm перед finalize (`leased-outbox-publisher.ts:120-180`), delivery finalization привязан к lease (`notification-delivery-finalizer.ts:136-167`). Provider SENT не означает receipt/display на устройстве; APNS_OUTCOME_UNKNOWN не является success и не допускает слепой retry.

## Ограничения и итог первого этапа

Аудит выполнен source/CI read-only; из live-систем прочитаны только GitHub metadata/logs. Не читались секреты, базы/платёжные кабинеты, App Store Connect/Play Console или текущие production hosts. **STAGING / PROVIDER / PRODUCTION и physical-device acceptance остаются UNKNOWN**, кроме явно описанных исторических CI records. Отсутствие live-доказательств не является доказательством дефекта, но блокирует full release approval.

Порядок работ, владельцы и критерии закрытия: [BLOCKERS](R1-BLOCKERS.md), [DEPENDENCIES](R1-DEPENDENCIES.md). Процедуры подготовки: [RELEASE-RUNBOOK](R1-RELEASE-RUNBOOK.md), [ROLLBACK](R1-ROLLBACK.md), решение [GO-NOGO](R1-GO-NOGO.md).

## Inventory: открытые PR и exact-head check runs

Проверены все открытые PR на момент snapshot. `success/skipped/cancelled/failure` ниже — фактические conclusions отдельных checks; отсутствие checks = UNKNOWN. Таблица не утверждает mergeability или актуальность старых branch contracts. Список снят до создания PR этого аудита.

### lk2: 33 открытых PR

| PR                                              | Draft | Head SHA                                   | Checks                           | Название                                                                              |
| ----------------------------------------------- | ----- | ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------- |
| [#504](https://github.com/Z6v6e6r/lk2/pull/504) | yes   | `83af7bbdc76794bc99544d7acd4b04b8a0818d86` | skipped:2, success:17            | feat(mobile): fail-closed Android release signing wiring (prepared, not activated)    |
| [#503](https://github.com/Z6v6e6r/lk2/pull/503) | yes   | `6d140606d99a25d71a819a0a6c267b69eafed90b` | failure:2, skipped:3, success:13 | feat(subscriptions): strict policy/usage binding refs (B2 step 1)                     |
| [#467](https://github.com/Z6v6e6r/lk2/pull/467) | yes   | `4db4e0dba217d54da16359e9b78e09c97147f051` | failure:4, skipped:3, success:11 | test(c3): rebase independent acceptance onto merged main                              |
| [#466](https://github.com/Z6v6e6r/lk2/pull/466) | yes   | `a8de3c97204c303c7a34d9fb2e4d1e421b414ec5` | skipped:2, success:17            | C2: reconcile #455 receipt recovery with JOIN custody after main merge                |
| [#461](https://github.com/Z6v6e6r/lk2/pull/461) | yes   | `c5f9bc86a03246d92e32af69293dd32e245a15b1` | skipped:4, success:10            | chore(mobile): version Android FCM and Yandex test APK as 1.15                        |
| [#453](https://github.com/Z6v6e6r/lk2/pull/453) | yes   | `9a8bb3e25e2834823d8e48ea1ed605e0e8d4d609` | skipped:3, success:15            | fix(games): secure commercial JOIN custody and Android transport                      |
| [#435](https://github.com/Z6v6e6r/lk2/pull/435) | yes   | `814aa6aa13920142a932051fb08cffa229c25022` | skipped:3, success:11            | Refine chat controls, header and notification rows                                    |
| [#403](https://github.com/Z6v6e6r/lk2/pull/403) | yes   | `d089989788edad47a0db030a400aba36ef50cca1` | skipped:3, success:15            | Refine Profile V2 subscription summaries and full active list                         |
| [#401](https://github.com/Z6v6e6r/lk2/pull/401) | yes   | `29124d58988204c9b25cc21e1e9ee67efff9feef` | skipped:3, success:15            | Add a closed Profile V2 Web delivery contract                                         |
| [#400](https://github.com/Z6v6e6r/lk2/pull/400) | yes   | `73923ef4d410ba820ac4916db6c439b723933802` | skipped:3, success:15            | Isolate support runtime and prepare compatible database activation                    |
| [#398](https://github.com/Z6v6e6r/lk2/pull/398) | yes   | `1ece979b42e24d553ccdf3299ff0ab015a41417f` | skipped:3, success:15            | Add canonical self-subscription pages and harden live-read inputs                     |
| [#392](https://github.com/Z6v6e6r/lk2/pull/392) | yes   | `63a0a2e2e47f43183f22aaa8cc9a5bb42e995a32` | skipped:3, success:15            | Prepare immutable CREATE custody and financial proof resolution                       |
| [#391](https://github.com/Z6v6e6r/lk2/pull/391) | yes   | `904b2306f5b012891d61de52457461745cdbaef6` | skipped:3, success:15            | fix(games): recover original CREATE through GET-only P2                               |
| [#388](https://github.com/Z6v6e6r/lk2/pull/388) | yes   | `6d761edd61b8f7dad4cac51d57016d74cc733ba6` | skipped:3, success:15            | Define fail-closed partial booked-game readback                                       |
| [#386](https://github.com/Z6v6e6r/lk2/pull/386) | yes   | `1222c407ef0492c7bab634fb13f9ab99e9f8b532` | skipped:3, success:15            | Android: bounded Profile and My Records read observations                             |
| [#382](https://github.com/Z6v6e6r/lk2/pull/382) | yes   | `283c2eadc8f367e77a46b99b886b567b18cbd75e` | skipped:3, success:15            | feat(legacy-games): add bounded one-game observer and internal CLI                    |
| [#374](https://github.com/Z6v6e6r/lk2/pull/374) | yes   | `127d4009a1ca888b8912275bc8e9a98e385aebb8` | skipped:3, success:15            | Pin Web-only delivery to the merged Home runtime                                      |
| [#364](https://github.com/Z6v6e6r/lk2/pull/364) | yes   | `20871c68d1dc30c5d192c228ce00bbc05b149243` | queued:1, skipped:3, success:12  | Show owner subscription conditions on existing game cards                             |
| [#362](https://github.com/Z6v6e6r/lk2/pull/362) | yes   | `f8d548cf431e3ed65841ad7660ca55cc8cb2b81f` | skipped:2, success:17            | Persist safe standard-delivery invocation diagnostics                                 |
| [#361](https://github.com/Z6v6e6r/lk2/pull/361) | yes   | `53466da2d0efb816fd93969e7fe8deb2d09b2228` | skipped:3, success:15            | fix: preserve JOIN admission uncertainty after response loss                          |
| [#360](https://github.com/Z6v6e6r/lk2/pull/360) | yes   | `b012d5ac84c5750255f0141636114890048ec2e3` | skipped:3, success:15            | fix(security): patch Sharp native image decoder                                       |
| [#359](https://github.com/Z6v6e6r/lk2/pull/359) | yes   | `e6909299c88c7c33ffb8cc04aed214e7e672fd51` | failure:2, skipped:3, success:13 | Add server-owned booked operation admission and real session proof                    |
| [#355](https://github.com/Z6v6e6r/lk2/pull/355) | yes   | `ac26e4ada162a94d2d81703d2d73c838d66c23a7` | skipped:3, success:15            | fix(games): recover accepted creation and define booked-game blocker                  |
| [#339](https://github.com/Z6v6e6r/lk2/pull/339) | yes   | `313e18f83887666768cf7f51182570f444d47c57` | skipped:3, success:15            | feat(communities): PadlHub-owned community rating formula (v1)                        |
| [#330](https://github.com/Z6v6e6r/lk2/pull/330) | yes   | `022f8da16fb60a49f6b4a4e7130cdf9b89e34486` | skipped:3, success:15            | feat(notifications): per-context chat push categories                                 |
| [#307](https://github.com/Z6v6e6r/lk2/pull/307) | yes   | `ddc14d4e5c02088c1004fe47d4a5379718f0dc80` | skipped:5, success:9             | docs(adr): propose station-scoped support dialogs for LK2                             |
| [#290](https://github.com/Z6v6e6r/lk2/pull/290) | no    | `da9ede3eaf4db9c66a5a231614f450fb2e1053ff` | skipped:3, success:15            | fix(deploy): make chat media activation a required beta runtime input                 |
| [#244](https://github.com/Z6v6e6r/lk2/pull/244) | yes   | `6c413707f40d15980a27fbc33f205dc467f23e25` | skipped:3, success:15            | feat(identity): add profile phone confirmation for the authenticated account          |
| [#243](https://github.com/Z6v6e6r/lk2/pull/243) | yes   | `262d3f43793edbee8d78146fc868c13b7e126499` | skipped:3, success:11            | fix(web): match community bottom navigation to Home                                   |
| [#242](https://github.com/Z6v6e6r/lk2/pull/242) | yes   | `36117d36d939532da233169c4b669246819ce9f8` | skipped:5, success:9             | docs(identity): design phone attestation and account linking (no provider dependency) |
| [#196](https://github.com/Z6v6e6r/lk2/pull/196) | yes   | `65af4f464b0db06719f4fba5210b6bb2d0250304` | skipped:3, success:15            | fix(participation,auth): bind the end user and caller on the participation gateway    |
| [#173](https://github.com/Z6v6e6r/lk2/pull/173) | no    | `53753ac9e607a00b7b2d64a77bbac08c430fc221` | UNKNOWN: no check runs           | feat(web): subscription storefront Figma restyle + summer live preview                |
| [#169](https://github.com/Z6v6e6r/lk2/pull/169) | yes   | `7b6868390677f1ce46c989c1e292cf40556141c4` | skipped:2, success:17            | test(timeweb): add reusable beta release rehearsal guard                              |

### lk: 34 открытых PR

| PR                                             | Draft | Head SHA                                   | Checks                 | Название                                                                                        |
| ---------------------------------------------- | ----- | ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------- |
| [#263](https://github.com/Z6v6e6r/lk/pull/263) | no    | `d6bbc6257c87b7afd824827f3a1200871a339441` | success:2              | ФПР 6×25: передача ID и управление трансляцией на экраны                                        |
| [#262](https://github.com/Z6v6e6r/lk/pull/262) | yes   | `2d628a305909d2b85c2cae1bcd4d1c73ac391bed` | success:1              | build(jump): installed-baseline activation artifact (not for main merge)                        |
| [#261](https://github.com/Z6v6e6r/lk/pull/261) | no    | `d81ee76383d841e3e3acbf106cfe644c60e9f5e2` | success:2              | ФПР 6×25: рейтинг сообщества и привычное проведение турнира                                     |
| [#259](https://github.com/Z6v6e6r/lk/pull/259) | yes   | `696cddc29e80920b0284591f38f593ac545f7073` | success:1              | fix(storefront): separate direct Viva returns from LK confirmation                              |
| [#258](https://github.com/Z6v6e6r/lk/pull/258) | yes   | `0d6670e4baea74de9464abd10e133ead5dc5b215` | success:1              | build(web): installed-byte Jump ranking release artifact (do not merge)                         |
| [#254](https://github.com/Z6v6e6r/lk/pull/254) | yes   | `a58dc7050999d6e1de4ecffdfce6e0188fd7cb53` | success:1              | build: archive UI installed-baseline artifact (not for main merge)                              |
| [#250](https://github.com/Z6v6e6r/lk/pull/250) | no    | `95998d01942707cbe842431b57338b7fba619b49` | success:2              | fix(communities): open invited community and center Jump play CTA                               |
| [#247](https://github.com/Z6v6e6r/lk/pull/247) | no    | `109e43d49f35e7e705d9117fee308bf49c722572` | success:2              | release(jump): freeze independent game module artifact                                          |
| [#246](https://github.com/Z6v6e6r/lk/pull/246) | no    | `43afde45fe6978b25f2acf3d2cfe48756cd12850` | success:2              | Jump installed-baseline release: cabinet session and requested feedback                         |
| [#243](https://github.com/Z6v6e6r/lk/pull/243) | yes   | `e357e70f279813a5d77bec6a7afd85ffbff59b87` | success:2              | docs(MAX): bind transport activation to transactional queue and strict TLS readiness            |
| [#236](https://github.com/Z6v6e6r/lk/pull/236) | yes   | `c1d27d46cf788dc4151f06010181d89ba54e2037` | success:2              | Release Jump team ranking on installed frontend baseline                                        |
| [#224](https://github.com/Z6v6e6r/lk/pull/224) | yes   | `77c77dc773ee437ac8c6b55a5814ca53094abd10` | success:2              | Release custody: isolate merged score-entry fix #222                                            |
| [#205](https://github.com/Z6v6e6r/lk/pull/205) | yes   | `6df4375f24351dbbefaf28c408043e14d3082a7d` | success:1              | fix: unblock guarded trial frontend publication                                                 |
| [#203](https://github.com/Z6v6e6r/lk/pull/203) | yes   | `c674367f44ba3461e9cd059765de152b8e98a130` | success:1              | fix(subscriptions): refresh balances without restoring stale snapshots                          |
| [#200](https://github.com/Z6v6e6r/lk/pull/200) | yes   | `9ace338f086fce43c21a337e797519395d98cf1d` | success:2              | Add durable Telegram campaign analytics and dated pending-only resume                           |
| [#199](https://github.com/Z6v6e6r/lk/pull/199) | yes   | `b351965820d969348d1ac62853567355a6d48867` | success:1              | test: isolate PREPARED response-loss recovery proof                                             |
| [#198](https://github.com/Z6v6e6r/lk/pull/198) | yes   | `d48511e00b9b73dfa5a70d878b9780a30aedd018` | success:1              | ci: require physical booked-operation admission proof                                           |
| [#197](https://github.com/Z6v6e6r/lk/pull/197) | yes   | `ef4d9fced42badbc35106f4589ac2e99ecf6d9f5` | success:1              | Add owner admission with canonical B1 association                                               |
| [#196](https://github.com/Z6v6e6r/lk/pull/196) | yes   | `787602d2b0c61056482f6946a8c8a26d8b5f0813` | success:1              | ci(lk1): enforce commercial receipt owner regressions                                           |
| [#195](https://github.com/Z6v6e6r/lk/pull/195) | yes   | `8d4365697cbfe4a2481b7dd384edadfb919b13d0` | success:1              | B1: add actor-bound commercial receipt GET boundary                                             |
| [#194](https://github.com/Z6v6e6r/lk/pull/194) | yes   | `507a82a902a00d8bd0d66edf65a601cfdc23b969` | success:1              | LK1: correct court co-pay units and refuse charges above the event base                         |
| [#192](https://github.com/Z6v6e6r/lk/pull/192) | yes   | `f80f0d9d5ef6469850241576bcbcbea36ce8016f` | success:1              | feat(subscriptions): prepare RA 2.0 server rule                                                 |
| [#156](https://github.com/Z6v6e6r/lk/pull/156) | no    | `52bd2549c486b400597f1fb143406935728f5351` | success:2              | Protect phone data in games, communities and tournaments                                        |
| [#146](https://github.com/Z6v6e6r/lk/pull/146) | yes   | `8dd968bf6c7e8b8661d1b3a825aec03e6fc0f0d2` | success:1              | feat(tournaments): открыть проведение турниров из ЛК (deep link + quick action)                 |
| [#144](https://github.com/Z6v6e6r/lk/pull/144) | yes   | `03928e70480ab20be7bf7b34bd344efb432189ef` | failure:1              | docs(tilda): single-club subscription purchase block                                            |
| [#109](https://github.com/Z6v6e6r/lk/pull/109) | yes   | `d465d816cbb782bff6729854746c59d4a664cc6b` | UNKNOWN: no check runs | Диагностика отказов превью подписки + граница ре-поллинга протухших оплат (инцидент 2026-09-17) |
| [#105](https://github.com/Z6v6e6r/lk/pull/105) | yes   | `d074925c6ef4b930695f6d36a88c5ca680922b65` | success:1              | Enroll participants into every published tournament community                                   |
| [#84](https://github.com/Z6v6e6r/lk/pull/84)   | yes   | `7b139b54d860223bda322b5f8426aaf58acc12d3` | failure:1              | fix(games): выход из игры для импортированного участника без записи в Viva                      |
| [#76](https://github.com/Z6v6e6r/lk/pull/76)   | yes   | `3220e0a82e6d84a05c43ad04b4c553a7a881340d` | success:1              | fix(subscriptions): preserve cross-date allowance in price preview                              |
| [#50](https://github.com/Z6v6e6r/lk/pull/50)   | yes   | `908799fc34a93e44922feafd10542e23a9ba57ba` | success:1              | fix(subscriptions): bound the HUB claim pending window and protect CREATE attempts              |
| [#37](https://github.com/Z6v6e6r/lk/pull/37)   | no    | `028fc863231b1dc1df544bdbacbc41749a403d39` | failure:1              | feat(subscriptions): guarded repair для устаревшего годового резерва                            |
| [#31](https://github.com/Z6v6e6r/lk/pull/31)   | yes   | `6e006e367ff1983f96c804798d25b191fa89a129` | success:1              | docs(partner): runbook для переиздания security evidence партнёрского API                       |
| [#27](https://github.com/Z6v6e6r/lk/pull/27)   | yes   | `582c3adad43778239d14778b2e040f70b158184a` | success:1              | Run LK1 locally with session-bound read-only Viva access                                        |
| [#20](https://github.com/Z6v6e6r/lk/pull/20)   | yes   | `ea8b4f6679e092cf7eae9229a9258f37821efb59` | success:1              | fix(release): confine frontend deployment SSH to static artifacts                               |

### ph-admin: 5 открытых PR

| PR                                                 | Draft | Head SHA                                   | Checks                 | Название                                                       |
| -------------------------------------------------- | ----- | ------------------------------------------ | ---------------------- | -------------------------------------------------------------- |
| [#54](https://github.com/Z6v6e6r/ph-admin/pull/54) | yes   | `1265e4739d34f2291522bf4a60854828feee21cd` | success:4              | fix(MAX): make queue custody, FIFO and recovery transactional  |
| [#9](https://github.com/Z6v6e6r/ph-admin/pull/9)   | yes   | `4aec8b3c92144a1050cccc7efea499716cf79d11` | UNKNOWN: no check runs | feat(subscriptions): prepare instance projector evidence check |
| [#7](https://github.com/Z6v6e6r/ph-admin/pull/7)   | yes   | `4f3b5afe16f31fc41ee3ea1984f99975aee9f4f4` | success:4              | test(subscriptions): prove Mongo delegation replay             |
| [#6](https://github.com/Z6v6e6r/ph-admin/pull/6)   | yes   | `2d8e09a60a85f2090de058cc06ab759063bb415b` | UNKNOWN: no check runs | feat(subscriptions): add LK2 actor delegation boundary         |
| [#5](https://github.com/Z6v6e6r/ph-admin/pull/5)   | yes   | `a0ad974d6ca5e83d8997ad0db4508ce06a0838da` | UNKNOWN: no check runs | Managed subscriptions: authoritative runtime foundation        |

## Inventory: workflows и последние deployment records

Workflows перечислены полностью. Deployment records ограничены последними 10 для LK2; LK/ph-admin вернули пустые списки. Это metadata GitHub, не host/runtime inventory.

### lk2 workflows

| Workflow                                               | Path                                                            | State  |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------ |
| Bootstrap staging runtime-secret boundary (B0)         | `.github/workflows/bootstrap-staging-runtime-secrets.yaml`      | active |
| Build Communities rehearsal migrator                   | `.github/workflows/build-communities-rehearsal-migrator.yaml`   | active |
| Communities staged migration rehearsal                 | `.github/workflows/communities-staged-migration-rehearsal.yaml` | active |
| Communities staging preflight                          | `.github/workflows/communities-staging-preflight.yaml`          | active |
| Promote verified digests to production                 | `.github/workflows/deploy-production.yaml`                      | active |
| Build and deploy staging                               | `.github/workflows/deploy-staging.yaml`                         | active |
| Legacy staging OTP hotfix canary                       | `.github/workflows/legacy-otp-hotfix-canary.yaml`               | active |
| Android internal build                                 | `.github/workflows/mobile-android.yaml`                         | active |
| iOS TestFlight build                                   | `.github/workflows/mobile-ios.yaml`                             | active |
| Provision staging runtime-secret isolation             | `.github/workflows/provision-staging-runtime-secrets.yaml`      | active |
| Publish immutable Timeweb amd64 images                 | `.github/workflows/publish-timeweb-amd64-images.yaml`           | active |
| Pull request checks                                    | `.github/workflows/pull-request.yaml`                           | active |
| Reconcile existing immutable Timeweb amd64 publication | `.github/workflows/reconcile-timeweb-amd64-publication.yaml`    | active |
| Renew staging realtime smoke session                   | `.github/workflows/renew-staging-realtime-smoke-session.yaml`   | active |
| Set staging client routing plan                        | `.github/workflows/set-staging-routing-plan.yaml`               | active |
| Standard Timeweb Web delivery                          | `.github/workflows/timeweb-standard-delivery.yaml`              | active |

| Deployment                                                                             | Environment               | SHA                                        | Последний status |
| -------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------ | ---------------- |
| [7369536612](https://github.com/Z6v6e6r/lk2/actions/runs/40577880952/job/122449060764) | timeweb-standard-delivery | `d6a0458a1ae79aac3efccb0396486444d27d73e7` | failure          |
| [7364497278](https://github.com/Z6v6e6r/lk2/actions/runs/40543119379/job/122326866909) | timeweb-amd64-publication | `4a3734a34ab4e0b295649243271a286d68984ba8` | success          |
| [7364497266](https://github.com/Z6v6e6r/lk2/actions/runs/40543119379/job/122326866987) | timeweb-amd64-publication | `4a3734a34ab4e0b295649243271a286d68984ba8` | success          |
| [7364497262](https://github.com/Z6v6e6r/lk2/actions/runs/40543119379/job/122326867167) | timeweb-amd64-publication | `4a3734a34ab4e0b295649243271a286d68984ba8` | success          |
| [7364497254](https://github.com/Z6v6e6r/lk2/actions/runs/40543119379/job/122326866985) | timeweb-amd64-publication | `4a3734a34ab4e0b295649243271a286d68984ba8` | success          |
| [7364497240](https://github.com/Z6v6e6r/lk2/actions/runs/40543119379/job/122326866864) | timeweb-amd64-publication | `4a3734a34ab4e0b295649243271a286d68984ba8` | success          |
| [7360356090](https://github.com/Z6v6e6r/lk2/actions/runs/40516206378/job/122230665706) | timeweb-standard-delivery | `4a3734a34ab4e0b295649243271a286d68984ba8` | failure          |
| [7360267536](https://github.com/Z6v6e6r/lk2/actions/runs/40515652034/job/122228801656) | timeweb-standard-delivery | `4a3734a34ab4e0b295649243271a286d68984ba8` | failure          |
| [7357756144](https://github.com/Z6v6e6r/lk2/actions/runs/40499806107/job/122174349810) | timeweb-standard-delivery | `022eddd45ffde83e932dffdb46beb3401123548b` | failure          |
| [7357662629](https://github.com/Z6v6e6r/lk2/actions/runs/40499202606/job/122172320018) | timeweb-standard-delivery | `022eddd45ffde83e932dffdb46beb3401123548b` | failure          |

### lk workflows

| Workflow                              | Path                                                 | State  |
| ------------------------------------- | ---------------------------------------------------- | ------ |
| Community monthly MongoDB integration | `.github/workflows/community-monthly.yml`            | active |
| LK Standard Frontend Delivery         | `.github/workflows/lk-frontend-delivery.yml`         | active |
| LK1 Subscription Enforcement          | `.github/workflows/lk1-subscription-enforcement.yml` | active |
| MAX outbox adapter                    | `.github/workflows/max-outbox-receipts.yml`          | active |
| Telegram reactivation offline checks  | `.github/workflows/telegram-reactivation.yml`        | active |

Deployments API: `[]`; runtime state UNKNOWN.

### ph-admin workflows

| Workflow                                        | Path                                                                    | State  |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| CUP immutable runtime and recovery              | `.github/workflows/cup-runtime-artifact.yml`                            | active |
| MAX outbox receipts                             | `.github/workflows/max-outbox-receipts.yml`                             | active |
| Subscription runtime delegation replay evidence | `.github/workflows/subscription-runtime-delegation-replay-evidence.yml` | active |
| subscriptions-binding-promotion                 | `.github/workflows/subscriptions-binding-promotion.yml`                 | active |
| traffic-quarantine                              | `.github/workflows/traffic-quarantine.yml`                              | active |

Deployments API: `[]`; runtime state UNKNOWN.

## Inventory: полный снимок веток

Снимок paginated branches API. Ветки не оценивались как готовые к merge и не изменялись. Включает historical/merged/artifact-only branches; release candidate выбирается отдельно.

<details>
<summary>lk2: 511 веток</summary>

| Branch                                                         | SHA                                        |
| -------------------------------------------------------------- | ------------------------------------------ |
| `agent/acl-pg-pin-20261027`                                    | `98118f3775f06bef8ceb0e9ea41340a96d95d319` |
| `agent/adoption-chain-adopted-baseline`                        | `f0041e76e78e9a6f8c126f858497873b10882916` |
| `agent/adoption-container-imageid-hotfix`                      | `ea73a7698eafd4e4dd633eb8e3308125774b3831` |
| `agent/adoption-source-ci-parity`                              | `cf7cd62500d921cdc94977e92df6885bccadb5b9` |
| `agent/c2-join-followup-f3-20261027`                           | `137c568186fe09a7834872631e3581aec886664e` |
| `agent/c2-join-test-flake-fix-20261027`                        | `421b71bee2aaf92ccabf00612e44ace507e6c997` |
| `agent/c2-reconcile-integration`                               | `4822e53428d132c64c47525578d7348b4fc840f2` |
| `agent/c2-web-attempt-integration`                             | `014409aa12d78afad1a6c9b8220edf6c25c41222` |
| `agent/chat-photo-webp-20260928`                               | `4a853872f7b5adf9d1a9ad98f6fe1da47865f973` |
| `agent/community-directory-swr-20260928`                       | `3496c1a5fb1150de74fbec990c1037ccf1c0b444` |
| `agent/first-auto-delivery`                                    | `1085bd0915c321ca2779693f32bf0819553619fa` |
| `agent/first-standard-delivery-pilot`                          | `179a6e2cd1b33f83de78abd1912f6e8ea2d2bcf7` |
| `agent/flaky-cleanup-20261027`                                 | `e3fc6ec80e7b6572086e4a5da26f66d7ea8c0d27` |
| `agent/game-chat-avatars-20260928`                             | `a223f32d9cb66cd46a638f28e0d1e8c7a9c2f02c` |
| `agent/game-chat-list-entry-20260927`                          | `6e8ed59ae99d3d41d24ca52ecf502686055349dd` |
| `agent/game-chat-row-20260927`                                 | `4026d74cf86cb321d2c86d7575aaf15a028be96f` |
| `agent/game-chats-in-games-ui-20260927`                        | `402254f8b56251dd1c7070d87fb74037ee4bda34` |
| `agent/gitignore-exact-20261027`                               | `6e3d842036720f039377a3226ec70c6af5669051` |
| `agent/lk2-b2-contract-plan-20261027`                          | `15d6787bc3e705e2fca11ba614a93509392bc9b9` |
| `agent/lk2-commercial-create-pg-evidence-20261027`             | `0ed04403ebfcf75439df8d5a8c114d99ece2100d` |
| `agent/lk2-commercial-create-warn-v1`                          | `351ee8daf19a7981e01af02a354a80262a0bfd4a` |
| `agent/lk2-policy-usage-binding-v1`                            | `6d140606d99a25d71a819a0a6c267b69eafed90b` |
| `agent/location-photo-acl-packet-20261027`                     | `434b9ae20e9321e1b38087f0fa1ca1ea0a210321` |
| `agent/manual-baseline-adoption-20261026`                      | `2fd50bb77705956cbf39a25d5e2a359968381e01` |
| `agent/mobile-r1-signing-20261027`                             | `83af7bbdc76794bc99544d7acd4b04b8a0818d86` |
| `agent/operator-entry-token-class`                             | `a7a44e8172d36c65dfc77c643dfbd7cf86d4cee8` |
| `agent/photo0102-controller-delta-widen`                       | `fd3acc4012d200f279d9fb635a5797f3aa6d1c19` |
| `agent/photo-manifest-runattempt-20261027`                     | `d51942318716e99cbe079fa28a9724407602b57b` |
| `agent/photo-migration-container-index-20261027`               | `538ed9e67d363072d9c5304fc8677330a242eb1a` |
| `agent/photo-prefetch-image-identity-20261027`                 | `4e5218329f2efd02a3aa9d0db2c8fff0f952984a` |
| `agent/remove-pycache-20261027`                                | `6bbc0354204c3bf31fc0727ffafb261c4d4fa9c0` |
| `agent/revert-gitignore-night-20261027`                        | `b7c3ec5494dbfd761a1ec4674c15a2facb55b0ce` |
| `agent/safe-web-test-timeout-fix`                              | `269224cb0465dd10ded71f84d344fdc43bdb2691` |
| `agent/standard-config-outside-critical-dir`                   | `ac044711def529290ffd6e058049787ed04cd596` |
| `agent/standard-delivery-pilot-2`                              | `59cccf0cbcd625a4322b2eafc5cb436d5f6590cd` |
| `agent/standard-delivery-pilot-3`                              | `55adcb38e9db5ad31c2fc6f7ce0b724f60c6fcc6` |
| `agent/timeweb-delivery-transport`                             | `659cd2116003a23f34217592506c3d5281cb3d00` |
| `agent/timeweb-safe-web-delivery-20260928`                     | `9630ec6febca91d494ce6123b556cb69f3e40844` |
| `agent/web-commercial-create-flow`                             | `402d3d0fd7c50caf1d9b1d1068341cb36611ac39` |
| `agent/web-copy-aria-20261027`                                 | `17c35169489574d31dacbdb0db87c6dfdfed74f7` |
| `agent/web-quality-078-20261027`                               | `211de407486f7702cc3f8c9269c701ead90af15d` |
| `agent/web-quality-079-20261027`                               | `e6dd080fdc03770d312fc62b0ca6a6ba95664aa6` |
| `codex/activity-history-refinement-20260920`                   | `b75f3fe8c6400bfd5a734f06fd9a00952f2cbff6` |
| `codex/android-api-session-20260927`                           | `47503e30f57ff884b9d5f96aa5346d121b1cdb4b` |
| `codex/android-app-icon-20261005`                              | `08643eb90063628b8ef4c805010ac1d9611baf1b` |
| `codex/android-chats-fcm-20261011`                             | `abdf1953d77740971d8e02f05990dc3b6837b6b3` |
| `codex/android-fcm-ci-download-recovery-20261012`              | `db646594dfa35902cc74ebdab504300639262cd1` |
| `codex/android-fcm-disk-restore-20261012`                      | `7f8c9ef14c0eaa9a6b583ba161426816604977b3` |
| `codex/android-fcm-docker-image-alias-20261012`                | `04c56032e635c740e89f5c2c4cba0a77cbfd45c5` |
| `codex/android-fcm-finish-20261019`                            | `83bdbe5e5a8e6d314ab2afacd163b4b92197b79d` |
| `codex/android-fcm-migration-backup-20261012`                  | `f0f0880a29abe45b810663fd15ec3545ff688921` |
| `codex/android-fcm-yandex-apk-20261023`                        | `c5f9bc86a03246d92e32af69293dd32e245a15b1` |
| `codex/android-local-cache-20260927`                           | `eb6a1a0264e55ead85413622827d299d364e1066` |
| `codex/android-login-icon-fix-20261010`                        | `210bf3c8240f226f83461150da0644f5c8475050` |
| `codex/android-oauth-callback-route-20261002`                  | `67403daed64a46ee6d127330af47776c420d4f93` |
| `codex/android-oauth-fallback-20261021`                        | `b08c61e729e9a0568ac9f60cc2debb261b3ce27e` |
| `codex/android-profile-read-diagnostics-20261012`              | `6d157068993213374bed926f19e4aa4cddd54768` |
| `codex/android-two-read-observation-20261012`                  | `1222c407ef0492c7bab634fb13f9ab99e9f8b532` |
| `codex/android-yandex-login-20260928`                          | `399e8cfe3a095bc2b3969612b3ee83937555d3d2` |
| `codex/api-worker-transaction-admission-20261025`              | `e6b4cd6cd128928b2faa677a4929acbd241a7143` |
| `codex/auth-diagnose-185`                                      | `812046b954f7438951bd4980e03767461fa6a3af` |
| `codex/auto-reauth-reliability`                                | `e6940de7d03cffbc523274a698cc45305c024f44` |
| `codex/b0-automated-smoke-session`                             | `4c9952b28f346dace7208203e66262bb0bffde1c` |
| `codex/b0-candidate-checkout-fix`                              | `9bade6637fa6e05905ea783fff1e0c3f1b3d10a9` |
| `codex/b0-docker-mount-final-current`                          | `0ae0763511957d829b2b95cc3fc51b7f671a87ca` |
| `codex/b0-docker-mount-rw-fix`                                 | `76013a1ff0b82b81e3a728c6b4c762a00c14476c` |
| `codex/b0-legacy-compose-env-fix`                              | `a47884a71d5837fed476ba9f73a7ca805e361878` |
| `codex/b0-runtime-env-metadata-fix-main`                       | `0b5ee2a235b05921bf1e70ed749367a7ae70293e` |
| `codex/b0-smoke-session-waiver-20260920`                       | `3b1ff7330315f7d31e76d5aed1de606bd3774a32` |
| `codex/b0-waiver-wording-20260921`                             | `af2ec141aa3d218c9bc1b3a47a2b28ea0574ebee` |
| `codex/backup-python-suite-timeout-20261016`                   | `af49fa2a4168adab2b884a085b51f2c71e01889a` |
| `codex/backup-supervisor-host-20261016`                        | `5f64159ca685799adf4df5836dd965e641d37375` |
| `codex/beta-access-contract-and-grant-fix-20260917`            | `6a4e432b1db749d0c4f1b18eedb6bf4297c5247f` |
| `codex/beta-clamav-dependency-20260916`                        | `b25289ecfc16ae4e4c4d0943fa619fc7a421b400` |
| `codex/beta-live-data-activation-20260916`                     | `3e6fc73d8a9196511b93d69d3971c4085abba3e1` |
| `codex/beta-roster-quarantine-doc-20260916`                    | `e01cab32dcdd8c6eb685cc3a20a0c92511a54afd` |
| `codex/browser-context-viva-user-methods`                      | `53ba565746b15b1dd6ee905aca93c04bb2da1bc9` |
| `codex/browser-otp-control`                                    | `330eb7e4c276352bdbf59ef61b1d4b8efd082f4b` |
| `codex/c1-create-join-commercial-20261021`                     | `c36877f921d93e39ec602f6448d15de7ef30eeac` |
| `codex/c2-commercial-ui-20261021`                              | `9a8bb3e25e2834823d8e48ea1ed605e0e8d4d609` |
| `codex/c2-reconcile-20261023`                                  | `a8de3c97204c303c7a34d9fb2e4d1e421b414ec5` |
| `codex/c3-acceptance-lk2-20261021`                             | `7bb40321b8fb0d98bdc9d71eac5ed6572c393a70` |
| `codex/c3-acceptance-rerun-20261023`                           | `4db4e0dba217d54da16359e9b78e09c97147f051` |
| `codex/callback-smoke-controller-20261005`                     | `33ddc0a7149ac804b665e5957a0589be86b62da7` |
| `codex/card-figma-20260915`                                    | `46cd38f56ceab38ea3a17b488261ccb84d9997cb` |
| `codex/chat-access-divergence-20260922`                        | `8d1af971248c99e579f7af829dfe74cc87dcb61f` |
| `codex/chat-composer-icons-20261021`                           | `814aa6aa13920142a932051fb08cffa229c25022` |
| `codex/chat-context-push-20260929`                             | `022f8da16fb60a49f6b4a4e7130cdf9b89e34486` |
| `codex/chat-direct-and-filters-20260923`                       | `bfa6be1f3ba6cfee20f0539a66d9578a88b8fc56` |
| `codex/chat-filters-20260918`                                  | `829dd6a6251dd7e099ea561dee78c28e9ee35b1a` |
| `codex/chat-header-icons-20260922`                             | `50d2d4f4c081750757fe3c89910f1b3bd258ccb3` |
| `codex/chat-list-avatars-20260922`                             | `767783db34303c8d60c42786f8aa7384559240ae` |
| `codex/chat-media-release-env-20260922`                        | `da9ede3eaf4db9c66a5a231614f450fb2e1053ff` |
| `codex/chat-message-links-20260927`                            | `b8fe1087e949ef2fbb2458b9fbc202316baeb440` |
| `codex/chat-push-p1-main-integration-20260815`                 | `daf9d9ec3b3edc3a8254d4e71571c61c05b63f34` |
| `codex/chat-push-solo-owner-20260815`                          | `362f243ec5dcd61b68e0e7d74895ef741ecd6567` |
| `codex/chat-push-staging-foundation-20260815`                  | `7115f2fc3021c808648a277bc580f4d0fe3965bb` |
| `codex/chat-search-profile-links-20260922`                     | `ba1f4c7a43ac68eee4d61afa782bc156b5857d41` |
| `codex/chat-station-dialogs-20260922`                          | `54b80d3792b45a5c2a10ad69f7d59c68b9a332e1` |
| `codex/chat-thread-figma-20260917`                             | `3e190e412c4bf21283b897e53c85c9c4954406e2` |
| `codex/chats-rail-mobile-20260922`                             | `7b02175e8d02b36e4d73d191906b74ee3bff228e` |
| `codex/chats-sleeve-wallpaper`                                 | `e55522c4bd860597e1093ea9894b849b4c795a7c` |
| `codex/chats-station-ux-20260924`                              | `7058b6daa1471b6837ff0cbbfe6976c0f1398491` |
| `codex/chats-visual-20260917`                                  | `878ce4c237bf34b9805b45b2e5bef434c8745d34` |
| `codex/chats-wallpaper-full`                                   | `71212ddfb184bd80014c488b07f8201e5deb108c` |
| `codex/ci-diagnostics-nonzero-finalization-hotfix-20260827`    | `d1157b1d916132740434441ea3e68a8f63ee7b95` |
| `codex/ci-docker-path-selection-20260825`                      | `a611b5e88e4ed7083229154b68ff88d88adfcac9` |
| `codex/clamav-signature-update-note-20260916`                  | `a30d9fc7b690b5f329efd8c078b780d9326eab82` |
| `codex/client-assisted-booking-screens`                        | `3484ee3d3dfc851afdc77eb5b3e7c8902386aefb` |
| `codex/closed-reminder-subject-migrations-20261027`            | `06533641cb6bfe6e1c01b9d1f57ae38f96005964` |
| `codex/communities-chain-integration`                          | `80d8f0d6e5f3a35d5412ee9c604cd2979f92c65b` |
| `codex/communities-import-reserve-logo-host-20260915`          | `5c37e4425c97930d2e38e9e6837cbb8ac14dad4c` |
| `codex/communities-inventory-dry-run`                          | `e311bee0c51308dddbb49aaaea0b992022a111f3` |
| `codex/communities-legacy-read-only-profile`                   | `e6d516999c23d343b30af278290e9046eda9ae43` |
| `codex/communities-legacy-readthrough-20260915`                | `dbe2d09619e589fd59401d1ad300148bf34a5356` |
| `codex/communities-media-quota`                                | `0265725b1b68221e0a37a5056a12024f50de5f09` |
| `codex/communities-migrator-attestation-v1-fix`                | `eab6d9e94561c606c33f24a59681dc9da8f16329` |
| `codex/communities-migrator-image-evidence-fix`                | `f0f974d11f639c3bc507ffd7b6ef8835ee8b6d72` |
| `codex/communities-migrator-image-prep`                        | `5252c4d89a663b3aaf26c97d7548e0205e9bb488` |
| `codex/communities-negative-harness-ci-fix`                    | `1e865fbb524146ce4ff06bf254644a65e296c287` |
| `codex/communities-preflight-evidence-fix`                     | `e7dabaabed1bf54c478e9ed2c92f8f9ecd059c2a` |
| `codex/communities-rank-on-demand-20260929`                    | `c4091d35abdec481e9ca944fd206a18b18aafc7d` |
| `codex/communities-rating-ledger-20260929`                     | `313e18f83887666768cf7f51182570f444d47c57` |
| `codex/communities-rc-20260804`                                | `13173227dfbeb8bb40734f3e2d5d6f391f86a45d` |
| `codex/communities-read-only-checkpoint-20260811`              | `2fc4af5560f3237ee304d4e5a710d7f1b613a9cf` |
| `codex/communities-read-only-pr-20260811`                      | `cf64715eec5e1b63d1a3412181dbc68e3276f18f` |
| `codex/communities-read-only-release-20260812`                 | `7646fcd2e40b86be6f7b163333120269b67fff50` |
| `codex/communities-read-only-staging-flags`                    | `52690b080712880780cd2ecd3fbab2d53c06c50d` |
| `codex/communities-rehearsal-32-acl-matrix`                    | `1b598013eb84b82ea43e792a2c5f9e3f49d0c69a` |
| `codex/communities-rehearsal-32-runtime-boundary`              | `580613b8e6420f6f84d0c3502a2d4723eff075a7` |
| `codex/communities-rehearsal-33-acl-matrix`                    | `53bedc2deaf36990c61c1d9b8795d8ed1d7e0122` |
| `codex/communities-release-gate`                               | `c5183c4e4e4c3c054886a9c2a20ef476e33aed7d` |
| `codex/communities-role-split-inventory-producer`              | `0c6ab1020fc42d8b6163749b82cb2ff588fe32ff` |
| `codex/communities-role-split-marker-ceremony`                 | `476bd898444a9a4bf4d729b9f769471cb7fce540` |
| `codex/communities-role-split-marker-writer`                   | `0789c54badbd3a64cefd075d83be0a766376a0de` |
| `codex/communities-role-split-pg16-adapter`                    | `071dd6cb2ef64d93f32204ed76b1cfa054916e00` |
| `codex/communities-role-split-restore-runner`                  | `aa02b2cba16d79a282d9236973239582b452d167` |
| `codex/communities-role-split-runner-adapter`                  | `fbfb53d17c3ae034d5c9c80f9eb37122c224e22f` |
| `codex/communities-role-split-v3-composition`                  | `3d5e8eb034c976e6f862593d271ffcd8b9449aa4` |
| `codex/communities-role-split-v3-continuation-host`            | `5dc6d3c98324b34f8c9b6c9ed0370a714bbdba38` |
| `codex/communities-role-split-v3-contract`                     | `e25ac7ee1d1e2485be2f7784e237d822ecb78601` |
| `codex/communities-role-split-v3-durable-capability`           | `eaeda547b26f5e3f93839a079280c64d7b1fbcac` |
| `codex/communities-role-split-v3-durable-host-prep`            | `05d56c63848eb0c4d7906686f858fc35a3ef91b4` |
| `codex/communities-role-split-v3-executable-composition-prep`  | `a922aa7fb739f115bb85fb47e834c88d464d8434` |
| `codex/communities-role-split-v3-execution-consumer-prep`      | `7c35cb393912fa5662cbd831fdc21d578b5b8850` |
| `codex/communities-role-split-v3-executor-bridge`              | `de102ef919223a8d11c0974d03b47c0532fae13f` |
| `codex/communities-role-split-v3-installable-composition`      | `26603492e8288fcd34c569048a95afaad3ba91d5` |
| `codex/communities-role-split-v3-runtime`                      | `0746e520a6002b872f73690ffcfe6b7ed604dfb5` |
| `codex/communities-source-write-denial-attestation`            | `a7ad4dd22b099ad3fdf8e55d31833195e8689c34` |
| `codex/communities-staged-migration-rehearsal`                 | `1bead78f4bd051452e169b204d06e6c97e658caf` |
| `codex/communities-staged-rehearsal-32`                        | `dc0a235008a4e5024abcd3ca0b8df985624177bc` |
| `codex/communities-staged-rehearsal-dispatch`                  | `2314c96f5898645667c24bbebc053e6e59b7e482` |
| `codex/communities-staging-https-source`                       | `4b31a4848be5ca6613863dbc219593204c89426e` |
| `codex/communities-staging-preflight`                          | `92985698d4b8c5d673fc4d326885c9abbe26d9a8` |
| `codex/communities-staging-role-split-prep`                    | `1dce96d2990fb0a1d5ae0d93ca27f35486a6737f` |
| `codex/communities-test-cluster-pilot`                         | `1721d187467113660c237133fd69c7c3a4715a9b` |
| `codex/communities-writer-inventory`                           | `c16dc53f48b5d8ced3a915452a00d09271805776` |
| `codex/community-bottom-nav-20260917`                          | `262d3f43793edbee8d78146fc868c13b7e126499` |
| `codex/community-chats-cache-20260927`                         | `651eebcaf4e3365be044698a58780834da8143aa` |
| `codex/community-chats-tab-20260927`                           | `d25826efbfee2690d7c3df136cb2909793e0ad6e` |
| `codex/community-search-figma-20261016`                        | `e84be9be119ef9213679a2aace9624c8ab0217d4` |
| `codex/community-sync-coverage-20260916`                       | `e7ad970caf56299795dcbd06df513d5021487c51` |
| `codex/compatible-web-release-20261021`                        | `6da8ac25d8d15d457d3672760d5c4ff37b29cee4` |
| `codex/compose-rehearsal-readiness-20261013`                   | `f28fbd8163947113c2777c7f8061347dfac95397` |
| `codex/consumer-session-revocation-kya02a-20261003`            | `b955ae76e4735b6f9b0509e9a9a2547ee4fb6c93` |
| `codex/controller-promotion-t2-20261019`                       | `f2bc69883e599e482d252eb55ea1e6f4e7049596` |
| `codex/cup-identity-client-assisted-20260916`                  | `0d53b38e61aa7d670fd469cf9d9c72085383e7ab` |
| `codex/cup-identity-delegation-read-20260916`                  | `577a00c0bee007e3e056c4022697dd899ad7c03b` |
| `codex/cup-identity-live-path-link-20260916`                   | `a793c92cbe881f4b2ed4ae213ffadeab7d6c654a` |
| `codex/cup-identity-login-link-20260916`                       | `b8e25206b6b3eef4964f4102ea274f804fb2f1b7` |
| `codex/cup-identity-phone-20260916`                            | `78721fad44d39f6888dd02e251814151b9f801aa` |
| `codex/cup-rules-p1-20261021`                                  | `e49ec76016db45826ac7bb5427e4eac7ebe05563` |
| `codex/customer-contacts-kya01a-20260930`                      | `6a223232f8ff60f089ea4e89620899e83957f2cf` |
| `codex/customer-contacts-read-kya01b-20261002`                 | `4ce1e7a76a986d16428205bd790514cbc80da789` |
| `codex/customer-core-design-20260930`                          | `30508b64b1a7958e3e9cf9de8f20be0024da9094` |
| `codex/d15-self-subscriptions-20261015`                        | `1ece979b42e24d553ccdf3299ff0ab015a41417f` |
| `codex/deferred-friend-request-20260918`                       | `832a38f6a73a05c48acd629c59872946fa831e15` |
| `codex/evidence-base-pre120-f9e1365-20260825`                  | `f9e1365336dd70fd2a95723ad98101accc3d5762` |
| `codex/evidence-head-post120-c845b618-20260825`                | `c845b618294535556987a60c385fd5aff065a931` |
| `codex/exact-main-publication-contract-595e954`                | `33464e96ab093176e21ac82cb847463402f794c3` |
| `codex/exclusive-merge-owner-policy-20260825`                  | `ffa8b97b18181dc6d5633f2df6f1ec9f26ea39d9` |
| `codex/fcm-backup-host-readback-20261013`                      | `6c4800123be317d5bdc742fad9c6376867ee1338` |
| `codex/fcm-backup-systemd-admission-20261013`                  | `bea1259349a59bd9767416469edd98c1de25f9f7` |
| `codex/fcm-cryptsetup-keysize-20261014`                        | `8c6454cf71a931add84d321ec5d4e00e91843f10` |
| `codex/fcm-private-socket-path-20261015`                       | `e87e0d8b1b2ec17330b3c32ddc2ae7473925c326` |
| `codex/fcm-publication-buildkit-budget-20261011`               | `d7c51d7fa6f28dc635b7425bf64f3ae0ec380449` |
| `codex/fcm-runtime-guards-20261014`                            | `b472e4385ad3bd23084c02eb67a26fb9c209e494` |
| `codex/fin01-authoritative-proof-20261013`                     | `63a0a2e2e47f43183f22aaa8cc9a5bb42e995a32` |
| `codex/fix-b0-candidate-checkout`                              | `11088d557c9792c01d884184dc464167fa4ceec7` |
| `codex/fix-b0-premarker-compose-preflight`                     | `62a56bb6f117ece3e111ecf0a425d5aebb0072e6` |
| `codex/fix-b0-smoke-tenant-key`                                | `c68ec6d496ffb48f90ab6a6d212453f8a9c1de7e` |
| `codex/fix-b0-staging-env-metadata`                            | `74781c88139952db283af71565c1032daaa96879` |
| `codex/fix-ci-diagnostics-finalization-race-20260828`          | `936312b9471e81495285c90015d12f0e3dbe14d8` |
| `codex/fix-ci-finalization-observation-contract-20260828`      | `d740fa7019710967e649544ac4bd806ab88642a9` |
| `codex/fix-deferred-friend-delivery-20260920`                  | `b4d3f0d20f62427629353134f9ed5be11578290d` |
| `codex/fix-dependency-security-advisories-20260912`            | `99a423e5dce6febf54445ff55a96b554f1610419` |
| `codex/fix-home-retry-test-timeout`                            | `13909020167151803aac893fea0b47ff67b4fe08` |
| `codex/fix-legacy-otp-compose-create-compat`                   | `e5f63c1468f927cdb34f738df9b7453abdf1c374` |
| `codex/fix-legacy-otp-hold-retry`                              | `3e7629bed078bd3bce2e5084d7c3b4eed02258fa` |
| `codex/fix-lk-layout-booking-avatars`                          | `c37aa5c328fa0930ddb75f43f20d56f3f43f4618` |
| `codex/fix-main-formatting-1ae3db`                             | `006f79478cc2ef0782fd8c2e60da595ee9f300cd` |
| `codex/fix-main-prettier-baseline`                             | `891975bbb4f455892af922c11e54a3c5fc869d78` |
| `codex/fix-media-recommendations-20260814`                     | `45b4460ab4f80bb1264329337680ebb67834b7ee` |
| `codex/fix-media-recommendations-current-20260814`             | `4010c32fa7a37176f4a9ce7e3887acfbc5e56500` |
| `codex/fix-otp-qemu-pull-platform`                             | `99a9e5b466e6b9fa67fe90c254fb1b7e8cc1bc74` |
| `codex/fix-otp-realtime-readiness-diagnostics`                 | `4e2557bbc546c579f388eba28b572c6bf96a8ca4` |
| `codex/fix-otp-runtime-image-permissions`                      | `cb8aedde63344c24bc98c52c3881ba71434bb2ca` |
| `codex/fix-otp-runtime-probe-diagnostics`                      | `322b13467a17d1a9a1a4d7cf3970ad56f70ce3f1` |
| `codex/fix-otp-runtime-workspace-packaging`                    | `023e650dbca0183d680977c115ed18b17e2a6086` |
| `codex/fix-profile-level-history-import`                       | `e4499b9957d9375e18052167ef8250939f03ef0c` |
| `codex/fix-profile-level-history-main`                         | `92a51f5a188615203dd5a6c44669824f236ba941` |
| `codex/fix-provider-phone-link-20260916`                       | `57093dfd3e2baa8bfe375f53fd17da786dd68c8b` |
| `codex/fix-restore-capacity-planning`                          | `b781664d87f48cd0d02fe2eb1eca0a8b18c6f4d5` |
| `codex/fix-timeweb-buildkit-bootstrap-readiness-20260828`      | `16a7f6949aa9ee176f5c6591635e46587170eedd` |
| `codex/fix-timeweb-publication-manifest-clean-check-20260828`  | `9ad670bd2f65837fd4d5a579571dc338c55a871d` |
| `codex/fix-timeweb-python-launcher-symlink-security-20260830`  | `ea88175ebcd6ddc6d46797d2f6f2f0963d284d91` |
| `codex/fix-tournament-detail-count-test`                       | `0892b2f8988e6cbfbccf8b9b19c9c513fdf4ffa5` |
| `codex/fix-viva-oauth-185`                                     | `eeb735ef67554fb44e80e6c2ef6f8a073547baa1` |
| `codex/fix-viva-otp-wire-phone`                                | `d4c6827153fa202e1ac0c8df62eb3d03e9028773` |
| `codex/foundation-catalog-type-fix-20260921`                   | `a9f54696a493d98ae116c6aac4456a48888b55ef` |
| `codex/foundation-monitoring-config-20260922`                  | `c362a31aaef6a4ee79f8f46835792481603d6308` |
| `codex/foundation-recovery-definitions-20260921`               | `cc18860b7a9fa40b3f2871ddc8c044858c215092` |
| `codex/foundation-worker-gate-check-20260922`                  | `84c9092f098b913e9d34278abfc66a1f45d7598c` |
| `codex/friends-chats-followup-20260918`                        | `a5c3227e7cc617e4736cc53619c7567a46795fc4` |
| `codex/friends-chats-ux-20260924`                              | `2a02976a383138fae2ac0ed07d363cab19022a01` |
| `codex/frozen-ledger-test-fixtures-20261015`                   | `1503df319b83d684aa8374c089760897c04c86b1` |
| `codex/game-history-lk1-style-20260918`                        | `23ddd0d9b4a6349fd3a481e959dc896cbc47d46d` |
| `codex/game-join-test-clock-20261022`                          | `470eb79e8201b879c752cd2f77cf2db74cba208a` |
| `codex/game-participants-figma-20261016`                       | `33655104dcdff93523e16cc34ad137d964ccf891` |
| `codex/game-result-http-contract-tests-20260916`               | `0c5ce16a8e2f8bd8af58903a40ce6ad669d485e5` |
| `codex/game-results-local-primary-20260916`                    | `06b73feb7f04b322b22763978604e1a69f9918ec` |
| `codex/game-start-reminders-20261026`                          | `0a36664f615656a0d2cd442a153d95848191139e` |
| `codex/home-date-filter-20260917`                              | `9a4250a434f15829bdac7590ab36b9728fb881b8` |
| `codex/home-feed-scroll-and-pagination-20260915`               | `6a901858a5b52f1a94ed069317c9cda2c69952f3` |
| `codex/home-header-scroll-snap`                                | `82bcbc9266e5129d1999449a5e8de6c9b821f244` |
| `codex/home-projection-freshness-window-20260916`              | `841c38255d88a54328f2f0e989cef9d526f7fb80` |
| `codex/home-scroll-handoff-20260915`                           | `14124d7c8354c6eb403a9b9a602b0dfd24c0e688` |
| `codex/home-section-freshness-reproject-20260916`              | `26d3c88d447ac7510e0c7723f7d2366251ddaca0` |
| `codex/home-single-scroller-20260915`                          | `10c1f9e2368c628b40417bb8192f35c1f0ac49b6` |
| `codex/home-sync-cadence-20260916`                             | `aaed5f3666fa4b9eb3cfd20bb03d08538e8aef84` |
| `codex/home-tabs-bar-full-bleed-20260915`                      | `ddb6deebd5af1ffb97b15945a5bfc8fdcab113bd` |
| `codex/ios-app-foundation-20260927`                            | `b2e348f5d15b811494caa51b30467de2e3df58cd` |
| `codex/ios-profile-readiness-ci-20261005`                      | `a02a5e566eb1b8635322066340f207fe8ae6b600` |
| `codex/ios-shared-cabinet-20260927`                            | `5e21b91260bbfcb9510655c03478b28a074f2eff` |
| `codex/jetson-staging`                                         | `8f585bfe13a277823adfc09bf2cc661458e8ebfe` |
| `codex/jetson-web-staging`                                     | `84676be698193b9bb8bb5cbf4731d6f209b85d8b` |
| `codex/join-468-controller-compatibility-20261024`             | `0303e9990f8e604d621d955daae5a7054918c090` |
| `codex/join-activation-ready-20261022`                         | `0c390ebb6056ba04179e0a9aa5382d42dd9dd662` |
| `codex/join-post0105-restore-proof-20261023`                   | `a21c934b0b0e5e5fa90402632f7637ed37e26f71` |
| `codex/join-selection-code-20261023`                           | `1444e4f951b05a73d6d774dbf59f568976d4c1b0` |
| `codex/join-subscription-quote`                                | `20871c68d1dc30c5d192c228ce00bbc05b149243` |
| `codex/join-web-env-transition-20261023`                       | `2512138aee9564c37a05adfc425b4f40c47f054c` |
| `codex/legacy-mongo-backfill-20260916`                         | `b28d5fa54e894aa3aae96072362f792c9ebf46b2` |
| `codex/legacy-otp-web-asset-coexistence`                       | `6cea87f58b195e8788e076b0649a27afaa277a77` |
| `codex/legacy-rank-bound-16mb-20260916`                        | `f02021c6dab9a205feda681d49d1d7351b65725b` |
| `codex/legacy-rank-response-bound-20260916`                    | `6d1175398ef7012f35cca090fa749f93ad95a04a` |
| `codex/legacy-roster-audited-repair-20260916`                  | `e9258073776676b9a055664f48c97df515119a8e` |
| `codex/level-eligibility-games-20260824`                       | `c1d5e0f2ed7f0babc649867d5c64ad7a6b8ab4b2` |
| `codex/live-home-failure-evidence`                             | `4e8b6f2fc492b94893e6487099540389a219b263` |
| `codex/lk1-game-observation-20261012`                          | `283c2eadc8f367e77a46b99b886b567b18cbd75e` |
| `codex/lk2-admission-uncertain-response-20261006`              | `53466da2d0efb816fd93969e7fe8deb2d09b2228` |
| `codex/lk2-android-existing-blocks-20260927`                   | `312e129e8de57ea8f5a151679e36e6a8332f9bab` |
| `codex/lk2-auth-01`                                            | `720a974a1d20c07cee38936ef2d6da50db396360` |
| `codex/lk2-auth-provenance-optional-20260913`                  | `e07433b4927a3470b73de61c1318108bc5e6af53` |
| `codex/lk2-beta-access-and-friends-20260917`                   | `94346fc995793b249b4f241fe7dc899d630e075f` |
| `codex/lk2-beta-communities-promotions-history-20260915`       | `3d2471cb3b90961689a3f9e7066c3fda40e88624` |
| `codex/lk2-beta-support-enable-20260922`                       | `6a93b98c74bb847594903c4e6a9dff85b252f341` |
| `codex/lk2-booked-operation-admission-20261006`                | `e6909299c88c7c33ffb8cc04aed214e7e672fd51` |
| `codex/lk2-booked-operation-read-20261006`                     | `df30ecf9b6cbf2a79765932a5bb0e630391bb999` |
| `codex/lk2-chats-notifications-mvp-20260831`                   | `8899ca51e7071f5e21db73e486edab70219551fc` |
| `codex/lk2-communications-ui-reference-20260829`               | `7a198bd464b3503d9b47e1529e0455eafa8f636a` |
| `codex/lk2-core-game-journey-closure-20260826`                 | `e590f21eac6d18c0cba91eeab5cf9be5d0d0c69d` |
| `codex/lk2-cup-phone-resolution-20260917`                      | `364e6746608c472381993cc32d4903411cc62112` |
| `codex/lk2-cup-user-id-targeting-20260917`                     | `06a2e7faeaafcc8822f5920c6bfa272c5ef840a0` |
| `codex/lk2-cup-web-push-subscribers-20260917`                  | `0b65ab1c3f9b47fd8ec7db828464911a9acf7ff9` |
| `codex/lk2-delivery-reset-20260827`                            | `ebb23c65e75f527bac6a918e168ffbe06ae65b22` |
| `codex/lk2-delivery-stats-20260920`                            | `6608b46c7503488e8547d243df147b61cbab2742` |
| `codex/lk2-fast-delivery-20260906`                             | `79e75059543c0279b88c64cb09cde6fcf8ae3a65` |
| `codex/lk2-full-function-access-20260914`                      | `912425d1569ccbea057c6add22df0d1e997cbe69` |
| `codex/lk2-game-chat-beta-closure-20260826`                    | `6dc2281a25759aefc482950abceffbb1637156d4` |
| `codex/lk2-game-messaging-membership-convergence-20260904`     | `b0d2906396583204357379fb7b03465d9f7f2bcf` |
| `codex/lk2-home-reco-flake-20260918`                           | `27d398e97bb9cc480bdbcc8e5111be100dec9eaf` |
| `codex/lk2-ingress-challenge-allowlist-20260913`               | `a38f069774e4da135714beac910a4d88fef73a42` |
| `codex/lk2-instructions-skills`                                | `63565235abcbb6827203af5a019da0d9566f2ebf` |
| `codex/lk2-ios-web-push-20260918`                              | `2f8c677a25d6d8c82c3acf77bafa1c8e588e4663` |
| `codex/lk2-legacy-compose-binding-20260906`                    | `011cd6a87e03229bc98bf5fe4b84621ac0f3a0b7` |
| `codex/lk2-local-delivery-loop`                                | `75d4772fd90e9367880dd0e2e2e21afc4bb1124f` |
| `codex/lk2-mobile-full-width`                                  | `fa247814afd7f8f118e551775376dbdc76f48671` |
| `codex/lk2-night-beta-release-rehearsal-20260901`              | `7b6868390677f1ce46c989c1e292cf40556141c4` |
| `codex/lk2-night-ci-release-parity-20260901`                   | `1894572c9da3df3387534656e70417976ffbd104` |
| `codex/lk2-night-core-game-current-main-20260901`              | `a96637d67a532d2d66c773b5473960a9d46e5319` |
| `codex/lk2-night-game-chat-resilience-20260901`                | `d6371bc6babcb29f285d6450e9c4d92c05a67c0e` |
| `codex/lk2-night-node-bootstrap-hardening-20260901`            | `fdf90c5e94aa7c26d8ab6657f5dc04a3ffd4731e` |
| `codex/lk2-node-bootstrap-ubuntu2604-apt-lists-20260831`       | `692c472f2e315473d5032b51799937b93c7669a6` |
| `codex/lk2-notification-receipts-20260920`                     | `f33c3f69e0de6f1682131b03a600af5ce53031d3` |
| `codex/lk2-oauth-broker-provenance-idtoken-20260913`           | `e994ddc2898e077569642324813e930b1cbe274f` |
| `codex/lk2-phone-attestation-linking-design-20260917`          | `36117d36d939532da233169c4b669246819ce9f8` |
| `codex/lk2-phone-confirmation-20260917`                        | `6c413707f40d15980a27fbc33f205dc467f23e25` |
| `codex/lk2-phone-uniqueness-report-20260917`                   | `5d3e408354391895e20b5bae48b82c7286210614` |
| `codex/lk2-platform-payload-fix-20260920`                      | `f6f424876b1ae3de8abe5e1ba9096aae9239f9b1` |
| `codex/lk2-pr135-pr137-integration-fix-20260830`               | `5dc9cf56dab40e2a21e2cf6367b37d5709585d38` |
| `codex/lk2-public-beta-security-hardening-20260831`            | `776a8758cf76390b579af798a1d904f6c18fb367` |
| `codex/lk2-publication-tag-fail-closed-20260831`               | `0a9af055ac4a181d76cf88ea700d5517608c3b5a` |
| `codex/lk2-push-brand-and-title-budget-20260917`               | `daa1696c298352a4ef7b7f1626ea4ebf0c72abe4` |
| `codex/lk2-real-account-preview`                               | `04714f7d7e3b3ba5d164749c27d2ccf52bd7294f` |
| `codex/lk2-sharp-librsvg-security-20261006`                    | `b012d5ac84c5750255f0141636114890048ec2e3` |
| `codex/lk2-stabilize-booking-recommendations-test-20260831`    | `bdd2b751a0a99e0bc7c3d4c3dc2ff4c49f5306e4` |
| `codex/lk2-station-chats-all-20260922`                         | `1d932b6cdf48563c4b140403097f27edf58b9494` |
| `codex/lk2-station-scoped-dialogs-adr-20260924`                | `ddc14d4e5c02088c1004fe47d4a5379718f0dc80` |
| `codex/lk2-test-courts-20260928`                               | `f3137711b1b199304a5d23d96d1aa4dddff93292` |
| `codex/lk2-timeweb-beta-release-20260831`                      | `b8c1d8b75ac3f7b7883f0553057a214af1b82d74` |
| `codex/lk2-timeweb-cup-cors-20260917`                          | `32e1828cf29c03dc36e779cd2b1156364321326b` |
| `codex/lk2-timeweb-observability-evidence-producer-20260902`   | `849d6171a1f931fb54d1bdbc81a683b4981877aa` |
| `codex/lk2-web-push-beta-activation-20260916`                  | `55f0d85c562b87b9402b4b66ca863b2ab9aeeee0` |
| `codex/lk2-web-push-local-20260916`                            | `32ee5b5a7b06f1624ddc066750fd81063455c25d` |
| `codex/lk2-web-push-prominence-20260917`                       | `a4eec19f8b482f5af04ae8c5985a928123b5dcf1` |
| `codex/local-password-email-proof-kya04-20261005`              | `8ccb4b8030870b3a8a4dad72e7f233f14248e088` |
| `codex/matchmaking-detail-price-20260825`                      | `f5f5b378e6d72659c08587fd70ceaaa5753ae8a1` |
| `codex/matchmaking-quick-fit-20260825`                         | `1a44b1b7c0cab6bd475c2595529db91530a8c449` |
| `codex/media-binary-rollout-20260815`                          | `fbdfecfd9b6c43d75e873da6801218c22fb047fd` |
| `codex/messaging-attachments-slice1-20260920`                  | `7123c460edef163308b89f2edbe2993d0b936f0c` |
| `codex/migration-ledger-contextual-0044-compat`                | `0f921257401890298cf8489272d2e253aa6daedb` |
| `codex/mobile-account-avatars-20261010`                        | `04ebf7df412277c3014ff810238ad1f88ab66e99` |
| `codex/mobile-auth-hardening-20260824`                         | `a9a54b0e885dc085f92c3ef6da257f3a12280ad1` |
| `codex/mobile-native-shell-bootstrap-20260825`                 | `9c3b3dd0aff2a1867b3cd5063f8fb76f8fd434de` |
| `codex/mobile-system-insets-20261010`                          | `e835f8bf7dfde8efb4ea91cc30801f5c8415ae1e` |
| `codex/mobile-translucent-status-bar-20261010`                 | `8617242fac3674062c11acfea0b1a11e146db6e0` |
| `codex/mobile-yandex-primary-20261002`                         | `7a559adfdd2721bdcc43619c29c24164600b0b50` |
| `codex/nano-auth-release`                                      | `1f6996000a05f363a8a80905e788a4a16bf01bb9` |
| `codex/nano-client-assisted-parity-20260804`                   | `b5a42575c8d8773180e3ec3bc0e889fb981ddc2c` |
| `codex/nano-comms-m1`                                          | `9e568b27f2399eb9f4ae1c50c264baf82d728a2e` |
| `codex/nano-history-auth-verifier-20260805`                    | `7b5ab3f4adcf885a4acf61340e22211be1687935` |
| `codex/nano-live-home`                                         | `13c653c55e53a4804de2caf85f2f389af802158f` |
| `codex/nano-recovery-diagnostics`                              | `dd3b05e3a8abd724f1f224f8c399b13c2a697a7a` |
| `codex/nano-verifier-diagnostics-20260805`                     | `b78acfa25fdbead00bdb2dd6c11eb8222d05e89b` |
| `codex/nano-viva-runtime-url-20260805`                         | `ef5686c5f60aa905c7f44df83185388746593b13` |
| `codex/notification-brand-logo`                                | `585afc437bcc3be74f6d15c75e14c346324ab380` |
| `codex/notification-grouping-and-types-20260920`               | `2481bf55127ffa2af777baf9853a23f94d7b4fd8` |
| `codex/notification-preferences-20260920`                      | `932028068fc559186181d7ba6e289b0cf6752370` |
| `codex/otp-canary-stage-diagnostics`                           | `ff9ade31b89adf525e27c2aa323f40ec4c0f6ce0` |
| `codex/p0-authz-participation-20260915`                        | `65af4f464b0db06719f4fba5210b6bb2d0250304` |
| `codex/p1-games-read-journey-20261005`                         | `23ee3d0d6f6bd65aeeb6733c4d498afc10c2304b` |
| `codex/p2-game-booking-operation-20261005`                     | `ac26e4ada162a94d2d81703d2d73c838d66c23a7` |
| `codex/p2-nonfinal-orthogonal-consumer-20261013`               | `6d761edd61b8f7dad4cac51d57016d74cc733ba6` |
| `codex/p2-same-game-recovery-20261013`                         | `904b2306f5b012891d61de52457461745cdbaef6` |
| `codex/padlhub-branding-20261021`                              | `4c00b06b27f8f93c9dfa11a7e6bc500329b058a4` |
| `codex/phone-subject-link-20261026`                            | `67c844bfd978bac6f47e0f1e83224573aec0aeaf` |
| `codex/photo0102-release-profile-20261026`                     | `365647abc0c4a727d13a8356c9951003cdda2496` |
| `codex/photo-acl-baseline-20261026`                            | `05cf42d14561e44812c2349da2cfca72c87a3d6c` |
| `codex/postmerge-secret-scan-main-range`                       | `8d79703721e8357a5619295b03040b0f6a03e4fc` |
| `codex/profile-friend-request-block-20260917`                  | `3b20ac9c61ca86eb43218373136e2d7fa37140e8` |
| `codex/profile-mobile-width-20260916`                          | `e9f67187b2fb03f4d92e82bbddbbf853cfc64028` |
| `codex/profile-photo-cdn-fetch`                                | `a04d8a6bbc0702320b4bf4c671d78ae1eca89147` |
| `codex/profile-photo-timeweb-s3-20260914`                      | `7574988cfaa411b14dd0fbd7219f8b750729d2f9` |
| `codex/profile-reachable-invites-20260918`                     | `119e6618bde5e14ec6923075eb91aa6119179051` |
| `codex/profile-remove-friend-20260917`                         | `e87fd29626c15901be15f62437193830c18dfa9a` |
| `codex/profile-screen-overflow-20261010`                       | `3d8ba78d3884e73a125cc662aeea80ea5c0cabcf` |
| `codex/profile-share-link-and-qr-20260922`                     | `2e0eab2d63d1c2851e64b3061e6874d7ec9bf3ec` |
| `codex/profile-subscriptions-display-20261016`                 | `d089989788edad47a0db030a400aba36ef50cca1` |
| `codex/profile-v2-critical-web-20261016`                       | `29124d58988204c9b25cc21e1e9ee67efff9feef` |
| `codex/profile-web-layout-actions-20261011`                    | `c346ac17a95ccd94f6ed38c1bd33157e118c5a6f` |
| `codex/promo-card-image-fit`                                   | `fd4b3a590e351eaf1a5930d955b871c4e74f7ff4` |
| `codex/provenance-cleanup-timeout-20261005`                    | `380a1e1fe7133c9cfb1a693cc8358c633f149583` |
| `codex/provider-payment-recovery-games-20260824`               | `bf92a1f6aeaf1850f63b72f20848cad7b0676918` |
| `codex/recommendation-cards-redesign-20260826`                 | `66d9a3ae7385d4dc2eae1b467f5ea4f8ab1a9294` |
| `codex/release-lanes-20261025`                                 | `b1f662c6d64b82de5e6bf563b83117d7bdb40b08` |
| `codex/release-phase1-20261025`                                | `532ae6f03e182b84c7fbe662b180a1623389bd07` |
| `codex/remove-orphan-worktree-gitlink`                         | `c86e645017e6a4b1d3db988f6617ca9c8fbeedd7` |
| `codex/remove-pull-request-workflow-dispatch-20260825`         | `adddd3521c5f588aad85ff55281a2481f6101567` |
| `codex/renewal-phase1b-20261025`                               | `85b00d815c805485d998e3c766b5efa2c3f2be95` |
| `codex/restrictions-corrections-20260927`                      | `0bc6eebc55c6f53499a553beef875bee5bb84610` |
| `codex/revert-pr-138-containment-20260826`                     | `3b6e5be1b6a77dbd7d037fd8d1940b27d71e2734` |
| `codex/revert-timeweb-containerd-store`                        | `664145fbf607ce27818bc26936c24937cf88729f` |
| `codex/risk-based-autonomy-lk2-20260824`                       | `a34a67f6aa654e69997a797fc4be9e60762a4a06` |
| `codex/risk-based-autonomy-lk2-v2-20260824`                    | `fcc8e485ba4c5c064aab5a8f53a80437e2117c31` |
| `codex/risk-based-engineering-policy-20260825`                 | `3e578d4a2948cfb93db15c34f62f454da075aa3d` |
| `codex/role-boundary-diagnostics-20260921`                     | `22ccedd18cd6a3f67a16aad9e931893f605541a4` |
| `codex/role-split-bundle-rebuild-doc-20260916`                 | `533539ec7e2e705b0f34a5a67772ed22cda929a2` |
| `codex/roster-repair-packaging-20260916`                       | `5636fb4571a9b81477c8f11765f011a2fbc54537` |
| `codex/runtime-secret-render-delta-main`                       | `ff47d65ad6ebd6cab24f0a4c373230c8cb1efb5e` |
| `codex/runtime-secret-transition-explicit-disabled-flags`      | `3a9c41dd72724d052a0710f1f2de4d8c57711fab` |
| `codex/runtime-secret-transition-minimal-compose`              | `f86027ade286a12aad6c5f1a875827b10bfca310` |
| `codex/simplify-timeweb-node-bootstrap`                        | `af9282aa2dfcb01ada39068d4453c97f0b3e9cbe` |
| `codex/stabilize-v3-layout-test-20260915`                      | `c2c486e58d74b0b2ee75d6c595ce0383d7385aa7` |
| `codex/staging-awk-portability-20260921`                       | `d682bd3d1bbfe4c944f675009247b3501ea4d332` |
| `codex/staging-boundary-window-ack-20260921`                   | `3acc0943fde2c0abb5f927825313836b07d19f29` |
| `codex/staging-browser-context-viva-control`                   | `0528ab0db41f1c0834cb7f548dc35f107837a66c` |
| `codex/staging-browser-context-viva-e308`                      | `5e62399b4f923c726c602b2c1bbe6c0b5cb8b0d7` |
| `codex/staging-browser-otp-exact-e308`                         | `c4aa5e8106fffc9a4fb8f9fb03efc9a6ba1c3239` |
| `codex/staging-dash-function-env-20260921`                     | `3f173811a50380ff87a3914cf6c3f4b9b13c6e16` |
| `codex/staging-foundation-build-skip-20260920`                 | `b7a477dfdbe28f55ccc113a9a49fdf78dcf96466` |
| `codex/staging-foundation-install-cwd-20260921`                | `f7261199c1ff742bbdd6c012a5163b2fcfae71ac` |
| `codex/staging-foundation-monitoring-abs-path-20260921`        | `f7716e5f52e3e7c7f7285e2e383f11d2838d2a1f` |
| `codex/staging-foundation-pending-window-20260921`             | `583f4528888d4770beb96bb724224466bf9f5be0` |
| `codex/staging-foundation-prerequisites-runbook-20260921`      | `b9e30359175e8c5331509a19565f83d5b113fbf5` |
| `codex/staging-otp-bootstrap-control`                          | `05597d1878c8159ddc54964d1813bc5891feb88b` |
| `codex/staging-otp-bootstrap-e308-v2`                          | `81cb534d169df256a87ee8f638924656f9f80d94` |
| `codex/staging-otp-bootstrap-e308-v3`                          | `9782ccd12ae15989f1e2b574bf4cfe9d868ac341` |
| `codex/staging-otp-bootstrap-e308`                             | `0cd064a7f65ad03207ba978cadd8f092ea8ed0b4` |
| `codex/staging-release-env-diagnostic`                         | `1bc059567994159a5dbb1fe919579b848ec3188f` |
| `codex/staging-runtime-secret-bootstrap-base-e308`             | `e308181da5222645d9a87d03642923c6841be8d1` |
| `codex/staging-runtime-secret-bootstrap-controller`            | `99d3d7abb31e9de39b65514e7c16e77035e6fd1b` |
| `codex/staging-runtime-secret-bootstrap-e308-v2`               | `ffb12608fb16eae17096ab3ab3a7337cc5359c8a` |
| `codex/staging-runtime-secret-bootstrap-e308`                  | `9697e0604d99a8bb989a9bc53929c96c1bbb0129` |
| `codex/staging-runtime-secret-provisioner`                     | `98da6e425c8d6f38ac26aa337ab84266cea06ab7` |
| `codex/staging-verifier-diagnostics-20260921`                  | `797890b7ce3de427d90f28025e3e1ff03f2ffb50` |
| `codex/staging-viva-source-diagnostics`                        | `bc61f47cda72437a59273819e6d3efa1d901d26a` |
| `codex/staging-window-grant-preposition-fix-20260921`          | `37c58b55ba9c9df6aecba4439f27f33251d63b2b` |
| `codex/staging-window-grant-sql-fix-20260921`                  | `6d8561cb52e7b1ca11275e2858bc4507c5980665` |
| `codex/staging-window-schema-create-grant-20260921`            | `11e33f3f7ea0516e5c818897ff9dc30f59e1b4d0` |
| `codex/staging-worker-env-isolation-20260921`                  | `924cf1501b0d76af509dceab43c62ced414c6bdb` |
| `codex/station-card-photos-20261011`                           | `55cbef4d266ee55c348eb36ff7883a88ef6ff57b` |
| `codex/station-chat-media-author-20260923`                     | `63b5749647e760f47a2a70989786980584670437` |
| `codex/station-chat-mobile-open-20260923`                      | `9de22c520013bee8ad62126d23cb7263b403cbcb` |
| `codex/station-chat-sirius-logo-20260923`                      | `0764a27d6d50562c2555340812cf2ae88b05ffdf` |
| `codex/station-support-event-contract-20260923`                | `9a89b919c0dc9573c038b8ee9b47232ba25e052b` |
| `codex/subscription-runtime-identity-20260824`                 | `e3dbb800720fec830079d78311af155f97151051` |
| `codex/subscription-runtime-identity-v2-20260824`              | `2abdfba6e43744ca0e4b8cd78523ad0f95f6f508` |
| `codex/subscription-runtime-lk2-adapter-20260824`              | `3339afe6b903c82140952515e1e0c97b8297200b` |
| `codex/subscription-storefront-ui-20260831`                    | `15f4452521b494538adcca1df2e68209c5d56897` |
| `codex/subscriptions-current-api-20261015`                     | `57ee5b14ebb1dbdc891e1a4415cc3b0dbe58779f` |
| `codex/support-activation-20261015`                            | `73923ef4d410ba820ac4916db6c439b723933802` |
| `codex/timeweb-actions-artifact-scope-20260902`                | `84ea03d24bb812c76ac51751b1115f76fdac197c` |
| `codex/timeweb-activation-inputs-readiness-overnight-20260826` | `b9593874a5780013f93ab4663ec6fc24476569e8` |
| `codex/timeweb-amd64-ci-gate`                                  | `326bffca6f3d843c9ff9bd0b5b853d88733f2eef` |
| `codex/timeweb-amd64-immutable-publication`                    | `79f0ebd6d2dc937d21d7e981788d208d4ab5a925` |
| `codex/timeweb-api-web-observability-contract-20260830`        | `05c9f3d104b34220dd9353c3b7495dd4d3b62abb` |
| `codex/timeweb-api-web-upgrade-20261002`                       | `c2b848419f55f52cc1d27c64e15d73b1194d5b05` |
| `codex/timeweb-api-worker-recovery-20261011`                   | `ba9e564368001d0236adb11fcaa4a09859962601` |
| `codex/timeweb-apt-config-isolation-20260831`                  | `5dc589fe00ebfba23d361117d4b8dabc465473f5` |
| `codex/timeweb-attestation-nested-index-fix`                   | `f8fa5ee2fad9609c65d9ebc1354158cb0c449d50` |
| `codex/timeweb-attestation-subject-material-fix`               | `27db46042b0cfa56e1b9af1236396a8dc7495b93` |
| `codex/timeweb-backup-argv-race`                               | `ac47e79a34a6e3e39ae40c7dc7979fc7ba6f6e1d` |
| `codex/timeweb-backup-containerd-store-20261019`               | `6861b1ccfe8f34d4ee23152d90c657faee32eb2c` |
| `codex/timeweb-backup-docker29-mounts`                         | `87a073ea19ff57abb3d90acc6623a1fd1e86b27b` |
| `codex/timeweb-backup-image-id-format`                         | `0f99b14189deaa9a9a0b821fb29b177d2008b614` |
| `codex/timeweb-backup-import-identity-20261019`                | `83265227751885d83dff79df7fe09796f0f026dc` |
| `codex/timeweb-backup-import-identity-hotfix`                  | `4229052adb5e34e656ae52c2f4807de289f30cac` |
| `codex/timeweb-backup-managed-drift-retry`                     | `675e666e73367bc23cfcadc134849673dab0dc68` |
| `codex/timeweb-backup-managed-race`                            | `7bb4dafd6dd967c1a2f8c17c5464655d5b3d1cbb` |
| `codex/timeweb-backup-member-superset`                         | `509cba1159a4ed9eb4cedc87ddca05ec50e65f0b` |
| `codex/timeweb-backup-network-read-retry`                      | `39c1e715b929377974b2b9c45eed20dbfc690fe6` |
| `codex/timeweb-backup-pid-churn`                               | `7cdbea9d290b7ef99cc01207bd254c22eefc7d98` |
| `codex/timeweb-backup-private-mounts-fix-20261019`             | `9d7942f3ba6ce2a34e9e3b9f9ef225d14797f7c0` |
| `codex/timeweb-backup-proof-retry`                             | `6f7bc9eb0323e5866daed3595a7ae3e347af98ba` |
| `codex/timeweb-backup-publish-proof-retry`                     | `358ff974ca541d78f362871b115df3f7c7c3748b` |
| `codex/timeweb-backup-restore-timeout`                         | `5c1233c458ecbe4f791a52d6a26f27be68611d7a` |
| `codex/timeweb-backup-size-store-dependent`                    | `3e5efecd718540c25304f6de62eac87f12f7d672` |
| `codex/timeweb-backup-sizing-vfs`                              | `5498508f7df508a864e85a45cfe30b7b41b6b0a4` |
| `codex/timeweb-backup-zombie-race`                             | `a01d5a0de9f58481c69277754bf437c92e985596` |
| `codex/timeweb-beta-bootstrap-plan`                            | `86e41f50f2ef08873fc6e57e2a472ea637b36dee` |
| `codex/timeweb-beta-immutable-binding`                         | `ba80b8cfff967a1997e45bab67190f39e90f6917` |
| `codex/timeweb-beta-restore-planner`                           | `ea223b9acffeb44acbc2aca1e352002d54fd9747` |
| `codex/timeweb-bridge-main-candidate`                          | `f29251091b64b77e67b2b19eef6a1cd3fa65aaed` |
| `codex/timeweb-buildkit-attestation-probe`                     | `c30ba964761cbe791669f9dac1508ba2f48e702f` |
| `codex/timeweb-buildkit-readiness-retry-20260829`              | `a4fdf369cf648ca4b48ee5b7e4ec22fb2a7481a6` |
| `codex/timeweb-callback-owner-observation-pinned-20261003`     | `b455d027d61dd6aeb9d813bc11fbf5ac02caa755` |
| `codex/timeweb-callback-release-bridge-20261002`               | `03f38c410d2554951e4addcb7af5174648882b77` |
| `codex/timeweb-callback-window-20261005`                       | `709ca8ba8ca52ee2c1cdd9bc3fe47e9e4a6b2e43` |
| `codex/timeweb-canonical-publication-one-run-20260825`         | `1e880f3176f95d6be302491b005ef876ebd20a49` |
| `codex/timeweb-config-profile-preflight-20261005`              | `256360a52f81779493418338f2d4eefb85605da2` |
| `codex/timeweb-delivery-adr`                                   | `7973d1f3a247c2682c8c73bc6181341137b3b8bf` |
| `codex/timeweb-delivery-pins-single-source`                    | `f82d78170f381c91f1c49458449668554e61ce6b` |
| `codex/timeweb-deploy-preflight-script`                        | `12d925e16db65fa83d3890dfaec9ef9a0e6bd2d7` |
| `codex/timeweb-ghcr-blob-redirect-fix`                         | `7204e320c5dae8794bb6d51fdfa6b8b7b6dc99de` |
| `codex/timeweb-ghcr-redirect-ci-stability`                     | `e365328ce11f56da9d020caf8e81442f87af1ec8` |
| `codex/timeweb-lk2-beta-live-20260826`                         | `5004571c2dcec5f92845cef57405005e5bc85814` |
| `codex/timeweb-main-ci-rerun`                                  | `9bb2c4c3d6c3cfec8151360c295f6ff5f5671e81` |
| `codex/timeweb-migration-mount-order`                          | `910b7039c89364247eb9962d4bdb63d40976eac2` |
| `codex/timeweb-migration-snapshot-network`                     | `24861fb74dd25c2fd1af8c34e7d6b837800b0f2d` |
| `codex/timeweb-migrator-database-create`                       | `fbd0c5742e9c2dc95def57c47333ff0a377e4958` |
| `codex/timeweb-migrator-entrypoint`                            | `c01406e069c1ab822ec218deab0b537e30960579` |
| `codex/timeweb-prerequisite-producers-20261010`                | `6c07f11c247b9c16d5f0c1de7b5258021be1178c` |
| `codex/timeweb-private-namespace-restore-20261012`             | `5ff146acb40b95a93290d10b64b03ee79685695e` |
| `codex/timeweb-production-gates`                               | `a4b0c6952efc07b57109e9d3ea6b1c439b7d521a` |
| `codex/timeweb-provenance-purl-contract-20260827`              | `f28f3d60a156026113c723645358ba827eaa4706` |
| `codex/timeweb-publication-custody-20261010`                   | `a1ac064001a94784d5c10027c630e638100e17ec` |
| `codex/timeweb-publication-custody-v2-20260826`                | `660caa20c68e6f20ca4f852d0a4903263bd95c81` |
| `codex/timeweb-publication-reconciliation-fix`                 | `554f3176066099e6986a774b9a0a5511c1b52dc8` |
| `codex/timeweb-release-manifest-contract-sync-20260824`        | `a6c21d42ee97bd2cd35ce9eeb67f7b03c4c21dad` |
| `codex/timeweb-rollout-degraded-backup`                        | `e16761499b9c0f4dcd86011fef0f485a24b68dfc` |
| `codex/timeweb-rollout-degraded-preflight`                     | `6464e9a700cdda112545c89f815c59941cfa7b7b` |
| `codex/timeweb-rollout-skip-monitoring`                        | `8168bf0e31639cb08aa4899a4a94d2e1f60ee054` |
| `codex/timeweb-staging-migration-runbook`                      | `f922f0def2c689f3f188a6ae73e2160fb1f26394` |
| `codex/timeweb-stop-diagnostics-20261006`                      | `f8d548cf431e3ed65841ad7660ca55cc8cb2b81f` |
| `codex/timeweb-token-contract-20260830`                        | `b2db751d6f91923951d08b3ef6d02c1a6068e3c3` |
| `codex/timeweb-web-anchor-6f8209fa`                            | `127d4009a1ca888b8912275bc8e9a98e385aebb8` |
| `codex/tournament-history-card`                                | `8841c53b94d6907cc7d41c81d715b95257423eb5` |
| `codex/trigger-backup-isolated-source-20261023`                | `a5ac88543ed0fe9a8cf43da77801f712c0e368a5` |
| `codex/trigger-communications-20261021`                        | `b07340c247c88747f798308aa68c729caf350cc0` |
| `codex/trigger-release-0099-0101-20261022`                     | `7936070cec8236fa637e2ab753af7c8b3cbdf1fc` |
| `codex/trigger-release-observation-20261023`                   | `5da8423d5a366f7e5a6204ab86dc1573a161ddf5` |
| `codex/trigger-release-recovery-20261023`                      | `4eb7ca1d962b51fb341e58367c329359827abf33` |
| `codex/trigger-retirement-baseline-migrators-20261023`         | `375b7cf5653945dbdc1ff8ef9b433556c5a2ad73` |
| `codex/trigger-timeweb-execution-20261022`                     | `6099b84d8ce1cd60d7e0444c8ac16b8b1fa4200b` |
| `codex/trigger-timeweb-terminal-proof-20261022`                | `97e687aa5203b2a49f29f351d4d7a349ae6ee70c` |
| `codex/viva-home-roster-bridge`                                | `b9dafd64e6eaa08d1cd367acbd0f60858bcc4b9a` |
| `codex/viva-provider-clarification-package-20260825`           | `0a151104983500b7e4f9974fe7fd2bd29c07c8e3` |
| `codex/viva-provider-contract-evidence-20260824`               | `7593288932c66678311cf3ceeef791ada386ca3b` |
| `codex/viva-reauth-browser-profile-current`                    | `4c0cd0da0376ff4df8eb2414942e22d65f0aa12f` |
| `codex/viva-safe-reauth-main`                                  | `a33f609e03a54c92f19bda8a41bc19b3ec27bddc` |
| `codex/viva-safe-reauth-recovery`                              | `1930d52be07ed616430e4d2fbd312ba9f38f0ce5` |
| `codex/web-cache-headers-20260922`                             | `7b02175e8d02b36e4d73d191906b74ee3bff228e` |
| `codex/web-compat-anchor-af25d36a-20261022`                    | `ff36a75f7ecaa37b21a83d94468e65ec6f207dd8` |
| `codex/web-delivery-compatibility-20261010`                    | `e3454918440c310af5a1a2a91e02742793634a94` |
| `codex/worker-home-base-sync-20260915`                         | `e4f61770d2a7cc30706488b9758832fbb2429c25` |
| `codex/yandex-oauth-public-beta-20260829`                      | `fe5d5c124d1cd2c18388dd4d1d869210c228d5f0` |
| `integration/lk2-booked-admission`                             | `c50e590dc47b46846e189c143684d522f90e03aa` |
| `integration/lk2-games-comms-20260901`                         | `654cfe93d018b640939a16b4d06141dbdb89c7a9` |
| `integration/lk2-join-conditions-20261007`                     | `f032a77699c94937bcd912dc6a3a4dc56a24b787` |
| `main`                                                         | `d6a0458a1ae79aac3efccb0396486444d27d73e7` |

</details>

<details>
<summary>lk: 272 веток</summary>

| Branch                                                 | SHA                                        |
| ------------------------------------------------------ | ------------------------------------------ |
| `codex/annual-claim-release-20260911`                  | `975bfa369628b246edef71d11d429079b5c1aeec` |
| `codex/annual-fingerprint-trim-20260917`               | `afa36e8d5f31e60e6bf8858e94e1c48485ad68f5` |
| `codex/annual-fingerprint-trim-deploy-result-20260917` | `233a3b90cd90ede446763ccb51983c1e1986c125` |
| `codex/annual-reservation-repair-20260911`             | `028fc863231b1dc1df544bdbacbc41749a403d39` |
| `codex/archive-ui-installed-20261027`                  | `a58dc7050999d6e1de4ecffdfce6e0188fd7cb53` |
| `codex/archive-ui-main-pin-20261027`                   | `b9e50c91512a80958ccaa4441524911724f3b301` |
| `codex/atlanty-booking-anchor-20260922`                | `760c0773ef28cccd2e6daa8c9c090b9f16495176` |
| `codex/atlanty-card-fallback-20260922`                 | `1c8d76726bb0f74c698d512ed480c6c1b87a9138` |
| `codex/atlanty-cards-20260922`                         | `2e67787fb5c33b0bf1cc8df0a4e4277ad844a93b` |
| `codex/atlanty-categories-20260921`                    | `2dac6eb759cb3127cda2aeeb209c8dc9090d3aa3` |
| `codex/atlanty-category-quota-20260922`                | `936142bc2d82f6fa2ce696d1f9fa2719f7cbbbbc` |
| `codex/atlanty-docs-20260922`                          | `1467b24a87d4357b0e9f1f379ad320c6ef1bd612` |
| `codex/atlanty-fetch-errors-20260922`                  | `5d8972d5f4af47949cf29cc68846540251f26df8` |
| `codex/atlanty-friendship-subscription-20260921`       | `defb2f90f765899e08d2758be233b9c570dbd972` |
| `codex/atlanty-landing-tilda-20260922`                 | `b5080846b520a39e2ba6a462c57a717d6931c8b0` |
| `codex/atlanty-lighter-cards-20260922`                 | `ca8a84398040d54bf5540e990aa5580284388295` |
| `codex/atlanty-schedule-20260921`                      | `8d9ff508994f9ebfcfed523951c800438e05c350` |
| `codex/atlanty-theme-20260922`                         | `4393299e73a2f1c7a4ab17e1b71be9f292ebcb4f` |
| `codex/atlanty-tilda-blocks-20260922`                  | `3f78b64e29581bb2510d3d98428bc6297e24e184` |
| `codex/atlanty-zero-offer-20260921`                    | `a6dca69e5683b43a2d50a98f2c8b157310841ed6` |
| `codex/auth-consent-denial-20261025`                   | `25abdaab9dd5c0d8b8ec8523e1d206b7cb1a3e87` |
| `codex/avatar-initials-fallback-20260913`              | `5e1ecf7f2058d418b763bd0b16e9436366a9ac35` |
| `codex/baseline-red-20260911`                          | `31ae1624d117ebce1def3bd42527f19442abd3ec` |
| `codex/booked-operation-receiver-20261021`             | `f63ffb732ec8fbbeb8d5fa64748735712133d697` |
| `codex/cabinet-game-load-guard-20260913`               | `b249f0c6ceac02ac16fd36bbad24bd22a727bc23` |
| `codex/cabinet-participant-invite-20260913`            | `f933fa48ac013c216514ce9260450d508e35638f` |
| `codex/ci-pii-split-fixture-phones-20260912`           | `567ff49717b217e125b2b043c6427c4404585120` |
| `codex/ci-red-baseline-20260911`                       | `a0c70a6bdfaef344968be0390ea1486f6f1da83e` |
| `codex/close-lk1-subscription-enforcement-20260826`    | `4edad43ad5a4bbba97ebffbd680167f60f9a2360` |
| `codex/club-subscription-block-20260922`               | `03928e70480ab20be7bf7b34bd344efb432189ef` |
| `codex/community-activation-runtime-20261026`          | `3c81d87828798f7751fc53af2a626aea6a936e85` |
| `codex/community-current-month-20261009`               | `7f46679982ea8513741cecd53d623a6fb8cb70a6` |
| `codex/community-invite-archive-20261027`              | `7c4f6e1e14bc64dba5a0547a38015db1ec41a5a9` |
| `codex/community-invite-copy-20261026`                 | `9c5d1c5a01d786f08822ab7eb8f7a81f20495167` |
| `codex/community-jump-ui-followup-20261027`            | `95998d01942707cbe842431b57338b7fba619b49` |
| `codex/community-media-alias-20261025`                 | `f05c02672f481b727c840bf6d4dbf88db2908c16` |
| `codex/community-month-worker-compat-20261009`         | `199ff9e901b874b4f56c94328419d298b4646d07` |
| `codex/community-monthly-endpoints`                    | `b6bcd8a5a2c32a7609dd61c75c6ab1663d944a9c` |
| `codex/community-monthly-release-compat-20261019`      | `a9504268799aefc9920d798cd610a1a1f1c94fb6` |
| `codex/community-types`                                | `32b3bc0c6e0ce7a31e5d871fc8645ece021e1491` |
| `codex/cup-bookingless-removal-20260911`               | `94e33a251de81ea2e0b6cdbe0869d31118d46577` |
| `codex/cup-feature-activation-20261026`                | `c5881af798de6b8200a6c2d3b4e83a3952a82e1e` |
| `codex/deploy-ssh-robustness-20260911`                 | `3d34d6d021bf2d77338c5e63d77e522fdaffafd3` |
| `codex/dev-release-split-join-price-20260911`          | `3263878f700236f00da98951d3659780c9989f80` |
| `codex/event-community-20261023`                       | `680d394013a535ea2c137dbb06fa850a94534ac3` |
| `codex/event-launch-preparation-20261023`              | `3fc909c3dcbd5dabc4cf71b1caf092ac30f2805a` |
| `codex/event-payment-dev-current-20260914`             | `ff9868c4132c96ad5ef204a9fa797dc2e60c9e51` |
| `codex/event-payment-dev-release-20260914`             | `fdf6975275b29228797d7a5cb5fe4ae36e965d0d` |
| `codex/event-payment-prod-release-20260914`            | `45a56c6101c7f3263b1f95f4eb09631210759fd8` |
| `codex/event-payment-routes-20260914`                  | `c69cdedca56a016ef9f92fa6433ab623e50fa37f` |
| `codex/event-release-clock-test-20260914`              | `a6111f6004503482b20408d2fe5e62bec18b9b12` |
| `codex/fix-mongo4-subscription-confirm-filter`         | `ecf505b593c03f04eaea26bb56eb287ca95cc1b4` |
| `codex/fix-sub-hab-confirm-contract`                   | `696cddc29e80920b0284591f38f593ac545f7073` |
| `codex/fix-viva-cancellation-readback-prod-20260731`   | `d90da57fd6b3f66182636166c68ba3a1163ca194` |
| `codex/fix-viva-cancellation-readback-v2-20260731`     | `7cbb7a7ac6d3c2678681bae1be0d7581ba08f3e1` |
| `codex/fpr-6x25-broadcast-20261029`                    | `d6bbc6257c87b7afd824827f3a1200871a339441` |
| `codex/fpr-6x25-installed-20261029`                    | `d81ee76383d841e3e3acbf106cfe644c60e9f5e2` |
| `codex/friendship-two-hours-20260930`                  | `363ef11fc4e45ff1cd83fbb90cac634d96754c32` |
| `codex/frontend-activation-access-20260906`            | `ea8b4f6679e092cf7eae9229a9258f37821efb59` |
| `codex/frontend-smoke-selector-only-20260911`          | `d6067a1161eeee031422cd393856981f1a824ee8` |
| `codex/frontend-static-isolation-20260906`             | `b56523bb57e45a2eecb10e4702af763c41245bdc` |
| `codex/game-count-in-category-row-20260913`            | `242589070eeb71374079700c31fca64b87ea83d4` |
| `codex/game-create-subscription-surcharge-20260915`    | `8ee26e813174dcb72683ab2b5b0f9ee0197f95e1` |
| `codex/game-leave-dev-release-20260914`                | `baffef8b8a892019228e5296ae23b1490e06747c` |
| `codex/game-leave-nonblocking-20260914`                | `0c9ffc3ec9fe724545f203a7d65e57a166cb8d48` |
| `codex/game-leave-prod-release-20260914`               | `52265f6f323670c6b577c355d507f83ce63592f3` |
| `codex/game-organizer-handoff-20260913`                | `29eccd8410cb81b693c898f71b7e9f386a127417` |
| `codex/game-progress-2026-03-04`                       | `1150b44d2e97c9946636d7bd4b561078fc84c38c` |
| `codex/game-result-player-audit-20261023`              | `a8151da90a5b0d980aa77b9759165918e019dba2` |
| `codex/games-leave-imported-participant-20260915`      | `7b139b54d860223bda322b5f8426aaf58acc12d3` |
| `codex/games-red-test-pins-20260915`                   | `6e58ba079c9db29caef1894b5e48f527ab67d1d9` |
| `codex/group-design-20260917`                          | `f5fa8ec9add538329d97d0dbfb82c6ae49ea4dbf` |
| `codex/group-discount-6538-20261016`                   | `050f169ce4e454623408c8a9699a559ccb11d7bc` |
| `codex/group-event-discount-payment-20260913`          | `8cfa01cb2402b13bcaef5d72a240b112b38cfb72` |
| `codex/group-preview-diagnostics-20261002`             | `c7eaaf45d5b6623b98a4f1111cddcc7c2e376f63` |
| `codex/group-subscription-offer-hotfix-20260917`       | `b5107f224c74d29a10e155482af0ab6f8a673330` |
| `codex/guard-games-membership-live-contract-20260823`  | `3e67382ccc426d1ee8da76bea5b55c65850fb57d` |
| `codex/home-load-errors-20260913`                      | `464ab7cc57d2b1cfa565e05c7b0721344c40846e` |
| `codex/hub-daily-limit-config-20260911`                | `8e9ea2fba42983cadd7b1701cab7ee78162a3188` |
| `codex/hub-pending-deadline-20260912`                  | `908799fc34a93e44922feafd10542e23a9ba57ba` |
| `codex/hung-claim-cancellation-reconcile-20260913`     | `b084682e12baa3fe8bff4e9d0c5dbd79d1cbc5a5` |
| `codex/hung-claim-release-20260912`                    | `be1bc2079f47b4dafe74f741dc784b580f5a665b` |
| `codex/join-activation-ready-20261022`                 | `d354929bea7338b977ce4969e97730ce3c9dbb44` |
| `codex/join-owner-get-probe-20261023`                  | `a0e1312da151996ce82651115ef9001a6402fd69` |
| `codex/jump-cabinet-session-20261026`                  | `f64ba4a4b486457fcbbf433a1f099bd06e59ff4a` |
| `codex/jump-community-installed-20261026`              | `c1d27d46cf788dc4151f06010181d89ba54e2037` |
| `codex/jump-community-primary-20261026`                | `9dec39cac60fd01396e06a95f8459041409525d9` |
| `codex/jump-feedback-20261026`                         | `3275e4337d2e0f50c5c3662308f5dbf399b589be` |
| `codex/jump-feedback-installed-20261026`               | `43afde45fe6978b25f2acf3d2cfe48756cd12850` |
| `codex/jump-lazy-main-20261027`                        | `82e59effabbb734a4d411af1b255064b8209f625` |
| `codex/jump-module-release-20261027`                   | `109e43d49f35e7e705d9117fee308bf49c722572` |
| `codex/jump-ranking-copy-20261026`                     | `9b21fb1d8ba343e64c7b5a08f99655e3bd428ecd` |
| `codex/jump-rating-archive-20261027`                   | `d0e92e2216adaccfe482f8a0eeebb3159c6f8cef` |
| `codex/jump-rating-installed-20261027`                 | `0d6670e4baea74de9464abd10e133ead5dc5b215` |
| `codex/jump-spectator-20261027`                        | `031806ff49ceda0f4ded85a57c20e6011747fdbd` |
| `codex/jump-start-archive-20261027`                    | `987addaa41aac8c2fd68d43a50a38a97f9f719e8` |
| `codex/jump-start-comment-20261027`                    | `3bb1e67bae198fb76711c51e4e20779a46f2d2e9` |
| `codex/jump-start-installed-20261029`                  | `2d628a305909d2b85c2cae1bcd4d1c73ac391bed` |
| `codex/leave-waitlist-cleanup-20260913`                | `f17867985a7e51417658abf974a3bba67d1ea14b` |
| `codex/limit8-release-trial-guard-20261005`            | `f4f7b8cc1a89d888ca3953a68a31d34aa2b3c3a0` |
| `codex/live-release-compatibility-20260913`            | `4beafb1e19c32dbdb710c9a38f50c9e5462d913b` |
| `codex/lk1-admission-ci-contract-20261006`             | `d48511e00b9b73dfa5a70d878b9780a30aedd018` |
| `codex/lk1-admission-uncertain-response-20261006`      | `b351965820d969348d1ac62853567355a6d48867` |
| `codex/lk1-b-owner-ci-wiring-20261006`                 | `787602d2b0c61056482f6946a8c8a26d8b5f0813` |
| `codex/lk1-booked-operation-admission-20261006`        | `ef4d9fced42badbc35106f4589ac2e99ecf6d9f5` |
| `codex/lk1-booked-operation-read-20261006`             | `8d4365697cbfe4a2481b7dd384edadfb919b13d0` |
| `codex/lk1-closeout-ci-matrix-20260827`                | `c3c611247644222ab5ecb90ce31182c52761ee91` |
| `codex/lk1-correlated-error-diagnostics`               | `293c326d40ca415da1cff58a749b96f88e26dc11` |
| `codex/lk1-court-copay-20261005`                       | `81cff6e7580d359c9744193bebe0bdab19c78b0b` |
| `codex/lk1-dev-full-enforcement-20260914`              | `5fdab319566849d1e03e9caed8fc755245778abb` |
| `codex/lk1-dev-source-remediation-20260904`            | `e9729c0bfa1281ff7f00b5391dba1854397d9ee0` |
| `codex/lk1-diag-wrapper-fix-20260915`                  | `44b98bc1905fe6d24b10fb9a240ba3609a6f050f` |
| `codex/lk1-docker-readonly-20260908`                   | `582c3adad43778239d14778b2e040f70b158184a` |
| `codex/lk1-error-source-fixes`                         | `5f65ca28eb5008535a216b2b4db4ce1f599a2976` |
| `codex/lk1-event-diagnostics-20260915`                 | `585111a63f6f6ddd40fe3dc4bd28379eccc90c7b` |
| `codex/lk1-event-quote-hotfix-20260915`                | `284a6b4a6d3806a922385be4c062686fd3c6bbe4` |
| `codex/lk1-event-tariff-rule-20260915`                 | `e0d2abc6aad54fc04dfec1b40b05933abf2928b9` |
| `codex/lk1-event-verification-notes-20260916`          | `9b2282fd1a4ea2ed4b6c88ab54ebffd29331d87f` |
| `codex/lk1-final-acceptance-20260901`                  | `0054f4aa3173a7197c2c725ef3f140466402014d` |
| `codex/lk1-free-event-checkout-20260916`               | `e1f1f3ffb55989fabbf9762e252739028ec93abf` |
| `codex/lk1-free-event-checkout-wrapper-20260916`       | `6f3c13c2b8ede20480b4ff0996b026d9ae2d696d` |
| `codex/lk1-free-first-event-20260916`                  | `f21fd517b913857bd23971bcfa8d56e21da43c91` |
| `codex/lk1-free-first-event-v1-create-notes-20260916`  | `278beb5f90c7368e483ee822fd9b0e560494aa76` |
| `codex/lk1-games-query-index`                          | `5f072f99299153d3faad3e6d7344fd9bb1a7b658` |
| `codex/lk1-hub-scoped-integration-20260906`            | `c4dd7f35f1cfbea117897b2114f0f28ff09bb33c` |
| `codex/lk1-legacy-v1-adoption-20260828`                | `9783e51f71aa471323fd8f26b8a845a67ba72662` |
| `codex/lk1-money-cohort-20260916`                      | `de0161d91efc0cb114b47252d51b8bd1d07e02fb` |
| `codex/lk1-money-evidence-diagnostics-20260916`        | `d80017d80916b4eaae9c8cf4da3dcc54e4f81f0d` |
| `codex/lk1-money-validity-diagnostics-20260916`        | `9098c665972c8d3e42cda4d17ecdc04d68b24b5c` |
| `codex/lk1-mongo-query-optimization`                   | `354b94d09eebb23682216ae450cbeb5d6baacf34` |
| `codex/lk1-payment-link-readback-20260915`             | `da2436be09d3cf84d9066aba46c0a67f1b793791` |
| `codex/lk1-payment-link-readback-20260928`             | `15ee536fcb65413e7416c3f0367209380a4c80ba` |
| `codex/lk1-payment-readback-deploy-20260915`           | `6993f901ea16a91f9024ec413f181be5f476b84d` |
| `codex/lk1-payment-readback-deploy-fix-20260915`       | `2482af3d858a668647a9de4107dacd8868976a30` |
| `codex/lk1-payment-readback-stage-fix-20260915`        | `4abdb1f41efbcb3841dcb54a90d62e3b0e9a6492` |
| `codex/lk1-piter-managed-gate-20260828`                | `3330b80d713f7838f061765ef05908d9e5c7585d` |
| `codex/lk1-plan-money-first-use-20260916`              | `0a295670495c425322e9f7031441d09c4cdc67d2` |
| `codex/lk1-plan-rules-integration-20260915`            | `b8dee24bce7b543459f4cc4fda5d7d3d30955c92` |
| `codex/lk1-preview-canonical-exports-hotfix-20260915`  | `937ed22abfd7d6ba48a6cbe77b5b6bf8782668f6` |
| `codex/lk1-preview-free-first-event-20260916`          | `f75e2e316beb91a1f87718821fe12e2683148b64` |
| `codex/lk1-preview-helper-scope-20261002`              | `fdc94c52e7f3b56fc54fda991dd9a826f1b2f685` |
| `codex/lk1-preview-multi-product-20260916`             | `45f88ee8ce717605b2c0bf8a774c10311fb831c9` |
| `codex/lk1-push-main-enforcement-ci-20260827`          | `52c12847dc8ba1e4896ac8d7bc845d1ea154718c` |
| `codex/lk1-rules-parity-20261006`                      | `507a82a902a00d8bd0d66edf65a601cfdc23b969` |
| `codex/lk1-sirius-station-legacy-20260918`             | `4f0a2014814fe31344b198538875850749fda4cd` |
| `codex/lk1-subscription-cache-refresh-20261015`        | `c674367f44ba3461e9cd059765de152b8e98a130` |
| `codex/lk1-subscription-price-preview-20260908`        | `bf0113f7a2e510491680b6ef9a29900e60e84a8b` |
| `codex/lk1-target-diagnostics-20260917`                | `d465d816cbb782bff6729854746c59d4a664cc6b` |
| `codex/lk1-topocraty-friendship-20260926`              | `a319c21563868f0b8ef47bef9b0c54fc07e0b082` |
| `codex/lk1-topokraty-copay-20260925`                   | `f8985fb40add78ebfa70e0f6254685b66623c57b` |
| `codex/lk1-topokraty-games-20261001`                   | `50173bcbea3b7509b686cbbec84b5602116e1351` |
| `codex/lk1-topokraty-generation-20260925`              | `4cca9546b401ed4e947210ad939a17c16aefc697` |
| `codex/lk1-topokraty-ingress-fix-20260925`             | `38f405d97e50896c572619fa249eec9cffc1f832` |
| `codex/lk1-topokraty-prior-fix-20260925`               | `1a38b3fe9671aaf478228fb98796fccf8ffa4ab6` |
| `codex/lk1-train-147-prep-20261005`                    | `318b594d01868fb87e27d1d4fcf6e2632778bcf7` |
| `codex/lk1-train-20261002`                             | `dbe963b613fc60bd8d05031b3ef95e196fd564c3` |
| `codex/lk1-train-g1-20261005`                          | `5558a9d07e03d5fc1b5e870a19556480615c5719` |
| `codex/lk1-train-g1-wrappers-20261005`                 | `9d4341cddf90cd878af0748da14c53d721d68803` |
| `codex/lk1-unpaid-booking-cancel`                      | `4d3e5672efb7f0656ef4248e4850f29d77148940` |
| `codex/lk1-unpaid-cancel-release`                      | `b8238b27ad25185ae9030760f206f7f76eec9b18` |
| `codex/lk-auth-openid-followup-20261025`               | `abeb6a8dfd7761aa3f98db9419c65e584717426f` |
| `codex/lk-auth-release-228-229-20261025`               | `19dbdfb15eedbe53bad3c39b76ed1488e59df787` |
| `codex/lk-booking-conversion-guard-v2-20260918`        | `cd3c92ae8270c1c498779de2eac5bdeefa3f6d13` |
| `codex/lk-ci-stale-prs-20261003`                       | `ccfa8049386ef162c0a3b22d040abf17dde1e302` |
| `codex/lk-error-causes`                                | `6e03d9c66012df04c22a4df4b6814e3d9a85de10` |
| `codex/lk-media-alias-followup-20261025`               | `28f84ca28f02c746222c426e922e8e8f5d82af68` |
| `codex/lk-merge-governance-focused-ci-20260905`        | `5af04ad176741c5f993ef0d75ae7766c27d69334` |
| `codex/lk-piter-unbound-amendment-ci-20260905`         | `ee5f39af0d7ec0a6641dafe0339a8960aa8df5aa` |
| `codex/lk-pro-training-exclusions-20260918`            | `32684a8acb4ac1477c98208f99f9fda74dfbd124` |
| `codex/lk-pro-training-exclusions-generation-20260918` | `6421e0584ba7787f5fb198370e84bbdb367a22a8` |
| `codex/lk-sales-candidate-contract-fix-20260903`       | `e7465de65c48ce642ae8274e8a7b7fc9bcc962cc` |
| `codex/lk-self-leave-active-viva-20260911`             | `ceda1bd57fcc6c3b16dbedde1ad002adb38618d4` |
| `codex/lk-station-deploy-wrapper-fix-20260922`         | `040d76de6680e20d9e2850d70a13498c8601d9d7` |
| `codex/lk-stopped-launcher-ci-fixture-20260905`        | `f7dc01db442e099d81f59f4ea51e20222d04fc7b` |
| `codex/lk-systemic-game-durability-20260918`           | `fc82d91f6373e900ebf54518ebeb3615cd1249e0` |
| `codex/main-stabilization`                             | `9cf8169543996e6cee4893c9893dc84488be36ef` |
| `codex/main-subscriptions-checkout-20261016`           | `659e96e4ea6ada5e04e21e9973b0bfbcd2d44e9f` |
| `codex/max-editor-operation-custody-20261027`          | `7f140e02af6d639ec4349e066817f3afe379f666` |
| `codex/max-queue-pairing-20261026`                     | `a60eef6bcfb40cee7aa1e37a2e843e011896aa15` |
| `codex/max-queue-readiness-20261026`                   | `e357e70f279813a5d77bec6a7afd85ffbff59b87` |
| `codex/max-retry-receipts`                             | `85dc8ce8ae4ea3c6024bc24d35f4b63c0fce258f` |
| `codex/message-delivery-fixes-20261026`                | `79e46af1498121491f89af2f0f7fc69c8e33a41e` |
| `codex/message-delivery-release-20261026`              | `712fb6ed766bba595075b9d5932c4243b121d4e4` |
| `codex/nodered-community-summary-projection-20260928`  | `0346b46798b23e9e200c25b080e13efa0baf2409` |
| `codex/nodered-editor-lease-20261026`                  | `04f496e6e3af68bdb2932d1af7ef265ef57dfc36` |
| `codex/nodered-split-fail-closed-20260912`             | `ee34cf91b6e3287d4c8f6a77a43c6036e928dfba` |
| `codex/organizer-handoff-maintenance-20260913`         | `b4bf6e7846af90d85266456b237453025f5f758c` |
| `codex/padlhub-jump-20261019`                          | `3dc471f5751d39fc3af8902921cbdfd257b92442` |
| `codex/paired-mexicano-deploy`                         | `710d51d3f76af9ab725092e7b43ff396f1ef467a` |
| `codex/partner-evidence-runbook-20260911`              | `6e006e367ff1983f96c804798d25b191fa89a129` |
| `codex/partner-open-games-20261006`                    | `a1c551d0b7df3ed300d15e61bb02f4b5733f9637` |
| `codex/partner-stage1-source-gate-20260911`            | `1c7b9e025d91cc7af23e56931ba8c82ddde46d8d` |
| `codex/patriots-benefits-20260930`                     | `b054a82e7ebd28e10c48c6038af9e05c3cbeb1da` |
| `codex/patriots-friendship-parity-20261021`            | `60c3810912d238809f3e906b59b597adecc5c2ae` |
| `codex/patriots-landing-20260929`                      | `1874af9b80d45f3157475cefb735405fa595ca6c` |
| `codex/patriots-sales-20260930`                        | `223ab11675260d2f061ce663f5df3fffb60bd9e4` |
| `codex/payment-archive-no-transaction-20260914`        | `719d2daf67bf1000155bf1a82b9cb4e0cc01a528` |
| `codex/payment-polling-expiry-20260914`                | `52eccf7b005c10fbcf0a7ae12cb0bf64d287286b` |
| `codex/phantom-subscription-claim-20260916`            | `c320b5051ec567930efacb148eb453978e558a4d` |
| `codex/phone-response-privacy`                         | `52bd2549c486b400597f1fb143406935728f5351` |
| `codex/piter-artwork-refresh-20260922`                 | `cc3e7dad86a13d3bda6a82872143d308194bb6a5` |
| `codex/practical-frontend-delivery-20260906`           | `7f359e6f89858f0fc6746517e0e43dff14ad570c` |
| `codex/pro-energy-button-parity-20260922`              | `01ac176cbbb6a8d46c002a60b31435f99d67fe84` |
| `codex/pro-energy-owned-pack-detection-20260922`       | `52b3dcc3e3d09c422d68d6e234c76c2061680327` |
| `codex/pro-energy-server-suffix-20260922`              | `6ba9d0c8c2e17015e7b48ec91579e3db21ee8bdc` |
| `codex/pro-energy-visit-pack-20260922`                 | `58b6ffd5fb7697ba2b1b5eab46303131f8c40f91` |
| `codex/pro-remove-note-20260922`                       | `c79cbc9bc668d98047bb56003b0f0d1d81042bfe` |
| `codex/pro-training-init-order-20261002`               | `91ed3aeef96e305c9cd1454e75c83c527db3456b` |
| `codex/pulkovo-restrictions-20261016`                  | `4f56059c004b36b2a8f89cb2dbe59e60697a22de` |
| `codex/quarantine-recovery-20260803`                   | `893db283fbbbcdd85c69e5d55b9195d8cf1ac5ff` |
| `codex/r03-response-lifecycle`                         | `bfa2073f44ec8f1dad7518a60550f46d0687933f` |
| `codex/ra-status-price-20260911`                       | `fc43cd60ae661081f0f4aa0c838b6ab6304b49e4` |
| `codex/ra-two-hours-20261006`                          | `f80f0d9d5ef6469850241576bcbcbea36ce8016f` |
| `codex/rating-worker-lock-wait`                        | `69f9e6da3bdaa10ea2edb08f39d50ff14704ac78` |
| `codex/rejoin-dev-release-20260913`                    | `373b6d65a4ada564fbe7e461b3643d206122fc03` |
| `codex/rejoin-prod-release-20260913`                   | `d45091d876689a2dcd2a752598a910f046398fbb` |
| `codex/release-auth-231-installed-base-20261025`       | `097a7352f11988497d65158e4a7bf5447c43b444` |
| `codex/remove-game-atlas-heading-20260913`             | `dbc49b672cf53b4ad52d5cbc81095d9745d62328` |
| `codex/repeated-booking-leave-binding-20260913`        | `6e532eea9aa3d96a2701b4ce79a9215fd1bd0770` |
| `codex/result-player-release-20261023`                 | `77c77dc773ee437ac8c6b55a5814ca53094abd10` |
| `codex/reviewed-flow-publication-recovery-20260905`    | `71493f7f065accb7dda5cc57d198d50bf45d64c5` |
| `codex/risk-based-autonomy-lk-20260824`                | `e01cf5c3ce930db69401ce0a177a519dfa2c8ab5` |
| `codex/rupadel-roster-dedupe-20261012`                 | `9a189bf0407b59d37f226cd3f0cf0f0ff6047c66` |
| `codex/september-tournament-enrollment-20260917`       | `d074925c6ef4b930695f6d36a88c5ca680922b65` |
| `codex/smoke-retry-fix-20260911`                       | `df712fa61369a052d4d02a6bfb536d2911e8d0e6` |
| `codex/split-join-ordinary-price-20260911`             | `44d20e5a595705cb7b615094fcde4db2e6b04762` |
| `codex/ssh-controlpath-fix-20260911`                   | `e4259e293601a18f9a8428ca3347eb48710df83b` |
| `codex/status-price-deploy-20260911`                   | `9be9602db7d2da2fe6be34fb393234959f69ad45` |
| `codex/storefront-choice-copy-20260914`                | `1734ec50ddebe348334c694db306d0da2f330722` |
| `codex/storefront-copy-20260913`                       | `7bbe90e46a8f0efd2bdd7a2b1f6df538d8d3962f` |
| `codex/storefront-promo-offers-20260914`               | `e9bad0fc7390f809c2ba271da38f372b97b4223e` |
| `codex/sub-hab-friendship-promo-20261023`              | `0fdf50b89c72e4cf6e5d314fb8b2fe65e506a603` |
| `codex/sub-hab-promo-code-20261002`                    | `f10389ebbd1fe6cb2f0e117eabc8b80f96893581` |
| `codex/subscription-active-limit-8-20261005`           | `a11a8d778317c729891b9c5293f0411e64b31aa5` |
| `codex/subscription-bouncing-loader-20260913`          | `1284e3a382f6a770e9984010f5e5bd159393e8d6` |
| `codex/subscription-calculation-repair-20261002`       | `9b0a07ebf6b7b62bda9f0839db1261571ca7f2c2` |
| `codex/subscription-card-polish-20261002`              | `e8dc43fbda8113454f0e0fc5370e08a433847b07` |
| `codex/subscription-first-use-prod-20260801`           | `c1c034a3a83261e9ffd2e03d028c00060f170c0e` |
| `codex/subscription-instance-limits-20260909`          | `0a2b2477e90ac97cb65618af493e8201527786af` |
| `codex/subscription-preview-date-20260915`             | `3220e0a82e6d84a05c43ad04b4c553a7a881340d` |
| `codex/subscription-preview-server-clock`              | `1ee9894e71785d985ccc7d06a11e9f0b2230ff1e` |
| `codex/subscription-rejoin-after-release-20260913`     | `fa345335772bcbd20bf95e5750282d5646ff91eb` |
| `codex/subscription-sale-date-fail-closed-20260902`    | `c4425940efc803268c42a2597e1a8cd6eac2a3a8` |
| `codex/subscription-sale-period-dev-uat-20260902`      | `470b92282318af3f5ad6e08d9b63ea413af58994` |
| `codex/telegram-reactivation-20261006`                 | `9ace338f086fce43c21a337e797519395d98cf1d` |
| `codex/tennis-pass-balances`                           | `3425e1bfc2bac267618c797cf2487c2fa9df13c3` |
| `codex/top-trainer-discount-20261002`                  | `8d740d01d4dc6343a52f79a4ae53c54e0c999728` |
| `codex/topocraty-directions-20260924`                  | `6244ad188737229b7a5cb7b3b3b18801e04d38c6` |
| `codex/topocraty-lk-booking-20260924`                  | `b68d0ee62cb3f362f1d992eba6136395128e86cc` |
| `codex/topocraty-tilda-20260922`                       | `e3583717646817d889eb8923553673c90494d3a6` |
| `codex/tournament-card-level-gender-20261021`          | `83f8acfda0146d325e854b2ccb0198e0dd8312df` |
| `codex/tournament-payment-booking-identity-20260919`   | `2112ad7b4176bdf5daecccff4377125ba6a15157` |
| `codex/tournament-payment-link-diagnostics-20260919`   | `e0ebe603b39c31b740f6002024155c8260fde5a7` |
| `codex/tournament-player-annulment-20261026`           | `6d06feb65ee7de2594ea02cbf9b56f360bcbd759` |
| `codex/tournament-preview-out-of-contour-20260919`     | `b8d7c2b5db50c2ea33312214abd56be93d19135d` |
| `codex/tournament-signup-drop-visit-note-20260915`     | `59879c78747988f66f8dc26c48966ff2c5e3e4d4` |
| `codex/tournament-signup-phone-login-20260921`         | `e6ebcbca7c34c8b4c9d5b4ec065a211ae3761db8` |
| `codex/tournaments-block`                              | `09737f5154a4523f69e9c7afe3c5254ed8d69541` |
| `codex/tournaments-organizer-link-20260922`            | `8dd968bf6c7e8b8661d1b3a825aec03e6fc0f0d2` |
| `codex/trial-group-direction-20261015`                 | `1d535821ce4bdc6dd9108f54e7860cf88eff36e6` |
| `codex/trial-group-live-gateway-compat-20261002`       | `039c364f9cedaf1a0189fa01fe70d9c7fd93ace1` |
| `codex/trial-group-visit-eligibility-20261002`         | `1b6cdc7bc851a424ddf898ae1e4d164be9fb518f` |
| `codex/trial-proxy-timeout-20261016`                   | `6df4375f24351dbbefaf28c408043e14d3082a7d` |
| `codex/zero-block-checkout-20260915`                   | `b88b2dbfff91cda4c6de102c736c58cd481272f1` |
| `dev`                                                  | `ccc387575f7d7665481a03a8502407706c968ab2` |
| `docs/topocraty-page-blocks-20260925`                  | `7fbb56355824f8733a7e074d929cdcd146dc9c37` |
| `docs/topocraty-publish-20260924`                      | `2d57bd80d56922790720f50ebb586493e2dd472e` |
| `docs/topocraty-publish-checks-20260925`               | `6bdae3bb5a4af35891b92c4d75463c72e7ac2039` |
| `docs/two-hours-deploy-record`                         | `641776b9ce8d62b4fb97ac4f66ccb97919db31b7` |
| `feat/topocraty-checkout-20260925`                     | `f875508dd236c37348698683acf4a4da48b53153` |
| `main`                                                 | `788fdb96b3efd60fb09e4187b4ca4b5b00e2daaa` |
| `release/group-direction-filter-20260920`              | `1e3770ebacaa25929f67208ceed4a3f7c338038c` |

</details>

<details>
<summary>ph-admin: 60 веток</summary>

| Branch                                                                 | SHA                                        |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| `agent/cup-r1-inbound-custody-20261022`                                | `a9a6b505726e1e9861bc53051f947703426fe073` |
| `agent/cup-r1-mongo-durability-20261020`                               | `beec56ca8c368852e381a69ffae5e7039359ea96` |
| `agent/cup-r1-safe-rollout-20261020`                                   | `82716ccec3561aba1b1cc6cb7ef1f4fd5a2ed877` |
| `codex/advertising-card-retina-20260916`                               | `e738cd652fd616ce25e66c11f17d48679216da98` |
| `codex/advertising-image-sizes-20260916`                               | `be4082adfeba57dddfcc067e03b7752ef15560b5` |
| `codex/advertising-portrait-400x532-20260917`                          | `2350ad8f8f593a4cbbc2c3207dfdc0f8f63d7f46` |
| `codex/agent-orchestration-clean`                                      | `fccda15fc93aa67b003293cffad3d3d24ad948ac` |
| `codex/community-quarantine-20260927`                                  | `3dec18994df601df5eb2f80d06dbf069f4f742fd` |
| `codex/community-results-export-20261015`                              | `4898ecdfdde29064f329ac0bf944531da92f1c97` |
| `codex/community-results-templates-20261016`                           | `1368545380242bf8e4ffa731ffacbb4bb5802dce` |
| `codex/community-types`                                                | `d6931adadc760850e40a5b7255d39261c9ade3b3` |
| `codex/cup-bookingless-removal-20260911`                               | `fc6e470be35d169ff2df2209ddeedd9355b55f01` |
| `codex/cup-compatible-release-20261026`                                | `2a87a5757bb0cde160cddffb825896462a7b07d3` |
| `codex/cup-corporate-tournament-direction-20260915`                    | `5144da7d22fd5975db8ed7e7b81ac02d29df75d9` |
| `codex/cup-delivery-funnel-20260920`                                   | `049dbadd88c919469d97eacb1dba4fe6e4d6eed2` |
| `codex/cup-delivery-stats-20260920`                                    | `bc4050b6d671db0e851576ddd9c1bb7a879e530b` |
| `codex/cup-feature-activation-20261026`                                | `b13947d0a62c8cd817b6a5b3c547ddc24fcaefb3` |
| `codex/cup-main-runtime-artifact-20261026`                             | `4be41031ecac2b97658351b03d4304adcbf1d5ad` |
| `codex/cup-notification-phone-match-20260917`                          | `18937ed6a504bf4aa39fee70ffa35c63dc29c377` |
| `codex/cup-notification-token-login-20260917`                          | `fedfc6ed7068a5466276021ca49909bd3aceb5b0` |
| `codex/cup-notification-user-ids-20260917`                             | `0ff4be95ac7bb64bb2c2f4c7f91a7b9ab8e195c8` |
| `codex/cup-rules-p1-20261021`                                          | `a1256282e171a6ec0239cf8d7e04a882fa8aa038` |
| `codex/cup-traffic-activation-20260925`                                | `d66fdf4875699820194023fb45482437d13f002c` |
| `codex/cup-traffic-protection-20260924`                                | `b584ae1457548048cadfd643d388e8a2e013b935` |
| `codex/cup-traffic-quarantine-20260924`                                | `cefb08b70914623eb7d2d2ce17364a30c10ea32a` |
| `codex/cup-traffic-reserve-20260925`                                   | `966d9ac831e9469ba35379032eac70bbe83a1cdb` |
| `codex/cup-viva-tournament-payment-safety`                             | `700bc60bc4d730fdf7081ed445175f749ae41410` |
| `codex/cup-web-push-subscribers-20260917`                              | `9726940f627bf2147ee9709f4ea21fb6e2f745cc` |
| `codex/dialog-contact-isolation-20261013`                              | `b5c41950da1b971616f4cd62e88179dfdcd1db7b` |
| `codex/dialogs-sprint-test`                                            | `ed42ef7056314d3633160d113b70f9ed3ee6514c` |
| `codex/disable-production-startup-indexes`                             | `ebe09617c98322c2d26644dbd28d7041ab879648` |
| `codex/event-community-20261023`                                       | `1169f799c4e4575138cb661eca370394d88e5642` |
| `codex/event-launch-preparation-20261023`                              | `f50652b9a42cc446ec790ca96d85618d3123e08d` |
| `codex/fpr-6x25-format`                                                | `514f7f3ab004707b930a1d034ce1167b82e271ae` |
| `codex/game-start-reminders-20261026`                                  | `d1c5e2a8735baa11b986877493517b687a98960e` |
| `codex/games-phone-filter`                                             | `ac0b0d2c1b404d9a905df655795942baa87c421e` |
| `codex/lk1-correlated-error-diagnostics`                               | `83605740d9a5334c44a6fec37d2128cfebb5dd1c` |
| `codex/lk1-instance-projector-apply-20260828`                          | `8d72cf484f96071b865d558aadbcf92cacca138a` |
| `codex/lk1-ph-admin-release-attestation-20260829`                      | `58a7af6fdc84ee55eab3be17c11b7c1b3e8d4e55` |
| `codex/lk2-station-scope-expand-20260924`                              | `0a82853d11841c40ca7e80907895ca47d25be47b` |
| `codex/max-queue-readiness-20261026`                                   | `1265e4739d34f2291522bf4a60854828feee21cd` |
| `codex/max-retry-receipts`                                             | `fb0b878b73822cd7f012ceb89240b75c3af30735` |
| `codex/message-delivery-fixes-20261026`                                | `aefe4a55fc15f286eceb2d3cc8ac03f6548db492` |
| `codex/nano-cup-staff-auth`                                            | `a316a4a9388b05b0c45713015d4bb65fa70ffbb6` |
| `codex/ph-admin-dev-release-preparation-20260903`                      | `baa442a7ba5eb2adf4856e387ff3e8c04d921236` |
| `codex/ph-admin-exact-live-p0-20260809`                                | `61d0b76f3508d323ea477d82974c7ac65c62cafb` |
| `codex/repeated-booking-leave-binding-20260913`                        | `9d41755809c9e1eea808b693b86c03c70fca1ca9` |
| `codex/risk-based-autonomy-ph-admin-20260824`                          | `b4f0ac750f9318f6038801f839a774253ccc1dcd` |
| `codex/station-card-photos-20261011`                                   | `bd9af90d1f80548624a2d72b837fcdb62fd6d49f` |
| `codex/subscription-instance-evidence-projector-20260828`              | `4aec8b3c92144a1050cccc7efea499716cf79d11` |
| `codex/subscription-policy-supersession-20260823`                      | `c702df95d145ef176b0d3acb0923a93b92767e4d` |
| `codex/subscription-runtime-control-plane-20260824`                    | `a0ad974d6ca5e83d8997ad0db4508ce06a0838da` |
| `codex/subscription-runtime-delegation-replay-mongo-evidence-20260824` | `4f3b5afe16f31fc41ee3ea1984f99975aee9f4f4` |
| `codex/subscription-runtime-identity-20260824`                         | `2d8e09a60a85f2090de058cc06ab759063bb415b` |
| `codex/subscription-sale-period-resolution-20260902`                   | `6df084ed07ef3c2331be1f4b690cf5478a77941c` |
| `codex/trigger-communications-cup-20261022`                            | `39dde49ad90d9985d9dbfc8ed4a13e96bbf84e08` |
| `codex/viva-settings-ui`                                               | `bcec90a6a733642465f4227c156e1941f83ae44c` |
| `codex/viva-shadow-rollout`                                            | `8397d3296578c653bf0134ce9c934bb8a2db2626` |
| `integration/cup-r1-20261020`                                          | `948732b1dd8f2584d327690e6461e7962bc25fd5` |
| `main`                                                                 | `83b1c17bc4c5edaec65387b25b5695e48337c3cf` |

</details>
