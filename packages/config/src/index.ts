import { z } from 'zod';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  REALTIME_HOST: z.string().default('0.0.0.0'),
  REALTIME_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(60_000).default(1000),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWT_REALTIME_AUDIENCE: z.string().min(1).default('phub-realtime'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).max(5_184_000).default(2_592_000),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  AUTH_CHALLENGE_RESEND_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  AUTH_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  AUTH_COOKIE_SECURE: booleanFromEnvironment,
  AUTH_DEV_PHONE_E164: z
    .string()
    .regex(/^\+7\d{10}$/)
    .default('+79990000001'),
  AUTH_DEV_OTP_CODE: z
    .string()
    .regex(/^\d{4}$/)
    .default('0000'),
  VIVA_MODE: z.enum(['mock', 'sandbox', 'production', 'disabled']).default('mock'),
  VIVA_API_URL: z.string().url().optional().or(z.literal('')),
  VIVA_API_KEY: z.string().optional(),
  VIVA_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
  VIVA_DIRECT_READ_ENABLED: booleanFromEnvironment,
  VIVA_AUTH_BASE_URL: z.string().url().default('https://kc.vivacrm.ru'),
  VIVA_AUTH_PROFILE_API_URL: z.string().url().default('https://api.vivacrm.ru/end-user/api/v1'),
  VIVA_AUTH_REALM: z.string().min(1).default('clients'),
  VIVA_AUTH_CLIENT_ID: z.string().min(1).default('widget'),
  VIVA_AUTH_TENANT_KEY: z.string().min(1).default('iSkq6G'),
  VIVA_AUTH_CHANNEL: z.string().min(1).default('cascade'),
  VIVA_OAUTH_ENABLED: booleanFromEnvironment,
  VIVA_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal('')),
  VIVA_OAUTH_SUCCESS_REDIRECT_URL: z.string().url().optional().or(z.literal('')),
  VIVA_OAUTH_SCOPES: z.string().min(1).default('openid'),
  VIVA_DELEGATION_ENCRYPTION_KEY: z.string().optional(),
  VIVA_DELEGATION_KEY_VERSION: z.string().min(1).default('v1'),
  PUBLIC_OFFER_VERSION: z.string().min(1).default('pending'),
  PERSONAL_DATA_POLICY_VERSION: z.string().min(1).default('pending'),
  OTEL_SERVICE_NAMESPACE: z.string().default('phub'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid application configuration: ${issues}`);
  }

  if (parsed.data.APP_ENV === 'production' && parsed.data.VIVA_MODE === 'mock') {
    throw new Error('VIVA_MODE=mock is forbidden in production');
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.AUTH_COOKIE_SECURE) {
    throw new Error('AUTH_COOKIE_SECURE=true is required in production');
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.TRUSTED_PROXY_CIDRS.trim()) {
    throw new Error('TRUSTED_PROXY_CIDRS is required in production');
  }
  if (parsed.data.VIVA_OAUTH_ENABLED) {
    if (!parsed.data.VIVA_OAUTH_REDIRECT_URI || !parsed.data.VIVA_OAUTH_SUCCESS_REDIRECT_URL) {
      throw new Error('Viva OAuth redirect URLs are required when VIVA_OAUTH_ENABLED=true');
    }
    if (!parsed.data.VIVA_DELEGATION_ENCRYPTION_KEY) {
      throw new Error('Viva delegation encryption key is required when VIVA_OAUTH_ENABLED=true');
    }
  }
  if (
    parsed.data.APP_ENV === 'production' &&
    (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET ||
      /replace|change|local|test|example|ci-/i.test(parsed.data.JWT_ACCESS_SECRET) ||
      /replace|change|local|test|example|ci-/i.test(parsed.data.JWT_REFRESH_SECRET))
  ) {
    throw new Error('Production JWT secrets must be distinct non-placeholder values');
  }

  return parsed.data;
}
