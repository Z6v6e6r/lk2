# LK2 R1 — rollback и recovery readiness

## Текущие решения и интеграция — 2026-11-01

Station v3 rollback сохраняет lifetime/outbox v2, sequence frontier, исходные READ receipts и epoch baselines; downconversion и timeout-удаление pending запрещены. Shared pending cap32 не позволяет пропускать sequence hole; требуется совместимый recovery. CUP#71 сохраняет tournamentChatV1, original candidates/receipts и sequence frontier, без TTL/eviction; отключение новых send не разрешает отключить восстановление принятых intents. Старые writers на adopted rows недопустимы. Возврат Web к v2 теряет точный unread/catch-up и не равен функциональному rollback acceptance.

Organizer rollback обязан сохранять постоянный tournamentOrganizerV1 receipt journal и текущую revision; повтор исторического ASSIGNED не назначает профиль заново. Старые unsupported writers нельзя возвращать на adopted row. Native rollback сохраняет metadata-only pending UUID/hash: отсутствие ответа не разрешает новый POST. Включение dedicated keys/config и будущая stream adoption требуют отдельных runtime-переходов; текущий пакет их не выполнял.

Владелец разрешил обе точные локальные интеграции; они выполнены и отправлены в свои Draft PR. [#525](https://github.com/Z6v6e6r/lk2/pull/525) `f042389bb09703a75b502e793b28985028cc1f54` включает согласованные #52630598d97 (с #524) и #523f5c33149. LOCAL302 функциональных и22 delivery-contract проверки,54 изменённых TS файла с зависимостями:0 diagnostics. Guard suite:48PASS и один отдельно повторённый PASS после временной ошибки разбора Darwin ps; это составное evidence, не полный повтор49. Android41274690263 SUCCESS:16 обязательных JVM cases, unsigned release APK artifact13070946919 (ZIP SHA256 `207921dd54feadf82e42ff3e84750617a412a0c9ee1692ab6ba70af591facbd6`, expires2026-11-15). iOS41274690260 SUCCESS:30PASS/1app-hosted Keychain SKIP и unsigned simulator build; full41274690282 SUCCESS:7555PASS/126SKIP; SELF PG9, managedJOIN PG3, TRAINING PG6, closedPG4. Required35physical+8guards zeroSKIP (lifecycle13/comms10/Rabbit4/notificationPG4/notificationRabbit4); static/security/deployment и все пять Docker builds PASS. Независимое review и exact outgoing scans PASS.

[#528](https://github.com/Z6v6e6r/lk2/pull/528) `cd4b3d27b156b56923fb0a96dfadad8f9b92b19f` содержит разрешённый parent#5273143ffbe. Итоговое дерево `9dd1d57c2a087d1a418a31bd92f6437cfc04bfeb` побайтно совпадает с прежним26c5ceaa: TRAINING bundle сохранён, исправление JOIN fixture уже присутствовало. Предыдущие54 LOCAL проверки переиспользованы; merge-custody review и outgoing scan PASS. Конфликт снят. Initial fullCI41274959565:7546PASS/126SKIP, TRAINING PG11 и managedJOIN PG10 PASS; один устаревший current-inventory testFAIL. Test-only `fbf29562bd5f359031f1ff6cda0be7b4ed4e712d` меняет только +9→+10 и список с0108, frozen ledger и rejection сохраняются. LOCAL1PASS/27 name-filteredSKIP, review/scans PASS; corrected fullCI41275879957 SUCCESS наfbf29562:7547PASS/126SKIP, TRAINING PG11/11, managedJOIN PG10/10, closedPG4/4, required27physical+8guards zeroSKIP; static/security и все пять Docker builds PASS. Прежние сообщения об ожидающих разрешениях или заблокированном запуске CI ниже являются историческими.

Правило турнирного чата реализовано отдельным SOURCE/CI пакетом: явное назначение профиля в [LK2#539](https://github.com/Z6v6e6r/lk2/pull/539) `1de0ef602708a4413f2ea99cd3b21d8b88fd0cbd` и [CUP#70](https://github.com/Z6v6e6r/ph-admin/pull/70) `5291e2aba00869f0fb543fea982232353b208753`. Full CI41277973675 и CI41278160399 SUCCESS, включая новые PostgreSQL3 и Mongo8 physical cases. Dedicated readonly lookup, tenant/station authorization, revision CAS, постоянный original receipt и GET-only восстановление прошли независимое review. Исправлены позднее открытие редактора после logout и приём невозможного revision receipt. Конфигурация отключена; ключи не создавались. Это **не** реализация tournament chat send/read/realtime ACL.

Native station consumer [LK2#540](https://github.com/Z6v6e6r/lk2/pull/540) `ce1b9249f0a824ce01a8136776f7f372b0469143`: full CI41278040418 и iOS41278040429 SUCCESS. Android shared UI и отдельный iOS entry используют исходный UUID; при pending native ручной Send и reload выполняют только GET. LOCAL/review/secret-PII scans прошли. Детальные counts и ограничения — в [R1-READINESS.md](R1-READINESS.md). Exact unread/gap-free catch-up реализованы в новых source-пакетах выше; native adoption, source integration и device acceptance остаются открыты. Все три PR — Draft, без main merge или live activation.

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

History v2 rollback: выключить новый reader до восстановления несовместимого graph; сохранить v1/default LK1 read, сообщения, outbox, events, receipts и исходные UUID/hash. Browser refresh ничего не записывает в provider/read marker и не пересылает UNKNOWN; его откат не требует DB cleanup. Не заменять reservation timestamps выдуманным publication watermark. Для будущих sequence/frontier/candidate изменений rollback должен сохранять accepted proof и pending holes; текущий пакет эти структуры не создаёт и не даёт полномочий на их очистку.

Ни один из новых PR не merged/activated. Production configuration, provider, shared DB, signing и stores не изменялись. Следующие разделы сохраняют историю; при расхождении приоритет у этой контрольной точки.

Expiry rollback сохраняет abort marker, original expiry, canonical и outer receipts/checksum, usage и outbox; ABORTING нельзя возвращать в RESERVED, mismatch нельзя автоматически чинить. Старый binary безопасно удерживает неподдерживаемый reason. Station Web rollback сохраняет unresolved UUID/hash; закрытие вкладки/очистка storage не обещает recovery. UNKNOWN/403/404 не разрешают замену исходного ключа, status не означает доставку.

Для versioned station contract LK#279 выключение consumer не удаляет исходные request keys, кандидаты, outbox или receipts. Сохранить read-only original status и canonical recovery; недоступный новый endpoint, UNKNOWN/403/404 или отсутствие candidate не разрешают другой ключ либо fallback на старую отправку. Новый контракт не добавляет схемы и не требует data rollback.

## Monetary SELF dispatch fence: rollback boundary

Для [LK#283](https://github.com/Z6v6e6r/lk/pull/283) сохранять исходные booking/generation, immutable dispatch markers, SERVICE baseline, readbacks и состояние MONETARY_DISPATCH_STARTED. Не сбрасывать marked operation в STARTED, не удалять journal и не освобождать membership gate для повторной отправки. Старый #270 router отказывает новому состоянию, старый background query его не выбирает; это удержание неопределённого результата, не восстановленная доступность. Уже выполняющийся старый writer source fence не останавливает — необходим drain. Откат кода не доказывает ни денежный возврат, ни его отсутствие.

## Quarter CREATE dormant rollback

Для#532/#533 выключить существующий consumer с сохранением исходных body/key/receipt и read-only reconciliation. UNKNOWN не превращается в разрешение новой операции. Native outer logout fence process-local: durable Keystore/Keychain custody и процессное восстановление требуют отдельной device проверки. Для API сохранять пару `enabled=false` и `transport=ADVISORY`, journal0110 и command fences.

Для#534/LK#280 сначала остановить/drain producer до rollback receiver. Сохранить0111 marker, INTENT, original admission, receipt/outbox, claims и lastApplied kind; не drop/backfill/adopt исторические NULL, не выдавать новый epoch старому receipt. Недоступный station transport удерживает adopted intent, а не переводит в legacy. Deduplication receiver действует внутри kind namespace; cross-kind JOIN/CREATE proof не заявлен. Реальный rollback/migration/restore не выполнялся.

## Ограничение отката station-message пакета — 2026-11-01

Для LK#278/CUP#68 нельзя удалять принятые outbox intents, скрытые candidates или исходные receipts и нельзя возвращать raw STATION writer поверх уже принятого состояния. Сохранить совместимый recovery worker, private fields и административную защиту от удаления непустого outbox. Принятие до LEFT/BAN остаётся действительным; повтор старого сообщения не получает права новой эпохи.

Новый запрос старого клиента без ключа получает отдельный server UUID: дедупликация последующего целого HTTP-повтора для такого клиента не доказана. При неоднозначном ACK legacy-барьера эффект не выпускается; это не обещание долговечности старого протокола. Конкретный runtime rollback, retention/backup и восстановление требуют отдельного плана и разрешения; source/CI proof не является репетицией production rollback.

## iOS tournament source checkpoint — 2026-11-01

iOS#531 retains original tournament custody and blocks commands synchronously during logout cleanup in the current process. Do not describe that fence as durable before native Keychain logout intent is written; process death during cleanup retains baseline session restoration, but no automatic tournament mutation. Keep original keys/journals through client downgrade. No device rollback or process-death rehearsal is claimed.

## Paired quarter CREATE source checkpoint — 2026-11-01

For CUP#67/LK#277 retain original outer admissions, canonical daily rows, immutable target/price/actor pins, attempt nonce, original exercise/booking IDs and terminal receipts. Disable new admissions through the existing approved gate; keep compatible read/recovery. Do not downgrade ambiguous CREATE to ordinary LK1, search/adopt a room-time match, retry with a new key, delete custody or roll back to an unfenced reclaim writer. Expired reserve-only operations remain pending until a supported reconciliation contract exists. This is a source recovery plan, not an executed rollback.

Ниже сохранены предыдущие контрольные точки; текущие статусы — в разделах выше.

## Android tournament checkpoint — 2026-11-01

Android#530 retains the same#529 original request/key/generation custody. On rollback, preserve pending WebView storage and server journals; unavailable older clients may require manual recovery but must not replace original keys or reinterpret HTTP404 as no dispatch. Keep native tenant/origin and public credential isolation; no destructive storage cleanup or automatic retry migration.

## LK2 tournament journal retention — 2026-11-01

LK2#529 adds0109 command custody without a second roster. Disable new commands while retaining the journal, original owner key, actor/mapping pins, original JOIN link and canonical receipts. Do not drop0109, rewrite pending operations, erase browser custody on404/409 or create a new key to recover an ambiguous command. Disabled status may expose historical own receipts but cannot claim fresh membership. CUP's permanent adoption/legacy-writer fences remain required after rollback. No physical runtime rollback has been executed.

## Tournament and quarter rollback constraints — 2026-11-01

For CUP#64 retain canonical localParticipationOperations and localParticipationTenantKey, including terminal receipts, actor identity and generation. Disable admission without removing permanent legacy-writer/restore guards. An old unguarded writer is not a safe rollback for adopted documents. Historical receipt readback must remain reachable after phone changes; it does not authorize transferring identity or deleting a later rejoin.

For CUP#65 retain immutable publication4 and target2 facts. Older validators must reject them; never remove descriptor/proof, redate purchases or downgrade stored schema to make an old binary accept them. Existing publication3 instances keep their original immutable pins. Future checkpoint reconciliation must preserve these bytes and use atomic fence/checkpoint CAS. Current LOCAL/CI evidence does not constitute a runtime rollback rehearsal.

CUP#66 `5eb4fe04` advances only new-instance adoption/checkpoint in an atomic transaction; old instances remain unchanged. Retain the shared sale/reconciliation fence and do not roll back to an uncoordinated sale writer while schema4 adoption is permitted. Lost-ACK replay is accepted only while the original rows/fence/history remain exact; later sale or activation drift must refuse without writes. Inspect the original checkpoint, then separately approve any new snapshot/apply; never reinterpret refusal as a failed original commit.

## Station recovery addendum — 2026-11-01

The station lifetime contract is now implemented in unmerged source packets LK#275/#276, CUP#63, LK2#527/#528; runtime recovery remains unverified. Rollback disables the coordinated producer/consumer flag and retains Mongo admissions, generation claims, community epoch/barrier and PostgreSQL0108 nullable markers. Existing protected roster writes remain fenced when the flag is off. Never delete those records or replace an original admission with the current membership epoch.

TRAINING INTENT retains the complete original canonical authority before owner POST. Recovery pins studio/actor/request/expiry and uses the original receiptId. Terminal NO_ENROLLMENT cannot be upgraded by a late ACK. Old code may complete a booking while its marker remains INTENT; the new worker must not enroll it. NULL rows remain permanent legacy. Removing0108/backfilling old records is not application rollback. The additive CHECK can scan the table; lock/statement timeouts do not replace an authorized migration rehearsal.

## Дополнительные original-operation ограничения

#525 объединяет source миграций0105/0106/0107 без изменения их bytes или frozen closed108 пакета. Это не применение миграций: существующий closed deploy mode по-прежнему отвергает неподтверждённый расширенный ledger. Application rollback сохраняет новые attempts/receipts; фактический forward migration/backup/old binary compatibility требуют отдельного принятого runtime package.

#521 добавляет restrictive POST reconcile, который сохраняет terminal NOT_DISPATCHED в существующем journal и атомарно блокирует запоздалую первую DELETE. При rollback эти записи и custody сохраняются; старый API404 не разрешает новый ключ. Currente1d781 CI41234847565/native41234847625 SUCCESS;9physicalSELF cases passed. Нет миграции или автоматического financial replay.

Предлагаемый station lifetime contract сохраняет immutable original admission и membership epoch. Leave/remove/ban/restoration не должны оживлять прежние admissions; пропавший ACK восстанавливается чтением исходной записи, не новым admission с текущим epoch. Ошибка доставки community fact не откатывает booking/деньги. Контракт ещё не реализован, production recovery не заявлен.

Принятый source/CI consumer#519 (0106) сохраняет исходный ключ и journal при UNKNOWN; unsupported typed refusal может сохранить custody и блокировать новый JOIN до подтверждения результата. Удаление browser custody по404/409 или повторная запись с новым ключом не являются recovery. При terminal original-key replay после rejoin нельзя менять новое участие. Для денежных отмен не повторять cancellation/refund после ambiguous write, пока provider contract не доказал idempotency; cancelled history не означает settlement. При tournament recovery сохранять source owner и original booking generation, не переключаться с CUP на LK или наоборот.

TRAINING consumer0107 в #520 прошёл source/CI, включая6physicalPG: после dispatch fence нельзя reprepare, подменять capsule или начинать новый booking. Fresh owner read не должен превращать immutable historical receipt в текущее участие после cancel/WAITLIST/rejoin. Только durable terminal pre-dispatch proof с CAS и отсутствием dispatch разрешает новый выбор/ключ; timeout,404/409 и отсутствие локальной строки сами по себе не доказательство. Rollback удерживает original attempts и не передаёт их старому writer.

Статус: **PARTIAL source procedures / UNKNOWN свежая rehearsal готовность**. На первом этапе rollback, restore, flags и runtime не менялись. Позднее отдельно одобрены repository delivery-flag cycles для source-only merge #508 и точного #511; production flags, rollback/restore, worker, возвраты и stores не затрагивались. Этот документ — требования к подготовке, не разрешение операций.

Каноническая основа: [application rollback](../runbooks/rollback.md), [Timeweb runtime](../runbooks/timeweb-lk2-beta.md), [publication custody](../runbooks/timeweb-amd64-image-publication.md). Выбранные target, previous digests, backup receipt и совместимый mobile/backend floor должны быть заполнены release owner до GO.

### Завершённый source-only merge #511

Разрешённый exact head `ed3854c384b88a023f4d88f0fd4a379598721396` merged в main `a37c05a2b2a28c8d53cb14447d357ad9a96bda1f` (tree `82500700a959ecf571a18beacb26c64bf6a4865d`) в18:36:31 UTC. `LK2_STANDARD_DELIVERY_ENABLED` был временно false с18:36:00 UTC. [Main CI41230249442](https://github.com/Z6v6e6r/lk2/actions/runs/41230249442) SUCCESS; связанный [delivery41231241175](https://github.com/Z6v6e6r/lk2/actions/runs/41231241175), job124625756504 `standard-web`, terminal SKIPPED, `steps=[]`. Перед восстановлением свежий main совпал, все пять nonterminal status queries вернули0, flag сохранил ожидаемые false/timestamp. В18:50:31 UTC исходный **true восстановлен и readback подтверждён**. Цикл COMPLETE; публикации/deploy/store activation не было. Разрешение относится только к #511, не к следующей партии.

## Что требуется сохранить до rollout

| Объект              | Необходимое доказательство                                                                                           | Статус этого аудита                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Backend package     | Canonical manifest/checksum, source/tree/run, пять компонентов, предыдущие runtime digests                           | UNKNOWN selected package                                 |
| Database            | Exact schema/ledger, compatible old binary, owned backup, successful isolated restore, роли/ACL                      | UNKNOWN fresh target proof                               |
| Business operations | Durable attempts/idempotency keys/receipt states, unresolved payment/refund/booking list в защищённом evidence store | UNKNOWN runtime; не выгружалось                          |
| Outbox/realtime     | Event schema compatibility, consumer checkpoint/lease, lag и DLQ baseline                                            | PARTIAL source mechanisms                                |
| Native builds       | Released build/version/hash/signing identity, minimum compatible API/event versions                                  | Unsigned CI #510 verified; signing/native parity BLOCKED |
| Operations          | Incident owner, rollout/rollback authority, target/lease, RPO/RTO, observation thresholds                            | UNKNOWN selected release                                 |

## Матрица отказов и безопасного восстановления

| Отказ                                 | Требуемое действие после соответствующего разрешения                                                                      | Что запрещено считать восстановлением                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Candidate не прошёл preflight         | Не активировать; сохранить failed category/receipt; устранить в task branch                                               | Повторный dispatch или ослабление guard                                             |
| Неизвестный результат provider POST   | Freeze original operation, GET/readback/reconcile по canonical owner; сохранять pending/unknown                           | Новый POST с новым ключом, ручное PAID/BOOKED                                       |
| Частичная cancellation/refund         | Reconcile provider outcome; применить idempotent compensation только по подтверждённому результату                        | Спекулятивный возврат визита/денег или повторный refund                             |
| App/readiness regression              | Выбрать проверенный previous digest; доказать schema/event compatibility; canonical sequential rollback и smoke           | Mutable tag, rebuild на host, schema downgrade по умолчанию                         |
| Worker/outbox regression              | Сохранить durable events и leases; совместимый worker; bounded replay/DLQ recovery                                        | Очистка outbox/queues, потеря attempts, неконтролируемый replay                     |
| Chat membership leakage               | Ограничить affected path по утверждённому плану; revoke/reconcile permissions, проверить read/send/fanout                 | Только UI hiding или стирание истории                                               |
| Push regression                       | Изолировать sending по approved scope; сохранить intents, endpoint/account ownership; reconciliation unknown outcomes     | Массовая повторная рассылка; SENT = устройство получило                             |
| Mobile regression после store rollout | При наличии разрешения остановить phased rollout; вернуть совместимый backend/feature behavior, подготовить signed hotfix | Предположение, что можно мгновенно downgrade все установленные клиенты              |
| DB несовместима с old binary          | Остановить автоматический application rollback, выбрать approved forward fix/restore plan                                 | Destructive restore без отдельной exact authority и reconciliation внешних операций |

## Обязательная rehearsal

В отдельно разрешённом disposable окружении воспроизвести: new schema + old binary; in-flight JOIN/payment во время app/worker switch; outbox commit без broker ACK; consumer crash после side effect; duplicate/late callback; client version N с backend N−1; повторный запуск recovery после потери ответа.

Assertions: число мест и состав участников сохранены, один commercial side effect на operation, деньги/usage согласованы с owner, outbox не теряется, tenant isolation соблюдается, сообщения восстанавливаются из HTTP history, notification preferences применяются при отправке. Проверить backup restore и измерить фактические recovery time/data loss относительно утверждённых RPO/RTO. В текущем аудите значения не измерялись.

WebSocket stream содержит recoverable hints, а не durable history: `apps/realtime/src/message-consumer.ts:155-229`, `apps/web/src/chat-realtime-client.ts:26-107`. Восстановление должно сверить sequence/cursor по HTTP. APNs `APNS_OUTCOME_UNKNOWN` нельзя автоматически превращать в success или безусловный retry.

## Закрытие инцидента

Сохранить exact before/after package identities, выполненные команды/receipts, DB/event compatibility и пользовательский smoke, provider reconciliation и observation. Успешный image rollback не отменяет migration или уже совершённый платёж. Решение закрыть инцидент принимает назначенный owner по фактическим business invariants, а не по зелёному health endpoint.

## Временное подавление automatic delivery при source merge

Если отдельно разрешённый flag cycle прерван, сначала прочитать variable, exact main/PR state,
main push CI и связанный delivery run. Не повторять неоднозначный merge и не делать безусловный
restore=true. При неразрешённой очереди/чужом drift оставить подтверждённый false, сообщить
точный hold владельцу и получить указание для изменившегося recovery scope. Если variable уже
изменена другим владельцем, не перезаписывать её. Revert main, workflow cancel/rerun/dispatch,
publication и host rollback этим планом не разрешаются. Восстановление исходного true разрешено
только в пределах одобренного цикла после доказанного skip и проверки quiescent main/delivery.

## Durable rejection и canonical readback

Compatibility order: CUP #57 → #58 → #59 → LK #264. Исторический LK worker видит durable
`PRECREATE_RECONCILIATION_REQUIRED` и оставляет reconciliation pending; он не должен возобновлять
CREATE. Не удалять marker или переписывать original observedAt ради retry. Exact local RELEASED
может вернуть прежний результат без signer/CUP request. Если локальный ACK потерян и TTL истёк,
новый consumer читает canonical CUP receipt и завершает только прежний full-marker CAS при
`FAILED / APPLIED / PROVIDER_REJECTED / null`. Endpoint unavailable, foreign/malformed receipt,
неприменённая компенсация или незавершённый CUP release сохраняют pending. Это не новый release,
proof refresh, refund или provider POST.

#58 physical canonical transaction/rollback/lost-response и #59 post-TTL readback CI passed
(`41201269983`, `41204278865`); новый LK consumer CI `41204447158` success. Эти результаты не являются
rehearsal rollback выбранного production target. Rollback не должен выключать strict validation
ради компенсации; secret/config/source transitions требуют собственного exact approval.

Завершённый source-only cycle #508: false 12:34:48 UTC → main `14ebdca6`, CI `41201792854` success
→ delivery `41202697617` standard-web SKIPPED, steps=[] → исходный true восстановлен/readback
12:49:05 UTC. Delivery, publication и host rollback не выполнялись; новое выполнение этого цикла
не разрешено исторической записью.

## Совместимость новых подготовленных пакетов

- CUP #60: expectations optional для прежних callers, прежний absent fingerprint сохраняется.
  После начала bound operations нельзя откатывать на receiver, игнорирующий expectations:
  остановить новые managed admissions и сохранить readback/replay до завершения операций.
  Старый ответ без строгой binding формы downstream обязан отвергать, а не принимать как legacy.
- #512 Android community history меняет только native GET allowlist; откат consumer не меняет
  membership или backend data. Debug APK не является rollback artifact установленной production версии.
- #513 iOS existing chats можно revert как отдельный consumer commit поверх #511, восстановив
  unavailable route/default-deny. Уже принятые сервером сообщения/read cursors остаются canonical.
  Pending send только в памяти mounted thread: нет обещания восстановления draft после process death.
- #511 test-only process termination fix не меняет production scripts. Ни один из этих source
  rollback планов не означает разрешение выполнить runtime rollback или изменение shared data.

## Recovery floor для новых bound operations

- #267/#515: после появления v2 bound operation сохранять compatible receipt/readback/recovery-only обработчики до её terminal outcome. Остановка новых admissions допустима только отдельным runtime решением; v1 или отсутствие instance не могут стать fallback. Original request tuple, fingerprint и canonical usage identity не переписывать.
- #269: после CUP compensation, но потерянного local ACK восстановление выполняется exact readback и CAS исходной operation/generation. Не повторять visit return или денежный refund ради локального состояния. Original proof timestamp не продлевается; post-TTL uncompensated operation остаётся pending.
- Старые managed leave rows без stored tenant требуют отдельного доказанного recovery/backfill решения; source rollback не добавляет им authority. Не удалять additive proof/receipt поля при откате consumer. Все описанные runtime действия требуют отдельного exact-target разрешения.

#516 можно откатить отдельным consumer revert до создания новых DIRECT, сохранив #513 existing chat reader. Уже созданные server conversations остаются canonical; удалять их для rollback нельзя. Незавершённый create key хранится в памяти authenticated cabinet; после process death новый запрос полагается также на server unique pair, а не обещанное восстановление памяти.

CUP#62: rollback gender enforcement на старый binary может снова разрешить restricted registration/legacyEnergy. До такого rollback отдельно ограничить соответствующий admission; не стирать pending payment, original identity/gender snapshots и roster journals. Новый пакет не требует index/migration execution.
