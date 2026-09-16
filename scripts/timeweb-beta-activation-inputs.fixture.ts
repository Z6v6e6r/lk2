import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  baseImageEvidence,
  parseBaseImageLock,
  validateBaseImageLock,
} from './verify-timeweb-base-images.js';

export const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
  encoding: 'utf8',
}).trim();
export const runId = '12345678901';
export const releaseId = `${sourceSha}-${runId}-1`;
export const host = 'lk2.padlhub.su';
export const tenantKey = 'local-padel';

const strongValue = (purpose: string) =>
  createHash('sha512').update(`synthetic-timeweb-beta-${purpose}`).digest('base64url');
const exact32ByteValue = (purpose: string) =>
  createHash('sha256').update(`synthetic-timeweb-beta-${purpose}`).digest('base64url');

const contract = JSON.parse(
  readFileSync('deploy/timeweb/runtime-environment.contract.json', 'utf8'),
) as {
  services: Record<
    string,
    {
      required: string[];
      requiredTrueFlags: string[];
      requiredFalseFlags: string[];
      requiredDisabledModes: string[];
      requiredOffModes: string[];
    }
  >;
};

function baseEnvironment(service: string): Record<string, string> {
  const values = Object.fromEntries(
    contract.services[service]!.required.map((key) => [key, `synthetic-${key.toLowerCase()}`]),
  );
  for (const key of contract.services[service]!.requiredTrueFlags) values[key] = 'true';
  for (const key of contract.services[service]!.requiredFalseFlags) values[key] = 'false';
  for (const key of contract.services[service]!.requiredDisabledModes) values[key] = 'disabled';
  for (const key of contract.services[service]!.requiredOffModes) values[key] = 'OFF';
  return values;
}

export function safeRuntimeEnvironments(): Record<string, Record<string, string>> {
  const dependencies = {
    DATABASE_URL: 'postgresql://synthetic:synthetic-value@db.internal:5432/phub',
    REDIS_URL: 'rediss://synthetic:synthetic-value@redis.internal:6380/0',
    RABBITMQ_URL: 'amqps://synthetic:synthetic-value@rabbit.internal:5671/phub',
  };
  const common = {
    APP_ENV: 'staging',
    ...dependencies,
    JWT_ISSUER: `https://${host}`,
    JWT_AUDIENCE: 'phub-api',
  };
  const api = {
    ...baseEnvironment('api'),
    ...common,
    LK2_BETA_HOST: host,
    TENANT_KEY: tenantKey,
    JWT_REALTIME_AUDIENCE: 'phub-realtime',
    JWT_ACCESS_SECRET: strongValue('access'),
    JWT_REFRESH_SECRET: strongValue('refresh'),
    JWT_REALTIME_SECRET: strongValue('realtime'),
    AUTH_COOKIE_SECURE: 'true',
    CORS_ORIGINS: `https://${host}`,
    TRUSTED_PROXY_CIDRS: '172.30.26.10/32',
    CUP_DEV_AUTH_ENABLED: 'false',
    VIVA_MODE: 'production',
    VIVA_OAUTH_ENABLED: 'true',
    VIVA_OAUTH_ALLOWED_PROVIDERS: 'yandex',
    VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED: 'true',
    PUBLIC_OFFER_VERSION: '2026-07-18',
    PERSONAL_DATA_POLICY_VERSION: '2026-07-18',
    VIVA_OAUTH_REDIRECT_URI: `https://${host}/user/api/v1/${tenantKey}/auth/viva/callback`,
    VIVA_OAUTH_SUCCESS_REDIRECT_URL: `https://${host}/`,
    VIVA_DELEGATION_ENCRYPTION_KEY: exact32ByteValue('delegation'),
    OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-api-1',
    // Local-only mock Home is not an acceptable beta state: the published legacy Home
    // endpoints must fail closed rather than serve fabricated data.
    HOME_READ_MODE: 'projection',
    HOME_BASE_SYNC_ENABLED: 'true',
    // The projection window must exceed both sync cadences (source and projector advance twenty users
    // every two minutes), otherwise a freshly synchronized section ages out to UNAVAILABLE between
    // cycles. Provider media URLs stay valid for an hour, so thirty minutes of grace is safe.
    HOME_PROJECTION_TTL_SECONDS: '900',
    HOME_PROJECTION_MAX_STALE_SECONDS: '900',
    // Game commands are open for beta testing; participation commands stay off until the shared
    // gateway token, tenant key and principal key exist and are shared with the calling side.
    GAMES_COMMANDS_ENABLED: 'true',
    PARTICIPATION_COMMANDS_ENABLED: 'true',
    // The participation command gateway needs its own shared token and principal identity; the
    // token must be handed to whichever service posts commands before that integration is used.
    PARTICIPATION_COMMAND_TOKEN: 'synthetic-participation-command-token-0123456789',
    PARTICIPATION_COMMAND_TENANT_KEY: tenantKey,
    PARTICIPATION_COMMAND_PRINCIPAL_KEY: 'timeweb-beta.operator:1',
    PARTICIPATION_COMMAND_AUTHORIZATION_TTL_SECONDS: '300',
    // Communities are LOCAL_ONLY in this tenant and the legacy inventory verifier only validates
    // externally produced artifacts, so the contour reads its own data instead of the mock mode.
    COMMUNITIES_READ_MODE: 'local',
    COMMUNITIES_REALTIME_ENABLED: 'true',
    COMMUNITY_HOME_SYNC_ENABLED: 'false',
    PLATFORM_HOME_SYNC_ENABLED: 'false',
    // The Viva End User profile read is the only operation certified for the direct browser
    // transport, so the web client fetches the profile from Viva itself.
    VIVA_DIRECT_READ_ENABLED: 'true',
    // The activity-history game backfill reads the production CUP Mongo store (`games.lk_games`).
    ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: 'true',
    LEGACY_GAMES_MONGODB_URI: 'mongodb://synthetic-mongo.invalid:27017/?authSource=admin',
    LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'mongo',
    LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: tenantKey,
    // The OAuth login reads the provider profile once and stores the phone that keys viewer-scoped
    // legacy reads in integration custody; the phone never becomes a PadlHub login key.
    CUP_IDENTITY_PROFILE_LINK_ENABLED: 'true',
    // Client-assisted avatar sync is a required-true flag, so startup config insists on a complete
    // media-storage binding even in the synthetic fixture.
    S3_ENDPOINT: 'https://s3.twcstorage.ru',
    S3_PUBLIC_ENDPOINT: 'https://s3.twcstorage.ru',
    S3_REGION: 'ru-1',
    S3_BUCKET: 'synthetic-profile-photo-bucket',
    S3_ACCESS_KEY: 'synthetic-media-access-key',
    S3_SECRET_KEY: 'synthetic-media-secret-key',
  };
  const worker = {
    ...baseEnvironment('worker'),
    ...common,
    TENANT_KEY: tenantKey,
    OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-worker-1',
    OUTBOX_PUBLISH_MODE: 'leased',
    WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED: 'true',
    // The top advertising slot lives on its own CUP placement; without this the hero deck only
    // mirrors the standard placement and the slot is never read or mirrored.
    PROMOTIONS_HERO_PLACEMENT: 'cabinet_home_top',
    // Real game and roster synchronization from the public CUP games API. The Mongo mirror stays the
    // staging source for the activity-history game backfill only. The roster sync requires the game
    // read flag, and the worker keeps commands disabled, so its lifecycle process manager stays off.
    GAMES_READ_ENABLED: 'true',
    LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
    LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'mongo',
    LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: tenantKey,
    LEGACY_GAMES_MONGODB_URI: 'mongodb://synthetic-mongo.invalid:27017/?authSource=admin',
    HOME_PROJECTION_TTL_SECONDS: '900',
    HOME_PROJECTION_MAX_STALE_SECONDS: '900',
    // A full synchronization pass over the tenant must stay well inside the freshness window: with the
    // default twenty users per two minutes a pass took about eighteen minutes, so a user's section was
    // rewritten just before its source advanced and expired before the next visit.
    HOME_BASE_SYNC_INTERVAL_MS: '60000',
    HOME_BASE_SYNC_BATCH_SIZE: '40',
    PROMOTIONS_SYNC_INTERVAL_MS: '60000',
    PROMOTIONS_SYNC_BATCH_SIZE: '40',
    COMMUNITY_HOME_SYNC_INTERVAL_MS: '60000',
    COMMUNITY_HOME_SYNC_BATCH_SIZE: '40',
    // The Worker's profile-photo maintenance is a required-true flag, so its config insists on the
    // same media-storage binding the API carries.
    S3_ENDPOINT: 'https://s3.twcstorage.ru',
    S3_PUBLIC_ENDPOINT: 'https://s3.twcstorage.ru',
    S3_REGION: 'ru-1',
    S3_BUCKET: 'synthetic-profile-photo-bucket',
    S3_ACCESS_KEY: 'synthetic-media-access-key',
    S3_SECRET_KEY: 'synthetic-media-secret-key',
  };
  const realtime = {
    ...baseEnvironment('realtime'),
    ...common,
    REALTIME_EXPECTED_REPLICAS: '1',
    JWT_REALTIME_AUDIENCE: 'phub-realtime',
    JWT_REALTIME_SECRET: api.JWT_REALTIME_SECRET,
    OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-realtime-1',
  };
  const migrator = {
    ...baseEnvironment('migrator'),
    DATABASE_URL: dependencies.DATABASE_URL,
    MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
  };
  return { api, worker, realtime, migrator };
}

export function encodeEnvironment(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

export function createSecretFixture() {
  const root = mkdtempSync(join(realpathSync(process.cwd()), '.phub-timeweb-activation-inputs-'));
  chmodSync(root, 0o700);
  const sourceDir = join(root, 'source');
  const hostEtc = join(root, 'host-etc');
  const targetParent = join(hostEtc, 'phub');
  const targetDir = join(targetParent, 'timeweb-beta');
  const backupRoot = join(targetParent, 'timeweb-beta-backups');
  const githubTokenFile = join(root, 'github-token');
  mkdirSync(sourceDir, { mode: 0o700 });
  mkdirSync(hostEtc, { mode: 0o700 });
  writeFileSync(githubTokenFile, `ghp_${'x'.repeat(36)}\n`, {
    mode: 0o600,
  });
  const files = {
    api: 'api.env',
    worker: 'worker.env',
    realtime: 'realtime.env',
    migrator: 'migrator.env',
  };
  const environments = safeRuntimeEnvironments();
  for (const [service, name] of Object.entries(files)) {
    writeFileSync(join(sourceDir, name), encodeEnvironment(environments[service]!), {
      mode: 0o600,
    });
  }
  return {
    root,
    sourceDir,
    targetDir,
    backupRoot,
    targetParent,
    githubTokenFile,
    githubCredentialContract: {
      schema: 'PHUB_TIMEWEB_GITHUB_RELEASE_READER_V1',
      file: {
        path: githubTokenFile,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mode: '0600',
        linkCount: 1,
        minimumBytes: 40,
        maximumBytes: 256,
      },
      credential: {
        type: 'github_personal_access_token_classic',
        prefix: 'ghp_',
        requiredScopes: ['read:packages'],
        scopeAuthority: 'github_x_oauth_scopes_exact',
      },
      resources: {
        repository: 'Z6v6e6r/lk2',
        packages: [
          'Z6v6e6r/phub-api',
          'Z6v6e6r/phub-migrator',
          'Z6v6e6r/phub-realtime',
          'Z6v6e6r/phub-web',
          'Z6v6e6r/phub-worker',
        ],
      },
      lifecycle: {
        oneShot: true,
        maximumFileAgeSeconds: 3600,
        revokeAfterUse: true,
        rotationOwner: 'Z6v6e6r repository owner',
      },
    },
    environments,
  };
}

export function canonicalManifest() {
  const lockBytes = readFileSync('deploy/timeweb/base-images.lock.json');
  const base = baseImageEvidence(validateBaseImageLock(parseBaseImageLock(lockBytes)), lockBytes);
  const components = ['web', 'api', 'worker', 'realtime', 'migrator'];
  return {
    schemaVersion: 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
    repository: 'Z6v6e6r/lk2',
    gitCommit: sourceSha,
    gitTree: sourceTree,
    platform: 'linux/amd64',
    publication: {
      workflow: '.github/workflows/publish-timeweb-amd64-images.yaml',
      workflowSha: sourceSha,
      runId,
      runAttempt: '1',
    },
    baseLock: base.baseLock,
    baseImages: base.baseImages,
    images: components.map((component, index) => {
      const runtimeDigest = `sha256:${(index + 6).toString(16).repeat(64)}`;
      return {
        component,
        repository: `ghcr.io/z6v6e6r/phub-${component}`,
        digest: `sha256:${(index + 1).toString(16).repeat(64)}`,
        runtimeDigest,
        architecture: 'amd64',
        revision: sourceSha,
        provenance: true,
        provenanceSubject: runtimeDigest,
        sbom: true,
        sbomSubject: runtimeDigest,
        sourceMaterialSha: sourceSha,
        publication: true,
      };
    }),
  };
}

export function writeCanonicalPair(directory: string, manifest = canonicalManifest()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const contents = `${JSON.stringify(manifest)}\n`;
  const checksum = createHash('sha256').update(contents).digest('hex');
  const manifestPath = join(directory, 'release-manifest.json');
  writeFileSync(manifestPath, contents, { mode: 0o600 });
  writeFileSync(
    join(directory, 'release-manifest.sha256'),
    `${checksum}  release-manifest.json\n`,
    {
      mode: 0o600,
    },
  );
  const checksumContents = `${checksum}  release-manifest.json\n`;
  return { manifestPath, checksum, contents, checksumContents };
}

function fixtureCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function canonicalArtifactArchive(
  manifestContents: string,
  checksumContents: string,
  extraEntries: ReadonlyArray<readonly [string, Buffer]> = [],
) {
  const entries = [
    ['release-manifest.json', Buffer.from(manifestContents)],
    ['release-manifest.sha256', Buffer.from(checksumContents)],
    ...extraEntries,
  ] as const;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(fixtureCrc32(contents), 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(fixtureCrc32(contents), 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

export function githubApiFixture(pair: ReturnType<typeof writeCanonicalPair>) {
  const manifest = canonicalManifest();
  const archive = canonicalArtifactArchive(pair.contents, pair.checksumContents);
  const artifactDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const artifactId = 9876543210;
  const artifactName = `timeweb-amd64-canonical-release-${sourceSha}-${runId}-1`;
  const scopedJson = (value: unknown) =>
    Response.json(value, { headers: { 'x-oauth-scopes': 'read:packages' } });
  const fetch = (input: string | URL | Request) =>
    Promise.resolve().then(() => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(`/actions/runs/${runId}/attempts/1`))
        return scopedJson({
          id: Number(runId),
          run_attempt: 1,
          head_sha: sourceSha,
          path: '.github/workflows/publish-timeweb-amd64-images.yaml',
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'success',
          updated_at: '2026-08-27T00:00:00.000Z',
        });
      if (url.endsWith(`/actions/runs/${runId}/artifacts?per_page=100`))
        return scopedJson({
          artifacts: [
            {
              id: artifactId,
              name: artifactName,
              digest: artifactDigest,
              expired: false,
              archive_download_url: `https://api.github.com/repos/Z6v6e6r/lk2/actions/artifacts/${artifactId}/zip`,
              workflow_run: { id: Number(runId), head_sha: sourceSha },
            },
          ],
        });
      if (url.endsWith(`/actions/artifacts/${artifactId}/zip`))
        return Response.json(
          { message: 'You must have the actions scope to download artifacts.' },
          { status: 403, headers: { 'x-oauth-scopes': 'read:packages' } },
        );
      const component = manifest.images.find(({ component }) =>
        url.includes(`/packages/container/phub-${component}/versions?`),
      );
      if (component)
        return scopedJson([
          {
            name: component.digest,
            metadata: { package_type: 'container', container: { tags: [] } },
          },
        ]);
      return new Response(null, { status: 404 });
    });
  return { archive, artifactDigest, artifactId, artifactName, fetch };
}

export function canonicalRunEvidence(manifestChecksum: string) {
  return {
    schema: 'PHUB_TIMEWEB_CANONICAL_RUN_EVIDENCE_V1',
    repository: 'Z6v6e6r/lk2',
    workflowPath: '.github/workflows/publish-timeweb-amd64-images.yaml',
    workflowSha: sourceSha,
    sourceSha,
    sourceTree,
    runId,
    runAttempt: '1',
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    authenticatedSource: 'github-actions-api',
    observedAt: '2026-08-27T00:00:00.000Z',
    canonicalArtifact: {
      id: '9876543210',
      name: `timeweb-amd64-canonical-release-${sourceSha}-${runId}-1`,
      digest: `sha256:${'b'.repeat(64)}`,
      expired: false,
      files: ['release-manifest.json', 'release-manifest.sha256'],
    },
    registryInventory: {
      complete: true,
      presentImages: 5,
      expectedImages: 5,
    },
    releaseManifestSha256: manifestChecksum,
  };
}

export function writeCanonicalRunEvidence(directory: string, manifestChecksum: string) {
  const evidence = canonicalRunEvidence(manifestChecksum);
  const contents = `${JSON.stringify(evidence)}\n`;
  const checksum = createHash('sha256').update(contents).digest('hex');
  const evidencePath = join(directory, 'canonical-run-evidence.json');
  writeFileSync(evidencePath, contents, { mode: 0o600 });
  writeFileSync(
    join(directory, 'canonical-run-evidence.sha256'),
    `${checksum}  canonical-run-evidence.json\n`,
    { mode: 0o600 },
  );
  return { evidence, evidencePath, checksum, contents };
}
