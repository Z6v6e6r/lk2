import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
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
