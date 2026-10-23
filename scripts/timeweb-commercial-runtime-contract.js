import { createPrivateKey } from 'node:crypto';

export function parseTimewebDelegationKeyring(value, fail) {
  let entries;
  try {
    entries = JSON.parse(value);
  } catch {
    fail('delegation_keyring_invalid');
  }
  if (
    !entries ||
    typeof entries !== 'object' ||
    Array.isArray(entries) ||
    JSON.stringify(entries) !== value ||
    Object.keys(entries).length < 1 ||
    Object.keys(entries).length > 8 ||
    /[#$']/u.test(value)
  )
    fail('delegation_keyring_invalid');
  for (const [id, pem] of Object.entries(entries)) {
    if (
      !/^[A-Za-z0-9._:-]{3,64}$/u.test(id) ||
      typeof pem !== 'string' ||
      !/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n?$/u.test(pem)
    )
      fail('delegation_keyring_invalid');
    let key;
    try {
      key = createPrivateKey(pem);
    } catch {
      fail('delegation_keyring_invalid');
    }
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      key.export({ type: 'pkcs8', format: 'pem' }).toString() !== pem
    )
      fail('delegation_keyring_invalid');
  }
  return entries;
}

export function validateTimewebCommercialRuntime(api, fail) {
  const mode = api.SUBSCRIPTION_RUNTIME_WARN_MODE ?? 'OFF';
  if (!['OFF', 'WARN'].includes(mode)) fail('subscription_runtime_mode');
  if (
    api.GAME_COMMERCIAL_JOIN_ENABLED !== undefined &&
    !['false', 'true'].includes(api.GAME_COMMERCIAL_JOIN_ENABLED)
  )
    fail('commercial_join_flag');
  const active = api.GAME_COMMERCIAL_JOIN_ENABLED === 'true';
  if (active && mode !== 'WARN') fail('commercial_join_boundary_required');
  const secureBase = (value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    } catch {
      return false;
    }
  };
  for (const key of ['SUBSCRIPTION_RUNTIME_BASE_URL', 'GAME_COMMERCIAL_JOIN_OWNER_BASE_URL']) {
    if (api[key] !== undefined && !secureBase(api[key]))
      fail('subscription_runtime_boundary_invalid');
  }
  for (const [key, pattern] of [
    ['SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN', /^[!-~]{32,4096}$/u],
    ['SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID', /^[A-Za-z0-9._:-]{3,64}$/u],
    ['SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER', /^[!-~]{1,512}$/u],
    ['SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE', /^[!-~]{1,256}$/u],
  ]) {
    if (api[key] !== undefined && !pattern.test(api[key]))
      fail('subscription_runtime_boundary_invalid');
  }
  if (mode === 'WARN') {
    const required = [
      'SUBSCRIPTION_RUNTIME_BASE_URL',
      'SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN',
      'SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS',
      'SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID',
      'SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER',
      'SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE',
    ];
    if (required.some((key) => !api[key])) fail('subscription_runtime_boundary_incomplete');
    if (
      !secureBase(api.SUBSCRIPTION_RUNTIME_BASE_URL) ||
      !/^[!-~]{32,4096}$/u.test(api.SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN) ||
      !/^[!-~]{1,512}$/u.test(api.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER) ||
      !/^[!-~]{1,256}$/u.test(api.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE)
    )
      fail('subscription_runtime_boundary_invalid');
    const entries = parseTimewebDelegationKeyring(
      api.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS,
      fail,
    );
    if (!Object.hasOwn(entries, api.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID))
      fail('delegation_active_key_missing');
  }
  if (
    active &&
    (!secureBase(api.GAME_COMMERCIAL_JOIN_OWNER_BASE_URL) ||
      api.GAMES_COMMANDS_ENABLED !== 'true' ||
      api.GAMES_READ_ENABLED !== 'true')
  )
    fail('commercial_join_owner_unavailable');
  const bounds = {
    GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: [100, 5000],
    SUBSCRIPTION_RUNTIME_TIMEOUT_MS: [100, 10000],
    SUBSCRIPTION_RUNTIME_CIRCUIT_FAILURE_THRESHOLD: [1, 100],
    SUBSCRIPTION_RUNTIME_CIRCUIT_RESET_MS: [1000, 300000],
    SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS: [10, 60],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (
      api[key] !== undefined &&
      (!/^[0-9]+$/u.test(api[key]) || Number(api[key]) < min || Number(api[key]) > max)
    )
      fail('subscription_runtime_bounds');
  }
}
