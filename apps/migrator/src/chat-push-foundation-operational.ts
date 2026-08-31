export class ChatPushFoundationOperationalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChatPushFoundationOperationalError';
  }
}

function fail(code: string): never {
  throw new ChatPushFoundationOperationalError(code);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CHAT_PUSH_FOUNDATION_OPERATIONAL_INVENTORY_INVALID');
  }
  return value as Readonly<Record<string, unknown>>;
}

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) fail('CHAT_PUSH_FOUNDATION_OPERATIONAL_INVENTORY_INVALID');
  return value.map(record);
}

function argumentValue(value: unknown, key: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Readonly<Record<string, unknown>>)[key];
  }
  if (Array.isArray(value)) {
    for (const entryValue of value as unknown[]) {
      if (!Array.isArray(entryValue) || entryValue.length < 3 || entryValue[0] !== key) continue;
      const tupleValue: unknown = entryValue[2];
      return tupleValue;
    }
  }
  return undefined;
}

function argumentKeys(value: unknown): readonly string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => (Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : ''))
      .filter(Boolean)
      .sort();
  }
  return [];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertFoundationRabbitInventory(
  input: unknown,
  options: { readonly mode: 'optional' | 'required' | 'inert' },
): { readonly queueCount: number; readonly bindingCount: number } {
  const inventory = record(input);
  const queues = rows(inventory.queues);
  const bindings = rows(inventory.bindings);
  const legacyQueueNames = [
    'phub.dead-letter.v1',
    'phub.notification-intent-projector.v1',
  ] as const;
  const gameQueueName = 'phub.game-notification-intent-projector.v1' as const;
  const gameQueuePresent = queues.some((queue) => queue.name === gameQueueName);
  if (options.mode === 'optional' && gameQueuePresent) {
    fail('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_INVENTORY_MISMATCH');
  }
  const expectedQueueNames: readonly string[] =
    options.mode === 'optional' ? legacyQueueNames : [...legacyQueueNames, gameQueueName];
  const selectedQueues = queues.filter((queue) => expectedQueueNames.includes(String(queue.name)));
  if (selectedQueues.length === 0 && options.mode === 'optional') {
    return { queueCount: 0, bindingCount: 0 };
  }
  if (selectedQueues.length !== expectedQueueNames.length) {
    fail('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_INVENTORY_MISMATCH');
  }

  for (const name of expectedQueueNames) {
    const queue = selectedQueues.find((entry) => entry.name === name);
    if (!queue || queue.durable !== true || queue.type !== 'quorum') {
      fail('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_SHAPE_MISMATCH');
    }
    if (Number(queue.messages_ready) !== 0 || Number(queue.messages_unacknowledged) !== 0) {
      fail('CHAT_PUSH_FOUNDATION_RABBIT_BACKLOG_PRESENT');
    }
    const expectedArgumentKeys =
      name !== 'phub.dead-letter.v1'
        ? ['x-dead-letter-exchange', 'x-delivery-limit', 'x-queue-type']
        : ['x-queue-type'];
    if (!sameStrings(argumentKeys(queue.arguments), expectedArgumentKeys)) {
      fail('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_ARGUMENT_MISMATCH');
    }
    if (argumentValue(queue.arguments, 'x-queue-type') !== 'quorum') {
      fail('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_ARGUMENT_MISMATCH');
    }
    if (
      name !== 'phub.dead-letter.v1' &&
      (Number(argumentValue(queue.arguments, 'x-delivery-limit')) !== 5 ||
        argumentValue(queue.arguments, 'x-dead-letter-exchange') !== 'phub.dead-letter')
    ) {
      fail('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_ARGUMENT_MISMATCH');
    }
  }

  const selectedBindings = bindings.filter((binding) =>
    expectedQueueNames.includes(String(binding.destination_name)),
  );
  const bindingKeys = selectedBindings
    .map(
      (binding) =>
        `${String(binding.source_name)}\u0000${String(binding.destination_name)}\u0000${String(binding.destination_kind)}\u0000${String(binding.routing_key)}`,
    )
    .sort();
  const expectedBindingKeys = [
    '\u0000phub.dead-letter.v1\u0000queue\u0000phub.dead-letter.v1',
    '\u0000phub.notification-intent-projector.v1\u0000queue\u0000phub.notification-intent-projector.v1',
    'phub.dead-letter\u0000phub.dead-letter.v1\u0000queue\u0000#',
    'phub.events\u0000phub.notification-intent-projector.v1\u0000queue\u0000booking.cancelled.v1',
    'phub.events\u0000phub.notification-intent-projector.v1\u0000queue\u0000booking.changed.v1',
    'phub.events\u0000phub.notification-intent-projector.v1\u0000queue\u0000booking.confirmed.v1',
    'phub.events\u0000phub.notification-intent-projector.v1\u0000queue\u0000booking.reminder.due.v1',
    ...(options.mode !== 'optional'
      ? [
          '\u0000phub.game-notification-intent-projector.v1\u0000queue\u0000phub.game-notification-intent-projector.v1',
          ...(options.mode === 'required'
            ? [
                'phub.events\u0000phub.game-notification-intent-projector.v1\u0000queue\u0000game.cancelled.v1',
                'phub.events\u0000phub.game-notification-intent-projector.v1\u0000queue\u0000game.participation.confirmed.v1',
                'phub.events\u0000phub.game-notification-intent-projector.v1\u0000queue\u0000game.participation.left.v1',
              ]
            : []),
        ]
      : []),
  ].sort();
  if (!sameStrings(bindingKeys, expectedBindingKeys)) {
    fail('CHAT_PUSH_FOUNDATION_RABBIT_BINDING_MISMATCH');
  }
  return { queueCount: selectedQueues.length, bindingCount: selectedBindings.length };
}

export function assertFoundationPrometheusRules(
  input: unknown,
  options: { readonly nowMs: number; readonly maxAgeMs?: number },
): { readonly ruleCount: number } {
  const response = record(input);
  if (response.status !== 'success') fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RESPONSE_INVALID');
  const data = record(response.data);
  const groups = rows(data.groups);
  const required = new Map<
    string,
    { readonly query: string; readonly duration: number; readonly severity: string }
  >([
    [
      'PadlHubWebPushCircuitOpen',
      {
        query:
          'sum by (environment) (increase(phub_worker_web_push_provider_outcomes_total{outcome="WEB_PUSH_CIRCUIT_OPEN"}[5m])) > 0',
        duration: 60,
        severity: 'p1',
      },
    ],
    [
      'PadlHubBookingReminderDelayed',
      {
        query: 'phub_worker_notifications_booking_reminder_oldest_due_age_seconds > 60',
        duration: 120,
        severity: 'p2',
      },
    ],
  ]);
  const matched: Readonly<Record<string, unknown>>[] = [];
  for (const group of groups) {
    for (const rule of rows(group.rules)) {
      if (typeof rule.name === 'string' && required.has(rule.name)) matched.push(rule);
    }
  }
  if (matched.length !== required.size || new Set(matched.map((rule) => rule.name)).size !== 2) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_INVENTORY_MISMATCH');
  }
  const maxAgeMs = options.maxAgeMs ?? 120_000;
  for (const rule of matched) {
    const expected = typeof rule.name === 'string' ? required.get(rule.name) : undefined;
    const labels = record(rule.labels);
    if (
      !expected ||
      rule.type !== 'alerting' ||
      rule.query !== expected.query ||
      Number(rule.duration) !== expected.duration ||
      labels.severity !== expected.severity ||
      labels.component !== 'worker' ||
      Object.keys(labels).sort().join(',') !== 'component,severity' ||
      rule.state !== 'inactive' ||
      !Array.isArray(rule.alerts) ||
      rule.alerts.length !== 0
    ) {
      fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_SHAPE_MISMATCH');
    }
    if (rule.health !== 'ok' || (rule.lastError !== undefined && rule.lastError !== '')) {
      fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_UNHEALTHY');
    }
    const lastEvaluationMs =
      typeof rule.lastEvaluation === 'string' ? Date.parse(rule.lastEvaluation) : Number.NaN;
    if (
      !Number.isFinite(lastEvaluationMs) ||
      lastEvaluationMs > options.nowMs + 30_000 ||
      options.nowMs - lastEvaluationMs > maxAgeMs
    ) {
      fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_STALE');
    }
  }
  return { ruleCount: matched.length };
}

export function assertFoundationPrometheusTargets(
  input: unknown,
  options: { readonly nowMs: number; readonly maxAgeMs?: number },
): { readonly targetCount: number } {
  const response = record(input);
  if (response.status !== 'success') fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RESPONSE_INVALID');
  const data = record(response.data);
  const matchingTargets = rows(data.activeTargets).filter(
    (target) =>
      target.scrapePool === 'otel-collector' &&
      target.scrapeUrl === 'http://otel-collector:8889/metrics',
  );
  if (matchingTargets.length !== 1) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_TARGET_INVENTORY_MISMATCH');
  }
  const target = matchingTargets[0];
  if (
    !target ||
    target.health !== 'up' ||
    (target.lastError !== undefined && target.lastError !== '')
  ) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_TARGET_UNHEALTHY');
  }
  const lastScrapeMs =
    typeof target.lastScrape === 'string' ? Date.parse(target.lastScrape) : Number.NaN;
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  if (
    !Number.isFinite(lastScrapeMs) ||
    lastScrapeMs > options.nowMs + 30_000 ||
    options.nowMs - lastScrapeMs > maxAgeMs
  ) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_TARGET_STALE');
  }
  return { targetCount: matchingTargets.length };
}

function prometheusVectorValue(input: unknown): number {
  const response = record(input);
  if (response.status !== 'success') fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_RESPONSE_INVALID');
  const data = record(response.data);
  if (data.resultType !== 'vector') {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_SERIES_RESPONSE_INVALID');
  }
  const result = rows(data.result);
  if (result.length !== 1) fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_SERIES_MISSING');
  const sample = result[0]?.value;
  if (!Array.isArray(sample) || sample.length !== 2) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_SERIES_RESPONSE_INVALID');
  }
  const value = Number(sample[1]);
  if (!Number.isFinite(value)) fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_SERIES_RESPONSE_INVALID');
  return value;
}

export function assertFoundationPrometheusHeartbeat(
  input: unknown,
  options: {
    readonly nowMs: number;
    readonly minimumUnixTime: number;
    readonly maxAgeMs?: number;
  },
): { readonly heartbeatUnixTime: number } {
  const heartbeatUnixTime = prometheusVectorValue(input);
  const heartbeatMs = heartbeatUnixTime * 1_000;
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  if (
    !Number.isInteger(heartbeatUnixTime) ||
    heartbeatUnixTime < options.minimumUnixTime ||
    heartbeatMs > options.nowMs + 30_000 ||
    options.nowMs - heartbeatMs > maxAgeMs
  ) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_HEARTBEAT_STALE');
  }
  return { heartbeatUnixTime };
}

export function assertFoundationPrometheusCollectionSuccess(input: unknown): void {
  if (prometheusVectorValue(input) !== 1) {
    fail('CHAT_PUSH_FOUNDATION_PROMETHEUS_COLLECTION_FAILED');
  }
}

export function assertFoundationPrometheusGaugePresent(input: unknown): void {
  prometheusVectorValue(input);
}
