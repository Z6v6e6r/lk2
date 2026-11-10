# ЛК2 — статус первой версии

Обновлено: 2026-11-10. Единственная страница статуса в режиме первой версии (AGENTS.md, «First-version mode»).
Приёмка на lk2 — [docs/runbooks/lk2-acceptance.md](runbooks/lk2-acceptance.md), read-only preflight — `npm run lk2:preflight`.
История и доказательства R1 — в `docs/release/R1-*.md`; новые контрольные точки туда не добавляются.

**Коротко:** lk2.padlhub.su — единственный контур тестирования; 2026-11-10 09:07 MSK он обновлён до
`31de9c30` (beta lane, ledger 120), включён `PROFILE_NATIVE_READ_ENABLED=true` для Android `profile.read`
(ADR 0023) и push-фикс 1.15 (16). Preflight = READY: live `assetlinks.json` содержит
release-сертификат, FCM на сервере включён (`FCM_ENABLED=true`, tenant `android_push=true`), флаги игр и
тестовых кортов включены. До полной приёмки остался ручной прогон матрицы и проверка уровня/баланса в
новом APK на телефоне — см. «Ждёт владельца».

## Где что работает

| Контур                               | Версия                                                                      | Данные                                                        | Как обновляется                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Тестовый стенд `test.lk2.padlhub.su` | выведен из работы: сервер удалён владельцем 2026-11-08, deploy пропускается | синтетические, `VIVA_MODE=mock`, вход `+7999000000x` / `0000` | SSH-секреты окружения `test-stand` удалены; workflow «Test stand» собирает пять образов для lk2 и пропускает выкатку |
| Бета `lk2.padlhub.su`                | `31de9c30` (beta lane, 2026-11-10 09:07 MSK), ledger 120; это текущий main  | синтетические, реальных пользователей нет                     | только с одобрения владельца: `deploy/timeweb/lk2-beta-lane.sh plan/promote <green-main-sha>`                        |
| ЛК1                                  | боевой                                                                      | реальные                                                      | основной продукт, пока ЛК2 не у пользователей                                                                        |

Промоут `af57d175` → `75110af8` (2026-11-08): 0 новых миграций (ledger 119), серверное поведение меняет
только `assetlinks.json` веба; остальное — docs, scripts и npm-скрипт, на выполнение в контейнерах не
влияющие. Бэкап перед промоутом: `20261108T151721Z-75110af82795.dump` (6.1 GB, проверен `pg_restore -l`).
UI приложения вшит в APK, обновление веба его не меняет.
Второй промоут 2026-11-08: `75110af8` → `10705588` (beta-каталог `games.test-courts`), бэкап
`20261108T175503Z-107055881e2f.dump` (6.2 GB). Третий: `10705588` → `04d9c2f9` (уровневые ограничения
записи из PR #613), бэкап `20261108T183903Z-04d9c2f9eb1b.dump` (6.2 GB).
Далее: `04d9c2f9` → `0f6165fc` (2026-11-09 03:26 MSK, бэкап `20261109T031623Z-0f6165fc95ac.dump`),
`0f6165fc` → `340ac394` (#624, 2026-11-09 12:05 MSK, бэкап `20261109T115346Z-340ac3946ce3.dump`) и
`340ac394` → `31de9c30` (2026-11-10 09:07 MSK, бэкап `20261110T055610Z-31de9c304850.dump`, включает #621 и
миграцию 0116). После промоута в `api.env` добавлен `PROFILE_NATIVE_READ_ENABLED=true` и пересоздан `api`;
старые release-образы четырёх SHA удалены для освобождения диска, retention бэкапов — 3.

## Флаги и доступность lk2 (readback 2026-11-10)

Включено: `VIVA_MODE=production`, `VIVA_OAUTH_ENABLED=true`, `VIVA_DIRECT_READ_ENABLED=true`,
`GAMES_READ_ENABLED=true`, `GAMES_COMMANDS_ENABLED=true` (api и worker; у worker до 2026-11-08 было
`false`, из-за чего не работал game lifecycle process manager), `GAMES_TEST_COURTS_ENABLED=true`
(api и worker), `GAMES_RESULTS_WRITE_MODE=local_primary` (api), `BETA_FULL_CLIENT_ACCESS_ENABLED=true`,
`WEB_PUSH_ENABLED=true`, `FCM_ENABLED=true` (`FCM_PROJECT_ID=padlhub`, `FCM_APP_ID=ru.padlhub.app`,
credential bind `/etc/phub/timeweb-beta-fcm/fcm-service-account.json`); tenant runtime settings:
in-app, web push и Android push включены.

Коммерческий JOIN (api, с 2026-11-07): `SUBSCRIPTION_RUNTIME_WARN_MODE=WARN`, полный набор
`SUBSCRIPTION_RUNTIME_DELEGATION_*` (ключ `lk2-beta-2026-11`), `SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN`,
`SUBSCRIPTION_RUNTIME_BASE_URL`, `GAME_COMMERCIAL_JOIN_ENABLED=true`, `GAME_COMMERCIAL_JOIN_OWNER_BASE_URL`.
JOIN по подписке всё ещё закрыт: Viva отвечает 403 на End User чтения с egress lk2, поэтому владение
подпиской подтверждает LK1 (ADR 0028, #614). Нужны маршрут аттестации на живом LK1 (lk#303, lk#304,
пакет lk#305 — не установлен) и `eligibleClientSubscriptionIds` с идентичностью продукта.

Выключено/отсутствует: `GAME_COMMERCIAL_CREATE_*`, `TRAINING_REGISTRATION_ENABLED` и покупка подписки — на
lk2 не выполняются; CREATE и запись на тренировку нельзя включать до привязки подписки к пользователю
(ADR 0028). Возвраты Viva (CURRENCY/DEPOSIT) и возврат посещения
тренировки в первой версии выключены, возвраты — вручную.

Profile observation (ADR 0023, readback 2026-11-10): `PROFILE_NATIVE_READ_ENABLED=true`,
`PROFILE_OBSERVATION_MAX_AGE_SECONDS=900` (api); routing plan `integration.client_routing_plans` уже
`MIXED_END_USER_READS` rev 2 с `profile.read`, активных VIVA-делегаций — 10. Миграция 0116 применена,
`profile.provider_observations` с forced RLS, `phub_runtime` имеет SELECT/INSERT/UPDATE и не имеет DELETE.
API и worker не делают `/end-user/api/` запросов (0 в последних логах).

Тестовые корты: флаг включён; право `games.test-courts` входит в beta-каталог
`FULL_CLIENT_PERMISSIONS` (PR #617) и сохраняется при входе любого номера (решение владельца
2026-11-08), поэтому персональные гранты и список тестеров не нужны. На lk2 каталог действует с промоута `10705588` (2026-11-08);
применяется к сессии после следующего входа/обновления токена. Уровневый гейт записи (#613) развёрнут с
промоутом `04d9c2f9`; его политика по умолчанию OFF и включается только per-tenant политикой.

## Сценарии (`docs/release/R1-E2E-MATRIX.md`)

Автоматический E2E (`stand:e2e`, `stand:e2e:results`) требует `VIVA_MODE=mock` и `AUTH_DEV_*`; эти ключи
запрещены runtime-контрактом Timeweb, а стенд выводится. На lk2 сценарии проходятся вручную по матрице
[runbooks/lk2-acceptance.md](runbooks/lk2-acceptance.md#4-матрица-приёмки); mock-E2E остаётся для локального
mock-стека.

| Сценарий                                      | Код и CI                                                                 | Проверка                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Вход, профиль, выход                          | готово                                                                   | вручную на lk2 (Яндекс + СМС); `npm run smoke:auth` — локальный mock-стек                                         |
| Игра: создать, вступить, выйти, отменить      | готово                                                                   | вручную на lk2: доступ к тестовым кортам у любого номера после входа (beta-каталог, PR #617); mock-E2E — локально |
| Результат игры и оспаривание                  | готово (PR #607, #608)                                                   | вручную на lk2 (нужна завершённая игра); mock-E2E — локально                                                      |
| Турниры: запись и чат                         | готово                                                                   | вручную на lk2; ручная проверка ещё не проводилась                                                                |
| Чаты, дружба, сообщества                      | готово                                                                   | вручную на lk2; mock-E2E пишет синтетические данные локально                                                      |
| Покупка подписки, CREATE60/JOIN60 по подписке | JOIN: флаг включён, закрыт до аттестации LK1; CREATE и покупка выключены | после установки lk#305 на LK1: `npm run lk2:commercial-acceptance` (сначала только чтение, затем один `--join`)   |
| Push-уведомления                              | готово                                                                   | FCM на сервере включён; остаток — реальная доставка на устройство с подписанным APK                               |

## Мобильное приложение

Android CI собирает только неподписанный release-APK. Для тестов собран локально вне Git и подписан
upload-ключом владельца release-APK **1.15 (16)** из main `8b72bd58` для `https://lk2.padlhub.su`
(тенант `local-padel`, Firebase `padlhub`):
`output/android-lk2-1.15-code16-20261110/PadlHub-1.15-code16-lk2-pushfix-8b72bd58.apk`,
SHA-256 `3c8d27bc…aafe04048`, сертификат `8C:59:A9:…:70:1E` (совпадает с live `assetlinks.json`). В 1.15 исправлены
bodyless-команды native-транспорта (415 на отзыве push-endpoint и других пустых DELETE) и застрявший
pending revoke больше не блокирует включение push; прежняя 1.14 (15) без FCM-конфига и 1.14 с FCM остаются
для истории. В сборку вшит
публичный клиент Firebase `google-services.json` проекта `padlhub` (`google_app_id`, `gcm_defaultSenderId`,
`PadlHubAndroidPushPlugin`), поэтому доступен Android push; сборка без этого файла даёт
«Уведомления пока недоступны»/«Не удалось настроить уведомления». Он включает
Android `refreshProfile` и `AndroidProfileRefresh` (ADR 0023) — уровень и баланс в профиле. Предыдущая
сборка — 1.13 (14) из `7a16312d`. Поверх debug-сборок он не ставится: старую debug-сборку нужно удалить;
signed release обновляется обычным install. App Links и вход через Яндекс проверяются на устройстве
(`adb shell pm get-app-links ru.padlhub.app` → `lk2.padlhub.su: verified`); резервная кнопка «Открыть
приложение» остаётся страховкой. Офлайн-сборка AAB для стора — черновик PR #567; сторы отложены
владельцем. iOS — после Android.

## Ждёт владельца

- Перезапустить приложение или перевойти (чтобы сессия получила новый beta-каталог) и прогнать матрицу
  на телефоне любым номером: после входа проверить каталог тестовых кортов 2/0 и отрицательный случай
  через `GAMES_TEST_COURTS_ENABLED=false` — порядок в `docs/runbooks/lk2-beta-test-courts.md`.
- На установленном APK (уже стоит у владельца): `pm get-app-links` → `verified`, Яндекс-вход, реальная
  FCM-доставка и остальные строки матрицы — `docs/runbooks/lk2-acceptance.md`.
- `Follow-up finding:` автоматическая веб-доставка на lk2 (`Standard Timeweb Web delivery`) падает с
  `BASELINE_ID_INVALID` с 2026-11-06; до исправления веб на lk2 обновляется только beta-lane промоутом.
- Установить APK 1.15 (16) и проверить уровень/баланс и push: один provider 200 → accepted relay →
  повторный `GET /profile` с уровнем и балансом (если provider-значений нет, остаются «—»). Provider-readback
  нулевого `/end-user/api/` трафика уже снят (0 в последних логах api/worker). Откат —
  `PROFILE_NATIVE_READ_ENABLED=false` + пересоздание `api`.
- `Follow-up finding:` диск lk2 после промоута 2026-11-10: ~16 ГБ свободно (84%), меньше 2× размера БД;
  старые release-образы четырёх SHA удалены, retention бэкапов — 3. Capacity остаётся provisioning-свойством.
- `Follow-up finding:` промоут 2026-11-10, запущенный в интерактивной SSH-сессии, оборвался при разрыве
  сессии после бэкапа (worker был остановлен); восстановлено повторным запуском detached (`setsid nohup`).
  Запускать lane detached и не закрывать сессию до строки `OK:`.
- Проверка действующей привязки месячной подписки в Node-RED ЛК1 (только чтение) — для коммерческой фазы.

## Открытые PR

- #567 — опциональная офлайн-подпись Android (черновик).
- #611 — ADR 0028, LK1-attested Viva account и subscription mappings (черновик).
- #622 — subscriptions: аттестация по LK1 alias `pay_<uuid>` (черновик).
- #629 — публикация подтверждённых результатов LK2 в LK1 (готов).
- #630 — user-bound Viva subscription mappings после OTP-входа, ADR 0029 D5 (черновик).
