import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } from '@opentelemetry/semantic-conventions';
import pino, { type Logger, type LoggerOptions } from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'phone',
  'message.content',
];

export interface LevelEligibilityMetric {
  readonly activityType: 'GAME' | 'TOURNAMENT' | 'TRAINING';
  readonly mode: 'OFF' | 'SHADOW' | 'WARN' | 'BLOCK';
  readonly outcome: 'PASS' | 'SKIP' | 'WARN' | 'FAIL' | 'BYPASS';
  readonly reasonCode: string;
  readonly action: string;
  readonly wouldBlock?: boolean;
}

const eligibilityMeter = metrics.getMeter('phub.eligibility');
const eligibilityCounters = {
  decision: eligibilityMeter.createCounter('eligibility_decision_total'),
  levelDecision: eligibilityMeter.createCounter('eligibility_level_decision_total'),
  unknownPlayer: eligibilityMeter.createCounter('eligibility_unknown_player_level_total'),
  missingActivity: eligibilityMeter.createCounter('eligibility_missing_activity_level_total'),
  clientServerMismatch: eligibilityMeter.createCounter('eligibility_client_server_mismatch_total'),
  personalInvite: eligibilityMeter.createCounter('eligibility_personal_invite_bypass_total'),
  organizerBypass: eligibilityMeter.createCounter('eligibility_organizer_bypass_total'),
  staffOverride: eligibilityMeter.createCounter('eligibility_staff_override_total'),
  waitlistRecheck: eligibilityMeter.createCounter('eligibility_waitlist_recheck_total'),
  constraintSource: eligibilityMeter.createCounter('level_constraint_source_total'),
  evaluation: eligibilityMeter.createCounter('participation_eligibility_evaluations_total'),
  allow: eligibilityMeter.createCounter('participation_eligibility_allow_total'),
  shadowWouldBlock: eligibilityMeter.createCounter(
    'participation_eligibility_shadow_would_block_total',
  ),
  warn: eligibilityMeter.createCounter('participation_eligibility_warn_total'),
  block: eligibilityMeter.createCounter('participation_eligibility_block_total'),
  missingLevel: eligibilityMeter.createCounter('participation_eligibility_missing_level_total'),
  staleLevel: eligibilityMeter.createCounter('participation_eligibility_stale_level_total'),
  policyUnavailable: eligibilityMeter.createCounter(
    'participation_eligibility_policy_unavailable_total',
  ),
  deniedWaitlistPromotion: eligibilityMeter.createCounter(
    'participation_eligibility_denied_waitlist_promotion_total',
  ),
};

export function levelEligibilityMetricAttributes(metric: LevelEligibilityMetric) {
  return {
    activity_type: metric.activityType,
    action: metric.action,
    mode: metric.mode,
    reason_code: metric.reasonCode,
  } as const;
}

export function recordLevelEligibilityMetrics(metric: LevelEligibilityMetric): void {
  const attributes = levelEligibilityMetricAttributes(metric);
  eligibilityCounters.decision.add(1, attributes);
  eligibilityCounters.levelDecision.add(1, attributes);
  eligibilityCounters.evaluation.add(1, attributes);
  if (metric.outcome !== 'FAIL') eligibilityCounters.allow.add(1, attributes);
  if (metric.mode === 'SHADOW' && metric.wouldBlock === true) {
    eligibilityCounters.shadowWouldBlock.add(1, attributes);
  }
  if (metric.outcome === 'WARN') eligibilityCounters.warn.add(1, attributes);
  if (metric.outcome === 'FAIL') eligibilityCounters.block.add(1, attributes);
  if (metric.reasonCode === 'PLAYER_LEVEL_REQUIRED')
    eligibilityCounters.missingLevel.add(1, attributes);
  if (metric.reasonCode === 'PLAYER_LEVEL_STALE') eligibilityCounters.staleLevel.add(1, attributes);
  if (metric.reasonCode === 'POLICY_UNAVAILABLE') {
    eligibilityCounters.policyUnavailable.add(1, attributes);
  }
  if (
    metric.reasonCode === 'PLAYER_LEVEL_UNKNOWN' ||
    metric.reasonCode === 'LEVEL_SCALE_VERSION_MISMATCH'
  )
    eligibilityCounters.unknownPlayer.add(1, attributes);
  if (metric.reasonCode === 'ACTIVITY_LEVEL_UNDEFINED')
    eligibilityCounters.missingActivity.add(1, attributes);
  if (metric.reasonCode === 'PERSONAL_INVITE_BYPASS')
    eligibilityCounters.personalInvite.add(1, attributes);
  if (metric.reasonCode === 'ORGANIZER_CREATION_BYPASS')
    eligibilityCounters.organizerBypass.add(1, attributes);
  if (metric.action === 'PROMOTE_WAITLIST') eligibilityCounters.waitlistRecheck.add(1, attributes);
  if (metric.action === 'PROMOTE_WAITLIST' && metric.outcome === 'FAIL') {
    eligibilityCounters.deniedWaitlistPromotion.add(1, attributes);
  }
}

export function recordLevelEligibilityBoundaryMetric(
  name: 'client_server_mismatch' | 'staff_override',
  metric: LevelEligibilityMetric,
): void {
  const attributes = levelEligibilityMetricAttributes(metric);
  (name === 'client_server_mismatch'
    ? eligibilityCounters.clientServerMismatch
    : eligibilityCounters.staffOverride
  ).add(1, attributes);
}

export function shouldIgnoreUndiciRequestPath(path: string): boolean {
  if (path.includes('/sms/authentication-code')) return true;
  if (!path.includes('/lk/communities')) return false;
  return /[?&](?:phone|clientId)=/u.test(path);
}

export function createLogger(service: string, level: string, release = 'development'): Logger {
  const options: LoggerOptions = {
    level,
    base: { service, release },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  return pino(options);
}

export function startTelemetry(options: {
  readonly serviceName: string;
  readonly serviceNamespace: string;
  readonly endpoint?: string;
}): NodeSDK | undefined {
  if (!options.endpoint) return undefined;
  const endpoint = options.endpoint.replace(/\/$/, '');

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_NAMESPACE]: options.serviceNamespace,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
        exportTimeoutMillis: 10_000,
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          redactedQueryParams: ['phoneNumber', 'phone', 'clientId', 'code', 'tenantKey'],
        },
        '@opentelemetry/instrumentation-undici': {
          // Temporary legacy endpoints put identity values in their query string. Their adapters
          // emit safe custom metrics instead of URL-bearing spans, so auto-instrumentation must not
          // export those raw paths.
          ignoreRequestHook: (request) => shouldIgnoreUndiciRequestPath(request.path),
        },
      }),
    ],
  });
  sdk.start();
  return sdk;
}
