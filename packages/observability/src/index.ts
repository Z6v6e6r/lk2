import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
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

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_NAMESPACE]: options.serviceNamespace,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${options.endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          redactedQueryParams: ['phoneNumber', 'code', 'tenantKey'],
        },
        '@opentelemetry/instrumentation-undici': {
          // Viva's legacy SMS endpoint puts the phone in its query string.
          // The adapter emits a safe custom metric instead of a URL-bearing span.
          ignoreRequestHook: (request) => request.path.includes('/sms/authentication-code'),
        },
      }),
    ],
  });
  sdk.start();
  return sdk;
}
