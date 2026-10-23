// Closed 0105 profiles in the existing Timeweb engines. Legacy bridges remain frozen.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { assertControllerPromotionGitConfig } from './verify-source-ci.js';
import {
  validateTimewebMonitorReadback,
  validateTimewebAlertReadback,
} from './produce-timeweb-api-web-observability-evidence.js';
import { validateTimewebMonitoringEvidence } from './verify-timeweb-api-web-observability.js';
import {
  NOTIFICATION_CATALOG_VERSION,
  NOTIFICATION_CATALOG_SQL,
  NOTIFICATION_DEFAULT_ACL_SQL,
  NOTIFICATION_NEW_TABLES,
  NOTIFICATION_NEW_TABLE_SECURITY_SQL,
  NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL,
  NOTIFICATION_REFERENCES_SAFE_SQL,
} from './notification-migration-catalog.js';
export const NOTIFICATION_BACKUP_SCHEMA = 'PHUB_TIMEWEB_NOTIFICATION_PRE0105_BACKUP_NAMESPACE_V1';
export const NOTIFICATION_MIGRATION_SCHEMA =
  'PHUB_TIMEWEB_NOTIFICATION_0105_MIGRATION_OPERATION_V1';
export const NOTIFICATION_ROLLOUT_SCHEMA = 'PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V2';
export const NOTIFICATION_PRE_LEDGER =
  'b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85';
export const NOTIFICATION_POST_LEDGER =
  '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd';
export const NOTIFICATION_SOURCE = '/opt/phub/timeweb-beta/standard/source';
export const isNotificationOperation = (op) =>
  [NOTIFICATION_BACKUP_SCHEMA, NOTIFICATION_MIGRATION_SCHEMA, NOTIFICATION_ROLLOUT_SCHEMA].includes(
    op?.schema,
  );
export const notificationHash = (v) => createHash('sha256').update(v).digest('hex');
const H = /^[a-f0-9]{64}$/,
  S = /^[a-f0-9]{40}$/;
const stop = (code) => {
  throw Error('NOTIFICATION_PROFILE_' + code);
};
export const notificationSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function notificationExact(v, keys) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !notificationSame(Object.keys(v).sort(), [...keys].sort())
  )
    stop('SHAPE');
}
export const notificationIdFields = [
  'id',
  'image',
  'imageId',
  'releaseId',
  'revision',
  'restarts',
  'startedAt',
];
export const notificationSecretNames = [
  '.release-identity.json',
  'api.env',
  'migrator.env',
  'realtime.env',
  'worker.env',
];
export function validateNotificationBaseline(row, service) {
  notificationExact(row, notificationIdFields);
  const refs = {
    api: '47bce1fab22cb47d99fa5391764dd20c8c1f53a31550eab2a759b512a4411839', // gitleaks:allow public OCI image digest
    worker: '72b9a03aaf95afab5711a8f489b56affe0be4d79eb5af513abe4966eb7695416',
    postgres: 'cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
  };
  const expected =
    service === 'postgres' ? 'docker.io/library/postgres' : 'ghcr.io/z6v6e6r/phub-' + service;
  if (
    !H.test(row.id ?? '') ||
    row.image !== expected + '@sha256:' + refs[service] ||
    row.imageId !== 'sha256:' + refs[service] ||
    row.restarts !== 0 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,9}Z$/.test(row.startedAt ?? '') ||
    row.revision !== (service === 'postgres' ? null : '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d') ||
    row.releaseId !==
      (service === 'api' ? '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d-39366813227-1' : null)
  )
    stop('BASELINE');
}
export function validateNotificationOperation(op, at) {
  const migration = op?.schema === NOTIFICATION_MIGRATION_SCHEMA,
    rollout = op?.schema === NOTIFICATION_ROLLOUT_SCHEMA;
  if (!migration && !rollout) stop('OPERATION');
  notificationExact(op, [
    'schema',
    'profile',
    'target',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'migratorImage',
    ...(rollout ? ['apiImage', 'workerImage'] : []),
    'packageDescriptorSha256',
    'catalogsSha256',
    'expectedApi',
    'expectedWorker',
    'expectedPostgres',
    ...(migration
      ? ['expectedSecretSetReleaseId', 'expectedSecretSetFiles']
      : [
          'expectedCurrentSecretSetReleaseId',
          'candidateSecretHashes',
          'expectedFcmSource',
          'migrationPlanSha256',
          'migrationSuccessSha256',
          'migrationReceiptSha256',
        ]),
    'expiresAt',
    'confirmation',
  ]);
  notificationExact(op.target, ['hostname', 'serverId', 'projectId']);
  if (
    !notificationSame(op.target, {
      hostname: 'lk2.padlhub.su',
      serverId: 8886471,
      projectId: 262717,
    }) ||
    op.profile !== 'production' ||
    !S.test(op.controllerSha ?? '') ||
    !S.test(op.controllerTree ?? '') ||
    op.controllerSha !== op.candidateSha ||
    op.controllerTree !== op.candidateTree ||
    op.controllerSourceCiRunId !== op.sourceCiRunId
  )
    stop('SOURCE');
  for (const k of ['sourceCiRunId', 'publicationRunId', 'artifactId'])
    if (!/^[1-9][0-9]*$/.test(op[k] ?? '')) stop('SOURCE');
  for (const k of [
    'manifestSha256',
    'packageDescriptorSha256',
    'catalogsSha256',
    ...(rollout ? ['migrationPlanSha256', 'migrationSuccessSha256', 'migrationReceiptSha256'] : []),
  ])
    if (!H.test(op[k] ?? '')) stop('DIGEST');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(op.artifactDigest ?? '') ||
    !/^ghcr\.io\/z6v6e6r\/phub-migrator@sha256:[a-f0-9]{64}$/.test(op.migratorImage ?? '')
  )
    stop('IMAGE');
  if (rollout)
    for (const service of ['api', 'worker'])
      if (
        !new RegExp(`^ghcr\\.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
          op[service + 'Image'] ?? '',
        )
      )
        stop('IMAGE');
  for (const service of ['api', 'worker', 'postgres'])
    validateNotificationBaseline(
      op['expected' + service[0].toUpperCase() + service.slice(1)],
      service,
    );
  const secrets = migration ? op.expectedSecretSetFiles : op.candidateSecretHashes;
  notificationExact(secrets, notificationSecretNames);
  if (
    !Object.values(secrets).every((v) => H.test(v ?? '')) ||
    !/^[a-f0-9]{40}-[1-9][0-9]*-1$/.test(
      op[migration ? 'expectedSecretSetReleaseId' : 'expectedCurrentSecretSetReleaseId'] ?? '',
    )
  )
    stop('SECRETS');
  if (
    rollout &&
    !['/dev/null', '/etc/phub/timeweb-beta-fcm/fcm-service-account.json'].includes(
      op.expectedFcmSource,
    )
  )
    stop('FCM_SOURCE');
  const confirmation = migration
    ? 'MIGRATE_0099_0100_0101_102_TO_105_PRESERVE_RUNTIME_AND_PROVIDERS'
    : 'DEPLOY_API_WORKER_0105_KEEP_SECRETS_AND_PROVIDERS';
  const expires = Date.parse(op.expiresAt);
  if (
    op.confirmation !== confirmation ||
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== op.expiresAt ||
    (at !== undefined && (expires - at < 1200000 || expires - at > 3600000))
  )
    stop('CONFIRMATION');
  return op;
}
export function validateNotificationCatalogFile(bytes, descriptorBytes) {
  const v = parseStrictJson(bytes);
  notificationExact(v, [
    'schema',
    'postgresMajor',
    'packageDescriptorSha256',
    'builderVersion',
    'builderSha256',
    'checkpoints',
  ]);
  const builder = notificationHash(
    [
      NOTIFICATION_CATALOG_VERSION,
      JSON.stringify(NOTIFICATION_NEW_TABLES),
      NOTIFICATION_CATALOG_SQL,
      NOTIFICATION_DEFAULT_ACL_SQL,
      NOTIFICATION_NEW_TABLE_SECURITY_SQL,
      NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL,
      NOTIFICATION_REFERENCES_SAFE_SQL,
    ].join('\n'),
  );
  if (
    v.schema !== 'PHUB_NOTIFICATION_MIGRATION_CATALOGS_V1' ||
    v.postgresMajor !== 16 ||
    v.packageDescriptorSha256 !== notificationHash(descriptorBytes) ||
    v.builderVersion !== NOTIFICATION_CATALOG_VERSION ||
    v.builderSha256 !== builder
  )
    stop('CATALOG_BINDING');
  notificationExact(v.checkpoints, ['102', '103', '104', '105']);
  for (const n of ['102', '103', '104', '105']) {
    const cp = v.checkpoints[n];
    notificationExact(cp, ['sha256', 'rows']);
    if (
      !H.test(cp.sha256 ?? '') ||
      !Array.isArray(cp.rows) ||
      !cp.rows.length ||
      notificationHash(JSON.stringify(cp.rows) + '\n') !== cp.sha256
    )
      stop('CATALOG');
    let previous = '';
    for (const row of cp.rows) {
      notificationExact(row, ['key', 'value']);
      if (typeof row.key !== 'string' || row.key <= previous || typeof row.value !== 'string')
        stop('CATALOG');
      const value = parseStrictJson(row.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) stop('CATALOG');
      previous = row.key;
    }
  }
  return v;
}
// IO is injected to reuse each owning engine's safe Git/read implementation without an import cycle.
export function attestNotificationSource(op, { git, read, secure, present }) {
  if (!isNotificationOperation(op)) stop('SOURCE');
  if (
    op.candidateSha !== undefined &&
    (op.candidateSha !== op.controllerSha ||
      op.candidateTree !== op.controllerTree ||
      op.sourceCiRunId !== op.controllerSourceCiRunId)
  )
    stop('SOURCE');
  if (
    !secure(NOTIFICATION_SOURCE, 0o700).isDirectory() ||
    !secure(NOTIFICATION_SOURCE + '/.git').isDirectory()
  )
    stop('SOURCE_DIRECTORY');
  assertControllerPromotionGitConfig(git);
  if (
    git(['rev-parse', '--show-toplevel']) !== NOTIFICATION_SOURCE ||
    git(['rev-parse', '--absolute-git-dir']) !== NOTIFICATION_SOURCE + '/.git' ||
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !==
      NOTIFICATION_SOURCE + '/.git' ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== op.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all']) ||
    present(NOTIFICATION_SOURCE + '/.git/objects/info/alternates') ||
    present(NOTIFICATION_SOURCE + '/.git/shallow')
  )
    stop('SOURCE_DIRECTORY');
  const config = parseStrictJson(read('/etc/phub/timeweb-beta-standard-delivery.json'));
  notificationExact(config, ['schema', 'enabled', 'owner', 'controllerSha']);
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    typeof config.owner !== 'string' ||
    !config.owner.trim() ||
    config.controllerSha !== op.controllerSha ||
    git(['config', '--local', '--no-includes', '--list'])
      .split('\n')
      .some((line) =>
        /^(?:remote\..*\.(?:promisor|partialclonefilter)|extensions\.partialclone|include(?:if\..*)?\.path)=/i.test(
          line,
        ),
      )
  )
    stop('ENROLLMENT');
  for (const item of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const m = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/.exec(item);
    if (!m || m[2].startsWith('/') || m[2].split('/').includes('..')) stop('SOURCE_FILE');
    secure(NOTIFICATION_SOURCE + '/' + m[2], m[1] === '100644' ? 0o644 : 0o755);
  }
  const descriptor = read(
    NOTIFICATION_SOURCE + '/deploy/timeweb/notification-migrations-0099-0101.v1.json',
    0o644,
  );
  const catalogs = read(
    NOTIFICATION_SOURCE + '/deploy/timeweb/notification-migration-catalogs.v1.json',
    0o644,
  );
  if (
    notificationHash(descriptor) !== op.packageDescriptorSha256 ||
    notificationHash(catalogs) !== op.catalogsSha256
  )
    stop('PACKAGE');
  validateNotificationCatalogFile(catalogs, descriptor);
  return true;
}
export function validateNotificationManifest(op, manifest) {
  if (manifest.gitCommit !== op.controllerSha || manifest.gitTree !== op.controllerTree)
    stop('MANIFEST');
  const image = manifest.images?.filter((v) => v.component === 'migrator');
  if (
    image?.length !== 1 ||
    op.migratorImage !== 'ghcr.io/z6v6e6r/phub-migrator@' + image[0].digest
  )
    stop('MANIFEST');
  if (op.schema === NOTIFICATION_ROLLOUT_SCHEMA)
    for (const service of ['api', 'worker']) {
      const rows = manifest.images.filter((v) => v.component === service);
      if (
        rows.length !== 1 ||
        op[service + 'Image'] !== 'ghcr.io/z6v6e6r/phub-' + service + '@' + rows[0].digest
      )
        stop('MANIFEST');
    }
  return manifest;
}
export function validateNotificationRoleReadback(v, kind, target, phase = 'pre', catalogSha) {
  notificationExact(v, [
    'schema',
    'kind',
    'phase',
    'wireRoleName',
    'currentRoleName',
    'sessionRoleName',
    'roleOverride',
    'databaseName',
    'systemIdentifier',
    'readOnly',
    'recovery',
    'superuser',
    'bypassRls',
    'createRole',
    'createDatabase',
    'replication',
    'inherit',
    'databaseCreate',
    'roleMembershipsPresent',
    'privilegedMembership',
    'runtimeCanAssumeMigrator',
    'businessCreate',
    'businessDdlControl',
    'capabilities',
    'defaultAcls',
    'catalog',
  ]);
  const role = 'phub_' + kind;
  if (
    !['runtime', 'migrator'].includes(kind) ||
    !['pre', 'post'].includes(phase) ||
    v.schema !== 'PHUB_NOTIFICATION_MIGRATION_ROLE_READBACK_V1' ||
    v.kind !== kind ||
    v.phase !== phase ||
    v.wireRoleName !== role ||
    v.currentRoleName !== role ||
    v.sessionRoleName !== role ||
    v.roleOverride !== 'none' ||
    v.databaseName !== target.databaseName ||
    v.systemIdentifier !== target.systemIdentifier ||
    v.readOnly !== 'on' ||
    v.recovery !== false ||
    v.inherit !== true
  )
    stop('ROLE');
  for (const k of [
    'superuser',
    'bypassRls',
    'createRole',
    'createDatabase',
    'replication',
    'roleMembershipsPresent',
    'privilegedMembership',
    'runtimeCanAssumeMigrator',
    ...(kind === 'runtime' ? ['databaseCreate', 'businessCreate', 'businessDdlControl'] : []),
  ])
    if (v[k] !== false) stop('ROLE');
  if (kind === 'runtime') {
    if (v.capabilities !== null || v.defaultAcls !== null || v.catalog !== null) stop('ROLE');
  } else {
    notificationExact(v.capabilities, [
      'identity',
      'notifications',
      'support',
      'plpgsql',
      'uuid',
      'ledger',
      'owners',
      'credentials',
      'tenants',
      'users',
      'templates',
      'intents',
      'tickets',
    ]);
    if (
      Object.values(v.capabilities).some((x) => x !== true) ||
      !Array.isArray(v.defaultAcls) ||
      v.defaultAcls.length !== 4 ||
      !notificationSame(v.defaultAcls.map((a) => a.privilege).sort(), [
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]) ||
      v.defaultAcls.some(
        (a) =>
          a.scope !== 'identity' ||
          a.type !== 'r' ||
          a.grantor !== 'phub_migrator' ||
          a.grantee !== 'phub_runtime' ||
          a.grantable !== false,
      )
    )
      stop('ROLE');
    notificationExact(v.catalog, ['count', 'sha256']);
    if (v.catalog.count !== (phase === 'pre' ? 102 : 105) || v.catalog.sha256 !== catalogSha)
      stop('ROLE');
  }
  return v;
}

// Fixed read-only catalog proof, used by backup guards and migration postflight.
export function notificationStateSql(phase, bootstrapSql) {
  if (!['pre', 'bootstrap', 'post'].includes(phase)) stop('STATE_PHASE');
  const first = /do \$\$[\s\S]*?end \$\$;/.exec(bootstrapSql)?.[0];
  if (!first) stop('BOOTSTRAP_SOURCE');
  const tables =
    'array[' + NOTIFICATION_NEW_TABLES.map((v) => "'" + v + "'").join(',') + ']::text[]';
  const catalog = NOTIFICATION_CATALOG_SQL.replaceAll('$1', tables);
  const defaults = NOTIFICATION_DEFAULT_ACL_SQL;
  const security = NOTIFICATION_NEW_TABLE_SECURITY_SQL.replaceAll('$1', tables);
  const counts =
    phase === 'post'
      ? NOTIFICATION_NEW_TABLES.map(
          (name) => `select '${name}' as name,count(*)::int as count from ${name}`,
        ).join(' union all ')
      : 'select null::text as name,0::int as count where false';
  return `begin isolation level repeatable read read only;
 set local search_path='pg_catalog';set local statement_timeout='15s';set local lock_timeout='2s';
 ${phase === 'pre' ? first : ''}
 select jsonb_build_object('schema','PHUB_NOTIFICATION_DATABASE_STATE_V1','phase','${phase}',
 'target',jsonb_build_object('databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_control_system())),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum) order by filename),'[]'::jsonb) from public.schema_migrations),
 'catalog',(select jsonb_agg(jsonb_build_object('key',key,'value',value) order by key collate "C") from (${catalog}) q),
 'defaults',(${defaults}),
 'security',${phase === 'post' ? `(select jsonb_agg(to_jsonb(s) order by name) from (${security}) s)` : `'[]'::jsonb`},
 'counts',(select coalesce(jsonb_agg(to_jsonb(n) order by name),'[]'::jsonb) from (${counts}) n),
 'legacyMarkers',${phase === 'post' ? `(select count(*)::int from notifications.deliveries where scenario_available_at is not null or scenario_dispatch_started_at is not null or scenario_v2_available_at is not null)+(select count(*)::int from support.tickets where internal_only)` : '0'},
 'postRights',${
   phase !== 'pre'
     ? `((select relowner='phub_migrator'::regrole from pg_class where oid='notifications.deliveries'::regclass)
 and has_schema_privilege('phub_migrator','notifications','USAGE') and has_schema_privilege('phub_migrator','notifications','CREATE')
 and ${NOTIFICATION_REFERENCES_SAFE_SQL} and ${NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL})`
     : 'false'
 })::text;
 rollback;`;
}
export function validateNotificationState(value, phase, golden, descriptor) {
  notificationExact(value, [
    'schema',
    'phase',
    'target',
    'ledger',
    'catalog',
    'defaults',
    'security',
    'counts',
    'legacyMarkers',
    'postRights',
  ]);
  notificationExact(value.target, ['databaseName', 'systemIdentifier']);
  if (
    value.schema !== 'PHUB_NOTIFICATION_DATABASE_STATE_V1' ||
    value.phase !== phase ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(value.target.databaseName ?? '') ||
    !/^[1-9][0-9]*$/.test(value.target.systemIdentifier ?? '')
  )
    stop('STATE');
  const expectedCount = phase === 'post' ? 105 : 102;
  if (
    !Array.isArray(value.ledger) ||
    value.ledger.length !== expectedCount ||
    notificationHash(JSON.stringify(value.ledger.map((r) => [r.filename, r.checksum])) + '\n') !==
      (phase === 'post' ? NOTIFICATION_POST_LEDGER : NOTIFICATION_PRE_LEDGER)
  )
    stop('STATE_LEDGER');
  const verified = validateNotificationCatalogFile(golden, descriptor);
  const expected = structuredClone(verified.checkpoints[String(expectedCount)].rows);
  if (phase === 'pre')
    for (const r of expected)
      if (r.key === 'relation:notifications.deliveries') {
        const data = JSON.parse(r.value);
        data.owner = 'phub_beta';
        for (const row of data.acl) {
          if (row[0] === 'MIGRATOR') row[0] = 'phub_beta';
          if (row[1] === 'MIGRATOR') row[1] = 'phub_beta';
        }
        data.acl.sort((a, b) => {
          const x = a[0] + '\0' + a[1] + '\0' + a[2],
            y = b[0] + '\0' + b[1] + '\0' + b[2];
          return x < y ? -1 : x > y ? 1 : 0;
        });
        r.value = JSON.stringify(data);
      }
  // JSONB value formatting is normalized semantically; row ordering and key sets stay exact.
  const semantic = (rows) => JSON.stringify(rows.map((r) => [r.key, JSON.parse(r.value)]));
  if (
    !Array.isArray(value.catalog) ||
    semantic(value.catalog) !== semantic(expected) ||
    value.postRights !== (phase !== 'pre') ||
    value.legacyMarkers !== 0
  )
    stop('STATE_CATALOG');
  if (
    !Array.isArray(value.defaults) ||
    value.defaults.length !== 4 ||
    !notificationSame(value.defaults.map((r) => r.privilege).sort(), [
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]) ||
    value.defaults.some(
      (r) =>
        r.scope !== 'identity' ||
        r.type !== 'r' ||
        r.grantor !== 'phub_migrator' ||
        r.grantee !== 'phub_runtime' ||
        r.grantable !== false,
    )
  )
    stop('STATE_DEFAULTS');
  const sorted = [...NOTIFICATION_NEW_TABLES].sort();
  if (phase === 'post') {
    if (
      !Array.isArray(value.counts) ||
      !notificationSame(
        value.counts.map((r) => r.name),
        sorted,
      ) ||
      value.counts.some((r) => r.count !== 0) ||
      !Array.isArray(value.security) ||
      !notificationSame(
        value.security.map((r) => r.name),
        sorted,
      ) ||
      value.security.some(
        (r) =>
          r.owner !== 'phub_migrator' ||
          r.rls !== true ||
          r.force !== true ||
          r.nonOwnerGrants !== 0 ||
          r.columnAcls !== 0 ||
          r.runtimeAccess !== false,
      )
    )
      stop('STATE_RUNTIME');
  } else if (!notificationSame(value.counts, []) || !notificationSame(value.security, []))
    stop('STATE');
  return value;
}

export function assertNotificationRuntimeOff(bytes) {
  const keys = [
    'NOTIFICATION_SCENARIOS_ENABLED',
    'NOTIFICATION_LIFECYCLE_VIVA_ENABLED',
    'NOTIFICATION_STAFF_TASKS_ENABLED',
    'APNS_ENABLED',
    'SMTP_ENABLED',
    'LOCAL_PASSWORD_RESET_ENABLED',
    'GAME_COMMERCIAL_JOIN_ENABLED',
  ];
  const seen = new Set();
  for (const line of bytes.toString().trimEnd().split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || seen.has(m[1])) stop('ENV');
    seen.add(m[1]);
    if (
      (m[1].startsWith('SUBSCRIPTION_RUNTIME_') &&
        !(m[1] === 'SUBSCRIPTION_RUNTIME_WARN_MODE' && m[2] === 'OFF')) ||
      m[1].startsWith('GAME_COMMERCIAL_JOIN_OWNER_')
    )
      stop('ACTIVATION_FORBIDDEN');
    if (keys.includes(m[1]) && !['false', '0'].includes(m[2])) stop('ACTIVATION_FORBIDDEN');
  }
  if (!seen.has('SUBSCRIPTION_RUNTIME_WARN_MODE')) stop('ACTIVATION_FORBIDDEN');
  return true;
}

export function validateNotificationMonitoringBinding(value) {
  notificationExact(value, ['provider', 'alerts', 'providerSha256', 'alertSha256']);
  for (const [name, key] of [
    ['provider', 'providerSha256'],
    ['alerts', 'alertSha256'],
  ]) {
    if (typeof value[name] !== 'string' || notificationHash(value[name]) !== value[key])
      stop('MONITORING_BINDING');
    parseStrictJson(value[name]);
  }
  return value;
}

// Only this new profile requires a current provider capture throughout activation/observation.
// The legacy bridge's historical monitoring behavior is unchanged.
export function validateNotificationMonitoring(providerBytes, alertBytes, contract, at, previous) {
  const provider = providerBytes.toString(),
    alerts = alertBytes.toString();
  const value = parseStrictJson(provider),
    alertValue = parseStrictJson(alerts);
  const monitors = validateTimewebMonitorReadback(value, contract, at);
  const alertTest = validateTimewebAlertReadback(alertValue, contract);
  validateTimewebMonitoringEvidence({ monitors, alertTest }, contract, at);
  const result = {
    provider,
    alerts,
    providerSha256: notificationHash(provider),
    alertSha256: notificationHash(alerts),
  };
  if (previous) {
    validateNotificationMonitoringBinding(previous);
    const old = parseStrictJson(previous.provider);
    const fixed = (v) => ({
      ...v,
      readAt: null,
      monitors: v.monitors.map((m) => ({
        ...m,
        lastCheckAt: null,
        successfulConsecutiveRounds: null,
      })),
    });
    if (
      result.alertSha256 !== previous.alertSha256 ||
      !notificationSame(fixed(value), fixed(old)) ||
      Date.parse(value.readAt) < Date.parse(old.readAt)
    )
      stop('MONITORING_DRIFT');
    for (let i = 0; i < value.monitors.length; i++)
      if (
        Date.parse(value.monitors[i].lastCheckAt) < Date.parse(old.monitors[i].lastCheckAt) ||
        value.monitors[i].successfulConsecutiveRounds < old.monitors[i].successfulConsecutiveRounds
      )
        stop('MONITORING_REGRESSION');
  }
  return result;
}

// Release-scoped policy: absent provider history is explicitly excluded, never a passing check.
export const NOTIFICATION_OBSERVATION_POLICY = Object.freeze({
  providerHistory: 'NOT_COLLECTED_OUT_OF_RELEASE',
  alertHistory: 'NOT_COLLECTED_OUT_OF_RELEASE',
  runtimeReadiness: 'REQUIRED_EVERY_SAMPLE',
  publicApiWebReadiness: 'REQUIRED_EVERY_SAMPLE',
  samples: 61,
  intervalMs: 15000,
  minimumElapsedMs: 900000,
  apiP95Ms: 1500,
  webP95Ms: 1000,
});
export const NOTIFICATION_OBSERVATION_POLICY_SHA256 = notificationHash(
  JSON.stringify(NOTIFICATION_OBSERVATION_POLICY),
);
export function validateNotificationObservationPolicy(value) {
  notificationExact(value, Object.keys(NOTIFICATION_OBSERVATION_POLICY));
  if (!notificationSame(value, NOTIFICATION_OBSERVATION_POLICY)) stop('OBSERVATION_POLICY');
  return value;
}
export function validateNotificationObservation(value, operationSha256, planSha256) {
  notificationExact(value, [
    'schema',
    'operationSha256',
    'planSha256',
    'observationPolicy',
    'startedAt',
    'completedAt',
    'samples',
    'providerActivation',
    'deviceDelivery',
  ]);
  validateNotificationObservationPolicy(value.observationPolicy);
  const time = (v) =>
    typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
      ? Date.parse(v)
      : NaN;
  const start = time(value.startedAt),
    end = time(value.completedAt);
  if (
    value.schema !== 'PHUB_TIMEWEB_NOTIFICATION_0105_OBSERVATION_V2' ||
    !H.test(operationSha256) ||
    !H.test(planSha256) ||
    value.operationSha256 !== operationSha256 ||
    value.planSha256 !== planSha256 ||
    value.providerActivation !== false ||
    value.deviceDelivery !== false ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end - start < 900000 ||
    !Array.isArray(value.samples) ||
    value.samples.length !== 61
  )
    stop('OBSERVATION');
  let previous;
  for (const sample of value.samples) {
    notificationExact(sample, ['observedAt', 'publicApiMs', 'publicWebMs']);
    const at = time(sample.observedAt);
    if (
      !Number.isFinite(at) ||
      at < start ||
      at > end ||
      (previous !== undefined && at - previous < 15000) ||
      ![sample.publicApiMs, sample.publicWebMs].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 10000,
      )
    )
      stop('OBSERVATION');
    previous = at;
  }
  for (const [key, limit] of [
    ['publicApiMs', 1500],
    ['publicWebMs', 1000],
  ]) {
    const values = value.samples.map((s) => s[key]).sort((a, b) => a - b);
    if (values[Math.ceil(values.length * 0.95) - 1] > limit) stop('OBSERVATION_LATENCY');
  }
  return value;
}
