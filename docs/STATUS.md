# ЛК2 — статус первой версии

Обновлено: 2026-11-08. Единственная страница статуса в режиме первой версии (AGENTS.md, «First-version mode»).
Приёмка на lk2 — [docs/runbooks/lk2-acceptance.md](runbooks/lk2-acceptance.md), read-only preflight — `npm run lk2:preflight`.
История и доказательства R1 — в `docs/release/R1-*.md`; новые контрольные точки туда не добавляются.

**Коротко:** lk2.padlhub.su — единственный контур тестирования; 2026-11-08 он обновлён до `75110af8`
(beta lane), preflight = READY: live `assetlinks.json` содержит release-сертификат подписанного APK, FCM на
сервере включён (`FCM_ENABLED=true`, tenant `android_push=true`), флаги игр и тестовых кортов включены.
До полной приёмки осталось: гранты `games.test-courts` тестовым аккаунтам (список — владелец), установка
APK и ручной прогон матрицы на телефоне — см. «Ждёт владельца».

## Где что работает

| Контур                               | Версия                                                                                                   | Данные                                                        | Как обновляется                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Тестовый стенд `test.lk2.padlhub.su` | выводится из работы (решение владельца 2026-11-08); сервер недоступен, deploy пропускается               | синтетические, `VIVA_MODE=mock`, вход `+7999000000x` / `0000` | SSH-секреты окружения `test-stand` удалены; workflow «Test stand» собирает пять образов для lk2 и пропускает выкатку |
| Бета `lk2.padlhub.su`                | `75110af8` (beta lane, 2026-11-08 18:28 MSK), ledger 119; main `ab0142f1` отличается только docs/scripts | синтетические, реальных пользователей нет                     | только с одобрения владельца: `deploy/timeweb/lk2-beta-lane.sh plan/promote <green-main-sha>`                        |
| ЛК1                                  | боевой                                                                                                   | реальные                                                      | основной продукт, пока ЛК2 не у пользователей                                                                        |

Промоут `af57d175` → `75110af8` (2026-11-08): 0 новых миграций (ledger 119), серверное поведение меняет
только `assetlinks.json` веба; остальное — docs, scripts и npm-скрипт, на выполнение в контейнерах не
влияющие. Бэкап перед промоутом: `20261108T151721Z-75110af82795.dump` (6.1 GB, проверен `pg_restore -l`).
UI приложения вшит в APK, обновление веба его не меняет.

## Флаги и доступность lk2 (readback 2026-11-08)

Включено: `VIVA_MODE=production`, `VIVA_OAUTH_ENABLED=true`, `VIVA_DIRECT_READ_ENABLED=true`,
`GAMES_READ_ENABLED=true`, `GAMES_COMMANDS_ENABLED=true` (api и worker; у worker до 2026-11-08 было
`false`, из-за чего не работал game lifecycle process manager), `GAMES_TEST_COURTS_ENABLED=true`
(api и worker), `GAMES_RESULTS_WRITE_MODE=local_primary` (api), `BETA_FULL_CLIENT_ACCESS_ENABLED=true`,
`WEB_PUSH_ENABLED=true`, `FCM_ENABLED=true` (`FCM_PROJECT_ID=padlhub`, `FCM_APP_ID=ru.padlhub.app`,
credential bind `/etc/phub/timeweb-beta-fcm/fcm-service-account.json`); tenant runtime settings:
in-app, web push и Android push включены.

Выключено/отсутствует: все `GAME_COMMERCIAL_*` и `SUBSCRIPTION_RUNTIME_DELEGATION_*` — коммерческие
CREATE/JOIN и покупка подписки на lk2 не выполняются. Возвраты Viva (CURRENCY/DEPOSIT) и возврат посещения
тренировки в первой версии выключены, возвраты — вручную.

Тестовые корты: флаг включён, но `identity.user_access_profiles` с правом `games.test-courts` — **0**,
поэтому сценарий остаётся `BLOCKED` до грантов тестовым аккаунтам.

## Сценарии (`docs/release/R1-E2E-MATRIX.md`)

Автоматический E2E (`stand:e2e`, `stand:e2e:results`) требует `VIVA_MODE=mock` и `AUTH_DEV_*`; эти ключи
запрещены runtime-контрактом Timeweb, а стенд выводится. На lk2 сценарии проходятся вручную по матрице
[runbooks/lk2-acceptance.md](runbooks/lk2-acceptance.md#4-матрица-приёмки); mock-E2E остаётся для локального
mock-стека.

| Сценарий                                      | Код и CI                | Проверка                                                                                                        |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Вход, профиль, выход                          | готово                  | вручную на lk2 (Яндекс + СМС); `npm run smoke:auth` — локальный mock-стек                                       |
| Игра: создать, вступить, выйти, отменить      | готово                  | вручную на lk2 после грантов `games.test-courts` (0 грантов на 2026-11-08); mock-E2E — локально                 |
| Результат игры и оспаривание                  | готово (PR #607, #608)  | вручную на lk2 (нужна завершённая игра); mock-E2E — локально                                                    |
| Турниры: запись и чат                         | готово                  | вручную на lk2; ручная проверка ещё не проводилась                                                              |
| Чаты, дружба, сообщества                      | готово                  | вручную на lk2; mock-E2E пишет синтетические данные локально                                                    |
| Покупка подписки, CREATE60/JOIN60 по подписке | готово, флаги выключены | нельзя проверить: флагов и Viva sandbox на lk2 нет (коммерческая приёмка — `npm run lk2:commercial-acceptance`) |
| Push-уведомления                              | готово                  | FCM на сервере включён; остаток — реальная доставка на устройство с подписанным APK                             |

## Мобильное приложение

Android CI собирает только неподписанный release-APK. Для тестов есть release-APK 1.13 (14) из main
`7a16312d`, собранный локально вне Git для `https://lk2.padlhub.su` (тенант `local-padel`, Firebase
`padlhub`) и подписанный upload-ключом владельца (сертификат SHA-256 `8C:59:A9:…:70:1E`, см.
`docs/runbooks/android-development.md`). Поверх debug-сборок он не ставится: старую сборку нужно удалить.
Live-`assetlinks.json` после промоута 2026-11-08 содержит оба отпечатка (release `8C:59:A9…:70:1E`),
поэтому App Links и вход через Яндекс должны верифицироваться; проверить на устройстве
(`adb shell pm get-app-links ru.padlhub.app` → `lk2.padlhub.su: verified`). Резервная кнопка «Открыть
приложение» остаётся страховкой. Офлайн-сборка AAB для стора — черновик PR #567; сторы отложены
владельцем. iOS — после Android.

## Ждёт владельца

- Тестовые аккаунты для lk2 с правом `games.test-courts`: явный список аккаунтов, затем
  `npm run user:access:set` (добавить только это право, сохранив текущие roles/permissions) — порядок в
  `docs/runbooks/lk2-beta-test-courts.md`. После грантов проверить каталог тестовых кортов 2/0 и пару
  «тестер/обычный аккаунт».
- Установка подписанного APK и ручной прогон матрицы на телефоне, включая реальную FCM-доставку и
  `pm get-app-links` — `docs/runbooks/lk2-acceptance.md`.
- Удаление сервера стенда в Timeweb (SSH-секреты и deploy уже отключены).
- `Follow-up finding:` автоматическая веб-доставка на lk2 (`Standard Timeweb Web delivery`) падает с
  `BASELINE_ID_INVALID` с 2026-11-06; до исправления веб на lk2 обновляется только beta-lane промоутом.
- Проверка действующей привязки месячной подписки в Node-RED ЛК1 (только чтение) — для коммерческой фазы.

## Открытые PR

- #567 — опциональная офлайн-подпись Android (черновик).
- #611 — ADR 0028, LK1-attested Viva account и subscription mappings (черновик).
- #613 — уровневые ограничения записи в турниры и тренировки (черновик; после вливания меняет eligibility).
- #614 — LK1-attested mappings writer и join ownership reader (черновик).
