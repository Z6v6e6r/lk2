#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';

const SHARED_DEPENDENCIES = ['DATABASE_URL', 'REDIS_URL', 'RABBITMQ_URL'];
const SHARED_JWT_IDENTITY = ['JWT_ISSUER', 'JWT_AUDIENCE'];
const DISABLED_FLAGS = [
  'GAMES_COMMANDS_ENABLED',
  'LEGACY_GAME_COMMAND_BRIDGE_ENABLED',
  'PARTICIPATION_COMMANDS_ENABLED',
  'BOOKING_REMINDER_SCHEDULER_ENABLED',
  'PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED',
  'ACTIVITY_HISTORY_SYNC_ENABLED',
  'ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED',
  'PROFILE_PHOTO_MAINTENANCE_ENABLED',
  'GIFT_CERTIFICATE_ISSUANCE_ENABLED',
];
const REALTIME_ALLOWED = new Set([
  'APP_ENV',
  'LOG_LEVEL',
  'DATABASE_URL',
  'REDIS_URL',
  'RABBITMQ_URL',
  'REALTIME_HOST',
  'REALTIME_PORT',
  'REALTIME_DATABASE_POOL_MAX',
  'REALTIME_DATABASE_POOL_WARM_CONNECTIONS',
  'REALTIME_MAX_CONNECTIONS',
  'REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION',
  'REALTIME_MAX_SOCKET_BUFFER_BYTES',
  'REALTIME_HEARTBEAT_INTERVAL_MS',
  'REALTIME_EXPECTED_REPLICAS',
  'COMMUNITIES_REALTIME_ENABLED',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'JWT_ADMIN_AUDIENCE',
  'JWT_REALTIME_AUDIENCE',
  'JWT_REALTIME_SECRET',
  'OTEL_SERVICE_NAMESPACE',
  'OTEL_SERVICE_INSTANCE_ID',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'LOCAL_RUNTIME_CONTOUR_ATTESTATION',
]);

function reject(reason) {
  throw new Error(reason);
}

export function parseEnvironment(contents) {
  const values = {};
  for (const line of contents.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) reject('env_format');
    const [, key, value] = match;
    if (Object.hasOwn(values, key)) reject('env_duplicate');
    if (!value || /[\r\n\0]/u.test(value)) reject('env_value');
    values[key] = value;
  }
  return values;
}

function requireValue(environment, key, expected) {
  if (!Object.hasOwn(environment, key)) reject(`missing_${key}`);
  if (expected !== undefined && environment[key] !== expected) reject(`unsafe_${key}`);
}

function requirePrivateKeyMaterial(environment, key) {
  requireValue(environment, key);
  const value = environment[key];
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(value) ||
    new Set(value).size < 16 ||
    /replace|change|local|test|example|password|secret/iu.test(value)
  )
    reject(`unsafe_${key}`);
}

function dependencyTarget(key, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    reject(`invalid_${key}`);
  }
  const allowedProtocols = {
    DATABASE_URL: new Set(['postgres:', 'postgresql:']),
    REDIS_URL: new Set(['redis:', 'rediss:']),
    RABBITMQ_URL: new Set(['amqp:', 'amqps:']),
  };
  if (!allowedProtocols[key]?.has(url.protocol) || !url.hostname) reject(`invalid_${key}`);
  url.username = '';
  url.password = '';
  return url.toString();
}

function validateCommon(environment, name) {
  requireValue(environment, 'APP_ENV', 'staging');
  for (const key of SHARED_DEPENDENCIES) requireValue(environment, key);
  for (const key of SHARED_JWT_IDENTITY) requireValue(environment, key);
  requireValue(environment, 'OTEL_SERVICE_INSTANCE_ID');
  if (environment.OTEL_SERVICE_INSTANCE_ID.trim() !== environment.OTEL_SERVICE_INSTANCE_ID)
    reject(`unsafe_${name}_instance`);
}

function validateEnabledFlags(environment, allowed, runtime) {
  for (const [key, value] of Object.entries(environment)) {
    if (key.endsWith('_ENABLED') && value === 'true' && !allowed.has(key))
      reject(`unsafe_${runtime}_${key}`);
  }
}

export function validateRuntimeEnvironments({ api, worker, realtime, migrator, host, tenantKey }) {
  if (!/^[a-z0-9][a-z0-9.-]+$/u.test(host) || host.includes('..')) reject('host');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(tenantKey)) reject('tenant_key');
  validateCommon(api, 'api');
  validateCommon(worker, 'worker');
  validateCommon(realtime, 'realtime');
  for (const key of SHARED_DEPENDENCIES) {
    const targets = [api, worker, realtime].map((environment) =>
      dependencyTarget(key, environment[key]),
    );
    if (new Set(targets).size !== 1) reject(`contour_${key}`);
  }
  for (const key of SHARED_JWT_IDENTITY) {
    if (api[key] !== worker[key] || api[key] !== realtime[key]) reject(`contour_${key}`);
  }
  if (new Set([api, worker, realtime].map((value) => value.OTEL_SERVICE_INSTANCE_ID)).size !== 3)
    reject('instance_identity');

  requireValue(api, 'AUTH_COOKIE_SECURE', 'true');
  requireValue(api, 'CORS_ORIGINS', `https://${host}`);
  requireValue(api, 'TRUSTED_PROXY_CIDRS', '172.30.26.10/32');
  requireValue(api, 'CUP_DEV_AUTH_ENABLED', 'false');
  requireValue(api, 'VIVA_MODE', 'production');
  if ('AUTH_DEV_PHONE_E164' in api || 'AUTH_DEV_OTP_CODE' in api) reject('api_dev_auth');
  requirePrivateKeyMaterial(api, 'JWT_ACCESS_SECRET');
  requirePrivateKeyMaterial(api, 'JWT_REFRESH_SECRET');
  requirePrivateKeyMaterial(api, 'JWT_REALTIME_SECRET');
  requireValue(api, 'JWT_REALTIME_AUDIENCE');
  if (api.JWT_ACCESS_SECRET === api.JWT_REFRESH_SECRET) reject('unsafe_api_signing_secret');
  if (
    api.JWT_REALTIME_SECRET === api.JWT_ACCESS_SECRET ||
    api.JWT_REALTIME_SECRET === api.JWT_REFRESH_SECRET
  )
    reject('unsafe_realtime_signing_secret');
  requireValue(api, 'VIVA_OAUTH_ENABLED', 'true');
  requireValue(
    api,
    'VIVA_OAUTH_REDIRECT_URI',
    `https://${host}/user/api/v1/${tenantKey}/auth/viva/callback`,
  );
  requireValue(api, 'VIVA_OAUTH_SUCCESS_REDIRECT_URL', `https://${host}/`);
  requirePrivateKeyMaterial(api, 'VIVA_DELEGATION_ENCRYPTION_KEY');
  requireValue(api, 'GAMES_READ_ENABLED', 'true');
  requireValue(api, 'GAMES_RESULTS_WRITE_MODE', 'disabled');
  requireValue(api, 'GIFT_CERTIFICATE_PAYMENT_MODE', 'disabled');
  requireValue(api, 'SUBSCRIPTION_RUNTIME_WARN_MODE', 'OFF');
  for (const key of DISABLED_FLAGS) requireValue(api, key, 'false');
  validateEnabledFlags(api, new Set(['GAMES_READ_ENABLED', 'VIVA_OAUTH_ENABLED']), 'api');

  requireValue(worker, 'OUTBOX_PUBLISH_MODE', 'leased');
  requireValue(worker, 'WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED', 'true');
  if (
    'JWT_ACCESS_SECRET' in worker ||
    'JWT_REFRESH_SECRET' in worker ||
    'JWT_REALTIME_SECRET' in worker
  )
    reject('worker_signing_secret');
  requireValue(worker, 'GAMES_READ_ENABLED', 'false');
  requireValue(worker, 'GAMES_RESULTS_WRITE_MODE', 'disabled');
  requireValue(worker, 'GIFT_CERTIFICATE_PAYMENT_MODE', 'disabled');
  requireValue(worker, 'SUBSCRIPTION_RUNTIME_WARN_MODE', 'OFF');
  for (const key of DISABLED_FLAGS) requireValue(worker, key, 'false');
  validateEnabledFlags(worker, new Set(), 'worker');
  for (const key of Object.keys(worker)) {
    if (
      key !== 'WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED' &&
      /(?:SECRET|TOKEN|PRIVATE_KEY|API_KEY|ENCRYPTION_KEY)/u.test(key)
    )
      reject(`worker_secret_${key}`);
  }

  for (const key of Object.keys(realtime)) {
    if (!REALTIME_ALLOWED.has(key)) reject(`realtime_key_${key}`);
  }
  requirePrivateKeyMaterial(realtime, 'JWT_REALTIME_SECRET');
  requireValue(realtime, 'JWT_REALTIME_AUDIENCE');
  if (realtime.JWT_REALTIME_SECRET !== api.JWT_REALTIME_SECRET)
    reject('realtime_signing_secret_mismatch');
  if (realtime.JWT_REALTIME_AUDIENCE !== api.JWT_REALTIME_AUDIENCE)
    reject('realtime_audience_mismatch');
  if ('JWT_ACCESS_SECRET' in realtime || 'JWT_REFRESH_SECRET' in realtime)
    reject('realtime_signing_secret');

  const migratorKeys = Object.keys(migrator).sort();
  if (
    migratorKeys.join(',') !== 'DATABASE_URL,MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS' ||
    dependencyTarget('DATABASE_URL', migrator.DATABASE_URL) !==
      dependencyTarget('DATABASE_URL', api.DATABASE_URL) ||
    migrator.MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS !== '30000'
  )
    reject('migrator_scope');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || Object.hasOwn(values, option)) reject('usage');
    values[option] = value;
  }
  const required = ['--host', '--tenant-key', '--api', '--worker', '--realtime', '--migrator'];
  if (Object.keys(values).length !== required.length || required.some((key) => !values[key]))
    reject('usage');
  return values;
}

function readSecureEnvironment(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.mode !== 0o100600 ||
    stat.nlink !== 1
  )
    reject('env_file_security');
  return { environment: parseEnvironment(readFileSync(path, 'utf8')), stat };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = ['--api', '--worker', '--realtime', '--migrator'].map((key) =>
    readSecureEnvironment(options[key]),
  );
  if (new Set(files.map(({ stat }) => `${stat.dev}:${stat.ino}`)).size !== files.length)
    reject('env_file_identity');
  validateRuntimeEnvironments({
    host: options['--host'],
    tenantKey: options['--tenant-key'],
    api: files[0].environment,
    worker: files[1].environment,
    realtime: files[2].environment,
    migrator: files[3].environment,
  });
  process.stdout.write('TIMEWEB_BETA_RUNTIME_ENV_PASSED|values_printed=false\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `TIMEWEB_BETA_RUNTIME_ENV_FAILED|reason=${error instanceof Error ? error.message : 'validation_error'}\n`,
    );
    process.exit(1);
  }
}
