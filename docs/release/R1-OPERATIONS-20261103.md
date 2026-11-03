# R1 — операционная запись 2026-11-03

## Текущий срез — 2026-11-03, после prefetch R2 и очистки кэшей

**APK проверен на эмуляторе; полный функциональный прогон пока NO-GO.** Main LK2 `599d9df5a96df623b5f264f55065e1d1fe970ab3`, tree `a0717294d475b11fc0ec18f9e8b8886015958c1f`: [PR578](https://github.com/Z6v6e6r/lk2/pull/578) merged, [main CI41642631213](https://github.com/Z6v6e6r/lk2/actions/runs/41642631213) SUCCESS, delivery41645215332 SKIPPED. Delivery=true восстановлен13:33:08UTC. Локальный ENOSPC после отправки merge закрыт read-only сверкой parents/tree/main; merge не повторялся. Publication599 выполнена однократно с разрешения владельца: [run41649179686](https://github.com/Z6v6e6r/lk2/actions/runs/41649179686) SUCCESS, attempt1. Пять immutable images и canonical V2 проверены; manifest SHA256 `baf693f4a72d3660ff526f2dd5e15b20d3b2650e0ae0df174018fa85c99d8891`, оба artifact ZIP checksum PASS, независимая сборка manifest byte-identical. Deploy не выполнялся.

Установлен controller/helper599: canonical reconcile `NEW_ENABLED / ACTIVE_RELEASE_DONE`. После исправления отсутствующего canonical manifest prefetch599 R2 завершён: request `cdde6f95cd1011506cb6d00782c9f0bb83dd6260c5ff9957f80a0a1378c13163`, receipt `4a503dd4d544db661d998bc709c709ce0c882de4bed4d5fc2508afa16d260d5b`; независимый attest совпал, delivery=true восстановлен15:42:28UTC. API/Worker/Realtime702, Web871, БД106 сохранены. Первая попытка до admission закрыта без replay, старые запросы сохранены в архиве.

По поручению владельца удалены три старых каталога `node_modules` из `source.previous`: освобождено 1 495 887 872 байта. Девять LOCAL тестов, два независимых ревью и проверка результата прошли. Исходники, lock-файлы, текущий контроллер 599, recovery 12aa, бэкапы, образы и контейнеры сохранены. В 16:02 UTC свободно 57 595 600 896 байт; расчёт оставляет 5 263 269 888 байт под дамп после выделения места для восстановления и резерва 5 GiB. Подготовлен один штатный backup БД106 и независимое восстановление копии: 12 LOCAL тестов, проверки штатных JS/Python валидаторов и два ревью прошли. Backup ещё не запускался; запрошено отдельное разрешение на него и цикл delivery-флага. Затем остаются миграции 106→107→108→119 и обновление приложений.

LOCAL Android36: тот же APK SHA256 `5cfa69dba0a1b86914467208756b6cdae5652bd03a20336362416cea63197dba` установлен в отдельный read-only/no-snapshot emulator. Основной прогон77PASS/1SKIP; targeted2PASS закрыл optional native TLS probe и получил3скриншота. Итого78уникальных тестовPASS, без реального входа, отправки SMS, booking или платежей. Native GET context подтвердил401 без cookie; это не authenticated/provider/device acceptance. Эмулятор завершён, физический телефон не использовался.

Monthly: authenticated read подтвердил отсутствие custody binding; epoch/inventory и соответствие серверного tenant/Viva binding установлены read-only. Candidate4830665e/contract275c19ae построены поверх актуального flow9ed37134 и сохраняют FPR; только5functions+11API nodes. LOCAL composition/review PASS; apply, trust configuration и provider acceptance не выполнены. Частные идентификаторы остаются вне Git.

CUP PR81 head `bdbe1db525e55c7dd133374e3d90f47ce0c4878b` committed/pushed:62LOCAL testsPASS для snapshot/union/fence и pure web-custody comparison, включая отдельное private сохранение web commands/history/SYSTEM messages/dialogs/clients до timer fence. ReviewCLEAR, buildPASS, Gitleaks0; CI41658831784/41658831836SUCCESS. Comparator проверяет только pinned input rows, не live completeness/drain. Предыдущий a948fc0:3 real SupportService web-history regressions/buildPASS, CI41653533975/41653534028SUCCESS. Counts R2 успешно завершён с InspectorCLOSED: MAX3799SENT/111FAILED/5LEASED, web785PENDING, другие0; это snapshot, не drain. WebPENDING не доказывает недоставку: история сообщения хранится отдельно. Полный first-restart operator, durable completeness и receipt integration остаются открыты; CUP83 не перезапускался, import не выполнялся. Детали и история ниже не заменяют этот текущий срез.

## История: 11:41UTC — source577 и подготовка нового перехода

[PR577](https://github.com/Z6v6e6r/lk2/pull/577) merged в12aa12ed; tree76f11804; main CI41623665865 SUCCESS и standard delivery41625825116 SKIPPED. После source-cycle true восстановлен11:14:54UTC. Новый API/Worker119 профиль сохраняет Web871/Realtime702, использует actual-role probes и CAS grants18relations; новые business flags OFF. Исправление PG catalog text прошло физический CI. Live grants/upgrade не выполнялись.

Четыре неиспользуемых47c image refs удалены после exact-reference/container-identity проверки. Первая попытка остановилась до удаления на RepoTags shape; read-only reconcile сохранил evidence. Исправленный R2 завершён: runtime unchanged,13containers сохранены, free58,162,475,008bytes. Все backups и migrator/role-probe containers сохранены.

Expired b88 request SHA256 a56a3e4ccbf5e9206e535451b964e5877cef16e83a304ff34615aa06b9b43e78 архивирован в game-start0103-expired-b88f2100-20261103. Fresh no-admission подтвердил ledger106, старые runtime/secret identities и отсутствие admission root; копия/intent/proof/receipt запечатаны до CAS удаления canonical name. Независимый archive readback прошёл; deliverytrue восстановлен11:29:08UTC. Это не pull, migration или application deploy.

После точного разрешения владельца одна publication12aa завершена успешно. Enrollment12aa завершён с canonical reconcile и восстановлением флага. Prefetch остановлен до admission; отдельный read-only closure подтвердил неизменность приложений/БД и отсутствие pull. Исправление PR578 проходит CI.

CUP [PR81](https://github.com/Z6v6e6r/ph-admin/pull/81), head248062b2803bc25aba0d55410d28738fcd352228: pure complete Map/Mongo union, deterministic bounded batches, retained private provenance;13 tests/build PASS, два reviews CLEAR, task branch pushed/Draft PR. Никаких raw queue exports в Git. После точного разрешения выполнен один diagnostic cycle: EXPORTED_INSPECTOR_CLOSED; MAX Map содержит3706 SENT,111 FAILED,0 PENDING/LEASED. Artifact SHA2569b216cf884c34b61d5e0a9117ecef8706537b0cf950a9791475b2369b9544ec6, raw остаётся приватно на сервере. soleClientProven/drainProven=false; restart/import/DB writes отсутствуют. Оба PR81 CI41627107109/41627107113 SUCCESS. До restart отдельно закрыть already accepted inbound/non-MAX writes; finalMap capture не заменяет этот контракт.

Существующий Android36 AVD проверен в read-only/no-snapshot режиме: запуск остановлен до boot на hasSufficientDiskSpace. Instrumentation/device evidence не получено. Новых SDK, signing keys или очистки AVD не было.

---

## История операций

## Операционный срез — 2026-11-03, после R5 enrollment и сборки APK, 2026-11-03

Этот раздел и [операционная запись](R1-OPERATIONS-20261103.md) заменяют конфликтующие исторические статусы ниже. **NO-GO для production release.** LK2 main `de451e712c08aae46fdc47ae162c20ce038657bd`; миграционный пакет отдельно зафиксирован на `b88f2100e0d77b8c3bbb3a75ced70f2fd97dcefd`.

R5 успешно завершён: `ENROLLED_NO_DEPLOY`, canonical reconcile `NEW_ENABLED / ACTIVE_RELEASE_DONE`, marker освобождён. Контроллер b88 и backup-helper установлены; `LK2_STANDARD_DELIVERY_ENABLED=true` подтверждён в07:38:29UTC. Приложения и БД не переключались. Свежий read-only preflight07:39:27UTC: ledger106, свободно56.21GB. Тестовый APK1.13/code14 из main de451 собран и проверен:652 mobile +59 native JVM tests PASS. Самостоятельную установку и device acceptance выполняет владелец; полная серверная готовность ещё не достигнута.

## Проверенный source

[PR574](https://github.com/Z6v6e6r/lk2/pull/574), commit `4306aba593b864fdcecf4b3faad561a569552da3`: fixed pg_catalog-only audit проверяет права новых relations/columns, parent row locks, unsafe roles/ownership и RLS на ожидаемых API/Worker database/role. Connector, CLI и grants не добавлены; результат всегда `activationAllowed:false`. Security и PG/recovery review CLEAR.

[CI41576927809](https://github.com/Z6v6e6r/lk2/actions/runs/41576927809):9173 PASS/133 SKIP; отдельный PostgreSQL16 contour7/7, включая R1-tail privilege assertions. Mandatory game14physical+6guards, communications10+1, Rabbit4+1, notificationPG4 и notificationRabbit4 — zeroSKIP. Static/security/dependency gates и пять Docker builds PASS. Это CI, не публикация.

LOCAL:28 unit PASS, scoped lint/types и scans PASS. Full macOS fixed-head run25FAIL/8792PASS/489SKIP в трёх существующих process/Git-custody suites; Git subset60/60 с исправленным только task TMPDIR/GID. Полный LOCAL gate не закрыт. Свежая диагностика local preview подтвердила недоступность Docker daemon; БД/API/Web не запускались, rendered acceptance отсутствует.

## Выполненные операции

Первый enrollment остановился на PROCESS_AMBIGUOUS: старая root serial-консоль находилась в удалённом cwd. После ответа владельца «готово» fresh process guard прошёл. Единственный guarded recovery завершился RESTORED_PRE_MIGRATION_RETAINED_R1_ARTIFACTS; canonical reconcile OLD_OR_RESTORED подтвердил старый source/config, отсутствие active и наличие released-active. GitHubtrue восстановлен04:51:26UTC.

R2 staged7files, но execute wrapper остановился локально на age<90 до SSH и создания execute-output. Свежий read-only proof05:55:02UTC проверил exact7files, отсутствие journal/active/provision/helper/source-stage, прежний source HEAD/tree/clean и config hash. После неизменного main, exact paused variable и отсутствия всех GitHub runs с начала окна originaltrue восстановлен05:55:05UTC. Ownership window закрыт. Приватные raw inputs остаются вне Git.

R3 был явно разрешён владельцем; staging и final readback→execute pipeline прошли без прежней задержки. Execute остановился OWNED_COMMAND_FAILED на STAGE_INTENT. Canonical reconcile подтвердил OLD_DISABLED, старый source, partial stage и отсутствие helper. Read-only inspection показал b88 HEAD/tree в stage, но отсутствие зависимостей и npm-логов. Серверный `npm --version` с теми же двумя `/dev/null` конфигами воспроизвёл double-loading config до разрешения конфигурации.

Guarded recovery4b83b5a9 восстановил только старый config, сохранил partial stage и освободил owned marker. Canonical reconcile OLD_OR_RESTORED и свежие GitHub main/variable/no-runs проверки позволили вернуть true06:24:31UTC. Приложения и БД не менялись.

Исправленный R4 создаёт отдельный пустой global npm config с exclusive/durable0600 publication, сохраняя явный user config `/dev/null`, task cache и `--ignore-scripts`.42 synthetic checks прошли. Три реальные offline regression проверки с официальным npm10.9.0 прошли: воспроизведение старой ошибки, успешная установка без lifecycle scripts и ambient HOME config, сохранность foreign file/symlink. Первоначальный fixture GID исправлен только в тесте. Два независимых review CLEAR;6 прежних Linux checks переиспользованы только для неизменных primitives. R4 затем был явно разрешён и выполнен: stage содержит необходимые зависимости, а pure imports проходят. Остановка произошла на последующей проверке operation; результат ниже.

Draft PR575 commit7cb4b9b0 прошёл полный CI41587299496 SUCCESS. Новая редакция операционного отчёта требует собственного CI.

### R4: подтверждённый отказ и восстановление

R4 staged/execute прошёл однократно. Canonical reconcile подтвердил OLD_DISABLED/STAGE_INTENT; source exchange и helper publication не произошли. Guarded recovery `b805ccac` восстановил старый config, сохранил установленный stage и освободил marker. Canonical recovery `497f4386` и GitHub readback подтверждают возврат deliverytrue в06:57:19UTC.

LOCAL reproduction на frozen b88: оригинальный intent проходит; вложенный intent после `sort_keys=True` даёт `CLOSED_APPLICATION_PROFILE_ACL_INPUTS`, поскольку SQL включает `JSON.stringify` ACL. Независимый review обнаружил тот же дефект на следующем шаге: сортировка `sourceProof` в helper receipt даёт `SOURCE_PROOF`.

Локальный R5 передаёт исходные intent bytes через Base64 в обоих Node entry points и сохраняет порядок proof в receipt; хеш receipt берётся от тех же записанных байтов. Общая canonical serialization журналов и все validators остаются прежними. 51 LOCAL check PASS:42 synthetic,3 real offline npm10.9.0,5 intent-transport и1 actual frozen helper custody regression. При проверке helper filesystem adapters используют только owned LOCAL fixtures; это не доказательство installed custody. Пакет R5 не установлен и не исполнен; точное live-разрешение запрошено после двух CLEAR package reviews.

## Хеши доказательств

| Артефакт                         | SHA256                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| Canonical published b88 manifest | ff3cf75fe52824142ef148e4c02371838671eedcaa0c121089703273180a61ab |
| R1 post-recovery reconcile       | cc96df184217443acd825370ad367a0a44f9a528013c818fb034941ba24b7082 |
| R2 unexecuted closure proof      | 051e34a80c9087130be79fccf73072845b920db64cdbeed2bbb86273169b2103 |
| R3 metadata capture              | 390135b45ae3e276e71559e8717f5fb4f6acadf38d00414df78e91e329bc9dc4 |
| R3 driver                        | be6aa0c9b416f023328c99521b50021ea227af9b1687342bfcc4f9f2746dc6bd |
| R3 sequential pipeline           | c7c5d2f7012d152941bcd6cf6b7efff363c030381a06b63ce9ac0d980f6fd5f6 |
| R3 post-recovery reconcile       | f05d5d3b7a3a61ee975f3bcac8322108085ee12622aa574245a4d1973022853a |
| R4 fixed driver                  | bfe7edc225ed5731613005fa3473df19273d5bce1b63bdc7a030887c96c1e821 |
| R4 prepared manifest             | 17222080e37321c7bc25ddf2a0e0e9d2a3e25eb1e480a9eb7c0d92c63aeb1971 |
| R4 pipeline                      | 846655c839e380c2d047ff66a063037b68cf972b4e491dabda9ad21d25c66f3f |

## Runtime и оставшийся путь

Read-only04:25:25UTC: API/Worker/Realtime702 и Web871 healthy, restartCount0. Отдельная Web lineage проверена по стандартному receipt/sourceCI/publication/overlays и совпадающим backend snapshots; смешанный canonical manifest не создавался.

В действующем API шесть R1 command flags отсутствуют; GAMES_COMMANDS_ENABLED=true. Source b88 default-deny для шести flags не заменяет проверку будущих env inputs и actual candidate. Readiness не проверяет runtime privileges. Realtime startup может писать в broker, поэтому его rollout требует отдельной topology/consumer/recovery приёмки.

После enrollment нужны свежие catalog/ACL/secret-digest inputs, backup с independent restore и цепочка106→107→108→119, actual-role acceptance, upgrade/recovery всех четырёх компонентов и business journeys. CUP first-restart queue custody, LK monthly effective binding и Viva attributable settlement/visit-return не подтверждены. Денежные операции не повторять по одному статусу отмены. Mobile signing/stores отложены владельцем.

Нового merge, image publication, application deploy/restart, DB migration, live grant, provider payment/refund или store activation этим срезом не выполнено. Выполненные shared-state изменения ограничены controller recovery и временными циклами GitHub-флага; они завершены.

Read-only R5 rehearsal на сохранённом R4 stage прошёл actual stage payload и source/CI/publication validation. Canonical source path/config подставлены только в памяти; это не installed attestation. Выходной SHA256 `dae370d5f78b4c5be15d0de7458b255e2c8d1581ddf57fa614db6889fd9cdc64`. Inventory07:12:56UTC включает400574 metadata rows; старые stages сохранены.

## R5 выполнен; APK подготовлен

Владелец разрешил R5. Пять файлов staged, delivery временно false07:37:23UTC; final manifest `d7df4db673ab4d8b7f7b0595056aedb4f5bf30d96364666df1dc5583fe4d80cb`. Once execute вернул `ENROLLED_NO_DEPLOY`; canonical reconcile подтвердил NEW_ENABLED/ACTIVE_RELEASE_DONE и released marker. Deliverytrue восстановлен07:38:29UTC. Application deployment, migration, grant, provider write и store activation не выполнялись.

Fresh read-only preflight07:39:27UTC:106 applied migrations, DB13,997,005,847bytes, free56,208,875,520bytes, availableRAM9,355,427,840bytes. Предварительный расчёт существующего namespace-helper: image46,628,077,568bytes +reserve5,368,709,120bytes оставляют4,212,088,832bytes для dump. Это не backup/restore proof; реальный after-dump gate обязателен. Старое утверждение «43.49GB свободно» неактуально.

APK `PadlHub-R1-test-1.13-de451e71.apk`, SHA256 `5cfa69dba0a1b86914467208756b6cdae5652bd03a20336362416cea63197dba`,27,050,008bytes. LOCAL mobile typecheck,652 tests, bundle/assembleDebug,59 app JVM tests и assembleDebugAndroidTest PASS. Первый offline Gradle запуск остановился на отсутствующем dependency cache; scoped online app-check завершился успешно. APK signature v2 проверена, Firebase client и HTTPS local-padel config включены, remote server.url отсутствует. Public health/ready/assetlinks HTTP200 и signer delegation проверены; это не business acceptance. Device installation/run не выполнялись по решению владельца; [phone checklist](R1-ANDROID-PHONE-ACCEPTANCE.md).
