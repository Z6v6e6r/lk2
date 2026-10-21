/**
 * Operator intake snapshot of the active LK1 subscription/commercial rules.
 *
 * Generated from the LK1 repository at the commit recorded below. This is INVENTORY EVIDENCE for
 * the operator registry, not runtime authority: CUP remains the only source of published rules and
 * LK2 must not evaluate these values. Every value carries `path:line` evidence and a confidence in
 * the source artifact; unconfirmed and conflicting rules keep their status here instead of being
 * silently promoted.
 */
export const LEGACY_RULES_INVENTORY: unknown = {
  schemaVersion: 1,
  generatedAt: '2026-10-21T10:59:44+03:00',
  repo: {
    url: 'https://github.com/Z6v6e6r/lk.git',
    sha: '6207cdeb',
    date: '2026-10-21',
  },
  products: [
    {
      productId: 'lk1:hub-annual',
      name: 'Падел.Дружба.ХАБ — годовая (сеть)',
      aliases: ['network_friendship', 'Падел.Дружба.ХАБ', 'HUB'],
      vivaProductIds: ['db7a5250-7369-4f43-8ac5-9111be24bc74'],
      stations: ['exact 25-station Viva snapshot (CUP policy, not published)'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '13',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '44-53',
          kind: 'APPROVED_DOC',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '146-153',
          kind: 'OPERATIONAL_NOTE',
        },
      ],
    },
    {
      productId: 'lk1:friendship-30d',
      name: 'Лето.Падел.Дружба / «Дружба» 30 дней',
      aliases: ['friendship', 'planKey:friendship', 'Дружба 30 дней'],
      vivaProductIds: ['b2e6a9d4-53b5-4f79-87ec-3fb076381e9b'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '17-39',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md',
          lines: '16',
          kind: 'OPERATIONAL_NOTE',
        },
      ],
    },
    {
      productId: 'lk1:friendship-two-hours',
      name: 'Падел.Дружба 2.0 («Дружба 2 часа»)',
      aliases: ['friendship_two_hours', 'Падел.Дружба 2.0'],
      vivaProductIds: ['6b98e7e3-5bd3-4e94-9dc3-7723ea52513e'],
      stations: ['any station (no station rule)'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_20260930.md',
          lines: '8-22',
          kind: 'OPERATIONAL_NOTE',
        },
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '60-63',
          kind: 'OPERATIONAL_NOTE',
        },
      ],
    },
    {
      productId: 'lk1:friendship-topokraty',
      name: 'Дружба Топократы (клубная)',
      aliases: ['topocraty', 'planKey:topocraty'],
      vivaProductIds: ['14692232-12be-4218-9fa1-2d5b79b62035'],
      stations: ['no station restriction (documented residual risk)'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '19',
          kind: 'OPERATIONAL_NOTE',
        },
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '41-55',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md',
          lines: '108-126',
          kind: 'OPERATIONAL_NOTE',
        },
      ],
    },
    {
      productId: 'lk1:ra',
      name: 'Лето.Падел.РА',
      aliases: ['ra', 'planKey:ra', 'РА'],
      vivaProductIds: ['b91e14d1-fe6e-4d0b-be39-3e45ad86b759'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '31',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '19-31',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:academy',
      name: 'Лето.Падел.Академия',
      aliases: ['academy', 'planKey:academy', 'Академия'],
      vivaProductIds: ['9eb8a7a4-c195-492a-95e4-3fb82899ac10'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '33',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '19-31',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:sport',
      name: 'Лето.Падел.Спорт',
      aliases: ['sport', 'planKey:sport', 'Спорт'],
      vivaProductIds: ['82caad6f-4d19-4d01-852b-932bdbb0f405'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '34',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'src/utils/tournamentSubscriptionCatalog.ts',
          lines: '7-9',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:promo-ra',
      name: 'РА Акция',
      aliases: ['promo_ra', 'ra-promo', 'РА Акция'],
      vivaProductIds: ['3b4806f1-6f9a-46df-a7d7-45075b4e7274'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '37',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'src/utils/tournamentSubscriptionCatalog.ts',
          lines: '28-35',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:promo-academy',
      name: 'Лето.Падел.Академия Акция',
      aliases: ['promo_academy', 'academy-promo'],
      vivaProductIds: ['6bda152b-0a9c-4308-82d0-3cd4e6aa680d'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '35',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'src/utils/tournamentSubscriptionCatalog.ts',
          lines: '12-19',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:promo-friendship',
      name: 'Лето.Падел.Дружба Акция',
      aliases: ['promo_friendship', 'friendship-promo'],
      vivaProductIds: ['c079dc82-c716-4f0e-b9ad-6aab62fb789e'],
      stations: ['all stations except configured station exclusions'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '36',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'src/utils/tournamentSubscriptionCatalog.ts',
          lines: '20-27',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:energy5',
      name: 'Абонемент «Энергия 5» (и «Энергия 25» для ПРО)',
      aliases: ['energy5', 'energy25', 'Энергия 5'],
      vivaProductIds: ['dfa72adf-233b-4285-8d69-e5eab4234fbe'],
      stations: ['n/a'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md',
          lines: '5-7',
          kind: 'APPROVED_DOC',
        },
        {
          path: 'docs/LK1_PRO_TRAINING_EXCLUSIONS_20260918.md',
          lines: '9-12',
          kind: 'OPERATIONAL_NOTE',
        },
      ],
    },
    {
      productId: 'lk1:piter-annual',
      name: 'Падел.Дружба.Питер — годовая',
      aliases: ['piter_friendship', 'Питер', 'SPb'],
      vivaProductIds: ['8bf334ba-3050-4017-b40a-7eef2db1eb16'],
      stations: ['1ea77cbf-bc36-49a1-96d6-f35c216a409b'],
      status: 'UNKNOWN',
      sources: [
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '82-92',
          kind: 'APPROVED_DOC',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '127-130',
          kind: 'OPERATIONAL_NOTE',
        },
        {
          path: 'docs/PITER_SUBSCRIPTION_CONTRACT.md',
          lines: '268-298',
          kind: 'APPROVED_DOC',
        },
      ],
    },
    {
      productId: 'lk1:kotelniki',
      name: 'Падел.Дружба.Котельники',
      aliases: ['kotelniki_friendship', 'Котельники'],
      vivaProductIds: [],
      stations: ['3b52e87f-33bb-436b-a1e3-19a3b62b4ed2'],
      status: 'DISABLED',
      sources: [
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '1875-1881',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '86-92',
          kind: 'APPROVED_DOC',
        },
      ],
    },
    {
      productId: 'lk1:patriots',
      name: 'Дружба.Патриоты',
      aliases: ['patriots', '37ab3713'],
      vivaProductIds: ['37ab3713-4431-4815-96ba-d7ece76a9241'],
      stations: ['any (direction-scoped, not station-scoped)'],
      status: 'CANDIDATE',
      sources: [
        {
          path: 'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md',
          lines: '7-9',
          kind: 'OPERATIONAL_NOTE',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '84-92',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:pulkovo',
      name: 'Дружба.Пулково',
      aliases: ['pulkovo', 'd84534c8'],
      vivaProductIds: ['d84534c8-aad1-46e1-ac6a-70296f319a3f'],
      stations: ['any (copies installed friendship rule)'],
      status: 'CANDIDATE',
      sources: [
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '8-24',
          kind: 'OPERATIONAL_NOTE',
        },
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '44-48',
          kind: 'IMPLEMENTED_CODE',
        },
      ],
    },
    {
      productId: 'lk1:summer-sale-counters',
      name: 'Летние счётчики продаж (friendship / ra / academy / sport / energy5 + акции)',
      aliases: ['summer_padel_friendship_2026', 'ab_leto', 'sub_hab'],
      vivaProductIds: [],
      stations: ['n/a'],
      status: 'ACTIVE',
      sources: [
        {
          path: 'scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js',
          lines: '39-66',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md',
          lines: '9-14',
          kind: 'APPROVED_DOC',
        },
      ],
    },
    {
      productId: 'lk1:pro-training-service',
      name: 'ПРО-тренировки / Игра+Тренер ПРО (сервис, не продаваемый продукт)',
      aliases: ['PRO', 'direction 5502-5507'],
      vivaProductIds: [],
      stations: ['any'],
      status: 'UNKNOWN',
      sources: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway_hooks.js',
          lines: '356-362',
          kind: 'IMPLEMENTED_CODE',
        },
        {
          path: 'docs/LK1_PRO_TRAINING_EXCLUSIONS_20260918.md',
          lines: '234-241',
          kind: 'OPERATIONAL_NOTE',
        },
        {
          path: 'docs/LK1_PRO_TRAINING_DISCOUNT_20261002.md',
          lines: '1-8',
          kind: 'APPROVED_DOC',
        },
      ],
    },
    {
      productId: 'lk1:trial-group-service',
      name: 'Пробная групповая тренировка (сервис/допуск)',
      aliases: ['trial_group', 'direction 4971', 'type 1755'],
      vivaProductIds: [],
      stations: ['any'],
      status: 'DISABLED',
      sources: [
        {
          path: 'docs/LK1_TRIAL_GROUP_ELIGIBILITY_20261002.md',
          lines: '5-19',
          kind: 'APPROVED_DOC',
        },
        {
          path: 'docs/LK1_TRIAL_GROUP_ELIGIBILITY_20261002.md',
          lines: '93-99',
          kind: 'OPERATIONAL_NOTE',
        },
      ],
    },
  ],
  rules: [
    {
      ruleId: 'lk1:hub-annual:exact-product-only',
      productId: 'lk1:hub-annual',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: 'db7a5250-7369-4f43-8ac5-9111be24bc74',
      unit: 'ENUM',
      period: 'VALIDITY',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '188-206',
          quote:
            'if (productId !== null && productId === LK1_HUB_PRODUCT_ID) { ... LK1_PRODUCT_RULE_INVALID }',
        },
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '13',
          quote: 'export const LK1_HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Rule selection is by exact Viva product UUID resolved from the owned instance, never by name or planKey. A managed-looking name without the product id yields MANAGED_SUBSCRIPTION_PRODUCT_MAPPING_REQUIRED (docs/LK1_SUBSCRIPTION_ENFORCEMENT_20260826.md:66-68).',
    },
    {
      ruleId: 'lk1:hub-annual:no-sale-date-gate',
      productId: 'lk1:hub-annual',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: 'contour applies to every sale (no purchaseDate cutoff)',
      unit: 'BOOLEAN',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '214-216',
          quote: '// The HUB rule carries no sale-date gate: the contour is on for every sale.',
        },
        {
          path: 'docs/LK1_STATION_EXCLUSIONS_20260918.md',
          lines: '17',
          quote:
            'годовой «Падел.Дружба.ХАБ» (`db7a5250-…`) в контуре всегда, без гейта по дате продажи',
        },
      ],
      confidence: 'CONFIRMED',
      notes: 'Differs from all plan products, which require purchaseDate >= 2026-09-01.',
    },
    {
      ruleId: 'lk1:hub-annual:free-60-min-per-day',
      productId: 'lk1:hub-annual',
      ruleGroup: 'usage_limits',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value: {
        freeGameMinutesPerDay: 60,
        visitConsumed: 1,
      },
      unit: 'MINUTES',
      period: 'DAY',
      exceptions: ['minutes already used today reduce the free portion'],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '289-296',
          quote:
            'const freeMinutes = Math.min(duration, Math.max(0, rule.freeGameMinutesPerDay - used)); ... decision.subscriptionVisitCount = freeMinutes > 0 ? 1 : 0;',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '1000-1010',
          quote: 'usedOrReservedFreeMinutesToday: used ... dailyBucketLocalDate: ctx.serviceDate',
        },
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '17-26',
          quote: 'freeGameMinutesPerDay: 60',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Bucket is the Moscow calendar day (moscowLocalDate in evaluator.js:111-118). Counter is instance-scoped (selected clientSubscriptionId only).',
    },
    {
      ruleId: 'lk1:hub-annual:join-uses-same-bucket',
      productId: 'lk1:hub-annual',
      ruleGroup: 'usage_limits',
      service: 'GAME',
      action: 'JOIN_GAME',
      appliesTo: 'BOTH',
      value: 'JOIN shares the same daily free-minute bucket and visit counter as CREATE',
      unit: 'MINUTES',
      period: 'DAY',
      exceptions: [],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '230-236',
          quote:
            'if (category === "GAME") { const used = usage?.usedOrReservedFreeMinutesToday; const day = moscowLocalDate(target?.startsAt); ...',
        },
        {
          path: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md',
          lines: '132-138',
          quote:
            'For GAME, any positive free-minute portion consumes exactly one subscription visit; the paid portion alone uses the existing partial-price percentage calculator.',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'The evaluator does not distinguish CREATE from JOIN for the GAME bucket; the action only has to match target category (evaluator.js:176-182).',
    },
    {
      ruleId: 'lk1:hub-annual:overage-30-percent',
      productId: 'lk1:hub-annual',
      ruleGroup: 'payment_cancel',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value: {
        gameOverageDiscountPercent: 30,
        kind: 'PARTIAL_PRICE_PERCENT_DISCOUNT',
      },
      unit: 'OTHER',
      period: 'NONE',
      exceptions: [
        'above the active-bookings cap the whole game is charged with the same 30% and no visit is consumed',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '295-306',
          quote:
            'selectedRule = { ruleId: "lk1-game", kind: "PARTIAL_PRICE_PERCENT_DISCOUNT", partialPrice: { numerator: paidOverageMinutes, denominator: duration }, percentage: rule.gameOverageDiscountPercent };',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '281-288',
          quote:
            'if (aboveActiveLimit) { ... discountPercent: rule.gameOverageDiscountPercent ... subscriptionVisitCount = 0',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Integer arithmetic: floor(base * numerator/denominator), then floor(partial*percent/100) — evaluator.js:506-533. Unit is a whole percent of the server-resolved price (not minor units).',
    },
    {
      ruleId: 'lk1:hub-annual:group-training-50-percent',
      productId: 'lk1:hub-annual',
      ruleGroup: 'payment_cancel',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value: {
        groupTrainingDiscountPercent: 50,
        visitConsumed: 0,
      },
      unit: 'OTHER',
      period: 'NONE',
      exceptions: [
        'rule requires an enabled matching benefit; a DISABLED/missing benefit blocks the category',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '374-380',
          quote:
            'decision.subscriptionVisitCount = freeFirstCovered ? 1 : 0; selectedRule = freeFirstCovered ? { ruleId: `lk1-${category.toLowerCase()}`, kind: "FREE_ENTITLEMENT" } : { ruleId: `lk1-${category.toLowerCase()}`, kind: "PERCENT_DISCOUNT", percentage: category === "GROUP_TRAINING" ? rule.groupTrainingDiscountPercent : rule.tournamentDiscountPercent };',
        },
        {
          path: 'docs/EVENT_SUBSCRIPTION_PAYMENTS.md',
          lines: '8-16',
          quote:
            'Групповая тренировка | BOOK_GROUP_TRAINING | Разовая услуга конкретного упражнения | groupTrainingDiscountPercent | 0',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'For HUB the free-first-event cohort does not apply (gateway.js:19-31), so the first group event of the day is also a 50% monetary discount with zero visit debit. Unit is a whole percent of the server-resolved price (not minor units).',
    },
    {
      ruleId: 'lk1:hub-annual:tournament-50-percent',
      productId: 'lk1:hub-annual',
      ruleGroup: 'payment_cancel',
      service: 'TOURNAMENT',
      action: 'BOOK_TOURNAMENT',
      appliesTo: 'BOTH',
      value: {
        tournamentDiscountPercent: 50,
        visitConsumed: 0,
      },
      unit: 'OTHER',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/GROUP_SUBSCRIPTION_DISCOUNT_20260909.md',
          lines: '11-13',
          quote: '5,500 RUB → 2,750 RUB, “Скидка 50% по подписке «Падел.Дружба.ХАБ»”',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '376-380',
          quote:
            'kind: "PERCENT_DISCOUNT", percentage: category === "GROUP_TRAINING" ? rule.groupTrainingDiscountPercent : rule.tournamentDiscountPercent',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Zero visible visits never blocks the monetary discount (docs/GROUP_SUBSCRIPTION_DISCOUNT_20260909.md:19-20). Unit is a whole percent of the server-resolved price (not minor units).',
    },
    {
      ruleId: 'lk1:hub-annual:active-bookings-cap-8',
      productId: 'lk1:hub-annual',
      ruleGroup: 'active_future_bookings',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'NEW',
      value: {
        maxActiveBookings: 8,
        scope: 'SUBSCRIPTION_BENEFIT_ONLY',
        priorValue: 4,
      },
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [
        'the cap is a benefit threshold, not a booking ban: above it the event is still bookable at the plan discount',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-10-05',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '220-227',
          quote:
            'decision.aboveActiveLimit = activeCount >= rule.maxActiveBookings; ... // A full active-bookings list is not a blocker',
        },
        {
          path: 'scripts/lib/lk1ActiveBookingLimit.mjs',
          lines: '6-10',
          quote:
            'export const ACTIVE_BOOKING_LIMIT = 8; ... HUB_POLICY_PRIOR = { ... maxActiveBookings: 4 ... }',
        },
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '12-20',
          quote:
            'Продукт отсутствовал в девяти установленных правилах `subscriptions_lk1_plan_rules`. ... Копируется **установленное**, а не историческое source-правило обычной «Дружбы»: ... | `maxActiveBookings` | 8 |',
        },
        {
          path: 'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md',
          lines: '14-18',
          quote: '| `maxActiveBookings` | 8 |',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        "Two later docs read 8 from the installed flow, while docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md:9-10 states the 4→8 change was prepared but not merged/deployed and the candidate's exact prior is 4. No deploy receipt was found. See conflicts[0].",
    },
    {
      ruleId: 'lk1:hub-annual:active-count-scope',
      productId: 'lk1:hub-annual',
      ruleGroup: 'active_future_bookings',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'NEW',
      value:
        'count = active bookings of the selected instance + bookings bound by LK1 benefit operations; unpaid non-subscription reserves are not counted unless bound',
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [
        'paid ON_PLACE JOIN bookings bound by an LK1 operation count toward the cap across all dates',
      ],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '985-990',
          quote:
            'const active = ctx.lk1.activeBookings.filter((booking) => normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId) || benefitBookings.has(normalizeId(bookingId(booking))));',
        },
        {
          path: 'docs/SUBSCRIPTION_PAID_JOIN_FIX_20260909.md',
          lines: '37-40',
          quote:
            "Gateway and preview include active paid bookings bound by existing LK1 operations, across dates, in the selected subscription's active-booking limit. Daily minutes remain date-scoped.",
        },
        {
          path: 'docs/HUNG_SUBSCRIPTION_CLAIM_RECONCILE_20260912.md',
          lines: '13-21',
          quote:
            'a claim that carries `bookingId` marks its provider booking as a benefit booking, so it occupies an `activeServices` slot against `maxActiveBookings`',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Usage snapshot must declare activeServiceScope=SUBSCRIPTION_BENEFIT_ONLY, otherwise USAGE_SNAPSHOT_INVALID (evaluator.js:220-222). Claims not in FAILED/RELEASED keep consuming a slot, including stale PENDING_CONFIRMATION ones.',
    },
    {
      ruleId: 'lk1:hub-annual:no-free-first-event',
      productId: 'lk1:hub-annual',
      ruleGroup: 'availability',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value: 'HUB is absent from LK1_FREE_FIRST_EVENT_PRODUCTS -> no free first event of the day',
      unit: 'BOOLEAN',
      period: 'DAY',
      exceptions: [],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '19-28',
          quote:
            'const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({ "b91e14d1-…": ["group_training", "tournament"], ... "6b98e7e3-…": ["tournament"] });',
        },
        {
          path: 'docs/LK1_STATION_EXCLUSIONS_20260918.md',
          lines: '17-19',
          quote:
            'в `LK1_FREE_FIRST_EVENT_PRODUCTS` ни «Дружбы», ни ХАБ нет, поэтому «первое событие дня бесплатно» на них не распространяется',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:hub-annual:no-booking-window-enforced',
      productId: 'lk1:hub-annual',
      ruleGroup: 'time_duration',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value:
        'LK1 contour enforces no booking horizon; 14-day station-local window exists only in the unpublished CUP policy',
      unit: 'OTHER',
      period: 'BOOKING_HORIZON',
      exceptions: [],
      onViolation: 'UNKNOWN',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'UNKNOWN',
      evidence: [
        {
          path: 'scripts/managed_subscription_dev_runtime.ts',
          lines: '350-378',
          quote:
            'activeServicesLimit: { enabled: true, max: 8, ... }, bookingWindow: { enabled: true, days: 14 }',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js',
          lines: '246-258',
          quote:
            'if (dayOffset < 0 || dayOffset >= bookingWindowDays) { block("BOOKING_WINDOW_EXCEEDED", ...)',
        },
        {
          path: 'docs/PITER_SUBSCRIPTION_CONTRACT.md',
          lines: '290-291',
          quote: 'окно записи — 14 локальных календарных дней станции: текущая дата и ещё 13 дней',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        'BOOKING_WINDOW_* lives in the CUP evaluator (managed contour), which is disabled by the absent `subscriptions_managed_enforcement_product_ids` allowlist. The HUB LK1 gateway (gateway.js) has no window check. See conflicts[2] and gaps[3]. Unit is a count of local calendar days.',
    },
    {
      ruleId: 'lk1:hub-annual:durations-60-90-120',
      productId: 'lk1:hub-annual',
      ruleGroup: 'time_duration',
      service: 'GAME',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: [60, 90, 120],
      unit: 'MINUTES',
      period: 'NONE',
      exceptions: [],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'UNKNOWN',
      evidence: [
        {
          path: 'scripts/nodered_subscription_price_preview_nodes/entry.js',
          lines: '29-32',
          quote:
            "|| ![60, 90, 120].includes(target.durationMinutes) ... return bad('PRICE_PREVIEW_REQUEST_INVALID');",
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '2149-2154',
          quote:
            'const unsupportedUsage = Number(policy.usage?.minHoursBetweenUses || 0) !== 0 || Number(policy.dailyUsageLimit) !== 1 || ["60", "90", "120"].some((key) => Number(policy.usageUnitsByDuration?.[key]) !== 1); const createDurations = Array.isArray(policy.createGame?.durationsMinutes)',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        'The allow-list is enforced in the price preview and in the CUP-policy compatibility check (which rejects a policy that deviates). The LK1 hub booking gateway itself derives minutes from the server-resolved target and has no 60/90/120 allow-list, so an off-list duration is priced by minutes instead of being refused there. Every known split/UI path offers only 60/90/120.',
    },
    {
      ruleId: 'lk1:hub-annual:provider-card-365-365',
      productId: 'lk1:hub-annual',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'PURCHASE_ADD_ON_PRODUCT',
      appliesTo: 'NEW',
      value: {
        productType: 'SUBSCRIPTION',
        validityDays: 365,
        visits: 365,
        activationDays: 'integer, must project no earlier than 2026-10-01',
      },
      unit: 'COUNT',
      period: 'VALIDITY',
      exceptions: [
        'later provider activation deadline is allowed (first-use activation is expected earlier)',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-08-21',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_LIFECYCLE_CORRECTION.md',
          lines: '34-53',
          quote:
            'Piter and HUB checkout is allowed only when ... `validityDays=365` and `visits=365` ... REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '200-204',
          quote:
            'Продажа годовых Питера и ХАБа дополнительно должна останавливаться до Viva transaction, если точная карточка продукта допускает автоактивацию раньше 1 октября 2026 года или не подтверждает строгие `365` дней / `365` визитов.',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Conflict with the 2026-09-09 sale opening, which edited both provider cards to activationDays=1 and introduced next-day activation without the October cutoff (docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md:43-52). See conflicts[4].',
    },
    {
      ruleId: 'lk1:hub-annual:sale-1-per-day-100-total',
      productId: 'lk1:hub-annual',
      ruleGroup: 'availability',
      service: 'ADD_ON',
      action: 'PURCHASE_ADD_ON_PRODUCT',
      appliesTo: 'NEW',
      value: {
        dailyLimit: 1,
        totalLimit: 100,
        priceMinor: 9800000,
      },
      unit: 'COUNT',
      period: 'DAY',
      exceptions: [
        'requires summer_subscription_sales_20260909_enabled and summer_subscription_hub_lk1_sales_enabled plus a ready atomic ledger',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-09',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md',
          lines: '9-14',
          quote:
            '| Годовая ХАБ | 1 daily seat, aggregate inventory 100 | 98,000 RUB | next day after purchase |',
        },
        {
          path: 'scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js',
          lines: '63-66',
          quote:
            'const NETWORK_FRIENDSHIP_DAILY_LIMIT_DEFAULT = (SALES_QUOTAS_20260909_ENABLED || subscriptionCounterEpoch.startedAt(global)) ? 1 : 10;',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Purchase-side rule (subscription sale), not a service rule. Without the flags the pre-existing HUB daily window is 10 (same line, else-branch). Doc states no deployment or sales activation occurred.',
    },
    {
      ruleId: 'lk1:friendship-30d:exact-product-and-sale-date',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        productId: 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b',
        enforceFrom: '2026-09-01',
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'instances whose only resolvable purchaseDate is before enforceFrom stay on the legacy path',
        'station-excluded pairs stay legacy without demanding a purchase date',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '235-249',
          quote:
            'const enforceFrom = rule.enforceFrom === null ? LK1_PLAN_RULES_FROM : rule.enforceFrom; // Inclusive comparison against the Moscow calendar date of the sale. const legacy = purchaseDate < enforceFrom;',
        },
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '17-32',
          quote: "enforceFrom: '2026-09-01', maxActiveBookings: 4, freeGameMinutesPerDay: 60, ...",
        },
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '26-29',
          quote:
            'Покупки до 2026-09-01 сохраняют legacy-поведение. Неустановленная дата покупки отвергается действующим resolver.',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Exactly one resolvable purchase date is required; zero or multiple dates produce SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED (lk1PlanRules.mjs:236-241).',
    },
    {
      ruleId: 'lk1:friendship-30d:active-bookings-cap-8',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'active_future_bookings',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'NEW',
      value: {
        maxActiveBookings: 8,
        scope: 'SUBSCRIPTION_BENEFIT_ONLY',
        priorValue: 4,
      },
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [
        'above the cap the booking remains allowed at the plan discount without free minutes',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-10-05',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md',
          lines: '3-7',
          quote: 'Решение 05.10.2026: единый порог **8 активных записей** для подписок контура',
        },
        {
          path: 'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md',
          lines: '27-30',
          quote:
            'При **восьми и более** работает прежняя логика после порога: бесплатные минуты и посещение не расходуются',
        },
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '21',
          quote: 'maxActiveBookings: 4,',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        'value 8 is read from the installed flow by two docs of 2026-10-16/2026-10-21; the repo source constant still carries 4 and the 2026-10-05 doc says the 4→8 candidate was not deployed. See conflicts[0].',
    },
    {
      ruleId: 'lk1:friendship-30d:free-60-min-per-day',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'usage_limits',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value: {
        freeGameMinutesPerDay: 60,
        visitConsumed: 1,
      },
      unit: 'MINUTES',
      period: 'DAY',
      exceptions: [],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '29-33',
          quote:
            'после использования 60 минут следующая игра в тот же день разрешена без бесплатных минут, со скидкой 30%',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '289-296',
          quote:
            'const freeMinutes = Math.min(duration, Math.max(0, rule.freeGameMinutesPerDay - used));',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:friendship-30d:discounts-30-50-50',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'payment_cancel',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
      },
      unit: 'OTHER',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '16-26',
          quote: '// The five rule numbers are identical for every product.',
        },
        {
          path: 'src/components/subscription-storefront/presentation.ts',
          lines: '6-18',
          quote:
            "{ id: 'game-discount', badge: '30%', ... }, { id: 'other-discount', badge: '50%', label: '... групповые тренировки, «Время на друзей», турниры ПадлхАБ' }",
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Group/tournament discounts never debit a visit for this product (it has no free-first-event entry); preview copy shows the same 30/50 split. Unit is a whole percent of the server-resolved price (not minor units).',
    },
    {
      ruleId: 'lk1:friendship-30d:legacy-shared-day',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'usage_limits',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        limitMode: 'shared_day',
        categories: ['open_game', 'tournament'],
      },
      unit: 'DAY_BENEFIT',
      period: 'DAY',
      exceptions: [
        'applies to the legacy cohort (purchase before 2026-09-01) and to products without a plan rule; the enforced cohort meters minutes instead',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '937-947',
          quote: 'const PLAN_CATEGORIES = { friendship: ["open_game", "tournament"], ... };',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '957-974',
          quote: 'return serviceDate >= SHARED_LIMIT_FROM ? "shared_day" : "category_day";',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '2347-2355',
          quote:
            'return finishError(ctx, 409, "По этому абонементу уже есть посещение на выбранную дату", { code: DAILY_LIMIT_CODE, ... })',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'SHARED_LIMIT_FROM=2026-08-01 (router:4), code SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED (router:3). For friendship the server includes `tournament` in the shared day while the client copy lists only open_game (see conflicts[6]).',
    },
    {
      ruleId: 'lk1:friendship-two-hours:one-event-per-day',
      productId: 'lk1:friendship-two-hours',
      ruleGroup: 'usage_limits',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        limitMode: 'shared_day',
        categories: ['open_game', 'tournament'],
      },
      unit: 'DAY_BENEFIT',
      period: 'DAY',
      exceptions: [
        'a game of 60/90/120 minutes or one «Время на друзей» event consumes the single daily seat; a second event of the day is refused',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-30',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '5-10',
          quote:
            '**Одно событие в день.** День даёт либо игру 60/90/120 минут (в пределах 120 бесплатных минут), либо событие «Время на друзей». Две игры по 60 минут в один день — отказ.',
        },
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_20260930.md',
          lines: '42-43',
          quote:
            '`PLAN_CATEGORIES["friendship_two_hours"] = ["open_game","tournament"]` — игра 60/90/120 и «Время на друзей» делят один дневной слот',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:friendship-two-hours:free-120-min-per-day',
      productId: 'lk1:friendship-two-hours',
      ruleGroup: 'usage_limits',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value: {
        freeGameMinutesPerDay: 120,
        visitConsumed: 1,
      },
      unit: 'MINUTES',
      period: 'DAY',
      exceptions: [],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-09-30',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '57-69',
          quote: 'maxActiveBookings: 6, freeGameMinutesPerDay: 120,',
        },
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_20260930.md',
          lines: '36-39',
          quote:
            'добавлено правило продукта `6b98e7e3…` (`maxActiveBookings: 6`, `freeGameMinutesPerDay: 120`, скидки 30 % на игру и 50 % на групповые, турниры и «Время на друзей»',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Cap value 6 was raised to 8 by the 2026-10-05 decision if that generation is live (docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md:4) — see conflicts[0].',
    },
    {
      ruleId: 'lk1:friendship-two-hours:free-first-event-5278-only',
      productId: 'lk1:friendship-two-hours',
      ruleGroup: 'availability',
      service: 'TOURNAMENT',
      action: 'BOOK_TOURNAMENT',
      appliesTo: 'BOTH',
      value: {
        freeFirstEventCategories: ['tournament'],
        directionScope: [5278],
      },
      unit: 'DAY_BENEFIT',
      period: 'DAY',
      exceptions: [
        'a ПадлхАБ tournament of the same category gets only the 50% discount',
        "after the day's free event is used, «Время на друзей» also gets 50%",
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-09-30',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '19-35',
          quote:
            '"6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze(["tournament"]) ... LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES = { "6b98e7e3-…": Object.freeze([5278]) }',
        },
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '65-67',
          quote:
            'пока дневное событие не потрачено, «Время на друзей» закрывается подпиской; потрачено — 50 % как у турниров',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'The free first event requires usedEventsToday==0, visitsLeft>=1 and activeCount below the cap (evaluator.js:365-374).',
    },
    {
      ruleId: 'lk1:friendship-two-hours:gt-50-no-visit',
      productId: 'lk1:friendship-two-hours',
      ruleGroup: 'payment_cancel',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value: '50% discount, subscriptionVisitCount = 0',
      unit: 'OTHER',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-30',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '8',
          quote:
            '**Игра + тренер, групповые, турниры ПадлхАБ и «Время на друзей» не списываются.** Их наличие даёт только скидку 50 %, визит остаётся нетронутым (`subscriptionVisitCount = 0`).',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Group training stays outside the daily seat for this product (PLAN_CATEGORIES include only open_game+tournament). Unit is a whole percent of the server-resolved price (not minor units).',
    },
    {
      ruleId: 'lk1:friendship-topokraty:standard-friendship-numbers',
      productId: 'lk1:friendship-topokraty',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        productId: '14692232-12be-4218-9fa1-2d5b79b62035',
        planKey: 'topocraty',
        enforceFrom: '2026-09-01',
        maxActiveBookings: 4,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md',
          lines: '8-17',
          quote:
            '| Пять чисел правила | `maxActiveBookings=4`, `freeGameMinutesPerDay=60`, `gameOverageDiscountPercent=30`, `groupTrainingDiscountPercent=50`, `tournamentDiscountPercent=50` |',
        },
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '19',
          quote:
            'поле `initialize` ... уже записывает `subscriptions_lk1_plan_rules` и несёт **восемь** правил, включая `planKey: "topocraty"` и продукт `14692232…`',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'The plan rule for the club product is installed; the club-specific co-pay branch and the club exclusion are separate candidates (see the next rules).',
    },
    {
      ruleId: 'lk1:friendship-topokraty:training-6233-court-hour-copay',
      productId: 'lk1:friendship-topokraty',
      ruleGroup: 'payment_cancel',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value: {
        freeMinutes: 'min(duration, 60 - used)',
        chargeableHours: 'ceil(paidOverageMinutes/60)',
        coPayPerHourMinor: 'floor(hourlyCourtPriceMinor/4)',
        discountPercent: 0,
      },
      unit: 'RUB_MINOR',
      period: 'DAY',
      exceptions: [
        'with no free hour left (day bucket spent or active-booking cap reached) the training is charged at the full one-time price and consumes no visit',
        'an unproven hourly court price refuses with LK1_COURT_PRICE_UNRESOLVED',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-10-05',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '309-349',
          quote:
            'const freeMinutes = aboveActiveLimit ? 0 : Math.min(duration, Math.max(0, rule.freeGameMinutesPerDay - used)); ... selectedRule = { kind: "COURT_HOURLY_COPAY", courtCoPay: { hourlyCourtPriceMinor, chargeableHours, perHourMinor } };',
        },
        {
          path: 'docs/LK1_TOPOKRATY_COURT_HOURLY_COPAY_20261005.md',
          lines: '6-24',
          quote:
            'Каждый следующий **начатый** оплачиваемый час стоит ровно **одну четверть часовой цены корта** ... Недоказанная цена часа корта — отказ `LK1_COURT_PRICE_UNRESOLVED`',
        },
        {
          path: 'docs/LK1_TOPOKRATY_COURT_HOURLY_COPAY_20261005.md',
          lines: '170-176',
          quote:
            'живая доставка требует отдельной авторизации — ни одно из существующих focused-поколений на текущий снимок не композируется',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'IMPLEMENTED_CODE only. Supersedes the 2026-09-26 proportional co-pay of 1/4 of the event one-time tariff (docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md:29-33). Deploy not proven; see gaps[1].',
    },
    {
      ruleId: 'lk1:friendship-topokraty:game-6180-visit-90-min',
      productId: 'lk1:friendship-topokraty',
      ruleGroup: 'time_duration',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value: {
        freeVisitMinutes: 90,
        longerGame: 'day bucket first, minutes above it charged at court-hour copay',
      },
      unit: 'MINUTES',
      period: 'DAY',
      exceptions: [
        'with no free visit the whole game is the full one-time price and no visit is consumed',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '75-83',
          quote:
            'const TOPOKRATY_GAME_DIRECTION_IDS = [6180]; const TOPOKRATY_GAME_FREE_VISIT_MINUTES = 90;',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '243-278',
          quote:
            'const freeVisitAvailable = !aboveActiveLimit && used < rule.freeGameMinutesPerDay; ... } else if (duration <= TOPOKRATY_GAME_FREE_VISIT_MINUTES) { ... subscriptionVisitCount = 1',
        },
        {
          path: 'docs/LK1_TOPOKRATY_COURT_HOURLY_COPAY_20261005.md',
          lines: '17-19',
          quote:
            'Направление клуба `6180` «Топократы игра» использует ту же модель для платной части: игра до лимита бесплатного визита (90 минут) бесплатна',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'One visit covers a whole game of up to 90 minutes, so its free minutes can exceed the 60-minute day bucket; the gateway audits this exception (gateway.js:932-938).',
    },
    {
      ruleId: 'lk1:friendship-topokraty:club-only-on-6180-6233',
      productId: 'lk1:friendship-topokraty',
      ruleGroup: 'stations_exceptions',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value:
        'only the club product may use a subscription on directions 6180/6233; any other subscription is refused',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: ['one-off payment stays available for those directions'],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-25',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway_hooks.js',
          lines: '313-324',
          quote:
            'return finishError(ctx, 409, "На занятия Топократов общие подписки не действуют: доступна разовая оплата или клубная подписка «Дружба Топократы»", { code: "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE" });',
        },
        {
          path: 'docs/LK1_TOPOKRATY_REJECTION_RECLAIM_20260925.md',
          lines: '28-38',
          quote:
            '**Исключение Топократов.** Направления **6180** «Топократы игра» и **6233** «Топократы тренировка» вне всех не-клубных подписок: `409 TOPOKRATY_SUBSCRIPTION_UNAVAILABLE`',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'The exclusion is applied before any subscription decision and before the money readback. Deploy not proven; see gaps[1].',
    },
    {
      ruleId: 'lk1:ra:standard-five-numbers-and-free-first-event',
      productId: 'lk1:ra',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'ra',
        enforceFrom: '2026-09-01',
        maxActiveBookings: 4,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
        freeFirstEvent: ['group_training', 'tournament'],
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'the first covered event of the local day is free (one visit) while usedEventsToday==0, visitsLeft>=1 and activeCount<cap',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '31',
          quote: "rule('b91e14d1-fe6e-4d0b-be39-3e45ad86b759', 'ra'),",
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '19-28',
          quote:
            '"b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '365-380',
          quote:
            'freeFirstCovered = !aboveActiveLimit && freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Owner decision 2026-09-16 extended the free-first cohort to РА/Академия and their promo variants (gateway.js:26-27).',
    },
    {
      ruleId: 'lk1:academy:standard-five-numbers-and-free-first-group',
      productId: 'lk1:academy',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'academy',
        enforceFrom: '2026-09-01',
        maxActiveBookings: 4,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
        freeFirstEvent: ['group_training'],
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: ['tournament is not part of the free-first cohort (discount only)'],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '33',
          quote: "rule('9eb8a7a4-c195-492a-95e4-3fb82899ac10', 'academy'),",
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '23-24',
          quote:
            '"9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]), "6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:sport:standard-five-numbers',
      productId: 'lk1:sport',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'sport',
        enforceFrom: '2026-09-01',
        maxActiveBookings: 4,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
        freeFirstEvent: null,
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '34',
          quote: "rule('82caad6f-4d19-4d01-852b-932bdbb0f405', 'sport'),",
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '19-28',
          quote: 'const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({ ... }); // no sport entry',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Sport is absent from LK1_FREE_FIRST_EVENT_PRODUCTS (gateway.js:19-28), so group/tournament bookings are always a 50% monetary discount with zero visit debit. Sport is retired from every public storefront sales entry point but remains valid for existing subscriptions (src/utils/tournamentSubscriptionCatalog.ts:7-9).',
    },
    {
      ruleId: 'lk1:promo-ra:standard-and-free-first',
      productId: 'lk1:promo-ra',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'promo_ra',
        enforceFrom: '2026-09-01',
        fiveNumbers: 'standard 4/60/30/50/50',
        freeFirstEvent: ['group_training', 'tournament'],
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '37',
          quote: "rule('3b4806f1-6f9a-46df-a7d7-45075b4e7274', 'promo_ra'),",
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '21-22',
          quote: '// РА and Академия, including their promo variants (owner decision 2026-09-16).',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:promo-academy:standard-and-free-first-group',
      productId: 'lk1:promo-academy',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'promo_academy',
        enforceFrom: '2026-09-01',
        fiveNumbers: 'standard 4/60/30/50/50',
        freeFirstEvent: ['group_training'],
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '35',
          quote: "rule('6bda152b-0a9c-4308-82d0-3cd4e6aa680d', 'promo_academy'),",
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '24',
          quote: '"6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:promo-friendship:standard-five-numbers',
      productId: 'lk1:promo-friendship',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'promo_friendship',
        enforceFrom: '2026-09-01',
        fiveNumbers: 'standard 4/60/30/50/50',
        freeFirstEvent: null,
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRulesTransition.mjs',
          lines: '36',
          quote: "rule('c079dc82-c716-4f0e-b9ad-6aab62fb789e', 'promo_friendship'),",
        },
        {
          path: 'docs/LK1_STATION_EXCLUSIONS_20260918.md',
          lines: '35-37',
          quote: 'Годовой ХАБ и промо-«Дружба» в исключение **не** входят',
        },
      ],
      confidence: 'CONFIRMED',
      notes: '',
    },
    {
      ruleId: 'lk1:energy5:no-active-booking-limit',
      productId: 'lk1:energy5',
      ruleGroup: 'active_future_bookings',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: 'no active-bookings limit (product has no plan rule)',
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [],
      onViolation: 'UNKNOWN',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md',
          lines: '5-7',
          quote:
            'Абонемент «Энергия 5» не получает нового ограничения: прежнего лимита активных записей у него нет.',
        },
        {
          path: 'scripts/tests/fixtures/lk1PlanRules/products.js',
          lines: '21-24',
          quote:
            "export const UNKNOWN_PRODUCTS = Object.freeze([ { key: 'energy5', productId: 'dfa72adf-233b-4285-8d69-e5eab4234fbe', label: 'Энергия-5' },",
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        "Products without a plan rule keep the untouched legacy path (lk1PlanRules.mjs:224-226; resolver comment 'No rule selected product: untouched legacy behaviour').",
    },
    {
      ruleId: 'lk1:energy5:visit-payment-for-pro-training',
      productId: 'lk1:energy5',
      ruleGroup: 'availability',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value:
        '«Энергия 5»/«Энергия 25» with a positive visit balance may pay for a ПРО training by a visit (legacy visit path); all other subscriptions are refused',
      unit: 'VISIT',
      period: 'NONE',
      exceptions: ['a zero-balance energy pack is refused', 'promo codes keep their separate path'],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-22',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_PRO_TRAINING_EXCLUSIONS_20260918.md',
          lines: '9-12',
          quote:
            'Если у клиента есть доступный owned-пакет **«Энергия 5»** или **«Энергия 25»** с остатком посещений, `/group` показывает кнопку списания посещения; сервер проводит её по legacy visit-пути.',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway_hooks.js',
          lines: '305-308',
          quote:
            'const proTrainingEnergyAllowed = selectedOwned.length === 1 && isProTrainingEnergyPack(selectedOwned[0]);',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        "Status follows the source and the 2026-09-22 policy note; the 2026-09-18 generation's apply is not documented, so the live visibility of this path is UNKNOWN.",
    },
    {
      ruleId: 'lk1:pro-training-service:subscription-cover-exclusion',
      productId: 'lk1:pro-training-service',
      ruleGroup: 'availability',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value:
        'ПРО trainings (directions 5502-5507 + standalone «ПРО» token) are outside Дружба/Спорт/Топократы/Энергия-турниры; only РА/Академия(with promo) with the 50% rule, one-off payment, or Энергия 5/25 visit pack',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'a rule whose discount is not exactly 50% does not grant the ПРО discount (2026-10-02)',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-18',
      effectiveTo: null,
      status: 'UNKNOWN',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway_hooks.js',
          lines: '356-362',
          quote:
            'return finishError(ctx, 409, "На ПРО-тренировки доступна скидка 50% по РА или Академии, разовая оплата или Энергия 5/25", { code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE" });',
        },
        {
          path: 'docs/LK1_PRO_TRAINING_EXCLUSIONS_20260918.md',
          lines: '167-168',
          quote:
            'Изменения внесены в **source** Node-RED; живой флоу на `147` не читался и не менялся, деплой не выполнялся.',
        },
        {
          path: 'docs/LK1_PRO_TRAINING_DISCOUNT_20261002.md',
          lines: '3-8',
          quote:
            '«РА» и «Академия», включая существующие промо-варианты этих продуктов, дают скидку 50% ... Посещение не списывается.',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        'Two generations exist: full exclusion (2026-09-18) and 50% for РА/Академия (2026-10-02). Source carries the newer combined form; no deploy receipt proves which body runs in production. See gaps[1].',
    },
    {
      ruleId: 'lk1:pro-training-service:no-free-first-event',
      productId: 'lk1:pro-training-service',
      ruleGroup: 'usage_limits',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value:
        'a ПРО training never consumes and never receives the free-first-event entitlement; a paid ПРО training does not spend the right for the next ordinary event',
      unit: 'DAY_BENEFIT',
      period: 'DAY',
      exceptions: [],
      onViolation: 'DENY_BENEFIT_ALLOW_DISCOUNTED_PRICE',
      effectiveFrom: '2026-10-02',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/LK1_PRO_TRAINING_DISCOUNT_20261002.md',
          lines: '6-8',
          quote:
            'При разовом тарифе 5 500 ₽ клиент платит 2 750 ₽. Посещение не списывается. Первое бесплатное событие дня на ПРО не распространяется',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '880-888',
          quote:
            'if (category === "group_training" && [5502, 5503, 5504, 5505, 5506, 5507].includes(Number(directionId))) return false;',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'The gateway excludes those directions from the free-first-event cohort, and the day counter also ignores proTraining operations (gateway.js:887 and 949).',
    },
    {
      ruleId: 'lk1:piter-annual:managed-contour-off',
      productId: 'lk1:piter-annual',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value:
        'managed CUP enforcement requires the exact product UUID inside subscriptions_managed_enforcement_product_ids; absent/empty global enables no managed product',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'product is 8bf334ba-3050-4017-b40a-7eef2db1eb16 only',
        'purchaseDate(Europe/Moscow) must be >= 2026-09-01, else the ordinary Friendship compatibility path',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_FULL_PRICE',
      effectiveFrom: '2026-08-28',
      effectiveTo: null,
      status: 'DISABLED',
      evidence: [
        {
          path: 'docs/LK1_PITER_MANAGED_ENFORCEMENT_GATE_20260828.md',
          lines: '13-26',
          quote:
            'Missing, null, blank, or empty configuration is safe and enables no managed product. ... PITER product `8bf334ba-…` enters the managed CUP path only when ...',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '127-130',
          quote:
            'Код маршрута готов, но использование остаётся выключенным до отдельного этапа ... До этого `usageEnabled=false` и запросы завершаются fail closed.',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '899-902',
          quote:
            'if (["piter_friendship", "network_friendship"].includes(planKey)) return "friendship";',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Until the allowlist is set, a Piter instance is treated as planKey friendship (compatibilityPlanKey) and its contour verdict comes from the plan-rules resolver, which has no rule for 8bf334ba -> legacy path.',
    },
    {
      ruleId: 'lk1:piter-annual:target-usage-contract',
      productId: 'lk1:piter-annual',
      ruleGroup: 'usage_limits',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value: {
        oneFree60MinuteCreateOrJoinPerLocalDay: true,
        durations90_120: '30% off the full server price (no free hour + overpay)',
        dailyUsageLimit: 1,
      },
      unit: 'VISIT',
      period: 'DAY',
      exceptions: [
        'a 90/120 paid discounted operation does not consume the free 60-minute bucket',
        'a second 60-minute subscription operation the same day is blocked (no 30% substitution)',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/PITER_SUBSCRIPTION_CONTRACT.md',
          lines: '273-293',
          quote:
            'одна 60-минутная операция `CREATE_GAME` или `JOIN_GAME` в локальный день бесплатна ... длительностью 90 или 120 минут получают скидку 30% от полной подтверждённой сервером цены события',
        },
        {
          path: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md',
          lines: '537-542',
          quote:
            'the PITER policy effective for sales from `2026-09-01` does not use them: 60 minutes are free once per local day, while 90/120 minutes receive a 30% discount',
        },
        {
          path: 'scripts/managed_subscription_dev_runtime.ts',
          lines: '356-380',
          quote:
            'dailyUsageLimit: 1, dailyUsagePolicy: { actions: ["CREATE_GAME", "JOIN_GAME"], limitExceeded: "PERCENT_DISCOUNT", percentage: 30, usageDurationsMinutes: [60], discountDurationsMinutes: [90, 120] }',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Target contract only: the CUP policy is DRAFT (no published policyVersion, no provider mappings), and the LK1 managed branch is off. The compatible LK-side check requires dailyUsageLimit==1 and usageUnitsByDuration 1/1/1 (router:2149-2190).',
    },
    {
      ruleId: 'lk1:piter-annual:station-and-structural-limits',
      productId: 'lk1:piter-annual',
      ruleGroup: 'stations_exceptions',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        stationAccessRules:
          'single STATION_LIST rule with station 1ea77cbf-bc36-49a1-96d6-f35c216a409b and surcharge NONE',
        deviation: 'MANAGED_SUBSCRIPTION_POLICY_UNSUPPORTED',
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '2155-2179',
          quote:
            'rule.selector?.kind === "STATION_LIST" && ... normalizeId(rule.selector.stationIds[0]) === normalizeId(PITER_STATION_ID) && rule.surcharge?.kind === "NONE"',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '43-46',
          quote: '| Питер | `STATION_LIST` | `1ea77cbf-bc36-49a1-96d6-f35c216a409b` |',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'This is a structure check on the CUP policy, not live station enforcement; the non-zero-surcharge and multi-station forms are refused with a 409 rather than applied.',
    },
    {
      ruleId: 'lk1:piter-annual:lifecycle-first-use-or-2026-10-01',
      productId: 'lk1:piter-annual',
      ruleGroup: 'time_duration',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'NEW',
      value: {
        activationMode: 'FIRST_USE_OR_FIXED_DATE',
        activationWindowDays: 0,
        fixedActivationAt: '2026-09-30T21:00:00.000Z',
        validityDays: 365,
        allowBookingsAfterExpiry: false,
      },
      unit: 'COUNT',
      period: 'VALIDITY',
      exceptions: [
        'a missing provider read-back at the deadline keeps the instance PENDING_ACTIVATION',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-08-27',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '27-35',
          quote:
            'экземпляр подписки начинает 365-дневный срок при первой подтверждённой записи по подписке; если такой записи нет, он автоматически активируется `2026-10-01T00:00:00+03:00`',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '193-198',
          quote:
            'Автоматическая активация 1 октября реализована отдельным выключенным по умолчанию воркером ЦУП.',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '17-20',
          quote:
            'const REGIONAL_ACTIVATION_MODE = "FIRST_USE_OR_FIXED_DATE"; const REGIONAL_ACTIVATION_FALLBACK_AT = "2026-09-30T21:00:00.000Z"; const REGIONAL_VALIDITY_DAYS = 365;',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'The fixed-date worker is off by default and the guard only checks policy structure. Conflicts with the next-day activation contract of 2026-09-09 (conflicts[4]). Unit is a count of validity days.',
    },
    {
      ruleId: 'lk1:piter-annual:sale-batches-4x100',
      productId: 'lk1:piter-annual',
      ruleGroup: 'availability',
      service: 'ADD_ON',
      action: 'PURCHASE_ADD_ON_PRODUCT',
      appliesTo: 'NEW',
      value: {
        totalLimit: 400,
        batchSize: 100,
        pricesMinor: [1980000, 2380000, 3680000, 5680000],
        saleReadiness: 'exact product binding + atomic ledger sentinel',
      },
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [
        'a missing active-batch product id returns bindingReady=false and no payment',
        'before sentinel activation sales stay fail closed',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/PITER_SUBSCRIPTION_CONTRACT.md',
          lines: '235-239',
          quote:
            '- общий объём: 400 подписок; - одна партия: 100 подписок; - партии и цены: 1 — 19 800 ₽, 2 — 23 800 ₽, 3 — 36 800 ₽, 4 — 56 800 ₽;',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '57-61',
          quote:
            '| `piter_friendship` | `piter_friendship_12m_2026_v1` | 4 × 100 | `1980000`, `2380000`, `3680000`, `5680000` |',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Ledger activation is a separate live step; the 2026-09-09 opening plan wants to start at 48 of the first 100 (docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md:13-27).',
    },
    {
      ruleId: 'lk1:kotelniki:blocked',
      productId: 'lk1:kotelniki',
      ruleGroup: 'availability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: 'MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED (409) before any Viva mutation',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: ['one-off payment remains available'],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '1875-1881',
          quote:
            'return finishError(ctx, 409, "Подписка Котельников ещё не подключена к правилам записи", { code: "MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED", planKey: ctx.planKey });',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '86-92',
          quote: '| `kotelniki_friendship` | — | fail closed |',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'No Viva product id is bound for Kotelniki, so no subscription purchase is possible (bindingReady=false, canPurchase=false).',
    },
    {
      ruleId: 'lk1:patriots:friendship-parity-five-numbers',
      productId: 'lk1:patriots',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'friendship',
        enforceFrom: '2026-09-01',
        maxActiveBookings: 8,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'no free-first-event entry (Patriots stays out of LK1_FREE_FIRST_EVENT_PRODUCTS)',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-10-21',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md',
          lines: '11-32',
          quote:
            'Новый композитор ... копирует правило **из установленного flow**, заменяя только `productId` ... `maxActiveBookings` | 8',
        },
        {
          path: 'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md',
          lines: '5-9',
          quote:
            'Подготовка этого кандидата не выполняет merge, import/restart, изменение globals, записи, покупки или публикацию Tilda.',
        },
      ],
      confidence: 'PARTIAL',
      notes: '11th rule, added by the guarded writer on top of the installed ten (docs line 56).',
    },
    {
      ruleId: 'lk1:patriots:direction-scoped-discounts',
      productId: 'lk1:patriots',
      ruleGroup: 'player_admission',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        GAME: ['6181/2349', '4588/1613'],
        GROUP_TRAINING: ['6307/2349'],
        TOURNAMENT: ['6306/2349', '5278/839'],
        outsideScope: 'EVENT_NOT_INCLUDED',
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        '5278/839 gets a monetary discount only; it is outside the Viva visit-redemption scope',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-10-21',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '84-92',
          quote:
            'const PATRIOTS_DISCOUNT_EVENTS = Object.freeze({ GAME: ["viva:direction:6181:type:2349", "viva:direction:4588:type:1613"], GROUP_TRAINING: ["viva:direction:6307:type:2349"], TOURNAMENT: ["viva:direction:6306:type:2349", "viva:direction:5278:type:839"] });',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '202-207',
          quote:
            'block("EVENT_NOT_INCLUDED", "Направление или тип события не входит в скидку Патриотов")',
        },
        {
          path: 'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md',
          lines: '27-32',
          quote:
            'Тренировки и турниры получают 50% без нового бесплатного визита ... Неизвестная дата покупки и неподтверждённые владение/срок/заморозка дают отказ.',
        },
      ],
      confidence: 'PARTIAL',
      notes: 'Visit redemption is replaced by a monetary discount (evaluator.js:350-358).',
    },
    {
      ruleId: 'lk1:patriots:zero-checkout-closed',
      productId: 'lk1:patriots',
      ruleGroup: 'availability',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value:
        'product scope lacks direction 5278 while parsePatriotsProductPrice requires it -> zero-tariff checkout stays fail closed',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-09-30',
      effectiveTo: null,
      status: 'UNKNOWN',
      evidence: [
        {
          path: 'docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md',
          lines: '20',
          quote:
            'живая область «Дружбы.Патриоты» — направления `[4588, 6181, 6306, 6307]`, типы `[1613, 2349]`, тогда как `parsePatriotsProductPrice` требует направления `[6181, 6306, 6307, 5278]` ... zero-checkout Патриотов сейчас закрыт fail closed',
        },
        {
          path: 'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md',
          lines: '87-100',
          quote:
            'Отсутствие 5278/839 в visit scope продукта Viva сохраняется: речь о денежной скидке, а не о списании посещения.',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        'No new evidence that the Viva product card was changed; treat as still closed until re-read.',
    },
    {
      ruleId: 'lk1:pulkovo:friendship-parity-five-numbers',
      productId: 'lk1:pulkovo',
      ruleGroup: 'subscription_applicability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        planKey: 'friendship',
        enforceFrom: '2026-09-01',
        maxActiveBookings: 8,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'purchases before 2026-09-01 keep legacy behaviour',
        'an unresolvable purchase date is refused',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-10-16',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '14-24',
          quote:
            'Копируется **установленное**, а не историческое source-правило обычной «Дружбы» ... | `maxActiveBookings` | 8 |',
        },
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '8',
          quote:
            'На этапе подготовки production не изменяется; включение, restart и merge не выполнены.',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Direction routing for the product: 6182/2349 -> game, 6246/2349 -> tournament (doc lines 46-47).',
    },
    {
      ruleId: 'lk1:pulkovo:direction-routing',
      productId: 'lk1:pulkovo',
      ruleGroup: 'player_admission',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        GAME: ['6182/2349'],
        TOURNAMENT: ['6246/2349'],
        GROUP_TRAINING: 'not extended',
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-10-16',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '43-48',
          quote:
            'В обоих роутерах UUID-only продукт распознаётся как `friendship`; `6182/2349` — игра, `6246/2349` — турнир. Остальные corporate-направления не расширяются.',
        },
        {
          path: 'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md',
          lines: '10-12',
          quote: 'Пулково — 30 дней/30 посещений, направления 4588, 6182, 6246; типы 1613, 2349.',
        },
      ],
      confidence: 'PARTIAL',
      notes: '',
    },
    {
      ruleId: 'lk1:friendship-30d:sirius-station-exclusion',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'stations_exceptions',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value: {
        stationId: '233c1405-1eac-40de-8ec6-1cf7e24c9276',
        productIds: ['b2e6a9d4-53b5-4f79-87ec-3fb076381e9b'],
        verdict: 'legacy',
      },
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [
        'the exclusion only downgrades an already-covered pair; a product without a rule stays untouched',
        'an unreadable exclusion global fails closed; an absent one excludes nothing',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_FULL_PRICE',
      effectiveFrom: '2026-09-18',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '123-166',
          quote:
            'export function normalizeStationExclusions(value) ... function lk1StationLegacy(stationId, productId, configured)',
        },
        {
          path: 'docs/LK1_STATION_EXCLUSIONS_20260918.md',
          lines: '27-37',
          quote:
            'Исключение **по станции**: пара «станция Сириус × продукт Лето.Падел.Дружба» остаётся на legacy-пути',
        },
        {
          path: 'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md',
          lines: '3-5',
          quote:
            'Дневные минуты, скидки, дата продажи `2026-09-01`, исключения станций и учёт выбранного экземпляра подписки сохраняются.',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'IMPLEMENTED_CODE plus a 2026-10-05 statement that station exclusions are part of the live contour. The 2026-09-18 apply was gated on explicit authorization and no deploy receipt was found — see gaps[1].',
    },
    {
      ruleId: 'lk1:friendship-30d:all-stations-otherwise',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'stations_exceptions',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value:
        'no per-product station allow-list: the plan rule applies on every station except a configured exclusion',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: ['Сириус pair excluded'],
      onViolation: 'UNKNOWN',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md',
          lines: '155-159',
          quote:
            '**Скоуп продукта.** Правило продукта не ограничено станцией: пока у подписки нет станционных исключений, она даёт стандартные льготы «Дружбы» на любых станциях',
        },
        {
          path: 'scripts/lib/lk1PlanRules.mjs',
          lines: '1-12',
          quote:
            '// Station exclusions: named `stationId` x `productId` pairs stay on the legacy path',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'No stationAccessRules are enforced by the LK1 contour; station restrictions exist only in the unpublished CUP policy.',
    },
    {
      ruleId: 'lk1:hub-annual:stations-25-exact-set',
      productId: 'lk1:hub-annual',
      ruleGroup: 'stations_exceptions',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'BOTH',
      value:
        'exact reviewed set of 25 Viva station ids, order-insensitive; ALL_STATIONS / missing / extra id blocks until a new policy version',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '47-53',
          quote:
            'ЛК принимает только точное множество из 25 reviewed station ID независимо от порядка; отсутствующий или добавленный ID блокирует действие до новой policy version.',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '20-21',
          quote: 'HUB v1 использует устаревший `ALL_STATIONS` и не подлежит публикации.',
        },
      ],
      confidence: 'PARTIAL',
      notes: 'CUP policy is DRAFT; the set is not enforced in production.',
    },
    {
      ruleId: 'lk1:friendship-30d:legacy-cohort-tournament-covered-by-visit',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'payment_cancel',
      service: 'TOURNAMENT',
      action: 'BOOK_TOURNAMENT',
      appliesTo: 'BOTH',
      value:
        'legacy cohort (purchase before 2026-09-01): a tournament is allowed by the plan and consumed the shared daily visit with no surcharge',
      unit: 'VISIT',
      period: 'DAY',
      exceptions: [
        'only the pre-cutoff cohort and station-excluded pairs; the enforced cohort pays 50% with no visit',
      ],
      onViolation: 'DENY_BENEFIT_ALLOW_FULL_PRICE',
      effectiveFrom: null,
      effectiveTo: '2026-09-01',
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_STATION_EXCLUSIONS_20260918.md',
          lines: '21-25',
          quote:
            'В legacy-таблице `PLAN_CATEGORIES` для `friendship` разрешены `open_game` и `tournament`, то есть до контура турнир по этой подписке проходил со списанием посещения и без доплаты.',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
          lines: '937-947',
          quote: 'const PLAN_CATEGORIES = { friendship: ["open_game", "tournament"], ... };',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        "This is why the Sirius pair needed an exclusion: switching the pair to the enforced contour made an already-free tournament cost 50% (docs/LK1_STATION_EXCLUSIONS_20260918.md:5-16). Marketed as 'participation in ПадлхАБ tournaments' on the Sirius plan card.",
    },
    {
      ruleId: 'lk1:friendship-30d:paid-join-on-place',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'payment_cancel',
      service: 'GAME',
      action: 'JOIN_GAME',
      appliesTo: 'BOTH',
      value:
        'positive final price -> one ON_PLACE booking without clientSubscriptionId/count + existing SERVICE discount transaction; fully free JOIN keeps SUBSCRIPTION/count=1 without a transaction',
      unit: 'RUB_MINOR',
      period: 'NONE',
      exceptions: [
        'ON_PLACE does not physically debit a Viva visit; a visit job performs the -1 after confirmation',
        'ambiguous outcomes stay PENDING_CONFIRMATION with no second booking or checkout',
      ],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: '2026-09-09',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/SUBSCRIPTION_PAID_JOIN_FIX_20260909.md',
          lines: '26-35',
          quote:
            'For JOIN_GAME with a positive authoritative final price, create one ON_PLACE booking without clientSubscriptionId/count, then reuse the existing SERVICE serializer, discount, transaction CAS and exact transaction readback.',
        },
        {
          path: 'docs/SUBSCRIPTION_VISIT_LIFECYCLE_20260909.md',
          lines: '11-20',
          quote:
            'JOIN с положительной доплатой создаёт одну запись ON_PLACE ... Отдельная запись SUBSCRIPTION для списания не создаётся.',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'HAR case: base 1125 RUB, 90 minutes, 60 free, 30 paid, final 262.50 RUB with a SERVICE discount of 973750 against the 1000000 carrier.',
    },
    {
      ruleId: 'lk1:friendship-30d:visit-debit-and-return',
      productId: 'lk1:friendship-30d',
      ruleGroup: 'payment_cancel',
      service: 'GAME',
      action: 'CANCEL',
      appliesTo: 'EXISTING',
      value: {
        debit: 'PUT /clients/{id}/subscriptions/{id}/limit {"type":"BY_VISITS","value":-1}',
        return: 'same URL with value:1',
        acceptance: 'HTTP 200 with both counters moved by exactly ±1 on the same instance',
      },
      unit: 'VISIT',
      period: 'NONE',
      exceptions: [
        'a lost/ambiguous response keeps SENT/UNKNOWN for manual reconciliation; no automatic retry',
        'an explicit staff NO_RETURN keeps the visit and the reservation',
      ],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: '2026-09-09',
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/SUBSCRIPTION_VISIT_LIFECYCLE_20260909.md',
          lines: '42-60',
          quote:
            'PUT /api/v1/clients/{clientId}/subscriptions/{clientSubscriptionId}/limit ... {"type":"BY_VISITS","value":-1}',
        },
        {
          path: 'docs/SUBSCRIPTION_VISIT_LIFECYCLE_20260909.md',
          lines: '22-27',
          quote:
            '`split_leave` после подтверждённой отмены сохраняет обратное задание ... worker возвращает посещение через +1 на тот же экземпляр.',
        },
        {
          path: 'docs/SUBSCRIPTION_VISIT_LIFECYCLE_20260909.md',
          lines: '29-35',
          quote: 'Явный staff `NO_RETURN` сохраняет посещение и резерв',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Worker activation on the server is not set up (docs line 141); local evidence includes one physical MongoDB run with 8 parallel workers.',
    },
    {
      ruleId: 'lk1:any:provider-rejection-reclaim',
      productId: 'lk1:friendship-topokraty',
      ruleGroup: 'payment_cancel',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'EXISTING',
      value: {
        reclaim: 'terminal 4xx rejection with no booking returns the operation to PREPARED via CAS',
        attemptCap: 5,
      },
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [
        '5xx/transport/unknown status, an accepted booking, a money leg, a visitJob or a checkout are never replayed',
        'split_create_readonly_preflight never writes',
      ],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: '2026-09-25',
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/LK1_TOPOKRATY_REJECTION_RECLAIM_20260925.md',
          lines: '39-50',
          quote:
            'Reclaim терминально отказанной операции ... Решение принимает `lk1ReclaimableAttempt(operation)`; кап — 5 попыток',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/gateway.js',
          lines: '312-313',
          quote:
            'const LK1_RECLAIM_ATTEMPT_CAP = 5; const lk1ReclaimableAttempt = (operation) => {',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Attached to the club product only because that is where the incident is documented; the mechanism itself is product-agnostic (all LK1 operations).',
    },
    {
      ruleId: 'lk1:any:no-show-is-authoritative-only',
      productId: 'lk1:hub-annual',
      ruleGroup: 'payment_cancel',
      service: 'ANY',
      action: 'NO_SHOW',
      appliesTo: 'EXISTING',
      value:
        'no-show may consume an entitlement, charge a fee, add a strike or temporarily block bookings only from authoritative Viva attendance/status evidence with read-back and audit; noShowBlockedUntil is stored null',
      unit: 'BOOLEAN',
      period: 'NONE',
      exceptions: ['LK must never infer a no-show from elapsed time or one missing response'],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md',
          lines: '604-613',
          quote:
            'These semantics are intentionally not implemented by this evaluator until a sanitized Golden HAR confirms the provider contract: ... late cancellation/no-show provider writes',
        },
        {
          path: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md',
          lines: '615-625',
          quote:
            'The LK must never infer a no-show merely because time passed ... `noShowBlockedUntil` can be set only from authoritative Viva attendance/status evidence',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js',
          lines: '139-147',
          quote:
            'if (noShowBlockedUntil && noShowBlockedUntil.getTime() > evaluatedAt.getTime()) { block(...)',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'The read side exists in the CUP evaluator (instance.noShowBlockedUntil), the write side does not exist anywhere in the repo.',
    },
    {
      ruleId: 'lk1:any:unpaid-event-booking-cancellation',
      productId: 'lk1:hub-annual',
      ruleGroup: 'payment_cancel',
      service: 'ANY',
      action: 'CANCEL',
      appliesTo: 'EXISTING',
      value: {
        scope:
          'new LK1 group/tournament bookings with durable SMS checkout, positive amount, subscriptionVisitCount=0, ON_PLACE carrier',
        conditions:
          'fresh transaction exactly UNPAID, paymentDueDate >= 60s past, createDate >= 26min past, no paid/refund evidence, event not started',
      },
      unit: 'BOOLEAN',
      period: 'NONE',
      exceptions: [
        'events that consumed a subscription visit are excluded (separate return-of-visit design)',
        'WAITING/PAID/unknown statuses never cancel',
      ],
      onViolation: 'REQUIRES_CHECK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/LK1_UNPAID_BOOKING_CANCELLATION.md',
          lines: '47-49',
          quote:
            'The systemd rate limit bounds rapid retries. Its [systemd unit](../scripts/lk1_unpaid_cancel_service/lk1-unpaid-cancel.service) defaults to `OFF`;',
        },
        {
          path: 'docs/LK1_UNPAID_BOOKING_CANCELLATION.md',
          lines: '47-49',
          quote:
            'The systemd rate limit bounds rapid retries. Its [systemd unit](../scripts/lk1_unpaid_cancel_service/lk1-unpaid-cancel.service) defaults to `OFF`;',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Attached to HUB only as a representative product; the rule is a cross-product worker. Service unit defaults to OFF, so live effect is UNKNOWN.',
    },
    {
      ruleId: 'lk1:any:active-service-limit-falls-back-to-full-price',
      productId: 'lk1:hub-annual',
      ruleGroup: 'availability',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'NEW',
      value:
        'sole blocker ACTIVE_SERVICES_LIMIT_REACHED switches the split flow to an ordinary ON_PLACE booking at full price without deleting the created game',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: ['any other blocker stays fail closed and does not fall back'],
      onViolation: 'DENY_BENEFIT_ALLOW_FULL_PRICE',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '99-108',
          quote:
            'только sole blocker `ACTIVE_SERVICES_LIMIT_REACHED` переводит split-flow на обычную запись `ON_PLACE` за полную стоимость без удаления уже созданной игры',
        },
        {
          path: 'scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js',
          lines: '299-303',
          quote:
            'block("ACTIVE_SERVICES_LIMIT_REACHED", "Достигнут лимит активных услуг по подписке", ...)',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Belongs to the CUP managed contour (off). In the LK1 contour exceeding maxActiveBookings never blocks the booking (evaluator.js:220-227).',
    },
    {
      ruleId: 'lk1:any:create-join-fail-closed-on-incomplete-decision',
      productId: 'lk1:hub-annual',
      ruleGroup: 'availability',
      service: 'ANY',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value:
        'unrecognised/incomplete server decision maps to a retryable technical error, never to a discount or a silent ordinary-payment fallback; malformed/insufficient evidence keeps the operation pending',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/LK1_SUBSCRIPTION_CRITICAL_MATRIX_20260831.md',
          lines: '6-14',
          quote:
            'an unrecognised or incomplete response maps to a retryable technical error and never to a subscription discount.',
        },
        {
          path: 'docs/LK1_SUBSCRIPTION_CRITICAL_MATRIX_20260831.md',
          lines: '261-270',
          quote:
            'INPUT: missing/invalid runtime decision, unknown response code or malformed body ... EXPECTED_DECISION: TECHNICAL_ERROR',
        },
        {
          path: 'scripts/nodered_lk1_hub_nodes/evaluator.js',
          lines: '537-548',
          quote:
            'finalPriceMinor: finalBeforeSurcharge === null ? (surchargeMinor || null) : finalBeforeSurcharge + surchargeMinor',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        "Fail-closed is the dominant contract across the contour; the doc's contract-level status is 'executable specification' but it matches the implemented codes.",
    },
    {
      ruleId: 'lk1:hub-annual:preview-is-advisory-only',
      productId: 'lk1:hub-annual',
      ruleGroup: 'usage_limits',
      service: 'ANY',
      action: 'ANY',
      appliesTo: 'NEW',
      value: {
        quoteTtlSeconds: 30,
        shareCounts: [2, 4],
        maxSubscriptionIds: 20,
        durationsMinutes: [60, 90, 120],
        noReservation: true,
      },
      unit: 'COUNT',
      period: 'NONE',
      exceptions: [
        'an expired or malformed response never becomes a displayed price',
        'CREATE submits only the selected clientSubscriptionId and the server rechecks',
      ],
      onViolation: 'UNKNOWN',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md',
          lines: '633-646',
          quote:
            '1–20 unique `subscriptionIds` ... `durationMinutes` 60/90/120, `shareCount` 2/4 ... A quote binds `selectionKey` ... and a 30-second expiry',
        },
        {
          path: 'scripts/nodered_subscription_price_preview_nodes/entry.js',
          lines: '15-32',
          quote:
            'ids.length < 1 || ids.length > 20 ... ![60, 90, 120].includes(target.durationMinutes) ... ![2, 4].includes(target.shareCount)',
        },
        {
          path: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md',
          lines: '665-668',
          quote:
            'Preview makes no reservation, booking, debit or payment; CREATE always rechecks current authoritative state.',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'The 30s cache applies to GAME tariff evidence; GT/T refetch the tariff (MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:205-206).',
    },
    {
      ruleId: 'lk1:summer-sale-counters:default-limits',
      productId: 'lk1:summer-sale-counters',
      ruleGroup: 'availability',
      service: 'ADD_ON',
      action: 'PURCHASE_ADD_ON_PRODUCT',
      appliesTo: 'NEW',
      value: {
        defaultTotalLimit: 100,
        maxTotalLimit: 1000,
        legacyDailyDropLimit: 5,
        networkFriendshipDailyDefault: 10,
      },
      unit: 'COUNT',
      period: 'DAY',
      exceptions: [
        'an absent/zero configured limit falls back to the default',
        'a paid+pending reservation consumes a daily seat until it expires',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js',
          lines: '39-54',
          quote:
            'const DEFAULT_TOTAL_LIMIT = 100; const MAX_TOTAL_LIMIT = 1000; ... const AB_LETO_DAILY_DROP_LIMIT = 5;',
        },
        {
          path: 'scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js',
          lines: '63-66',
          quote:
            'const NETWORK_FRIENDSHIP_DAILY_LIMIT_DEFAULT = (SALES_QUOTAS_20260909_ENABLED || subscriptionCounterEpoch.startedAt(global)) ? 1 : 10;',
        },
        {
          path: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md',
          lines: '63-69',
          quote:
            'Публичный status показывает не больше 10 доступных продаж за календарный день `Europe/Moscow`',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Sale-side counters, not service rules. The network daily window is only active with the exact boolean flag per the same doc.',
    },
    {
      ruleId: 'lk1:summer-sale-counters:staged-daily-seats',
      productId: 'lk1:summer-sale-counters',
      ruleGroup: 'availability',
      service: 'ADD_ON',
      action: 'PURCHASE_ADD_ON_PRODUCT',
      appliesTo: 'NEW',
      value: {
        launchLimit: 150,
        dailyLimit: {
          ra: 10,
          other: 7,
        },
      },
      unit: 'COUNT',
      period: 'DAY',
      exceptions: ['only for the new counter epoch (subscriptionCounterEpoch.isNew)'],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'CANDIDATE',
      evidence: [
        {
          path: 'scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js',
          lines: '52-54',
          quote:
            'const AB_LETO_STAGED_LAUNCH_LIMIT = 150; const AB_LETO_STAGED_DAILY_DROP_LIMIT = 7; const AB_LETO_STAGED_RA_DAILY_DROP_LIMIT = 10;',
        },
        {
          path: 'scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js',
          lines: '273-276',
          quote:
            'launchLimit: AB_LETO_STAGED_LAUNCH_LIMIT, dailyLimit: counterKey === "ra" ? 10 : 7',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'The 2026-09-09 approved quotas (РА +10/day, Дружба 7/day, ХАБ 1/day & 100 total, Питер 48 of 100) are gated by summer_subscription_sales_20260909_enabled and were not activated (docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md:60-67).',
    },
    {
      ruleId: 'lk1:summer-sale-counters:promo-offers',
      productId: 'lk1:summer-sale-counters',
      ruleGroup: 'availability',
      service: 'ADD_ON',
      action: 'PURCHASE_ADD_ON_PRODUCT',
      appliesTo: 'NEW',
      value: {
        offers: {
          'friendship-promo': 490000,
          'academy-promo': 1190000,
          'ra-promo': 1190000,
        },
        validityDays: 30,
        'sport-promo': 'retired',
      },
      unit: 'RUB_MINOR',
      period: 'NONE',
      exceptions: [
        'empty/unknown/retired or conflicting offer shows an error and never falls back to the ordinary tariff',
        'the offer parameter does not prove geographic or personal eligibility',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'src/utils/tournamentSubscriptionCatalog.ts',
          lines: '11-36',
          quote:
            '"friendship-promo": { ... priceMinor: 490000, productId: "c079dc82-…" }, "academy-promo": { ... 1190000, "6bda152b-…" }, "ra-promo": { ... 1190000, "3b4806f1-…" }',
        },
        {
          path: 'docs/SUBSCRIPTION_STOREFRONT_PROMOS.md',
          lines: '11-21',
          quote:
            'Пустой, неизвестный, снятый с продажи `sport-promo` или конфликтующий параметр показывает ошибку без покупки обычного тарифа ... Каждая ссылка показывает одну карточку ... на 30 дней',
        },
      ],
      confidence: 'CONFIRMED',
      notes:
        'Browser marker blocks a second purchase of the same promo in the same browser until manual reconciliation (docs line 41-49).',
    },
    {
      ruleId: 'lk1:trial-group-service:visit-limit-0-2',
      productId: 'lk1:trial-group-service',
      ruleGroup: 'player_admission',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'NEW',
      value: {
        allowedConfirmedVisits: '0, 1 or 2',
        window:
          'previous 6 calendar months before server request time (Europe/Moscow, end-of-month clamped)',
        violation: '409 TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED',
      },
      unit: 'COUNT',
      period: 'MONTH',
      exceptions: [
        'all categories and studios count, not just trial trainings',
        'an unverified history closes admission',
        'attendance must be explicitly confirmed; PAID/COMPLETED/REFUNDED alone do not count',
      ],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-10-02',
      effectiveTo: null,
      status: 'DISABLED',
      evidence: [
        {
          path: 'docs/LK1_TRIAL_GROUP_ELIGIBILITY_20261002.md',
          lines: '5-19',
          quote:
            'Запись разрешена при 0, 1 или 2 подтверждённых посещениях занятий в сети за шесть календарных месяцев ... При 3 и более посещениях сервер возвращает 409 / `TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED`',
        },
        {
          path: 'docs/LK1_TRIAL_GROUP_ELIGIBILITY_20261002.md',
          lines: '93-99',
          quote:
            'Node-RED global `trial_group_visit_policy`: {"mode":"off", ...} ... Отсутствие значения также означает off и disabled.',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Service admission rule (not a subscription entitlement). Default is off/disabled; the frontend flag VITE_TRIAL_GROUP_CHECKOUT_ENABLED defaults to false.',
    },
    {
      ruleId: 'lk1:any:ariadna-6538-no-subscription-discount',
      productId: 'lk1:academy',
      ruleGroup: 'stations_exceptions',
      service: 'GROUP_TRAINING',
      action: 'BOOK_GROUP_TRAINING',
      appliesTo: 'BOTH',
      value:
        'direction 6538 (guest-coach training with Ariadna) keeps the full one-time price; owned visit packs and promo codes keep their own checkout paths',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'DENY_BENEFIT_ALLOW_FULL_PRICE',
      effectiveFrom: null,
      effectiveTo: null,
      status: 'ACTIVE',
      evidence: [
        {
          path: 'src/utils/groupSubscriptionDiscount.ts',
          lines: '184-190',
          quote:
            '// Guest-coach training with Ariadna: the one-time tariff has no subscription discount. ... if (directionId === 6538) return null;',
        },
        {
          path: 'src/components/group-schedule/GroupSchedulePage.tsx',
          lines: '777',
          quote: '&& selectedTraining?.directionId !== 6538',
        },
      ],
      confidence: 'PARTIAL',
      notes:
        'Client-side only: no server-side direction-6538 rule was found, so a direct API call still receives a server quote. See gaps[6].',
    },
    {
      ruleId: 'lk1:any:enforcement-requires-free-entitlement-for-create-join',
      productId: 'lk1:hub-annual',
      ruleGroup: 'availability',
      service: 'GAME',
      action: 'CREATE_GAME',
      appliesTo: 'BOTH',
      value:
        'CREATE_GAME and JOIN_GAME require a FREE_ENTITLEMENT decision in the 2026-08-26 enforcement contour; price-bearing benefits are rejected there',
      unit: 'ENUM',
      period: 'NONE',
      exceptions: [],
      onViolation: 'BLOCK',
      effectiveFrom: '2026-08-26',
      effectiveTo: '2026-09-09',
      status: 'DISABLED',
      evidence: [
        {
          path: 'docs/LK1_SUBSCRIPTION_ENFORCEMENT_20260826.md',
          lines: '71-72',
          quote:
            '`CREATE_GAME` and `JOIN_GAME` require `FREE_ENTITLEMENT`; price-bearing or absent benefits are rejected.',
        },
        {
          path: 'docs/SUBSCRIPTION_PAID_JOIN_FIX_20260909.md',
          lines: '26-32',
          quote:
            'For JOIN_GAME with a positive authoritative final price, create one ON_PLACE booking',
        },
      ],
      confidence: 'AMBIGUOUS',
      notes:
        'Historical invariant superseded by the paid-JOIN correction; kept because the 2026-08-26 document is still cited as the write-path inventory. See conflicts[7].',
    },
  ],
  conflicts: [
    {
      topic: 'Active-bookings cap: 4 vs 6 vs 8',
      sources: [
        'scripts/lib/lk1PlanRulesTransition.mjs:21 (maxActiveBookings: 4)',
        'scripts/lib/lk1ActiveBookingLimit.mjs:6-10 (ACTIVE_BOOKING_LIMIT = 8, HUB prior 4)',
        'scripts/lib/lk1PlanRulesTransition.mjs:66 (friendship_two_hours maxActiveBookings: 6)',
        'docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md:9-10 (not merged/deployed)',
        'docs/LK1_PULKOVO_FRIENDSHIP_20261016.md:20 (installed friendship rule = 8)',
        'docs/LK1_PATRIOTS_FRIENDSHIP_20261021.md:18 (installed friendship rule = 8)',
        "src/components/subscription-storefront/presentation.ts:23 ('До 8 активных записей')",
      ],
      description:
        'Repo source constants still carry 4 (and 6 for «Дружба 2 часа»), and the 2026-10-05 decision document explicitly says the 4→8 generation was only prepared. Two later documents of 2026-10-16 and 2026-10-21 read the *installed* flow and report 8, and the shipped storefront copy says 8. No deploy receipt for the 8-limit was found. Treat the live value as 8 with low confidence until a fresh read-only global/quote readback is done.',
    },
    {
      topic: 'Piter active-services limit and the fifth booking',
      sources: [
        'docs/PITER_SUBSCRIPTION_CONTRACT.md:289 (не более 8 активных записей)',
        "docs/PITER_SUBSCRIPTION_CONTRACT.md:325 ('Пятая активная запись | отказ по active-services limit')",
        'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md:219-220 (четвёртая разрешена, пятая уходит только в full-price path)',
        'scripts/lib/lk1PlanRulesTransition.mjs:21 (maxActiveBookings 4)',
      ],
      description:
        "The same Piter contract states both an 8-active-booking cap and a rejection at the fifth active booking; the regional bindings doc says the fourth is still allowed and the fifth only loses the benefit (full price, not a refusal). The LK1 evaluator never refuses a booking above the cap, so the 'отказ' wording is either legacy or wrong.",
    },
    {
      topic: 'Booking window: absent in the LK1 contour but documented as 14 days',
      sources: [
        'docs/PITER_SUBSCRIPTION_CONTRACT.md:290-291 (14 локальных дней)',
        'scripts/managed_subscription_dev_runtime.ts:365 (bookingWindow { enabled: true, days: 14 })',
        'scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js:246-258 (BOOKING_WINDOW_EXCEEDED)',
        'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:405 (example policy: days: 4)',
        'scripts/tests/managedSubscriptionDevRuntime.test.ts:40 (4-day fixture)',
      ],
      description:
        'The 14-day station-local window exists only in the DRAFT CUP policy and in the CUP evaluator, which the LK1 booking gateway does not run. The 4-day value in the contract examples is illustrative, not a product rule. No horizon is enforced for subscriptions in the LK1 contour today.',
    },
    {
      topic: 'Piter 90/120-minute pricing model',
      sources: [
        'docs/PITER_SUBSCRIPTION_CONTRACT.md:279-285 (30% off the full price, not free hour + overpay)',
        'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:132-138 (free minutes + partial-price percentage calculator)',
        'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:537-542 (PITER policy does not use partial-price rules)',
      ],
      description:
        "Two different mental models coexist in the same contract family: a free-minute bucket with proportional overpay (generic evaluator) and a flat 30% off the whole event price for 90/120 minutes (Piter). The Piter document wins for Piter, but any tool that reuses the generic 'first hour free' model will misprice Piter.",
    },
    {
      topic: 'Piter/HUB lifecycle: 1 October fixed activation vs next-day activation',
      sources: [
        'docs/REGIONAL_SUBSCRIPTION_LIFECYCLE_CORRECTION.md:10-14, 34-53 (activationDays=0, no earlier than 2026-10-01, validity 365/visits 365)',
        'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md:27-35 (FIRST_USE_OR_FIXED_DATE, fixed 2026-09-30T21:00Z)',
        'docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md:43-52 (activationDays 365 → 1 on both provider cards, next-day activation)',
        "docs/SUBSCRIPTION_SALE_QUOTAS_20260909.md:62-70 (VIVA_NEXT_DAY_V1 / LK1_VIVA_PRODUCT_NEXT_DAY_V1, 'without the old October cutoff')",
      ],
      description:
        'The August lifecycle guard requires the provider card to project activation no earlier than 2026-10-01; the September sale opening changed activationDays to 1 and introduced a next-day activation mode that explicitly drops the October cutoff. The current provider card state (activationDays=1) would fail the August guard. This is a real product decision conflict that affects the purchase preflight and the CUP instance lifecycle.',
    },
    {
      topic: 'Visit units: 1 visit for any covered game vs 2 visits for 90+ minutes',
      sources: [
        'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:132-138 (any positive free-minute portion consumes exactly one visit)',
        'scripts/nodered_lk1_hub_nodes/evaluator.js:294 (subscriptionVisitCount = freeMinutes > 0 ? 1 : 0)',
        'scripts/nodered_games_nodes/fn_split_router.js:232-237 (durationMinutes >= 90 ? 2 : 1)',
        'docs/SUBSCRIPTION_JOIN_PRICE_PREVIEW_2026-09-09.md:9 (legacy two-visit filter no longer hides one-visit annual subscriptions)',
      ],
      description:
        'The split router still has a legacy fallback that computes 2 visits for a 90+ minute game when the explicit count is absent, while the LK1 contour always spends exactly one visit. Any path that omits subscriptionVisitCount inherits the legacy 2-visit rule, so the same 90-minute game can cost one or two visits depending on the caller.',
    },
    {
      topic: '«Дружба» daily-seat categories: server vs client',
      sources: [
        'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js:937-947 (friendship: ["open_game","tournament"])',
        'src/utils/subscriptionCategoryDailyLimit.ts:55-56 (friendship: [OPEN_GAME] only)',
        'src/utils/subscriptionCategoryDailyLimit.ts:60-62 (sport: [open_game, tournament])',
      ],
      description:
        'The server treats a tournament as consuming the daily seat for «Дружба» (and for «Спорт»), while the client copy for «Дружба» lists only open games and for «Спорт» lists tournaments too. A same-day friendship tournament can therefore be refused by the server with SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED while the widget predicted it as allowed (or vice versa for sport).',
    },
    {
      topic: 'CREATE/JOIN must be free vs paid JOIN with surcharge',
      sources: [
        'docs/LK1_SUBSCRIPTION_ENFORCEMENT_20260826.md:71-72 (CREATE_GAME and JOIN_GAME require FREE_ENTITLEMENT; price-bearing benefits are rejected)',
        'docs/SUBSCRIPTION_PAID_JOIN_FIX_20260909.md:26-35 (ON_PLACE booking + SERVICE discount transaction)',
        'scripts/nodered_lk1_hub_nodes/evaluator.js:280-307 (partial-price overage is a normal ACTIVE branch)',
      ],
      description:
        'The August enforcement document declares that only free entitlements may serve CREATE/JOIN; since 2026-09-09 mixed free/paid and fully paid JOINs are supported and priced. The August invariant is still cited as the current write-path inventory in that document, so readers may take a superseded rule for the current one.',
    },
    {
      topic: "Marketing copy '1 hour per day' vs runtime coverage",
      sources: [
        "src/components/subscription-storefront/presentation.ts:37-51 (fullBenefits: '1 час в день на выбор' including игра+тренер, групповые, «Время на друзей», турниры)",
        'scripts/nodered_lk1_hub_nodes/gateway.js:19-31 (free-first-event cohort: only РА/Академия/promos and «Дружба 2 часа»/5278)',
        "src/components/subscription-storefront/presentation.ts:27-35 (friendshipBenefits: '1 час в день' + 30/50 discounts)",
      ],
      description:
        "The storefront presents 'one hour per day of your choice' for РА and lists formats (coach game, group, friends-time, tournaments). Runtime: РА does carry a free first group/tournament event per day, but the 'hour' unit is a visit for the day's first covered event, not a 60-minute slice of any format. For «Дружба»/ХАБ in the enforced cohort, group training and tournaments are always a 50% monetary discount with no visit; only the legacy cohort (purchase before 2026-09-01) and station-excluded pairs keep a visit-covered tournament.",
    },
  ],
  gaps: [
    {
      topic: 'No deploy receipts for several generations',
      why: "docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md, LK1_STATION_EXCLUSIONS_20260918.md, LK1_PRO_TRAINING_EXCLUSIONS_20260918.md and LK1_PRO_TRAINING_DISCOUNT_20261002.md, LK1_TOPOKRATY_* and LK1_PULKOVO/PATRIOTS all end at 'apply requires explicit authorization'; only «Дружба 2 часа» (2026-09-30) and the 2026-09-15 plan-rules release have live application records. The live state of the 8-limit, Sirius exclusion, PRO guard, Topokraty club co-pay and the Pulkovo/Patriots rules must be established by a read-only global/quote readback, not by these documents.",
    },
    {
      topic: 'CUP managed policy is DRAFT and unpublished',
      why: 'docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md:16-35 records that both Piter and HUB types and v1 policies are DRAFT with no publications, provider mappings or SubscriptionInstances; docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:5-118 states no rule/subscription/booking/payment was activated. Every CUP-side rule (14-day window, station sets, dailyUsageLimit, partial-price, weekly/monthly caps, station surcharges, no-show extensions, activation capabilities, active-services refusal) therefore has no production evidence and no policyVersion to cite.',
    },
    {
      topic: 'Managed-contour allowlist state unknown',
      why: 'subscriptions_managed_enforcement_product_ids is absent by default (safe), but the repo cannot prove its current server value; the Piter managed branch, the 25-station HUB set and the CUP evaluator all depend on it. Same for subscriptions_lk1_plan_rules, subscriptions_lk1_product_policy, subscriptions_lk1_station_exclusions and subscriptions_lk1_hub_sale_runtime.',
    },
    {
      topic: 'No booking-horizon rule in the LK1 contour',
      why: 'The 14-day window is a CUP-policy field only; gateway.js, gateway_hooks.js and the preview router contain no window check. Any claim that subscriptions cannot book beyond 14 days is unproven for the live LK1 path.',
    },
    {
      topic: 'Station enforcement is structural only',
      why: 'The LK1 gateway passes the target station to the rule resolver (used only for station *exclusions*), while per-product allowed-station sets, station surcharges and the HUB 25-station set live in the unpublished CUP policy. There is no evidence that a HUB/Piter subscription is refused on a foreign station today.',
    },
    {
      topic: 'Ariadna direction 6538 is client-side only',
      why: 'Only src/utils/groupSubscriptionDiscount.ts:189 and GroupSchedulePage.tsx:777 suppress the subscription quote; no server-side rule for direction 6538 exists, so a direct API call still gets a server quote.',
    },
    {
      topic: 'Duration allow-list not enforced in the gateway',
      why: '60/90/120 is checked in the preview entry and in the CUP policy compatibility check, but the LK1 booking gateway prices whatever duration the server-resolved target carries. A non-standard duration would be metered by minutes rather than refused.',
    },
    {
      topic: 'Kotelniki has no product binding',
      why: 'No Viva product ID exists for kotelniki_friendship (docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md:86-92) and bookings return MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED; the intended rules cannot be inventoried.',
    },
    {
      topic: 'No implemented no-show, freeze, refund or late-cancellation provider semantics',
      why: 'docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md:602-613 lists visit debit/return counts, discount/fixed-price transactions, activation/freeze/unfreeze, late cancellation/no-show writes and refund/unpaid behavior as evidence-gated and unimplemented by the evaluator. Only the read side (frozenUntil, noShowBlockedUntil) exists.',
    },
    {
      topic: 'PARTNER_GAME_MEMBERSHIP_SOURCE_LIMITS is not a subscription rule',
      why: 'docs/PARTNER_GAME_MEMBERSHIP_SOURCE_LIMITS.md documents independent nginx IP rate/concurrency limits for the partner API (2r/s burst 10, 5r/s burst 20, 4/8 concurrent), not subscription entitlement; it was reviewed and deliberately not modelled as a product rule.',
    },
    {
      topic: 'Sale-side quotas vs service rules are conflated in the source docs',
      why: "The summer-subscription counters ('daily seats', 'total inventory', tier prices) describe purchasability of the subscription itself, while the same documents also describe usage rules. This inventory separates them (PURCHASE_ADD_ON_PRODUCT rules on lk1:summer-sale-counters, lk1:hub-annual, lk1:piter-annual) but the source wording does not always distinguish the two.",
    },
  ],
};
