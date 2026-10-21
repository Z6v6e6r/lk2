// Pure preparation producer: no IO, CLI, native-format claim or activation fallback.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';

const TARGET = Object.freeze({ hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 });
const MONITORS = Object.freeze([
  {
    service: 'api',
    id: '26ed404e-98e5-45c5-98e3-31b9dfd6f0f2',
    name: 'lk2-beta-api-ready',
    url: 'https://lk2.padlhub.su/health/ready',
  },
  {
    service: 'web',
    id: 'b25e28a0-02d8-49e4-a0a1-f49f62abc02c',
    name: 'lk2-beta-web-root',
    url: 'https://lk2.padlhub.su/',
  },
]);
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const ID = /^[A-Za-z0-9_.:@+-]{1,160}$/u;
const TRUST = 'APPROVED_READER_HUMAN_REVIEW_V1';
const MAX_RAW = 2 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
const REVIEW_WINDOW_MS = 86400000;
const ROLES = Object.freeze([
  'panel-configuration',
  'direct-observation',
  'gmail-account',
  'owner-account',
  ...MONITORS.flatMap(({ service }) => [
    `${service}-trigger`,
    `${service}-recovery-start`,
    `${service}-owner-active`,
    ...['email', 'telegram'].flatMap((channel) =>
      ['alert', 'recovery'].map((event) => `${service}-${channel}-${event}`),
    ),
  ]),
]);

export class DirectRecipientEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DirectRecipientEvidenceError';
    this.code = code;
  }
}
function fail(code) {
  throw new DirectRecipientEvidenceError(code);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    fail('FIELDS');
}
function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    fail('TIME');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('TIME');
  return ms;
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(bytes, limit) {
  if (
    !(typeof bytes === 'string' || bytes instanceof Uint8Array) ||
    Buffer.byteLength(bytes) > limit
  )
    fail('SIZE');
  try {
    return parseStrictJson(bytes);
  } catch {
    fail('JSON');
  }
}
function identifier(value) {
  if (!ID.test(value ?? '')) fail('IDENTITY');
}
function noCredentials(bytes) {
  const value = Buffer.from(bytes).toString('utf8');
  if (
    /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=-]{8,}|(?:["']?(?:authorization|cookie|set-cookie|password|access_token|refresh_token)["']?\s*[:=])/iu.test(
      value,
    )
  )
    fail('CREDENTIAL_CAPTURE');
}
function roleKind(role) {
  if (role === 'direct-observation') return 'reviewed-direct-probe-observation';
  if (role === 'panel-configuration') return 'timeweb-panel';
  if (role.startsWith('gmail-search-') || role === 'gmail-account' || role.includes('-email-'))
    return 'gmail';
  if (role.includes('-telegram-') || role.endsWith('-owner-active') || role === 'owner-account')
    return 'telegram-desktop-export';
  return 'approved-operator-event-trace';
}
function binding(value) {
  exact(value, [
    'sourceSha',
    'sourceTree',
    'releaseId',
    'operationSha256',
    'contractSha256',
    'collectorSourceSha256',
  ]);
  if (
    !SHA.test(value.sourceSha ?? '') ||
    !SHA.test(value.sourceTree ?? '') ||
    !HASH.test(value.operationSha256 ?? '') ||
    !HASH.test(value.contractSha256 ?? '') ||
    !HASH.test(value.collectorSourceSha256 ?? '') ||
    !new RegExp(`^${value.sourceSha}-[1-9][0-9]*-1$`, 'u').test(value.releaseId ?? '')
  )
    fail('BINDING');
}

export function parseDirectRecipientPolicy(bytes) {
  const policy = json(bytes, 64 * 1024);
  exact(policy, [
    'schema',
    'state',
    'trust',
    'target',
    'binding',
    'nonce',
    'reader',
    'owner',
    'recipients',
    'configuration',
    'templates',
    'captureReviewSha256',
  ]);
  exact(policy.target, Object.keys(TARGET));
  if (
    policy.schema !== 'PHUB_TIMEWEB_DIRECT_RECIPIENT_POLICY_V1' ||
    policy.trust !== TRUST ||
    !same(policy.target, TARGET) ||
    !/^[a-f0-9]{32}$/u.test(policy.nonce ?? '')
  )
    fail('POLICY');
  if (
    !['UNENROLLED', 'REVIEWED_PRIVATE_INPUT'].includes(policy.state) ||
    (policy.state === 'UNENROLLED'
      ? policy.captureReviewSha256 !== null
      : !HASH.test(policy.captureReviewSha256 ?? ''))
  )
    fail('POLICY_STATE');
  if (policy.state === 'UNENROLLED') {
    if (policy.templates !== null) fail('POLICY_TEMPLATES');
  } else {
    exact(policy.templates, ['email', 'telegram']);
    for (const templates of Object.values(policy.templates)) {
      exact(templates, ['alert', 'recovery']);
      if (templates.alert === templates.recovery) fail('POLICY_TEMPLATES');
      for (const template of Object.values(templates)) {
        if (
          typeof template !== 'string' ||
          template.length > 16000 ||
          template.split('{{nonce}}').length !== 2 ||
          template.split('{{monitorName}}').length !== 2 ||
          template.split('{{monitorUrl}}').length > 2 ||
          /\{\{|\}\}/u.test(
            template
              .replaceAll('{{nonce}}', '')
              .replaceAll('{{monitorName}}', '')
              .replaceAll('{{monitorUrl}}', ''),
          )
        )
          fail('POLICY_TEMPLATES');
      }
    }
  }
  binding(policy.binding);
  identifier(policy.reader);
  exact(policy.owner, ['identity', 'role', 'account', 'peer']);
  identifier(policy.owner.identity);
  identifier(policy.owner.account);
  identifier(policy.owner.peer);
  if (policy.owner.role !== 'release-owner') fail('OWNER_ROLE');
  exact(policy.recipients, ['email', 'telegram']);
  exact(policy.recipients.email, ['account', 'sender']);
  exact(policy.recipients.telegram, ['account', 'sender', 'peer']);
  if (
    policy.owner.identity === policy.recipients.telegram.sender ||
    policy.owner.account !== policy.recipients.telegram.account
  )
    fail('OWNER_IDENTITY');
  for (const channel of Object.values(policy.recipients))
    for (const value of Object.values(channel)) identifier(value);
  exact(policy.configuration, ['monitors', 'deliveryChannels']);
  if (
    !same(policy.configuration.deliveryChannels, ['email', 'telegram']) ||
    !Array.isArray(policy.configuration.monitors) ||
    policy.configuration.monitors.length !== 2
  )
    fail('CONFIGURATION');
  policy.configuration.monitors.forEach((m, index) => {
    exact(m, [
      'id',
      'name',
      'url',
      'enabled',
      'method',
      'expectedStatus',
      'regions',
      'intervalSeconds',
      'timeoutSeconds',
      'authorizationHeaderConfigured',
    ]);
    const expected = MONITORS[index];
    if (
      m.id !== expected.id ||
      m.name !== expected.name ||
      m.url !== expected.url ||
      m.enabled !== true ||
      m.method !== 'GET' ||
      m.expectedStatus !== 200 ||
      m.intervalSeconds !== 60 ||
      m.timeoutSeconds !== 10 ||
      m.authorizationHeaderConfigured !== true ||
      !Array.isArray(m.regions) ||
      m.regions.length !== 2 ||
      new Set(m.regions).size !== 2 ||
      m.regions.some((region) => typeof region !== 'string' || !region.trim() || region.length > 80)
    )
      fail('CONFIGURATION');
  });
  noCredentials(bytes);
  return policy;
}

// The independent human review must pin this hash AND the policy hash outside this library.
// Hashes do not authenticate sources, an owner or the reader.
export function directRecipientCaptureReviewSha256(captures) {
  if (
    !Array.isArray(captures) ||
    captures.length < ROLES.length ||
    captures.length > ROLES.length + 20
  )
    fail('CAPTURE_COUNT');
  return hash(
    Buffer.from(
      JSON.stringify(
        [...captures].sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
      ),
    ),
  );
}
function parseCaptures(bundle, files, policy, now) {
  if (
    !(files instanceof Map) ||
    !Array.isArray(bundle.captures) ||
    bundle.captures.length < ROLES.length + 1 ||
    bundle.captures.length > ROLES.length + 20
  )
    fail('CAPTURE_COUNT');
  const captures = new Map();
  const calls = new Map();
  let total = 0;
  for (const c of bundle.captures) {
    exact(c, [
      'role',
      'kind',
      'toolVersion',
      'callId',
      'reader',
      'capturedAt',
      'rawFile',
      'rawSize',
      'rawSha256',
      'assertion',
    ]);
    if (
      !(ROLES.includes(c.role) || /^gmail-search-([1-9]|1[0-9]|20)$/u.test(c.role)) ||
      captures.has(c.role) ||
      c.kind !== roleKind(c.role) ||
      c.reader !== policy.reader ||
      typeof c.toolVersion !== 'string' ||
      !c.toolVersion.trim() ||
      c.toolVersion.length > 80 ||
      c.rawFile !== `raw/${c.role}.bin` ||
      !Number.isSafeInteger(c.rawSize) ||
      c.rawSize < 1 ||
      c.rawSize > MAX_RAW ||
      !HASH.test(c.rawSha256 ?? '')
    )
      fail('CAPTURE');
    identifier(c.callId);
    // Export roles may reference one original multi-message export/call. Other calls are unique.
    const call = {
      kind: c.kind,
      toolVersion: c.toolVersion,
      capturedAt: c.capturedAt,
      rawSize: c.rawSize,
      rawSha256: c.rawSha256,
    };
    if (
      calls.has(c.callId) &&
      (c.kind !== 'telegram-desktop-export' || !same(calls.get(c.callId), call))
    )
      fail('CALL_REUSE');
    calls.set(c.callId, call);
    const capturedAt = time(c.capturedAt);
    if (capturedAt > now || now - capturedAt > REVIEW_WINDOW_MS) fail('CAPTURE_AGE');
    const raw = files.get(c.rawFile);
    if (!(raw instanceof Uint8Array) || raw.byteLength !== c.rawSize || hash(raw) !== c.rawSha256)
      fail('RAW_HASH');
    noCredentials(raw);
    total += raw.byteLength;
    if (total > MAX_TOTAL) fail('TOTAL_SIZE');
    captures.set(c.role, { ...c, raw });
  }
  if (
    files.size !== captures.size ||
    [...files.keys()].some((key) => ![...captures.values()].some((c) => c.rawFile === key)) ||
    ROLES.some((role) => !captures.has(role))
  )
    fail('CLOSURE');
  if (directRecipientCaptureReviewSha256(bundle.captures) !== policy.captureReviewSha256)
    fail('REVIEW_HASH');
  return captures;
}
function message(c, policy, monitor, event, channel, seen) {
  const a = c.assertion;
  exact(a, [
    'source',
    'immutableId',
    'account',
    'sender',
    'peer',
    'recordedAt',
    'monitorId',
    'event',
    'text',
  ]);
  const expected = channel === 'owner' ? policy.owner : policy.recipients[channel];
  const sender = channel === 'owner' ? expected.identity : expected.sender;
  if (
    a.source !== TRUST ||
    a.account !== expected.account ||
    a.sender !== sender ||
    a.peer !== (expected.peer ?? null) ||
    a.monitorId !== monitor.id ||
    a.event !== event
  )
    fail('MESSAGE_IDENTITY');
  identifier(a.immutableId);
  const identity = JSON.stringify([channel, a.account, a.peer, a.immutableId]);
  if (seen.has(identity)) fail('MESSAGE_REUSE');
  seen.add(identity);
  const recorded = time(a.recordedAt);
  const observed = time(c.capturedAt);
  if (recorded > observed) fail('MESSAGE_TIME');
  if (
    typeof a.text !== 'string' ||
    a.text.length > 16000 ||
    a.text.split(policy.nonce).length !== 2 ||
    !a.text.includes(monitor.name)
  )
    fail('CORRELATION_CAPABILITY_UNPROVEN');
  if (channel !== 'owner') {
    const template = policy.templates[channel][event.toLowerCase()];
    const text = template
      .replaceAll('{{nonce}}', policy.nonce)
      .replaceAll('{{monitorName}}', monitor.name)
      .replaceAll('{{monitorUrl}}', monitor.url);
    if (a.text !== text) fail('MESSAGE_TEMPLATE');
  }
  if (
    event === 'OWNER_ACTIVE' &&
    a.text !==
      `Наблюдаю активный сбой ${monitor.name}; операция ${policy.binding.operationSha256}; nonce ${policy.nonce}`
  )
    fail('OWNER_OBSERVATION');
  return {
    recorded,
    observed,
    channel: channel === 'owner' ? null : channel,
    sourceIdentitySha256: hash(Buffer.from(identity)),
    rawSha256: c.rawSha256,
  };
}
function eventAnchor(c, policy, monitor, event) {
  exact(c.assertion, ['source', 'monitorId', 'event', 'operationSha256', 'nonce', 'at']);
  const a = c.assertion;
  if (
    a.source !== 'APPROVED_OPERATOR_TRANSITION_LOWER_BOUND_V1' ||
    a.monitorId !== monitor.id ||
    a.event !== event ||
    a.operationSha256 !== policy.binding.operationSha256 ||
    a.nonce !== policy.nonce
  )
    fail('EVENT_ANCHOR');
  const at = time(a.at);
  if (at > time(c.capturedAt)) fail('EVENT_ANCHOR_TIME');
  return at;
}
function observation(c, policy, now, lastRecovery) {
  exact(c.assertion, ['source', 'trust', 'target', 'binding', 'nonce']);
  if (
    c.assertion.source !== 'REVIEWED_DIRECT_PROBE_OBSERVATION' ||
    c.assertion.trust !== TRUST ||
    !same(c.assertion.target, TARGET) ||
    !same(c.assertion.binding, policy.binding) ||
    c.assertion.nonce !== policy.nonce
  )
    fail('OBSERVATION_SOURCE');
  const o = json(c.raw, MAX_RAW);
  exact(o, ['schema', 'startedAt', 'completedAt', 'samples']);
  const start = time(o.startedAt);
  const end = time(o.completedAt);
  if (
    o.schema !== 'PHUB_TIMEWEB_CRITICAL_WEB_OBSERVATION_V1' ||
    end - start < 900000 ||
    end - start > 1200000 ||
    start < lastRecovery ||
    end > time(c.capturedAt) ||
    now - end > REVIEW_WINDOW_MS ||
    !Array.isArray(o.samples) ||
    o.samples.length !== 61
  )
    fail('OBSERVATION_WINDOW');
  let previous;
  const keys = ['api_private', 'api_public', 'web_private', 'web_public'];
  for (const sample of o.samples) {
    exact(sample, ['observedAt', ...keys]);
    const at = time(sample.observedAt);
    if (
      at < start ||
      at > end ||
      (previous !== undefined && (at <= previous || at - previous > 20000))
    )
      fail('OBSERVATION_CADENCE');
    previous = at;
    for (const key of keys)
      if (!Number.isFinite(sample[key]) || sample[key] < 0) fail('OBSERVATION_PROBE');
  }
  if (
    time(o.samples[0].observedAt) !== start ||
    time(o.samples.at(-1).observedAt) > end ||
    time(o.samples.at(-1).observedAt) - start < 900000
  )
    fail('OBSERVATION_CADENCE');
  for (const key of keys) {
    const values = o.samples.map((s) => s[key]).sort((a, b) => a - b);
    if (values[Math.ceil(values.length * 0.95) - 1] > (key.startsWith('api') ? 1500 : 1000))
      fail('OBSERVATION_P95');
  }
  return {
    source: 'reviewed-direct-probe-observation',
    trust: TRUST,
    assertedCollectorSourceSha256: policy.binding.collectorSourceSha256,
    startedAt: o.startedAt,
    completedAt: o.completedAt,
    rounds: 61,
    requestsPerService: 122,
    rawSha256: c.rawSha256,
  };
}

/** Only a trusted caller supplies expected hashes after independent review. No enrollment/writer. */
export function buildDirectRecipientEvidence(input) {
  exact(input, ['policyBytes', 'bundleBytes', 'files', 'expected', 'observedAt']);
  const { policyBytes, bundleBytes, files, expected, observedAt } = input;
  exact(expected, ['policySha256', 'binding', 'nonce', 'reader']);
  binding(expected.binding);
  if (!HASH.test(expected.policySha256 ?? '') || hash(policyBytes) !== expected.policySha256)
    fail('POLICY_PIN');
  const policy = parseDirectRecipientPolicy(policyBytes);
  const now = time(observedAt);
  if (
    !same(policy.binding, expected.binding) ||
    policy.nonce !== expected.nonce ||
    policy.reader !== expected.reader
  )
    fail('EXPECTED_BINDING');
  if (policy.state !== 'REVIEWED_PRIVATE_INPUT') fail('CORRELATION_CAPABILITY_UNPROVEN');
  const bundle = json(bundleBytes, 512 * 1024);
  exact(bundle, [
    'schema',
    'target',
    'policySha256',
    'operationSha256',
    'nonce',
    'reader',
    'captures',
    'gmailSearch',
  ]);
  if (
    bundle.schema !== 'PHUB_TIMEWEB_DIRECT_RECIPIENT_CAPTURE_V1' ||
    !same(bundle.target, TARGET) ||
    bundle.policySha256 !== expected.policySha256 ||
    bundle.operationSha256 !== policy.binding.operationSha256 ||
    bundle.nonce !== policy.nonce ||
    bundle.reader !== policy.reader
  )
    fail('BUNDLE_BINDING');
  const captures = parseCaptures(bundle, files, policy, now);
  const config = captures.get('panel-configuration');
  exact(config.assertion, ['source', 'configurationSha256']);
  if (
    config.assertion.source !== 'OPERATOR_ATTESTED_PANEL_CONFIGURATION' ||
    config.assertion.configurationSha256 !==
      hash(Buffer.from(JSON.stringify(policy.configuration))) ||
    now - time(config.capturedAt) > REVIEW_WINDOW_MS
  )
    fail('CONFIGURATION_OBSERVATION');
  const account = captures.get('gmail-account');
  exact(account.assertion, ['source', 'account']);
  if (
    account.assertion.source !== TRUST ||
    account.assertion.account !== policy.recipients.email.account
  )
    fail('GMAIL_ACCOUNT');
  const ownerAccount = captures.get('owner-account');
  exact(ownerAccount.assertion, ['source', 'account', 'peer', 'identity']);
  if (
    ownerAccount.assertion.source !== TRUST ||
    ownerAccount.assertion.account !== policy.owner.account ||
    ownerAccount.assertion.peer !== policy.owner.peer ||
    ownerAccount.assertion.identity !== policy.owner.identity
  )
    fail('OWNER_ACCOUNT');
  exact(bundle.gmailSearch, ['query', 'windowEndAt', 'pageRoles']);
  const searchEnd = time(bundle.gmailSearch.windowEndAt);
  if (searchEnd > now) fail('SEARCH_WINDOW');
  const firstTrigger = Math.min(
    ...MONITORS.map((m) => time(captures.get(`${m.service}-trigger`).assertion.at)),
  );
  const searchQuery = `after:${Math.floor(firstTrigger / 1000) - 1} before:${Math.floor(searchEnd / 1000) + 1} in:anywhere "${policy.nonce}"`;
  if (
    typeof bundle.gmailSearch.query !== 'string' ||
    bundle.gmailSearch.query !== searchQuery ||
    !Array.isArray(bundle.gmailSearch.pageRoles) ||
    bundle.gmailSearch.pageRoles.length < 1 ||
    bundle.gmailSearch.pageRoles.length > 20
  )
    fail('SEARCH');
  const ids = new Set();
  let token = null;
  bundle.gmailSearch.pageRoles.forEach((role, index) => {
    if (role !== `gmail-search-${index + 1}`) fail('SEARCH_PAGES');
    const c = captures.get(role);
    if (!c) fail('SEARCH_PAGES');
    exact(c.assertion, ['source', 'query', 'requestToken', 'nextPageToken', 'messageIds']);
    const a = c.assertion;
    if (time(c.capturedAt) < searchEnd) fail('SEARCH_WINDOW');
    if (
      a.source !== TRUST ||
      a.query !== bundle.gmailSearch.query ||
      a.requestToken !== token ||
      !Array.isArray(a.messageIds) ||
      a.messageIds.length > 100 ||
      (a.nextPageToken !== null &&
        (typeof a.nextPageToken !== 'string' ||
          !a.nextPageToken ||
          a.nextPageToken.length > 1024)) ||
      (index === bundle.gmailSearch.pageRoles.length - 1
        ? a.nextPageToken !== null
        : a.nextPageToken === null)
    )
      fail('SEARCH_CLOSURE');
    for (const id of a.messageIds) {
      identifier(id);
      if (ids.has(id)) fail('SEARCH_DUPLICATE');
      ids.add(id);
    }
    token = a.nextPageToken;
  });
  if (
    [...captures.keys()].filter((role) => role.startsWith('gmail-search-')).length !==
    bundle.gmailSearch.pageRoles.length
  )
    fail('SEARCH_CLOSURE');
  const seen = new Set();
  let lastRecovery = 0;
  const cycles = [];
  for (const monitor of MONITORS) {
    const trigger = eventAnchor(
      captures.get(`${monitor.service}-trigger`),
      policy,
      monitor,
      'TRIGGER',
    );
    const recovery = eventAnchor(
      captures.get(`${monitor.service}-recovery-start`),
      policy,
      monitor,
      'RECOVERY_START',
    );
    if (now - trigger > 86400000 || trigger > recovery || recovery > now) fail('CYCLE_TIME');
    const alert = ['email', 'telegram'].map((channel) =>
      message(
        captures.get(`${monitor.service}-${channel}-alert`),
        policy,
        monitor,
        'ALERT',
        channel,
        seen,
      ),
    );
    const recovered = ['email', 'telegram'].map((channel) =>
      message(
        captures.get(`${monitor.service}-${channel}-recovery`),
        policy,
        monitor,
        'RECOVERY',
        channel,
        seen,
      ),
    );
    const owner = message(
      captures.get(`${monitor.service}-owner-active`),
      policy,
      monitor,
      'OWNER_ACTIVE',
      'owner',
      seen,
    );
    for (const d of alert)
      if (d.recorded < trigger || d.observed - trigger > 300000) fail('ALERT_DEADLINE');
    if (
      owner.recorded < Math.max(...alert.map((d) => d.observed)) ||
      owner.recorded - trigger > 600000 ||
      owner.recorded >= recovery
    )
      fail('OWNER_ACTIVE_ORDER');
    for (const d of recovered)
      if (d.recorded < recovery || d.observed - recovery > 300000) fail('RECOVERY_DEADLINE');
    for (const d of [...alert, ...recovered]) if (d.observed > searchEnd) fail('SEARCH_WINDOW');
    for (const event of ['alert', 'recovery'])
      if (!ids.delete(captures.get(`${monitor.service}-email-${event}`).assertion.immutableId))
        fail('SEARCH_MESSAGE');
    lastRecovery = Math.max(lastRecovery, recovery, ...recovered.map((d) => d.observed));
    cycles.push({
      monitorId: monitor.id,
      triggerLowerBoundAt: new Date(trigger).toISOString(),
      recoveryLowerBoundAt: new Date(recovery).toISOString(),
      alerts: alert.map((d) => ({
        channel: d.channel,
        observedBy: new Date(d.observed).toISOString(),
        sourceIdentitySha256: d.sourceIdentitySha256,
        rawSha256: d.rawSha256,
      })),
      owner: {
        observedBy: new Date(owner.observed).toISOString(),
        acknowledgedAt: new Date(owner.recorded).toISOString(),
        sourceIdentitySha256: owner.sourceIdentitySha256,
        rawSha256: owner.rawSha256,
      },
      recoveries: recovered.map((d) => ({
        channel: d.channel,
        observedBy: new Date(d.observed).toISOString(),
        sourceIdentitySha256: d.sourceIdentitySha256,
        rawSha256: d.rawSha256,
      })),
    });
  }
  if (ids.size) fail('AMBIGUOUS_SEARCH');
  return {
    schema: 'PHUB_TIMEWEB_DIRECT_RECIPIENT_PREPARATION_V1',
    purpose: 'PREPARATION_ONLY_NOT_FOR_ACTIVATION',
    trust: TRUST,
    target: TARGET,
    binding: policy.binding,
    nonce: policy.nonce,
    observedAt,
    policySha256: expected.policySha256,
    captureReviewSha256: policy.captureReviewSha256,
    bundleSha256: hash(bundleBytes),
    panelConfiguration: {
      source: config.assertion.source,
      configurationSha256: config.assertion.configurationSha256,
      rawSha256: config.rawSha256,
    },
    directObservation: observation(captures.get('direct-observation'), policy, now, lastRecovery),
    recipientLifecycle: cycles,
    operationalWriter: false,
  };
}
