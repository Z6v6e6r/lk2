# Subscription storefront UI

Переиспользуемый визуальный каркас витрин абонементов. Он не загружает каталог, не создаёт
заказы и не вызывает платёжные или Viva API.

## Локальный preview

Запуск из корня worktree:

```bash
npm run dev:web
```

Сценарии:

- `/__preview/subscriptions` — три карточки из исходного desktop-макета;
- `/__preview/subscriptions?scenario=ab-leto` — конфигурация страницы типа `ab_leto`;
- `/__preview/subscriptions?scenario=multi` — несколько секций для вертикального скролла;
- `/__preview/subscriptions?scenario=test` — live-данные с `padlhub.su`, обновление каждые 5 сек и создание ссылки на оплату.

Preview доступен только в Vite DEV. Сценарии `default`, `ab-leto` и `multi` не выполняют покупку. Сценарий `test` читает клиента из `localStorage` (`iSkq6G_lk_analytics_user_v1`) и открывает `paymentUrl` после POST на `/lk/tournaments/summer-subscription/purchase`.

## Адаптивный контракт

- до `719px` (mobile): вертикальный скролл страницы, внутри секции горизонтальная snap-лента с фиксацией карточки по центру;
- `720px`–`1279px` (tablet): свободный горизонтальный scroll без center-snap, небольшие inset'ы у крайних карточек;
- от `1280px` (desktop): контент до `1496px`, hero h1 56px, карточки 480px с gap 24px, тот же свободный scroll;
- rail «full-bleed»: ширина `100vw` с `margin-left: calc(50% - 50vw)` — симметрично до краёв дисплея на всех брейкпоинтах (не только за паддинги canvas);
- если карточки не влезают, rail получает `data-overflow="true"`: flex-спейсеры `::before`/`::after`; на mobile спейсер `(100vw − card) / 2` + snap `center` и старт с центральной / `n/2` карточки; на tablet/desktop спейсер = rail-inset, `scroll-snap-type: none`; если влезают — группа центрируется (`justify-content: center`);
- на узких экранах ширина карточки оставляет видимый «подгляд» соседней (`calc(100vw - clamp(56px, 10vw, 96px))`);
- при переполнении ленты работает автолистание после простоя (`useRailAutoscroll`): пауза на hover/focus/скролле, отключение при `prefers-reduced-motion` и скрытом документе; без overflow — не планируется;
- на `<500px` селектор периода оплаты (`subscription-card__billing-options`) переносится под цену отдельной строкой;
- на tablet и desktop rail остаётся горизонтальным scroll-контейнером даже при 4+ тарифах;
- gap между секциями (`subscription-storefront__sections`) адаптивный: `clamp(24px, 4vw, 48px)`;
- заголовок секции `h2` адаптивный: `clamp(18px, 2.5vw, 24px)`; подзаголовок `p`: `clamp(13px, 2vw, 16px)`;
- шапка (nav ↔ hero, заголовок ↔ подзаголовок) имеет увеличенные gap'ы; шрифты шапки на мобильных не уменьшаются;
- у страницы не должно быть горизонтального overflow;
- каждая карточка — градиентный контейнер `subscription-card` с прогресс-полоской сверху и белой панелью `subscription-card__panel` внутри;
- rail и интерактивные элементы должны оставаться доступными с клавиатуры.

## Ассеты

Файлы разложены по смыслу внутри `assets/`:

- `fonts/` — шрифты витрины: `Inter_18pt-Regular.ttf`, `Inter_24pt-Regular.ttf` (`Subscription Inter`), `RFDewi-Regular.woff`, `RFDewi-Semibold.woff`, `RFDewi-Bold.woff` (`Subscription RF Dewi`);
- `icons/` — `back.svg`, `more.svg` (навигация, белый круг 48×48 встроен в сам SVG), `lightning.svg` (молния в полоске прогресса), `game.svg`, `training.svg`, `group.svg`, `time.svg`, `tournament.svg` (иконки преимуществ);
- `plan-art/` — `дружба.svg`, `ра.svg`, `академия.svg` — логотипы тарифов на карточке (`artUrl`);
- `brand/` — `подписка.svg` — марк в hero, `subscription-mark-compact.png`;
- `benefit-icons.ts` — маппинг `SubscriptionBenefitIcon` → URL иконок.

## Контракт карточки

- `tagTone` — hex-цвет фона тега;
- `artUrl` — SVG-логотип тарифа вместо текстового `label` в теге;
- `progress` — на уровне `billingOptions`, меняется при переключении периода оплаты;
- `ctaDisabled` — CTA некликабельна (sold out / «Мест нет»), фон `#e8e8e9`;
- `featured` — флаг «выделенного» тарифа (класс `subscription-plan-rail__item--featured`); отдельной визуальной темы пока нет.

## Summer status API → mapper

`mapSummerSubscriptionStatus` берёт из `GET …/summer-subscription/status` только то, что нужно витрине:

| Берём | Куда |
|-------|------|
| `plans[].counterKey` | `plan.id` (+ порядок из `summerPlanDisplayOrder`) |
| `priceMinor` | `billingOptions[0].priceMinor` |
| `remainingCount` / `totalLimit` / `unlimited` | `progress` (если не unlimited и totalLimit > 0) |
| `canPurchase` | `ctaLabel` + `ctaDisabled` |
| `productId` / `campaignKey` / … | не в view; остаются в `plansById` для POST purchase |

Сознательно **не** маппятся в UI (inventory/ops, не презентация):

- staged release / daily drop: `stagedRelease`, `releasePhase`, `releaseStartDate`, `dailyDropActive`, `dailyDropDate`, `dailyDropStartsAt`, `dailyLimit`, `dailyCapEnabled`;
- launch batch: `launchLimit`, `launchPaidCount`, `launchReservedCount`, `launchRemainingCount`, `launchCompletedAt`;
- batch inventory: `batchSize`, `batchIndex`, `batchCount`, `batchRemainingCount`;
- дубли учёта: `paidCount`, `reservedCount`, `takenCount`, `inventory*`, корневой «один план», `summary`;
- readiness: `bindingReady` / `bindingError`, `managedSaleReady` / `managedSaleError` (кроме косвенного влияния на `canPurchase`);
- биллинг-себестоимость: `providerProductCostMinor`, `discountMinor`;
- `productName` / `saleType` / `planKey` / `campaignKey` / `inventoryId` — для purchase payload, не для карточки;
- `energy5` — исключён из витрины (`EXCLUDED_SUMMER_PLAN_KEYS`).

Презентация (label, art, benefits, featured, hero) — локально в `plan-presentation.ts` / mapper, не из API.