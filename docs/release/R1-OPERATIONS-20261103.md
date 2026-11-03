# R1 — операционная запись 2026-11-03

## Операционный срез — 2026-11-03, после 09:24 MSK

Этот раздел и [операционная запись](R1-OPERATIONS-20261103.md) заменяют конфликтующие исторические статусы ниже. **NO-GO для production release.** LK2 main `de451e712c08aae46fdc47ae162c20ce038657bd`; миграционный пакет отдельно зафиксирован на `b88f2100e0d77b8c3bbb3a75ced70f2fd97dcefd`.

Старая консоль исправлена владельцем. R1 восстановлен, R2 подтверждён как неисполненный. R3 был явно разрешён и запущен, но остановился до переключения source на установке зависимостей: npm отказался читать `/dev/null` одновременно как user и global config. Guarded recovery восстановил старый source/config; partial stage и все пакеты сохранены, active marker освобождён. `LK2_STANDARD_DELIVERY_ENABLED=true` подтверждён в06:24:31UTC. Исправленный R4 подготовлен и проверен локально; его запуск ещё не выполнен. Приложения и БД не переключались.

## Проверенный source

[PR574](https://github.com/Z6v6e6r/lk2/pull/574), commit `4306aba593b864fdcecf4b3faad561a569552da3`: fixed pg_catalog-only audit проверяет права новых relations/columns, parent row locks, unsafe roles/ownership и RLS на ожидаемых API/Worker database/role. Connector, CLI и grants не добавлены; результат всегда `activationAllowed:false`. Security и PG/recovery review CLEAR.

[CI41576927809](https://github.com/Z6v6e6r/lk2/actions/runs/41576927809):9173 PASS/133 SKIP; отдельный PostgreSQL16 contour7/7, включая R1-tail privilege assertions. Mandatory game14physical+6guards, communications10+1, Rabbit4+1, notificationPG4 и notificationRabbit4 — zeroSKIP. Static/security/dependency gates и пять Docker builds PASS. Это CI, не публикация.

LOCAL:28 unit PASS, scoped lint/types и scans PASS. Full macOS fixed-head run25FAIL/8792PASS/489SKIP в трёх существующих process/Git-custody suites; Git subset60/60 с исправленным только task TMPDIR/GID. Полный LOCAL gate не закрыт. Mock-preview setup остановился на npm ci до запуска БД/API/Web; rendered acceptance отсутствует.

## Выполненные операции

Первый enrollment остановился на PROCESS_AMBIGUOUS: старая root serial-консоль находилась в удалённом cwd. После ответа владельца «готово» fresh process guard прошёл. Единственный guarded recovery завершился RESTORED_PRE_MIGRATION_RETAINED_R1_ARTIFACTS; canonical reconcile OLD_OR_RESTORED подтвердил старый source/config, отсутствие active и наличие released-active. GitHubtrue восстановлен04:51:26UTC.

R2 staged7files, но execute wrapper остановился локально на age<90 до SSH и создания execute-output. Свежий read-only proof05:55:02UTC проверил exact7files, отсутствие journal/active/provision/helper/source-stage, прежний source HEAD/tree/clean и config hash. После неизменного main, exact paused variable и отсутствия всех GitHub runs с начала окна originaltrue восстановлен05:55:05UTC. Ownership window закрыт. Приватные raw inputs остаются вне Git.

R3 был явно разрешён владельцем; staging и final readback→execute pipeline прошли без прежней задержки. Execute остановился OWNED_COMMAND_FAILED на STAGE_INTENT. Canonical reconcile подтвердил OLD_DISABLED, старый source, partial stage и отсутствие helper. Read-only inspection показал b88 HEAD/tree в stage, но отсутствие зависимостей и npm-логов. Серверный `npm --version` с теми же двумя `/dev/null` конфигами воспроизвёл double-loading config до разрешения конфигурации.

Guarded recovery4b83b5a9 восстановил только старый config, сохранил partial stage и освободил owned marker. Canonical reconcile OLD_OR_RESTORED и свежие GitHub main/variable/no-runs проверки позволили вернуть true06:24:31UTC. Приложения и БД не менялись.

Исправленный R4 создаёт отдельный пустой global npm config с exclusive/durable0600 publication, сохраняя явный user config `/dev/null`, task cache и `--ignore-scripts`.42 synthetic checks прошли. Три реальные offline regression проверки с официальным npm10.9.0 прошли: воспроизведение старой ошибки, успешная установка без lifecycle scripts и ambient HOME config, сохранность foreign file/symlink. Первоначальный fixture GID исправлен только в тесте. Два независимых review CLEAR;6 прежних Linux checks переиспользованы только для неизменных primitives. Новая live попытка не запускалась.

Draft PR575 commit7cb4b9b0 прошёл полный CI41587299496 SUCCESS. Новая редакция операционного отчёта требует собственного CI.

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
