# handoff-C2 — коммерческий CREATE/JOIN в ЛК2

## Статус

**C2 НЕ ЗАКРЫТА. Подготовлена независимая часть UI_LOCAL. Коммерческое подключение и интеграционная приёмка ожидают handoff-C1.**

- Репозиторий: `Z6v6e6r/lk2`.
- Worktree: `/Users/zver/Documents/Приложение ПаделхАБ/.worktrees/c2-commercial-ui-20261021`.
- Ветка: `codex/c2-commercial-ui-20261021`.
- Исходный HEAD: `03b4484e35dd7909d78285b2fded0751d2c3d57c` (свежий origin/main в начале работы).
- Текущие изменения локальные, не закоммичены. Push, PR, merge, deploy и публикация не выполнялись.
- MODEL_ROUTE: parent. Независимая advisory-презентация — FAST. Будущее подключение коммерческой команды/ledger — CRITICAL, требует соответствующих проверок и независимого review.
- Пользователь сообщил: «С1 идет в дипсик». Готовый handoff-C1 не предоставлен; незакоммиченные файлы другого владельца не импортировались.

## Владение и пересечения, проверенные до исходных изменений

Основной checkout содержит многочисленные чужие изменения; не редактировался.

| Область                        | Фактические файлы                                                  | Действие C2                                                 |
| ------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| CREATE                         | `apps/web/src/CreateGamePage.tsx`                                  | Только чтение; пересечение PR #391/#355                     |
| Существующий NO_PAYMENT ledger | `apps/web/src/create-game-attempt.ts`, `.test.ts`                  | Только чтение и запуск существующих unit-тестов             |
| JOIN и readback карточки       | `apps/web/src/GamesPage.tsx`                                       | Только чтение; PR #364/#404                                 |
| Карточка/состав                | `apps/web/src/GameDetailView.tsx`                                  | Только чтение; PR #404/#364                                 |
| Свой продукт                   | `apps/web/src/GameJoinSubscriptionPicker.tsx`, `.css`, `.test.tsx` | Только чтение, тесты и synthetic preview                    |
| Advisory-условия               | `apps/web/src/GameJoinConditionsPanel.tsx`                         | Единственный изменённый runtime-файл C2                     |
| Транспорт                      | `apps/web/src/auth-gateway.ts`, SDK                                | Владение C1; C2 не менял                                    |
| Общая навигация                | `apps/web/src/App.tsx`                                             | Не менялась; пересечения #442/#403/#399 и текущая работа C1 |

Дополнительно создан `apps/web/src/GameJoinConditionsPanel.ui.test.tsx` и этот запрошенный handoff-артефакт.

При последующей проверке worktree C1 обнаружены его новые клиентские файлы:

- `apps/web/src/GameJoinFlowPanel.tsx`;
- `apps/web/src/game-join-attempt.ts`, `.test.ts`;
- `apps/web/src/game-join-flow.ts`, `.test.ts`;
- изменения `App.tsx`, `GameDetailView.tsx`, `GamesPage.tsx` и соответствующих тестов.

**Нужна явная передача/разделение этих файлов. C2 не создаёт второй flow/ledger и не редактирует worktree C1.** Последний прочитанный коммит C1: `90ba06a4` (server-owned paid JOIN), перед ним `6c2d9104` (durable paid-join repository). Это наблюдаемые промежуточные коммиты, не принятый handoff и не подтверждение готовности SDK/контракта.

## Реализовано C2

1. Зависшая проверка advisory-условий прекращает loading через 8 секунд, показывает отдельный timeout и разрешает только явную повторную проверку.
2. Поздний результат после timeout игнорируется и не возвращает цену в UI; автоматического retry нет. Это UI deadline: транспортный запрос не объявляется отменённым, поскольку существующий SDK-метод здесь не предоставляет signal.
3. При `price.status = MISSING` сумма не отображается, даже если некорректный ответ содержит `amountMinor`.
4. Нулевая предварительная цена явно не называется бесплатной игрой и не даёт разрешения на запись/оплату.
5. `LIMIT_USED` объясняет исчерпание льготы, не приравнивает его к запрету услуги и не разрешает самостоятельно другую цену.
6. Добавлены шесть UI-тестов; runtime-заглушек, расчёта скидок, команд оплаты или нового API нет.

Существующий `GameJoinConditions` является `nonBinding: true`, `price.confirmed: false`, `requiresReservationRecheck: true`. Он не даёт безопасной основы для коммерческого submit или подтверждения текущих условий.

## Проверки — LOCAL / UI_LOCAL

Команды выполнены из worktree C2 на Node `v24.21.0`, npm `11.19.0`.

- `npm ci --ignore-scripts`: установлен зафиксированный dependency graph; package/lockfile не изменялись. npm сообщил 27 advisories (15 moderate, 10 high, 2 critical); `npm audit fix` не запускался. Это вывод установки, не отдельный security audit.
- `npm run contracts:generate`: успешно; только генерация из неизменённого контракта, без правок исходных OpenAPI/SDK. Были предупреждения существующих операций без 2XX.
- `vitest run ...GameJoinConditionsPanel.ui.test.tsx ...GameJoinConditionsPanel.test.tsx ...GameJoinSubscriptionPicker.test.tsx`: **22 passed, 2 skipped**, три файла. Оба skipped требуют `LK1_JOIN_EVALUATOR_SOURCE`; источник реального LK1 не предоставлялся.
- `vitest run apps/web/src/create-game-attempt.test.ts`: **15 passed**. Это характеристика существующего NO_PAYMENT ledger с in-memory Storage/serialLocks, НЕ browser two-tab и НЕ коммерческий CREATE/JOIN restart.
- Изменения timeout, MISSING, zero и LIMIT_USED получили ожидаемый RED перед минимальной реализацией, затем GREEN. Две другие проверки характеризуют отсутствие запроса без выбора и явный retry/double tap.
- Affected ESLint: PASS после исправления одной test-only `require-await` ошибки.
- `tsc -p tsconfig.web-app.json --noEmit`: PASS.
- `npm run build -w @phub/web`: PASS.
- `git diff --check`: PASS.

### Фактический browser preview

Backend-free fixture импортирует реальные React-компоненты C2 и существующий `styles.css`; synthetic doubles находятся только в scratch preview. База/OTP/provider не запускались. Task-owned headless Chromium, отдельный профиль, локальные file-ресурсы; HTTP(S) блокирован.

- 375×1000: available, zero, benefit denied, limit, empty products, error, timeout, expired.
- 1280×1000: available (существующая центрированная колонка приложения сохранена).
- 9 screenshots; `documentElement.scrollWidth` не превышает фактический viewport ни в одном из этих состояний.
- Console exceptions: 0. HTTP(S) requests: 0.
- Screenshot zero/375 и available/1280 просмотрены: текст и кнопка не обрезаны.
- Browser Tab проверен на preview-selector. Полный keyboard lifecycle реального коммерческого flow, включая сохранение фокуса после retry/платёжного возврата, НЕ принят. UI double tap проверен компонентным тестом, не выдан за native/device evidence.
- Browser loading проверен unit-тестом; screenshot loading не заявляется.

Артефакты: `/Users/zver/.hermes/artifacts/c2-commercial-ui-20261021/` — screenshots, `browser-results.json`, пакет handoff и исходный patch.

Полный `npm run check`, CI, STAGING, PROVIDER и PRODUCTION не выполнялись для этой независимой FAST advisory-правки. Подключение CRITICAL-команды ещё не начиналось.

## Матрица исходных требований

| Требование                                                           | Статус                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Станция, слот, открытый/приватный формат, разрешённый расчёт      | Существующий CREATE имеет станцию/время/формат и NO_PAYMENT; коммерческий слот и разрешённые сервером способы не подключены                           |
| 2. Конкретный собственный продукт                                    | Существующий JOIN-picker протестирован; коммерческая передача выбора команде ожидает C1                                                               |
| 3. Покрытие/доплата/полная цена/причина                              | Advisory уже показывается; исправлены MISSING/zero/лимит. Подтверждённые доплата/полная цена отсутствуют до C1                                        |
| 4. Услуга запрещена / льгота недоступна / другая цена / не проверено | Проверка/error/timeout/льгота различимы; текущий advisory-контракт не подтверждает отдельные serviceAllowed/alternativePrice, клиент их не выдумывает |
| 5. Подтверждение актуальных условий                                  | Не подключено: нужен authoritative quote/consent C1, не advisory-checkbox                                                                             |
| 6. Одна команда с сохранённым исходным ключом                        | Существующий NO_PAYMENT ledger охарактеризован; коммерческий JOIN/CREATE ждёт передачи владения C1                                                    |
| 7. Оплата/обработка/успех/отказ/UNKNOWN                              | Коммерческий flow ещё не принят/не подключён C2                                                                                                       |
| 8. Return/reopen/readback исходной операции                          | Нужен handoff-C1, включая lookup после потери operationId. Return URL не используется как PAID                                                        |
| 9. Карточка/участники/личная запись после серверного результата      | Не принято; нужно authoritative readback и проверка сходимости всех трёх проекций                                                                     |

Нельзя интерпретировать этот пакет как готовый рабочий коммерческий CREATE/JOIN.

## Необходимый вход handoff-C1

1. Зафиксированный commit/PR с контрактом, SDK и общим транспортом; точные экспортируемые типы и методы, не промежуточные файлы.
2. Authoritative проверка станции/слота/формата/способа расчёта и конкретного продукта; отдельные семантики service denial, benefit denial, alternative price и temporarily unverified. Не заставлять UI выводить их из reason text.
3. Серверный quote/consent: ревизия, expiry, серверные суммы, валюта, покрытие и exact echo/подтверждение; реакция на expired/stale quote без новой команды.
4. Единственная команда с caller-supplied исходным idempotency key; SDK не должен повторять mutation через retry/refresh.
5. GET-only readback исходной операции по сохранённому ключу/identity, включая потерю ответа до получения operationId; точные final/nonfinal/UNKNOWN и подтверждённый сервером отказ без side effect.
6. Оплата: разрешённый nextAction/return, возврат/отмена/закрытие и UNKNOWN/reconciliation. Return URL не является финансовым доказательством.
7. Условия подтверждённого результата и версия для readback карточки, состава и личной записи.
8. Передача C2 указанных клиентских flow/ledger-файлов либо подтверждение, что C1 их исключает. Общую навигацию менять только последовательно одним владельцем.

## Mobile handoff — точные файлы и ещё открытые кейсы

### Android

`apps/mobile/src/main.tsx:19-20` → `shared-app-entry.tsx` → `MobileApp.tsx:2-3` импортирует общий Web `App`/gateway. Общие Web-компоненты используются Android-сценарием, но это НЕ доказательство работы Web Locks/хранилища/deep-link/native transport на устройстве.

Передать Android-владельцу после C1: `apps/mobile/src/MobileApp.tsx`, `apps/mobile/src/native-api-fetch.ts`, `apps/mobile/src/navigation.ts`, `apps/mobile/src/shared-app-entry.tsx`. Проверить исходную tenant/user attempt после process kill/reopen, payment return/deep-link/back/cancel, отключённую сеть/timeout, double tap, logout→другой аккаунт, новую сессию того же аккаунта, поддержку межконтекстной блокировки, отсутствие mutation replay в native transport, обновление карточки/состава/личной записи только после readback. Native config/signing C2 не менял.

### iOS — отдельный путь

`apps/mobile/src/main.tsx:9-17` → `ios/IOSAuthApp.tsx` → `ios/IOSCabinet.tsx`. В `IOSCabinet.tsx:460-469` игра показывается через `GameCard readOnly`; текст прямо говорит, что запись/оплата/управление ещё не подключены. Это НЕ общий `GamesPage`/`CreateGamePage`.

Точные файлы владельцу: `apps/mobile/src/ios/IOSCabinet.tsx`, `ios/cabinet-data.ts`, `ios/IOSAuthApp.tsx`, `ios/IOSCabinet.test.tsx`, `ios/IOSAuthApp.test.tsx`. Нужна отдельная scoped интеграция в существующий cabinet без платформенной переработки. Кейсы: собственный продукт/quote/consent, заблокированная услуга vs недоступная льгота, возврат/отмена оплаты, background/kill/reopen с прежним ключом, offline/UNKNOWN, смена аккаунта/tenant, повторное открытие по ссылке, подтверждённые roster/bookings/card, keyboard/accessibility/native viewport. C2 этот путь не менял; Android/iOS приёмка отсутствует.

## Границы

Реальных платежей, OTP, внешних записей, миграций/fixture DB, merge, deploy, публикации, signing/native-конфигурации не было. Токены/платёжные секреты/клиентские ПДн в artifacts, localStorage или логи этой работой не добавлялись. Документ является промежуточным handoff-C2 и списком точных зависимостей, не финальным acceptance.
