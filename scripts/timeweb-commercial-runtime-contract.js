import { createPrivateKey } from 'node:crypto';

function validateWholeCourtPilot(raw, fail) {
  let pilot;
  try {
    pilot = JSON.parse(raw);
  } catch {
    fail('whole_court_pilot_invalid');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const instant = (v) =>
    typeof v === 'string' &&
    v.length === 24 &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v;
  if (
    !pilot ||
    JSON.stringify(pilot) !== raw ||
    Object.keys(pilot).sort().join() !==
      'amountMinor,courtId,endsAt,startsAt,stationId,tenantId,userId' ||
    ![pilot.tenantId, pilot.userId, pilot.stationId, pilot.courtId].every(
      (id) => typeof id === 'string' && id.length === 36 && uuid.test(id),
    ) ||
    !instant(pilot.startsAt) ||
    !instant(pilot.endsAt) ||
    !Number.isSafeInteger(pilot.amountMinor) ||
    pilot.amountMinor < 1 ||
    pilot.amountMinor > 10_000_000
  )
    fail('whole_court_pilot_invalid');
  const start = Date.parse(pilot.startsAt),
    end = Date.parse(pilot.endsAt);
  const moscowDay = (ms) => new Date(ms + 180 * 60_000).toISOString().slice(0, 10);
  if (
    start % 60_000 !== 0 ||
    ![60, 90, 120].includes((end - start) / 60_000) ||
    moscowDay(start) !== moscowDay(end)
  )
    fail('whole_court_pilot_invalid');
}

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
  const schedule = api.GAME_CREATE_SCHEDULE_LK1_URL !== undefined;
  if (schedule && api.GAME_CREATE_SCHEDULE_LK1_URL !== 'https://padlhub.su/')
    fail('game_create_schedule_owner_invalid');
  const mode = api.SUBSCRIPTION_RUNTIME_WARN_MODE ?? 'OFF';
  if (!['OFF', 'WARN'].includes(mode)) fail('subscription_runtime_mode');
  if (
    api.GAME_COMMERCIAL_JOIN_ENABLED !== undefined &&
    !['false', 'true'].includes(api.GAME_COMMERCIAL_JOIN_ENABLED)
  )
    fail('commercial_join_flag');
  if (
    api.MONTHLY_SUBSCRIPTION_PURCHASE_ENABLED !== undefined &&
    !['false', 'true'].includes(api.MONTHLY_SUBSCRIPTION_PURCHASE_ENABLED)
  )
    fail('monthly_purchase_flag');
  if (
    api.GAME_COMMERCIAL_CREATE_ENABLED !== undefined &&
    !['false', 'true'].includes(api.GAME_COMMERCIAL_CREATE_ENABLED)
  )
    fail('commercial_create_flag');
  // lk2 admits only the LK1 organizer quarter owner (whole-court window, organizer quarter on the
  // subscription). ADVISORY would admit CREATE without an owner decision and BOOKED_OPERATION has
  // no LK1 receiver, so both stay out of this contour.
  if (
    api.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT !== undefined &&
    api.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT !== 'QUARTER_OWNER'
  )
    fail('commercial_create_transport');
  const monthly = api.MONTHLY_SUBSCRIPTION_PURCHASE_ENABLED === 'true';
  const quarterCreate = api.GAME_COMMERCIAL_CREATE_ENABLED === 'true';
  const active = api.GAME_COMMERCIAL_JOIN_ENABLED === 'true';
  const wholeCourt = api.GAME_WHOLE_COURT_CHECKOUT_PILOT !== undefined;
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
  if (api.MONTHLY_SUBSCRIPTION_OWNER_BASE_URL !== undefined) {
    if (
      !secureBase(api.MONTHLY_SUBSCRIPTION_OWNER_BASE_URL) ||
      new URL(api.MONTHLY_SUBSCRIPTION_OWNER_BASE_URL).href !== 'https://padlhub.su/'
    )
      fail('monthly_purchase_owner_invalid');
  }
  if (api.GAME_COMMERCIAL_CREATE_OWNER_BASE_URL !== undefined) {
    if (
      !secureBase(api.GAME_COMMERCIAL_CREATE_OWNER_BASE_URL) ||
      new URL(api.GAME_COMMERCIAL_CREATE_OWNER_BASE_URL).href !== 'https://padlhub.su/'
    )
      fail('commercial_create_owner_invalid');
  }
  if (wholeCourt) {
    validateWholeCourtPilot(api.GAME_WHOLE_COURT_CHECKOUT_PILOT, fail);
    if (
      api.GAME_WHOLE_COURT_CHECKOUT_OWNER_URL !== 'https://padlhub.su/' ||
      api.GAME_WHOLE_COURT_CHECKOUT_TIMEOUT_MS !== '25000' ||
      api.GAMES_COMMANDS_ENABLED !== 'true' ||
      api.GAMES_READ_ENABLED !== 'true' ||
      api.VIVA_OAUTH_ENABLED !== 'true' ||
      (api.VIVA_AUTH_TENANT_KEY ?? 'iSkq6G') !== 'iSkq6G' ||
      api.VIVA_MODE !== 'production'
    )
      fail('whole_court_owner_unavailable');
  } else if (
    api.GAME_WHOLE_COURT_CHECKOUT_OWNER_URL !== undefined ||
    api.GAME_WHOLE_COURT_CHECKOUT_TIMEOUT_MS !== undefined
  ) {
    fail('whole_court_owner_without_pilot');
  }
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
    if (!api.SUBSCRIPTION_RUNTIME_BASE_URL || !api.SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN)
      fail('subscription_runtime_boundary_incomplete');
    if (
      !secureBase(api.SUBSCRIPTION_RUNTIME_BASE_URL) ||
      !/^[!-~]{32,4096}$/u.test(api.SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN)
    )
      fail('subscription_runtime_boundary_invalid');
  }
  // packages/config refuses QUARTER_OWNER without the flag, so a flag-only deactivation must also
  // drop the transport; otherwise the API would fail at startup after passing this validator.
  if (api.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT !== undefined && !quarterCreate)
    fail('commercial_create_transport_without_flag');
  if (quarterCreate) {
    if (
      api.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT !== 'QUARTER_OWNER' ||
      !api.GAME_COMMERCIAL_CREATE_OWNER_BASE_URL ||
      api.GAMES_COMMANDS_ENABLED !== 'true' ||
      api.GAMES_READ_ENABLED !== 'true'
    )
      fail('commercial_create_owner_unavailable');
  }
  if (mode === 'WARN' || monthly || quarterCreate || wholeCourt || schedule) {
    const required = [
      'SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS',
      'SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID',
      'SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER',
      'SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE',
      ...(monthly ? ['MONTHLY_SUBSCRIPTION_OWNER_BASE_URL'] : []),
    ];
    if (required.some((key) => !api[key])) fail('subscription_runtime_boundary_incomplete');
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
    MONTHLY_SUBSCRIPTION_OWNER_TIMEOUT_MS: [100, 10000],
    GAME_COMMERCIAL_JOIN_OWNER_TIMEOUT_MS: [100, 5000],
    GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS: [100, 5000],
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
