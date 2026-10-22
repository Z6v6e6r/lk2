# handoff-C2 — подключённый коммерческий JOIN ЛК2

## Продолжение 22 октября 2026 — интеграция merged C1

- Собственная C2-ветка обновлена обычным merge актуального `origin/main` `599ed7210d84b4aec6e5d0aa6382db5ff3d98909`; integration commit `88fc9b4b`. Опубликованная история не переписана, protected branch не менялась. C1 #447 уже merged; ниже сохранена история приёмки от 21 октября, а не описание текущего main.
- Актуальный C1 source исправляет конкретные прежние blockers late receipt после TTL, actor-token transmission и runtime composition. Это source-вывод, не доказательство реального provider settlement или готовности всех owner receivers.
- После интеграции выполнены JOIN/detail/ledger/conditions/picker/panel tests и C1 commercial JOIN/runtime/admission tests: **11 files PASS, 169 tests PASS / 2 SKIP**. Web typecheck и `git diff --check` PASS. Оба skipped не стали интеграционной приёмкой.
- Найден и исправлен test-only wall-clock dependency: capacity/eviction regression задаёт одно и то же время при записи и перечитывании. Runtime TTL/custody не менялись; полный check от 21 октября не выдаётся за проверку нового integration tree.
- Новый `npm run check` на frozen index `f0dcf7753c44873e3a8e4156fb790b2901454579`: все `source:static` gates PASS (generation, format, lint, typecheck, contract lint, build, runtime imports); итог **exit 1** на двух 5000 ms timeout в неизменённом `scripts/provision-timeweb-beta-runtime-secrets.test.ts`. Полный прогон: **6085 PASS / 281 SKIP / 2 timeout**, source/index unchanged. Изолированный повтор того же файла с прежним timeout и без product/release edits: **63 PASS**. Это не выдаётся за повторный зелёный `npm run check`; exact-head CI нового delivery head проверяется отдельно.
- Последующий Android transport candidate `530da882e24df99383ee50d553ce236310674cd9`: **полный `npm run check` exit 0, 6087 PASS / 281 SKIP, 625 files PASS / 22 SKIP**; Java host-JVM **10 PASS / 0 SKIP** (6 JOIN cases) и instrumentation Java compilation PASS. Source/index/worktree не менялись во время проверки. Independent R3 source review PASS без blockers; затем исправлены только test-fixture `intent` и пояснение transport/server bounds, production Java policy не менялась. Новая fixture проверяется повторным JVM gate, docs — affected format check; приёмка устройства/реального owner/provider не заявляется.
- Android использует общий экран. Первоначальный blocker user-API JOIN/readback находился в Java `AndroidSessionPolicy`; JS `native-api-fetch.ts` уже передаёт такие user-API запросы без автоматического повтора JOIN. Последующий отдельный native increment расширяет Java allowlist только для текущего C1 JOIN/readback, без изменения TS transport, SDK, auth engine, signing/configuration. Точный scope и пределы host-JVM evidence: [Android commercial JOIN transport](../../docs/runbooks/android-commercial-join.md). Приёмка устройства/WebView/payment return остаётся OPEN; browser screenshots её не доказывают. На iOS сохраняются отдельный read-only cabinet и read-only native session policy.
- Пользователь отдельно разрешил дальнейшую реализацию серверного контракта/SDK/native policies на task-ветках. Правила D0, real payments/OTP, protected merge, публикация и deploy этим разрешением не охвачены. Инкремент слияния main не менял owner/native-файлы; последующий native increment ограничен описанной Java JOIN transport policy и её тестами/документацией.
- Commercial CREATE/full-price/private court, real owner/provider acceptance и native acceptance остаются **OPEN**. Полный результат двух направлений не объявляется завершённым.

## Историческая приёмка 21 октября — статус и точный источник

**C2 в работе: поддерживаемый C1 сценарий JOIN реализован и проверен UI_LOCAL; independent specialist re-review PASS. Полный LOCAL check PASS. Собственные Draft PR/CI фиксируются отдельным exact-head delivery readback, не подменяются CI C1. Полный коммерческий CREATE/full-price/private court не реализованы — принятый owner-контракт их не предоставляет.**

- Репозиторий: `Z6v6e6r/lk2`.
- Ветка: `codex/c2-commercial-ui-20261021`.
- Worktree: `/Users/zver/Documents/Приложение ПаделхАБ/.worktrees/c2-commercial-ui-20261021`.
- Принятый точный handoff-C1: `214324a31a94dbeaab1541be6e48457126050908`, Draft PR #447.
- Проверяемое source/index tree C2: `fa57ca03cd33b28cf89a3c9666c6d97370ee8c50`.
- Исторический advisory checkpoint: `2ec55a8cd505956cca8d0e941c611d6108e7cc68`. Commercial source commit: `5b5ec80a2b0e16c77c7f0a4fe4cd1a1ff4f9c447`, tree точно совпадает с reviewed/tested `fa57ca03...`. Этот финальный report меняет только запрошенный handoff; source evidence переиспользуется без ложного утверждения о повторном прогоне.
- На повторной remote-проверке C1 уже `39e0baf8a5a13f68ff8165a53145b24d1d273007`. Его CI прочитан: green. Дополнительные два коммита затрагивают только API/database owner и их tests; C2 остаётся на переданном `214324a3`, не импортирует новый tip молча. CI C1 не является CI C2.
- Риск: CRITICAL только затронутого клиентского command/custody/consent boundary; preview/advisory presentation — FAST. D0/C1 ownership не расширялось.

## Владение и изменённые файлы

Основной грязный checkout и worktree C1 не менялись. До исходных изменений проверялись PR #391/#355 (CREATE), #364/#404 (JOIN/detail), #442/#403/#399 (общая навигация); после точного handoff унаследован flow C1, а не создан второй runtime ledger/controller.

C2 delta от `214324a3`:

| Файлы                                                | Назначение                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/web/src/GameJoinConditionsPanel.tsx`           | Advisory deadline, поздний ответ, MISSING/zero/limit copy                                            |
| `apps/web/src/GameJoinConditionsPanel.ui.test.tsx`   | Loading/empty/error/timeout/retry/zero/benefit tests                                                 |
| `apps/web/src/GameJoinFlowPanel.tsx`, `.ui.test.tsx` | Consent/status presentation, zero due, keyboard confirmation, confirmed-but-updating                 |
| `apps/web/src/GamesPage.tsx`, `.test.tsx`            | Подключённый JOIN lifecycle, account/gateway/game lifetime, условия, deadline, readback, projections |
| `apps/web/src/game-join-attempt.ts`, `.test.ts`      | Principal-wide Web Locks, исходный ключ и неизменяемый operation binding, client custody             |
| `apps/web/src/game-join-flow.ts`, `.test.ts`         | Строгий parser квитанции, consent expiry/revision, семантические состояния                           |
| `apps/web/src/GameDetailView.test.tsx`               | Адаптация inherited consent fixtures                                                                 |
| `output/c2-commercial-ui-20261021/handoff-C2.md`     | Запрошенный итоговый handoff, заменяет раннюю advisory-only версию                                   |

Не менялись server, правила D0, OpenAPI, SDK, `auth-gateway.ts`, auth core, `App.tsx`/общая навигация, package/lockfile, CI, config/env, signing и native-конфигурация. Генерация ignored contract types выполнялась штатной командой из неизменённых OpenAPI.

## Рабочее поведение поддерживаемого JOIN

1. Используется существующий picker конкретного собственного продукта. Суммы, покрытие и причины приходят от C1; правила, скидки и право полной оплаты на клиенте не вычисляются.
2. Advisory без цены/согласия не превращается в free JOIN. Коммерческий entry point fail-closed, не вызывает legacy free command.
3. Zero due явно означает использование подписки, а не бесплатную игру. LIMIT_USED не объявляет запрет услуги и не разрешает альтернативную оплату.
4. Service denial, benefit denial, изменившаяся цена и непроверенные условия различаются в пределах переданных C1 outcome codes. Неизвестное правило/unsupported full-price остаётся unavailable, не додумывается.
5. Явное подтверждение хранит expiry/revision/выбранный продукт. На confirm просроченное или изменившееся согласие сбрасывается и условия явно перепроверяются без submit.
6. Исходная попытка/ключ сохраняются до dispatch. Все ledger mutations и dispatch сериализованы principal-wide Web Lock, включая разные игры. Без Web Locks нет unsafe localStorage fallback: команда fail-closed.
7. Зависшие conditions GET, original-operation GET и JOIN POST ограничены 8-секундным UI deadline. Таймаут POST означает UNKNOWN, не отмену серверной операции; прежний ключ не теряется, replacement POST не выполняется.
8. Return URL не подтверждает PAID. Refresh/reopen и восстановление после утраты operationId используют GET исходной операции по прежнему ключу. Временный `GAME_OPERATION_NOT_FOUND` удерживает custody и не даёт начать новую оплату.
9. Tenant/user/gateway/game-scoped lifetime исключает позднее согласие/результат другого аккаунта или предыдущей игры. Storage содержит минимальную identity/payload/consent/key/state, не токены и не платёжные секреты.
10. Каждый parsed operation result связывается с актуальной persisted custody под lock до классификации. Ответ для другого operationId не объявляет успех и не удаляет исходную попытку.
11. Trusted success отделён от сходимости карточки, состава и confirmed personal booking: состояние `CONFIRMED_UPDATING` удерживает custody и предлагает только GET-проверку. Busy освобождается и при stale/error/timeout проекций; старый task не снимает busy нового.
12. Итоговый success показывается только при подходящей server revision, self membership/roster и подтверждённой personal booking. Проекции не вычисляются клиентом и не сливаются с неподтверждённым ответом команды.

## Проверки и атрибуция доказательств

### LOCAL — тесты и static checks

- Targeted suite: 8 files, **123 PASS / 2 SKIP**. Оба skipped требуют реального `LK1_JOIN_EVALUATOR_SOURCE`; реальный evaluator не подключался.
- После test-only устранения `require-await` повторены четыре новых regression tests: **4 PASS**. Они воспроизводили RED до исправления: pending A → success B; pending A → failure B; success readback со stale projections и заблокированной кнопкой; поздний old-game result после смены маршрута.
- Web typecheck и affected ESLint: PASS. Prettier/diff check: PASS.
- Общий build/typecheck/lint/format/contract/runtime-import checks выполнены внутри финального `npm run check`: PASS на замороженном `fa57ca03...`.
- Existing NO_PAYMENT create ledger characterization: **15 PASS**, результат раннего этапа, не повторно выдан за commercial CREATE acceptance.
- Preliminary staged-diff Gitleaks: repo-pinned `ghcr.io/gitleaks/gitleaks@sha256:e1b35e12a8c6fa8901f060459cfb6b2fc4c484d3afbe3b029733a3bbfab07055`, redacted stdin, exit 0, no leaks. Это не заменяет complete committed-range scan перед push.
- Independent review исходного `bc515cef7e9a44645eb01ef5b3ab49ae36d95849`: FAILED на stale operation-ID binding и locked recovery button. Замечания воспроизведены и исправлены. Bounded specialist re-review нового `fa57ca03cd33b28cf89a3c9666c6d97370ee8c50`: **PASS**, без security/logic blockers; parent readback подтвердил совпадение index/worktree. `c2-independent-rereview.json` сохраняет source identity, findings и static-only limits. Nonblocking follow-up: дополнительные точные interleavings write failure/смена binding при ожидании lock.
- Полный `npm run check`: первая попытка использовала другой Node из background PATH; вторая, на Node 24, завершилась **21 FAIL / 5994 PASS / 258 SKIP**. Все 21 failure — `scripts/verify-source-ci.test.ts`, `CONTROLLER_PROMOTION_GIT_METADATA`.
- Диагностика второй попытки: фактический inherited TMPDIR был `/var/...`, canonical realpath — `/private/var/...`; custody test запрещает этот alias. Тот же неизменённый файл с `TMPDIR=/Users/zver/.hermes/cache/scratch` дал **60 PASS**. Никакой trust check или release script не ослаблялся.
- Третья полная попытка: **`npm run check` PASS**, Node `v24.21.0`, `--no-experimental-webstorage`, canonical task scratch, minimal env без DB/provider/verification flags. **621 test files PASS / 21 SKIP; 6019 tests PASS / 258 SKIP**. Source/index/worktree `fa57ca03...` совпали до и после выполнения. Log SHA256 `a456a840f87ab171e532ee1116d75471d2bf4aaa75fc4176b804f57a5957a791`; metadata: `c2-full-check-final-result.json`. Ранние неуспешные попытки сохранены отдельно, не выданы за PASS.

Данные C3 пользователя (58 PASS, 3 BLOCKED на старом C1) не запускались C2 повторно и не выдаются за собственную интеграционную приёмку. Реальная БД/owner/provider не использовались.

### UI_LOCAL — фактический Chromium

Backend-free fixture импортирует реальный `GamesPage`, компоненты и CSS из дерева `fa57ca03...`; fake gateway существует только в scratch preview. Chrome `155.0.8059.85`, task-owned profile, native Web Locks, общий storage двух page targets. HTTP(S) блокирован, network requests 0, runtime exceptions 0.

Машинный результат: `c2-connected-browser-results.json`, source tree и bundle SHA256 привязаны к фактическому прогону.

- Фактические widths 375/1280, без horizontal overflow.
- Concurrent confirm в двух вкладках: одна synthetic command, один исходный key; reopen с `?status=paid&payment=success` — только GET того же key, без success из URL.
- Synthetic server success при отстающей карточке: `CONFIRMED_UPDATING`, ручная GET-проверка доступна; после изменения synthetic server projections — подтверждённая карточка/состав/личная запись, без второй команды.
- Другой principal не отображает прежнюю попытку.
- Native CDP Tab фокусирует именно реальную кнопку подтверждения с `:focus-visible`; Enter confirmation проверена компонентным UI-тестом.
- Получены 11 connected screenshots: шесть full-context и пять scrolled-panel viewport captures. Последние позволяют осмотреть панель без артефакта fixed bottom nav в full-page screenshot. Содержимое полностью synthetic, без клиентских ПДн.
- Сохраняются девять ранних advisory screenshots; это отдельный предыдущий source preview, не подмена доказательства нового connected flow.

Ни synthetic server receipt, ни браузерный return/reopen не доказывают реальные платежи, приёмку Android/iOS, auth refresh по сети или готовность owner receivers.

## Матрица исходного результата

| Требование                                                       | Результат                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Станция/слот/открытый или приватный формат/разрешённый расчёт | Существующий CREATE/NO_PAYMENT сохранён. Коммерческий CREATE/full-price/private court BLOCKED принятым owner-контрактом, не эмулируется |
| 2. Конкретный собственный продукт                                | Поддерживаемый JOIN подключён к существующему picker/команде C1                                                                         |
| 3–4. Покрытие, цена и раздельные причины                         | Реализовано в пределах C1 response semantics; альтернативное право полной оплаты не придумывается                                       |
| 5. Явное актуальное согласие                                     | Реализовано с expiry/revision/product guard и server recheck                                                                            |
| 6. Одна команда и сохранённый ключ                               | Реализовано; unit + native browser two-tab synthetic evidence                                                                           |
| 7. Оплата/processing/success/rejection/UNKNOWN                   | Реализована клиентская state machine; real provider не принят                                                                           |
| 8. Return/close/reopen/original readback                         | UI_LOCAL и client regression coverage; реальные payment redirect/process kill/native transport не приняты                               |
| 9. Card/roster/personal booking                                  | Реализован server-read convergence gate; интеграционная сходимость реального backend не принята                                         |

## Native handoff

### Android — общий Web экран

`apps/mobile/src/main.tsx` → `shared-app-entry.tsx` → `MobileApp.tsx` импортирует общий Web `App`/gateway. Передать владельцу `apps/mobile/src/MobileApp.tsx`, `apps/mobile/src/native-api-fetch.ts`, `apps/mobile/src/navigation.ts`, `apps/mobile/src/shared-app-entry.tsx`.

Проверить на устройстве Web Locks/storage origin, process kill→reopen и тот же original key, payment deep-link/back/cancel, offline/timeout/UNKNOWN, double tap, logout→другой tenant/user, новую сессию того же principal, отсутствие mutation replay в native/auth refresh transport, доступность keyboard/accessibility и card/roster/bookings после server readback. Отсутствие Web Locks fail-closed, не повод делать небезопасный fallback в C2.

### iOS — отдельный read-only cabinet

`apps/mobile/src/main.tsx` → `ios/IOSAuthApp.tsx` → `ios/IOSCabinet.tsx`; игра выводится через `GameCard readOnly`, это не `GamesPage`/`CreateGamePage`.

Точные файлы владельцу: `apps/mobile/src/ios/IOSCabinet.tsx`, `ios/cabinet-data.ts`, `ios/IOSAuthApp.tsx`, `ios/IOSCabinet.test.tsx`, `ios/IOSAuthApp.test.tsx`. Нужна отдельная scoped интеграция в существующий cabinet: собственный продукт/условия/consent, service vs benefit denial, payment return/cancel/background/kill/reopen, original-key GET-only recovery без mutation replay, account/tenant isolation, подтверждённые card/roster/bookings, native viewport/keyboard/accessibility. C2 эти файлы и native config/signing не меняла.

## Открытые границы и запреты

- По принятому `214324a3` остаются blockers C1: commercial CREATE/full-price/private court, trusted late `CONFIRM_PAYMENT` B3 и реальные LK1/ph-admin admission/read receivers. Более новый C1 `39e0baf8` содержит owner fixes, но нового exact handoff/приёмки C2 ещё нет; старые blockers не объявляются автоматически закрытыми.
- Флаг по умолчанию OFF; C2 его не меняла.
- LOCAL check и independent re-review текущего source tree PASS. Собственный Draft PR/CI проверяется по точному head отдельно; результаты доставки — в `c2-delivery.json`/PR. Остаётся C3 backend/provider/native acceptance в разрешённой среде.
- Реальных платежей, OTP, миграций, live/shared DB/provider writes, merge, deploy, image/app publication не выполнялось.
- Этот документ фиксирует готовый UI_LOCAL поддерживаемого JOIN и открытые контрактные/интеграционные границы. Это не разрешение включать коммерцию и не утверждение о полной готовности commercial CREATE/JOIN.
