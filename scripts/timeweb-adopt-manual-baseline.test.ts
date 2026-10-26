import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type * as NativeFs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ADOPTED_MANUAL_FULL_KIND,
  buildAdoptionArtifacts,
  validateAdoptionOperation,
  validateAdoptedBaseline,
} from './timeweb-adopt-manual-baseline.js';
import type { AdoptionArtifactsInputs } from './timeweb-adopt-manual-baseline.js';

const root = '/opt/phub/timeweb-beta';
const runtimeRoot = '/etc/phub/timeweb-beta';
const releaseSha = 'a'.repeat(40);
const releaseTree = 'b'.repeat(40);
const publicationRunId = '37038298584';
const sourceCiRunId = '37034485776';
const artifactId = '11241473445';
const releaseId = `${releaseSha}-${publicationRunId}-1`;
const previousReleaseId = `${'c'.repeat(40)}-555-1`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const image = (service: string, value: string) => `ghcr.io/z6v6e6r/phub-${service}@${value}`;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const previousDescriptor = Buffer.from(
  [
    `PHUB_RELEASE_ID=${previousReleaseId}`,
    'PHUB_COMPONENT_ROLLOUT_KIND=API_WEB',
    'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA=PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
    `API_IMAGE_DIGEST=${digest('0')}`,
    `WEB_IMAGE_DIGEST=${digest('f')}`,
    `PHUB_RUNTIME_SECRET_SET_RELEASE_ID=${previousReleaseId}`,
  ].join('\n') + '\n',
);
const currentDescriptor = Buffer.from(
  [
    `PHUB_RELEASE_ID=${releaseId}`,
    'PHUB_COMPONENT_ROLLOUT_KIND=SIMPLIFIED_FULL',
    'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA=PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
    `API_IMAGE_DIGEST=${digest('1')}`,
    `WEB_IMAGE_DIGEST=${digest('2')}`,
    `PHUB_RUNTIME_SECRET_SET_RELEASE_ID=${previousReleaseId}`,
    'PHUB_MIGRATOR_ENABLED=false',
  ].join('\n') + '\n',
);
const secretFiles: Record<string, Buffer> = {
  '.release-identity.json': Buffer.from(
    JSON.stringify({ releaseId: previousReleaseId, schema: 'PHUB_TIMEWEB_SECRET_SET_V1' }) + '\n',
  ),
  'api.env': Buffer.from('API_FIXTURE=1\n'),
  'worker.env': Buffer.from('WORKER_FIXTURE=1\n'),
  'realtime.env': Buffer.from('REALTIME_FIXTURE=1\n'),
  'migrator.env': Buffer.from('MIGRATOR_FIXTURE=1\n'),
};
const secretHashes = Object.fromEntries(
  Object.entries(secretFiles).map(([name, bytes]) => [name, sha256(bytes)]),
);
const imageDigests = {
  api: digest('1'),
  web: digest('2'),
  realtime: digest('3'),
  worker: digest('4'),
  migrator: digest('5'),
};
const containerEvidence: AdoptionArtifactsInputs['containers'] = {
  api: {
    id: '6'.repeat(64),
    image: image('api', imageDigests.api),
    releaseId,
    revision: releaseSha,
    imageId: 'a'.repeat(64),
  },
  web: {
    id: '7'.repeat(64),
    image: image('web', imageDigests.web),
    releaseId,
    revision: releaseSha,
    imageId: 'b'.repeat(64),
  },
  realtime: {
    id: '8'.repeat(64),
    image: image('realtime', imageDigests.realtime),
    releaseId: null,
    revision: releaseSha,
    imageId: 'c'.repeat(64),
  },
  worker: {
    id: '9'.repeat(64),
    image: image('worker', imageDigests.worker),
    releaseId: null,
    revision: releaseSha,
    imageId: 'd'.repeat(64),
  },
};
const githubEvidence: AdoptionArtifactsInputs['github'] = {
  publicationRun: {
    id: Number(publicationRunId),
    head_sha: releaseSha,
    head_branch: 'main',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    path: '.github/workflows/publish-timeweb-amd64-images.yaml',
  },
  publicationArtifacts: {
    total_count: 1,
    artifacts: [
      {
        id: Number(artifactId),
        name: `timeweb-amd64-canonical-release-${releaseSha}-${publicationRunId}-1`,
        expired: false,
        digest: digest('d'),
      },
    ],
  },
  sourceCiRun: {
    id: Number(sourceCiRunId),
    head_sha: releaseSha,
    run_attempt: 1,
    conclusion: 'success',
    path: '.github/workflows/pull-request.yaml',
  },
};

function freshOperation() {
  return {
    schema: 'PHUB_TIMEWEB_ADOPT_MANUAL_BASELINE_V1',
    profile: 'beta',
    controllerSha: '4'.repeat(40),
    controllerTree: '5'.repeat(40),
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    release: {
      releaseId,
      sha: releaseSha,
      tree: releaseTree,
      sourceCiRunId,
      publicationRunId,
      artifactId,
      artifactDigest: digest('d'),
      manifestSha256: 'e'.repeat(64),
    },
    images: { ...imageDigests },
    containers: {
      api: { id: '6'.repeat(64), image: image('api', imageDigests.api) },
      web: { id: '7'.repeat(64), image: image('web', imageDigests.web) },
      realtime: { id: '8'.repeat(64), image: image('realtime', imageDigests.realtime) },
      worker: { id: '9'.repeat(64), image: image('worker', imageDigests.worker) },
    },
    expectedCurrentBaseline: {
      releaseId: previousReleaseId,
      descriptorSha256: sha256(previousDescriptor),
      currentDescriptorSha256: sha256(currentDescriptor),
    },
    secretSet: { releaseId: previousReleaseId, files: { ...secretHashes } },
    expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    confirmation: `ADOPT_MANUAL_BASELINE_${releaseSha.slice(0, 12).toUpperCase()}_KEEP_SECRETS_${previousReleaseId.slice(0, 12).toUpperCase()}`,
  };
}
type Operation = ReturnType<typeof freshOperation>;

const baseOperation: Operation = {
  ...freshOperation(),
  expiresAt: '2026-10-26T12:30:00.000Z',
};

function buildInputsFor(
  operation: Operation,
  adoptedAt = '2026-10-26T10:00:00.000Z',
): AdoptionArtifactsInputs {
  return {
    requestBytes: Buffer.from(JSON.stringify(operation, null, 2) + '\n'),
    previousDescriptorBytes: previousDescriptor,
    secretFiles,
    containers: containerEvidence,
    github: githubEvidence,
    controller: { sha: operation.controllerSha, tree: operation.controllerTree },
    adoptedAt,
  };
}

const PARSE_ENV = `
  const parseEnv = (bytes) => Object.fromEntries(
    bytes.toString('utf8').trimEnd().split('\\n').map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
`;
const PRELUDE = `
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const base64 = (value) => Buffer.from(value, 'base64');
  const BASE_OPERATION = ${JSON.stringify(baseOperation)};
  const operation = () => ({
    ...structuredClone(BASE_OPERATION),
    expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
  });
  const requestBytes = (value = operation()) =>
    Buffer.from(JSON.stringify(value, null, 2) + '\\n');
  const previousDescriptorBytes = base64(${JSON.stringify(previousDescriptor.toString('base64'))});
  const currentDescriptorBytes = base64(${JSON.stringify(currentDescriptor.toString('base64'))});
  const secretFiles = {
    ${Object.entries(secretFiles)
      .map(
        ([name, bytes]) =>
          `${JSON.stringify(name)}: base64(${JSON.stringify(bytes.toString('base64'))})`,
      )
      .join(',\n    ')}
  };
  const containerEvidence = ${JSON.stringify(containerEvidence)};
  const githubEvidence = ${JSON.stringify(githubEvidence)};
  const buildInputs = (value = operation(), adoptedAt = '2026-10-26T10:00:00.000Z') => ({
    requestBytes: requestBytes(value),
    previousDescriptorBytes,
    secretFiles,
    containers: containerEvidence,
    github: githubEvidence,
    controller: { sha: value.controllerSha, tree: value.controllerTree },
    adoptedAt,
  });
  const adoptionRoot = '/opt/phub/timeweb-beta';
  const operatorPath = adoptionRoot + '/operator/adopt-manual-baseline.json';
  const fakeHost = (request, descriptor = currentDescriptorBytes, extra = {}) => {
    const entry = JSON.parse(request.toString());
    const directory = adoptionRoot + '/releases/' + entry.release.releaseId;
    const paths = {
      descriptor: directory + '/installed-components.env',
      receipt: directory + '/adoption-receipt.json',
      request: directory + '/adoption-request.json',
      preimage: directory + '/installed-components.pre-adoption.env',
      previous:
        adoptionRoot + '/releases/' + entry.expectedCurrentBaseline.releaseId + '/installed-components.env',
    };
    const files = new Map([
      [operatorPath, request],
      [paths.descriptor, descriptor],
      [paths.previous, previousDescriptorBytes],
    ]);
    for (const [name, bytes] of Object.entries(secretFiles))
      files.set('/etc/phub/timeweb-beta/' + name, bytes);
    for (const [path, bytes] of Object.entries(extra.files ?? {})) files.set(path, bytes);
    const writes = [];
    const calls = { docker: [], github: [] };
    const readFile = (path) => files.get(path);
    const writeFileAtomic = (path, bytes, exclusive) => {
      if (exclusive && files.has(path))
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      writes.push(path);
      files.set(path, bytes);
    };
    const dockerInspect = (service) => {
      calls.docker.push(service);
      if (extra.docker) return extra.docker(service, containerEvidence[service]);
      return { ...containerEvidence[service], healthy: true, restarts: 0 };
    };
    const fetchJson = async (path) => {
      calls.github.push(path);
      if (extra.fetch) return extra.fetch(path, githubEvidence);
      if (path === 'actions/runs/' + entry.release.publicationRunId)
        return githubEvidence.publicationRun;
      if (path.endsWith('/artifacts?per_page=100')) return githubEvidence.publicationArtifacts;
      return githubEvidence.sourceCiRun;
    };
    const options = {
      readFile,
      writeFileAtomic,
      dockerInspect,
      fetchJson,
      getuid: () => 0,
      now: () => new Date(),
      readControllerSource: () => ({
        sha: entry.controllerSha,
        tree: entry.controllerTree,
        dirty: false,
      }),
      ...(extra.options ?? {}),
    };
    return { files, writes, calls, options, directory, paths, request, entry };
  };
`;

function scenario(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { ADOPTED_MANUAL_FULL_KIND, buildAdoptionArtifacts, canonicalArtifactName, runAdoptManualBaseline, validateAdoptionOperation, validateAdoptionReceipt, validateAdoptedBaseline } from './scripts/timeweb-adopt-manual-baseline.js';
    ${PARSE_ENV}
    ${PRELUDE}
    ${body}
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

function parseEnv(bytes: Buffer) {
  return Object.fromEntries(
    bytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

describe('beta manual-baseline adoption operation', () => {
  it('admits exactly one beta adoption request and rejects every changed authority field', () => {
    const operation = freshOperation();
    expect(validateAdoptionOperation(operation, new Date())).toEqual(operation);
    const mutations: Array<(value: Operation) => void> = [
      (value) => {
        value.schema = 'PHUB_TIMEWEB_ADOPT_MANUAL_BASELINE_V2';
      },
      (value) => {
        value.profile = 'production';
      },
      (value) => {
        value.controllerSha = 'f'.repeat(39);
      },
      (value) => {
        value.controllerTree = 'not-a-tree';
      },
      (value) => {
        value.target.hostname = 'elsewhere.example';
      },
      (value) => {
        value.target.serverId = 1;
      },
      (value) => {
        value.target.projectId = 1;
      },
      (value) => {
        value.release.sha = 'f'.repeat(40);
      },
      (value) => {
        value.release.tree = 'latest';
      },
      (value) => {
        value.release.releaseId = `${releaseSha}-1-1`;
      },
      (value) => {
        value.release.sourceCiRunId = '0';
      },
      (value) => {
        value.release.publicationRunId = '1;id';
      },
      (value) => {
        value.release.artifactId = '01';
      },
      (value) => {
        value.release.artifactDigest = digest('D');
      },
      (value) => {
        value.release.manifestSha256 = 'short';
      },
      (value) => {
        value.images.api = 'sha256:abc';
      },
      (value) => {
        value.containers.api.image = value.containers.web.image;
      },
      (value) => {
        value.containers.web.id = 'nothex';
      },
      (value) => {
        value.expectedCurrentBaseline.releaseId = value.release.releaseId;
      },
      (value) => {
        value.expectedCurrentBaseline.descriptorSha256 = 'f'.repeat(63);
      },
      (value) => {
        value.expectedCurrentBaseline.currentDescriptorSha256 = '';
      },
      (value) => {
        value.secretSet.releaseId = value.release.releaseId;
      },
      (value) => {
        value.secretSet.files['api.env'] = 'short';
      },
      (value) => {
        value.secretSet.files['extra.env'] = 'f'.repeat(64);
      },
      (value) => {
        value.confirmation = `ADOPT_MANUAL_BASELINE_${releaseSha.slice(0, 12).toUpperCase()}_KEEP_SECRETS`;
      },
      (value) => {
        Reflect.deleteProperty(value, 'expiresAt');
      },
      (value) => {
        Reflect.deleteProperty(value.release, 'tree');
      },
      (value) => {
        (value as unknown as Record<string, unknown>).extra = true;
      },
    ];
    for (const mutate of mutations) {
      const altered = structuredClone(operation);
      mutate(altered);
      expect(() => validateAdoptionOperation(altered, new Date())).toThrow();
    }
  });
  it('requires 20-60 minutes of forward authority and never production', () => {
    scenario(`
      const now = new Date('2026-10-26T12:00:00.000Z');
      for (const minutes of [20, 45, 60]) {
        const value = { ...operation(), expiresAt: new Date(now.getTime() + minutes * 60000).toISOString() };
        assert.equal(validateAdoptionOperation(value, now), value);
      }
      for (const minutes of [19, 61, 0, -5]) {
        const value = { ...operation(), expiresAt: new Date(now.getTime() + minutes * 60000).toISOString() };
        assert.throws(() => validateAdoptionOperation(value, now), /invalid_expiry/);
      }
      assert.throws(() => validateAdoptionOperation({ ...operation(), expiresAt: '2026-10-26T12:00:00Z' }, now), /invalid_expiry/);
      assert.throws(() => validateAdoptionOperation({ ...operation(), profile: 'production' }, now), /invalid_operation/);
    `);
  });
});

describe('adoption artifact construction', () => {
  it('renders the deterministic adopted descriptor and bound receipt', () => {
    scenario(`
      const value = operation();
      const inputs = buildInputs(value);
      const built = buildAdoptionArtifacts(value, inputs);
      const text = built.descriptorBytes.toString('utf8');
      assert(text.endsWith('\\n'));
      assert(!text.includes('PHUB_CANONICAL_'));
      assert(!text.includes('PHUB_RELEASE_SOURCE_'));
      const lines = text.trimEnd().split('\\n');
      const descriptor = Object.fromEntries(lines.map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }));
      assert.deepEqual(Object.keys(descriptor), [...Object.keys(descriptor)].sort());
      assert.deepEqual(Object.keys(descriptor), ${JSON.stringify(['API_IMAGE_DIGEST', 'COMPOSE_PROFILES', 'MIGRATOR_IMAGE_DIGEST', 'PHUB_ADOPTION_REQUEST_SHA256', 'PHUB_ADOPTION_SOURCE', 'PHUB_API_RUNTIME_ENV_FILE', 'PHUB_COMPONENT_ROLLOUT_KIND', 'PHUB_COMPONENT_ROLLOUT_RECEIPT', 'PHUB_MIGRATOR_ENABLED', 'PHUB_MIGRATOR_RUNTIME_ENV_FILE', 'PHUB_REALTIME_RUNTIME_ENV_FILE', 'PHUB_RELEASE_ID', 'PHUB_ROLLBACK_MODE', 'PHUB_ROLLBACK_PREVIOUS_RELEASE_ID', 'PHUB_RUNTIME_SECRET_SET_RELEASE_ID', 'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA', 'PHUB_WORKER_ENABLED', 'PHUB_WORKER_RUNTIME_ENV_FILE', 'REALTIME_IMAGE_DIGEST', 'REGISTRY', 'TIMEWEB_FCM_CREDENTIAL_SOURCE', 'TIMEWEB_RUNTIME_ENV_ROOT', 'WEB_IMAGE_DIGEST', 'WORKER_IMAGE_DIGEST'])});
      assert.equal(descriptor.PHUB_COMPONENT_ROLLOUT_KIND, ADOPTED_MANUAL_FULL_KIND);
      assert.equal(descriptor.PHUB_ADOPTION_SOURCE, 'manual-compose-simplified');
      assert.equal(descriptor.PHUB_ADOPTION_REQUEST_SHA256, sha256(inputs.requestBytes));
      assert.equal(descriptor.PHUB_RELEASE_ID, value.release.releaseId);
      assert.equal(descriptor.PHUB_ROLLBACK_PREVIOUS_RELEASE_ID, value.expectedCurrentBaseline.releaseId);
      assert.equal(descriptor.API_IMAGE_DIGEST, value.images.api);
      assert.equal(descriptor.MIGRATOR_IMAGE_DIGEST, value.images.migrator);
      assert.equal(descriptor.PHUB_COMPONENT_ROLLOUT_RECEIPT, ${JSON.stringify(root)} + '/releases/' + value.release.releaseId + '/adoption-receipt.json');
      const receipt = JSON.parse(built.receiptBytes.toString('utf8'));
      validateAdoptionReceipt(receipt);
      assert.throws(() => validateAdoptionReceipt({ ...receipt, declaredUnverifiedInputs: ['tree', 'manifestSha256', 'images.migrator'] }), /adoption_receipt/);
      assert.throws(() => validateAdoptionReceipt({ ...receipt, controllerSha: 'short' }), /adoption_receipt/);
      assert.equal(receipt.descriptorSha256, sha256(built.descriptorBytes));
      assert.equal(receipt.requestSha256, sha256(inputs.requestBytes));
      assert.equal(receipt.previousBaselineSha256, sha256(previousDescriptorBytes));
      assert.deepEqual(receipt.images, value.images);
      assert.deepEqual(receipt.containers.api, {
        id: value.containers.api.id,
        image: value.containers.api.image,
        releaseId: value.release.releaseId,
      });
      assert.equal(receipt.githubVerification.canonicalArtifactName, canonicalArtifactName(value.release.sha, value.release.publicationRunId));
      assert.equal(receipt.runtimeEvidence.rolloutReceipt, 'absent-manual-compose');
      assert.equal(receipt.controllerSha, value.controllerSha);
      assert.equal(receipt.controllerTree, value.controllerTree);
      assert.deepEqual(receipt.declaredUnverifiedInputs, ['manifestSha256', 'tree', 'images.migrator']);
      assert(!('rolloutReceiptSha256' in receipt));
      assert(!('PHUB_CANONICAL_MANIFEST' in receipt));
    `);
  });
  it('rejects previous baseline drift, kind, byte binding and request binding', () => {
    scenario(`
      const value = operation();
      const inputs = buildInputs(value);
      const reject = (code, change) => {
        const copy = {
          ...inputs,
          containers: structuredClone(inputs.containers),
          secretFiles: { ...inputs.secretFiles },
          github: structuredClone(inputs.github),
        };
        change(copy);
        assert.throws(() => buildAdoptionArtifacts(value, copy), new RegExp(code));
      };
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        previousDescriptorBytes: Buffer.from(previousDescriptorBytes.toString('utf8').replace('PHUB_COMPONENT_ROLLOUT_KIND=API_WEB', 'PHUB_COMPONENT_ROLLOUT_KIND=SIMPLIFIED_FULL')),
      }), /previous_baseline_drift/);
      assert.throws(() => buildAdoptionArtifacts(value, { ...inputs, previousDescriptorBytes: currentDescriptorBytes }), /previous_baseline_drift/);
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        previousDescriptorBytes: Buffer.from(previousDescriptorBytes.toString('utf8').replace('PHUB_COMPONENT_ROLLOUT_KIND=API_WEB', 'PHUB_COMPONENT_ROLLOUT_KIND=API_WEB_JOIN_DORMANT_0105')),
      }), /previous_baseline_drift/);
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        previousDescriptorBytes: Buffer.from(previousDescriptorBytes.toString('utf8').replace('PHUB_COMPONENT_ROLLOUT_KIND=API_WEB', 'PHUB_COMPONENT_ROLLOUT_KIND=API_WORKER')),
      }), /previous_baseline_drift/);
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        controller: { sha: 'f'.repeat(40), tree: value.controllerTree },
      }), /controller_source_mismatch/);
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        controller: { sha: value.controllerSha, tree: 'f'.repeat(40) },
      }), /controller_source_mismatch/);
      reject('previous_baseline_drift', (copy) => {
        copy.previousDescriptorBytes = Buffer.from(previousDescriptorBytes.toString('utf8').replace('PHUB_TIMEWEB_RELEASE_ENV_SCHEMA=PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1', 'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA=OTHER'));
      });
      const altered = operation();
      altered.release.manifestSha256 = 'f'.repeat(64);
      assert.throws(() => buildAdoptionArtifacts(altered, inputs), /operation_binding/);
      assert.throws(() => buildAdoptionArtifacts(value, { ...inputs, adoptedAt: 'yesterday' }), /invalid_adopted_at/);
      assert.throws(() => buildAdoptionArtifacts(value, { ...inputs, extra: true }), /invalid_keys/);
    `);
  });
  it('rejects container identity, image, revision and release label drift', () => {
    scenario(`
      const value = operation();
      const inputs = buildInputs(value);
      const reject = (code, change) => {
        const copy = { ...inputs, containers: structuredClone(inputs.containers) };
        change(copy.containers);
        assert.throws(() => buildAdoptionArtifacts(value, copy), new RegExp(code));
      };
      reject('container_image', (containers) => { containers.api.image = containers.web.image; });
      reject('container_revision', (containers) => { containers.web.revision = 'f'.repeat(40); });
      reject('container_release', (containers) => { containers.api.releaseId = null; });
      reject('container_release', (containers) => { containers.worker.releaseId = 'f'.repeat(40) + '-0-1'; });
      reject('container_identity', (containers) => { containers.api.id = 'f'.repeat(64); });
      reject('container_identity', (containers) => { containers.api.imageId = 'short'; });
    `);
  });
  it('rejects secret-set hash and marker release drift', () => {
    scenario(`
      const value = operation();
      const inputs = buildInputs(value);
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        secretFiles: { ...inputs.secretFiles, 'api.env': Buffer.from('tampered') },
      }), /secret_set_drift/);
      assert.throws(() => buildAdoptionArtifacts(value, {
        ...inputs,
        secretFiles: {
          ...inputs.secretFiles,
          '.release-identity.json': Buffer.from(JSON.stringify({ releaseId: value.release.releaseId, schema: 'PHUB_TIMEWEB_SECRET_SET_V1' })),
        },
      }), /secret_set_drift/);
    `);
  });
  it('rejects publication, artifact and source CI evidence mismatch', () => {
    scenario(`
      const value = operation();
      const inputs = buildInputs(value);
      const reject = (code, change) => {
        const copy = { ...inputs, github: structuredClone(inputs.github) };
        change(copy.github);
        assert.throws(() => buildAdoptionArtifacts(value, copy), new RegExp(code));
      };
      reject('github_publication', (github) => { github.publicationRun.head_sha = 'f'.repeat(40); });
      reject('github_publication', (github) => { github.publicationRun.head_branch = 'release'; });
      reject('github_publication', (github) => { github.publicationRun.run_attempt = 2; });
      reject('github_publication', (github) => { github.publicationRun.conclusion = 'failure'; });
      reject('github_publication', (github) => { github.publicationRun.path = '.github/workflows/other.yaml'; });
      reject('github_artifacts', (github) => { github.publicationArtifacts.artifacts[0].digest = 'sha256:' + 'f'.repeat(64); });
      reject('github_artifacts', (github) => { github.publicationArtifacts.artifacts[0].expired = true; });
      reject('github_artifacts', (github) => { github.publicationArtifacts.artifacts[0].id = 1; });
      reject('github_artifacts', (github) => { github.publicationArtifacts.total_count = 2; });
      reject('github_artifacts', (github) => { github.publicationArtifacts.artifacts = []; });
      reject('github_source', (github) => { github.sourceCiRun.conclusion = 'failure'; });
      reject('github_source', (github) => { github.sourceCiRun.path = '.github/workflows/other.yaml'; });
      reject('github_source', (github) => { github.sourceCiRun.run_attempt = 2; });
      reject('github_source', (github) => { github.sourceCiRun.head_sha = 'f'.repeat(40); });
    `);
  });
});

describe('adopted baseline readback', () => {
  const fixture = (() => {
    const operation = freshOperation();
    const inputs = buildInputsFor(operation);
    const built = buildAdoptionArtifacts(operation, inputs);
    return { inputs, descriptorBytes: built.descriptorBytes, receiptBytes: built.receiptBytes };
  })();
  const directory = `${root}/releases/${releaseId}`;
  const evidenceFiles = () =>
    new Map<string, Buffer>([
      [`${directory}/installed-components.env`, fixture.descriptorBytes],
      [`${directory}/adoption-receipt.json`, fixture.receiptBytes],
      [`${directory}/adoption-request.json`, fixture.inputs.requestBytes],
    ]);
  const reader = (files: Map<string, Buffer>) => (path: string) => files.get(path);

  it('accepts the adopted descriptor only with its request and receipt', () => {
    const values = parseEnv(fixture.descriptorBytes);
    expect(
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(evidenceFiles()),
      }),
    ).toMatchObject({
      schema: 'PHUB_TIMEWEB_ADOPTION_RECEIPT_V1',
      status: 'SUCCESS',
      adoptedFrom: 'manual-compose-simplified',
    });
  });
  it('rejects kind, identity, missing and drifted evidence', () => {
    const values = parseEnv(fixture.descriptorBytes);
    expect(() =>
      validateAdoptedBaseline(
        { ...values, PHUB_COMPONENT_ROLLOUT_KIND: 'SIMPLIFIED_FULL' },
        fixture.descriptorBytes,
        directory,
        releaseId,
        { readFile: reader(evidenceFiles()) },
      ),
    ).toThrow('installed_baseline_kind');
    expect(() =>
      validateAdoptedBaseline(
        { ...values, PHUB_RELEASE_ID: previousReleaseId },
        fixture.descriptorBytes,
        directory,
        releaseId,
        { readFile: reader(evidenceFiles()) },
      ),
    ).toThrow('installed_baseline_identity');
    const missingReceipt = evidenceFiles();
    missingReceipt.delete(`${directory}/adoption-receipt.json`);
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(missingReceipt),
      }),
    ).toThrow('adoption_receipt_missing');
    const missingRequest = evidenceFiles();
    missingRequest.delete(`${directory}/adoption-request.json`);
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(missingRequest),
      }),
    ).toThrow('adoption_request_missing');
    const descriptorDrift = evidenceFiles();
    descriptorDrift.set(`${directory}/installed-components.env`, currentDescriptor);
    expect(() =>
      validateAdoptedBaseline(values, currentDescriptor, directory, releaseId, {
        readFile: reader(descriptorDrift),
      }),
    ).toThrow('adoption_descriptor_drift');
  });
  it('rejects descriptor, request and image drift inside an otherwise valid receipt', () => {
    const values = parseEnv(fixture.descriptorBytes);
    const withReceipt = (change: (receipt: Record<string, unknown>) => void) => {
      const files = evidenceFiles();
      const receipt = JSON.parse(fixture.receiptBytes.toString('utf8')) as Record<string, unknown>;
      change(receipt);
      files.set(`${directory}/adoption-receipt.json`, Buffer.from(JSON.stringify(receipt) + '\n'));
      return files;
    };
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(
          withReceipt((receipt) => {
            receipt.descriptorSha256 = '0'.repeat(64);
          }),
        ),
      }),
    ).toThrow('adoption_lineage');
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(
          withReceipt((receipt) => {
            receipt.requestSha256 = '0'.repeat(64);
          }),
        ),
      }),
    ).toThrow('adoption_lineage');
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(
          withReceipt((receipt) => {
            const images = receipt.images as Record<string, string>;
            images.api = digest('9');
            const containers = receipt.containers as Record<string, { image: string }>;
            containers.api = { ...containers.api, image: image('api', digest('9')) };
          }),
        ),
      }),
    ).toThrow('adoption_image_drift');
    expect(() =>
      validateAdoptedBaseline(
        { ...values, WEB_IMAGE_DIGEST: digest('9') },
        fixture.descriptorBytes,
        directory,
        releaseId,
        { readFile: reader(evidenceFiles()) },
      ),
    ).toThrow('adoption_descriptor_drift');
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(
          withReceipt((receipt) => {
            receipt.controllerSha = 'f'.repeat(40);
          }),
        ),
      }),
    ).toThrow('adoption_controller_drift');
    expect(() =>
      validateAdoptedBaseline(values, fixture.descriptorBytes, directory, releaseId, {
        readFile: reader(
          withReceipt((receipt) => {
            receipt.declaredUnverifiedInputs = ['manifestSha256'];
          }),
        ),
      }),
    ).toThrow('adoption_receipt');
  });
});

describe('runAdoptManualBaseline', () => {
  it('adopts, preserves the manual descriptor and never writes a secret or restarts', () => {
    scenario(`
      const request = requestBytes();
      const host = fakeHost(request);
      const receipt = await runAdoptManualBaseline(operatorPath, host.options);
      assert.equal(receipt.schema, 'PHUB_TIMEWEB_ADOPTION_RECEIPT_V1');
      assert.equal(receipt.adoptedFrom, 'manual-compose-simplified');
      assert.deepEqual(host.calls.docker.sort(), ['api', 'realtime', 'web', 'worker']);
      assert.equal(host.calls.github.length, 3);
      const adopted = host.files.get(host.paths.descriptor).toString('utf8');
      assert(adopted.includes('PHUB_COMPONENT_ROLLOUT_KIND=' + ADOPTED_MANUAL_FULL_KIND));
      assert(host.files.get(host.paths.preimage).equals(currentDescriptorBytes));
      assert(host.files.get(host.paths.request).equals(request));
      assert(host.files.has(host.paths.receipt));
      assert(host.writes.every((path) => path.startsWith(adoptionRoot + '/')));
      assert(host.writes.some((path) => path === host.paths.descriptor));
      assert(!host.writes.some((path) => path.startsWith('/etc/phub/')));
      host.calls.docker.length = 0;
      host.calls.github.length = 0;
      const resumed = await runAdoptManualBaseline(operatorPath, host.options);
      assert.deepEqual(resumed, receipt);
      assert.equal(host.calls.docker.length, 0);
      assert.equal(host.calls.github.length, 0);
      const late = { ...host.options, now: () => new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) };
      assert.deepEqual(await runAdoptManualBaseline(operatorPath, late), receipt);
    `);
  });
  it('refuses non-root, a non-fixed request path and an expired fresh request', () => {
    scenario(`
      const guarded = {
        readFile: () => { throw new Error('unexpected_read'); },
        writeFileAtomic: () => { throw new Error('unexpected_write'); },
        getuid: () => 1000,
      };
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, guarded), /not_root/);
      await assert.rejects(() => runAdoptManualBaseline('/tmp/adopt.json', { ...guarded, getuid: () => 0 }), /adoption_entry/);
      const expired = { ...operation(), expiresAt: new Date(Date.now() - 60000).toISOString() };
      const host = fakeHost(requestBytes(expired));
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, host.options), /invalid_expiry/);
      assert.equal(host.writes.length, 0);
      assert.equal(host.calls.docker.length, 0);
      assert.equal(host.calls.github.length, 0);
    `);
  });
  it('fails closed on unhealthy containers, drifted manual descriptors and unadopted evidence', () => {
    scenario(`
      const request = requestBytes();
      const unhealthy = fakeHost(request, currentDescriptorBytes, {
        docker: (service, evidence) => ({ ...evidence, healthy: service !== 'web', restarts: 0 }),
      });
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, unhealthy.options), /container_unhealthy/);
      assert.equal(unhealthy.writes.length, 0);
      const restarted = fakeHost(request, currentDescriptorBytes, {
        docker: (service, evidence) => ({ ...evidence, healthy: true, restarts: service === 'worker' ? 1 : 0 }),
      });
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, restarted.options), /container_restarted/);
      assert.equal(restarted.writes.length, 0);
      const wrongDescriptor = fakeHost(request, Buffer.from(currentDescriptorBytes.toString('utf8').replace('PHUB_COMPONENT_ROLLOUT_KIND=SIMPLIFIED_FULL', 'PHUB_COMPONENT_ROLLOUT_KIND=API_WEB')));
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, wrongDescriptor.options), /current_descriptor_drift/);
      const wrongBaseline = fakeHost(request);
      wrongBaseline.files.delete(wrongBaseline.paths.previous);
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, wrongBaseline.options), /previous_baseline_missing/);
    `);
  });
  it('resumes a completed adoption whose receipt was lost without re-adopting', () => {
    scenario(`
      const request = requestBytes();
      const first = fakeHost(request);
      const receipt = await runAdoptManualBaseline(operatorPath, first.options);
      const adoptedBytes = first.files.get(first.paths.descriptor);
      const withoutReceipt = fakeHost(request, adoptedBytes, {
        files: {
          [first.paths.request]: first.files.get(first.paths.request),
          [first.paths.preimage]: currentDescriptorBytes,
        },
      });
      assert(!withoutReceipt.files.has(withoutReceipt.paths.receipt));
      const rebuilt = await runAdoptManualBaseline(operatorPath, withoutReceipt.options);
      assert.equal(rebuilt.schema, 'PHUB_TIMEWEB_ADOPTION_RECEIPT_V1');
      assert(withoutReceipt.files.has(withoutReceipt.paths.receipt));
      assert(withoutReceipt.files.get(withoutReceipt.paths.descriptor).equals(adoptedBytes));
      assert.equal(withoutReceipt.writes.filter((path) => path === withoutReceipt.paths.descriptor).length, 0);
      assert.deepEqual(rebuilt.releaseId, receipt.releaseId);
    `);
  });
});

it('accepts an adopted descriptor through readInstalledApiBaseline and keeps the manual kind rejected', async () => {
  const operation = freshOperation();
  const inputs = buildInputsFor(operation);
  const built = buildAdoptionArtifacts(operation, inputs);
  const directory = `${root}/releases/${releaseId}`;
  const files = new Map<string, Buffer>([
    [`${directory}/installed-components.env`, built.descriptorBytes],
    [`${directory}/adoption-receipt.json`, built.receiptBytes],
    [`${directory}/adoption-request.json`, inputs.requestBytes],
  ]);
  const stat = (path: string) => ({
    uid: 0,
    gid: 0,
    mode: files.has(path) ? 0o600 : 0o700,
    nlink: 1,
    ino: 1,
    dev: 1,
    size: files.get(path)?.length ?? 0,
    isSymbolicLink: () => false,
    isDirectory: () => !files.has(path),
    isFile: () => files.has(path),
  });
  const validatePaths = vi.fn();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof NativeFs>();
    return {
      ...actual,
      existsSync: (path: string) => files.has(path),
      lstatSync: stat,
      openSync: (path: string) => path,
      fstatSync: stat,
      readFileSync: (path: string) => {
        const value = files.get(path);
        return value ?? actual.readFileSync(path);
      },
      closeSync: () => {},
    };
  });
  vi.doMock('./render-timeweb-beta-release-env.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    validateTimewebRuntimeSecretPaths: validatePaths,
  }));
  try {
    vi.resetModules();
    const { readInstalledApiBaseline } = await import('./timeweb-api-web-upgrade.js');
    const installed = readInstalledApiBaseline(releaseId);
    expect(installed.bytes.equals(built.descriptorBytes)).toBe(true);
    expect(installed.values.PHUB_COMPONENT_ROLLOUT_KIND).toBe(ADOPTED_MANUAL_FULL_KIND);
    expect(installed.secretSetReleaseId).toBe(previousReleaseId);
    expect(validatePaths).toHaveBeenCalledWith(runtimeRoot, previousReleaseId);
    files.set(`${directory}/installed-components.env`, currentDescriptor);
    expect(() => readInstalledApiBaseline(releaseId)).toThrow('installed_baseline_kind');
    files.set(`${directory}/installed-components.env`, built.descriptorBytes);
    const receipt = JSON.parse(built.receiptBytes.toString('utf8')) as Record<string, unknown>;
    receipt.requestSha256 = '0'.repeat(64);
    files.set(`${directory}/adoption-receipt.json`, Buffer.from(JSON.stringify(receipt) + '\n'));
    expect(() => readInstalledApiBaseline(releaseId)).toThrow('adoption_lineage');
  } finally {
    vi.doUnmock('node:fs');
    vi.doUnmock('./render-timeweb-beta-release-env.js');
    vi.resetModules();
  }
});

describe('canonical descriptor after adoption (B1)', () => {
  it('writes the API_WEB kind without adoption claims and reads back as installed', async () => {
    const operation = freshOperation();
    const built = buildAdoptionArtifacts(operation, buildInputsFor(operation));
    const adoptedValues = parseEnv(built.descriptorBytes);
    const nextId = `${releaseSha}-888-1`;
    const plan = {
      secretSetReleaseId: previousReleaseId,
      candidate: {
        api: { image: image('api', digest('9')) },
        web: { image: image('web', digest('a')) },
      },
      unchangedServiceImages: { worker: null, realtime: null },
    };
    const upgrade = await import('./timeweb-api-web-upgrade.js');
    const descriptorBytes = upgrade.buildApiWebInstalledDescriptor(
      adoptedValues,
      plan,
      nextId,
      `${root}/backups/${nextId}-api-web/rollout-receipt.json`,
    );
    const text = descriptorBytes.toString('utf8');
    const values = parseEnv(descriptorBytes);
    expect(values.PHUB_COMPONENT_ROLLOUT_KIND).toBe('API_WEB');
    expect(values.PHUB_RELEASE_ID).toBe(nextId);
    expect(values.PHUB_ROLLBACK_MODE).toBe('previous-release-only');
    expect(values.PHUB_ROLLBACK_PREVIOUS_RELEASE_ID).toBe(operation.release.releaseId);
    expect(values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID).toBe(previousReleaseId);
    expect(text).not.toMatch(/PHUB_ADOPTION_/);
    expect(text).not.toContain(ADOPTED_MANUAL_FULL_KIND);
    // A minimal canonical V1 receipt context lets readInstalledApiBaseline accept the next release.
    const planBytes = Buffer.from(JSON.stringify({ fixture: 'installed-plan' }) + '\n');
    const observation = Buffer.from('observation\n');
    const provider = Buffer.from('provider\n');
    const alert = Buffer.from('alert\n');
    const receipt = {
      schema: 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1',
      status: 'SUCCESS',
      planSha256: sha256(planBytes),
      observedAt: '2026-10-26T10:00:00.000Z',
      installedBaselineSha256: sha256(descriptorBytes),
      observationSha256: sha256(observation),
      providerReadbackSha256: sha256(provider),
      alertReadbackSha256: sha256(alert),
    };
    const directory = `${root}/releases/${nextId}`;
    const transaction = `${root}/backups/${nextId}-api-web`;
    const files = new Map<string, Buffer>([
      [`${directory}/installed-components.env`, descriptorBytes],
      [`${transaction}/rollout-receipt.json`, Buffer.from(JSON.stringify(receipt) + '\n')],
      [`${transaction}/plan.json`, planBytes],
      [`${transaction}/observation.json`, observation],
      [`${transaction}/timeweb-monitor-readback.json`, provider],
      [`${transaction}/alert-test-readback.json`, alert],
    ]);
    const stat = (path: string) => ({
      uid: 0,
      gid: 0,
      mode: files.has(path) ? 0o600 : 0o700,
      nlink: 1,
      ino: 1,
      dev: 1,
      size: files.get(path)?.length ?? 0,
      isSymbolicLink: () => false,
      isDirectory: () => !files.has(path),
      isFile: () => files.has(path),
    });
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof NativeFs>();
      return {
        ...actual,
        existsSync: (path: string) => files.has(path),
        lstatSync: stat,
        openSync: (path: string) => path,
        fstatSync: stat,
        readFileSync: (path: string) => files.get(path) ?? actual.readFileSync(path),
        closeSync: () => {},
      };
    });
    try {
      vi.resetModules();
      const { readInstalledApiBaseline } = await import('./timeweb-api-web-upgrade.js');
      const installed = readInstalledApiBaseline(nextId, { checkRuntimeSecrets: false });
      expect(installed.values.PHUB_COMPONENT_ROLLOUT_KIND).toBe('API_WEB');
      expect(installed.bytes.equals(descriptorBytes)).toBe(true);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
  it('strips adoption metadata in the JOIN and API/Worker descriptor builders', () => {
    scenario(`
      const previousBytes = Buffer.from([
        'PHUB_RELEASE_ID=' + 'c'.repeat(40) + '-555-1',
        'PHUB_COMPONENT_ROLLOUT_KIND=' + ADOPTED_MANUAL_FULL_KIND,
        'PHUB_ADOPTION_SOURCE=manual-compose-simplified',
        'PHUB_ADOPTION_REQUEST_SHA256=' + 'a'.repeat(64),
        'API_IMAGE_DIGEST=sha256:' + '1'.repeat(64),
        'WEB_IMAGE_DIGEST=sha256:' + '2'.repeat(64),
      ].join('\\n') + '\\n');
      const previous = parseEnv(previousBytes);
      const join = await import('./scripts/timeweb-join-dormant-profile.js');
      const joinPlan = {
        candidate: {
          api: { image: 'ghcr.io/z6v6e6r/phub-api@sha256:' + '9'.repeat(64) },
          web: { image: 'ghcr.io/z6v6e6r/phub-web@sha256:' + '8'.repeat(64) },
        },
        unchangedServiceImages: {
          worker: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + '7'.repeat(64),
          realtime: null,
        },
      };
      const joinBytes = join.buildJoinInstalledDescriptor(previous, joinPlan, 'd'.repeat(40) + '-777-1', '/receipt').toString('utf8');
      assert(!joinBytes.includes('PHUB_ADOPTION_'));
      assert(!joinBytes.includes('ADOPTED_MANUAL_FULL'));
      assert(joinBytes.includes('PHUB_COMPONENT_ROLLOUT_KIND=API_WEB_JOIN_DORMANT_0105'));
      const worker = await import('./scripts/timeweb-api-worker-upgrade.js');
      const workerBytes = worker.buildApiWorkerInstalledDescriptor(
        previousBytes,
        {
          previousSecrets: { releaseId: 'c'.repeat(40) + '-555-1' },
          candidate: {
            api: { image: 'ghcr.io/z6v6e6r/phub-api@sha256:' + '9'.repeat(64) },
            worker: { image: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + '7'.repeat(64) },
          },
        },
        'd'.repeat(40) + '-777-1',
        '/receipt',
        {},
      );
      assert(!workerBytes.includes('PHUB_ADOPTION_'));
      assert(!workerBytes.includes('ADOPTED_MANUAL_FULL'));
      assert(workerBytes.includes('PHUB_COMPONENT_ROLLOUT_KIND=API_WORKER\\n'));
    `);
  });
});

describe('post-merge controller registration (B2)', () => {
  it('admits the adoption additions through every controller allowlist and rejects foreign files', () => {
    scenario(`
      const paths = [
        'scripts/timeweb-adopt-manual-baseline.js',
        'scripts/timeweb-adopt-manual-baseline.d.ts',
        'scripts/timeweb-adopt-manual-baseline.test.ts',
      ];
      const entry = (path) => ({
        path,
        status: 'A',
        oldMode: '000000',
        newMode: '100644',
        oldOid: '0'.repeat(40),
        newOid: 'a'.repeat(40),
        oldType: null,
        newType: 'blob',
      });
      const entries = paths.map(entry);
      const foreign = entry('apps/api/src/foreign.ts');
      const join = await import('./scripts/timeweb-join-dormant-profile.js');
      join.validateJoinRuntimeTail(entries, {
        fromSha: join.JOIN_RUNTIME_ANCHOR,
        toSha: 'b'.repeat(40),
        toTree: 'c'.repeat(40),
      });
      assert.throws(
        () =>
          join.validateJoinRuntimeTail([...entries, foreign], {
            fromSha: join.JOIN_RUNTIME_ANCHOR,
            toSha: 'b'.repeat(40),
            toTree: 'c'.repeat(40),
          }),
        /RUNTIME_TAIL/,
      );
      const upgrade = await import('./scripts/timeweb-api-web-upgrade.js');
      upgrade.validateControllerDelta(entries);
      assert.throws(() => upgrade.validateControllerDelta([foreign]));
      const worker = await import('./scripts/timeweb-api-worker-contract.js');
      worker.validateApiWorkerControllerDelta(entries);
      assert.throws(() => worker.validateApiWorkerControllerDelta([foreign]), /CONTROLLER_DELTA/);
      const migration = await import('./scripts/timeweb-api-worker-migration.js');
      migration.validateMigrationControllerClosure(entries);
      assert.throws(() => migration.validateMigrationControllerClosure([foreign]), /CONTROLLER_DELTA/);
      const critical = await import('./scripts/timeweb-critical-web.js');
      critical.validateWebControllerDelta(entries);
      assert.throws(() => critical.validateWebControllerDelta([foreign]), /SOURCE_DELTA/);
      const source = await import('./scripts/verify-source-ci.js');
      for (const path of paths) {
        assert(source.CONTROLLER_PROMOTION_CHANGED_PATHS.includes(path));
        assert(source.CONTROLLER_PROMOTION_EXECUTABLE_PATHS.includes(path));
      }
      assert(!source.CONTROLLER_PROMOTION_CHANGED_PATHS.includes(foreign.path));
      assert(!source.CONTROLLER_PROMOTION_EXECUTABLE_PATHS.includes(foreign.path));
    `);
  });
});

describe('executed controller source binding (M3)', () => {
  it('refuses a dirty or mismatched checkout before collecting evidence or writing', () => {
    scenario(`
      const request = requestBytes();
      const dirty = fakeHost(request, currentDescriptorBytes, {
        options: {
          readControllerSource: () => ({
            sha: operation().controllerSha,
            tree: operation().controllerTree,
            dirty: true,
          }),
        },
      });
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, dirty.options), /controller_source_dirty/);
      assert.equal(dirty.writes.length, 0);
      assert.equal(dirty.calls.docker.length, 0);
      assert.equal(dirty.calls.github.length, 0);
      const stale = fakeHost(request, currentDescriptorBytes, {
        options: {
          readControllerSource: () => ({
            sha: 'f'.repeat(40),
            tree: operation().controllerTree,
            dirty: false,
          }),
        },
      });
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, stale.options), /controller_source_mismatch/);
      assert.equal(stale.writes.length, 0);
      const wrongTree = fakeHost(request, currentDescriptorBytes, {
        options: {
          readControllerSource: () => ({
            sha: operation().controllerSha,
            tree: 'f'.repeat(40),
            dirty: false,
          }),
        },
      });
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, wrongTree.options), /controller_source_mismatch/);
    `);
  });
  it('repeats a completed readback without re-reading a checkout that later moved', () => {
    scenario(`
      const host = fakeHost(requestBytes());
      const receipt = await runAdoptManualBaseline(operatorPath, host.options);
      const strict = {
        ...host.options,
        readControllerSource: () => {
          throw new Error('checkout_must_not_be_read');
        },
      };
      assert.deepEqual(await runAdoptManualBaseline(operatorPath, strict), receipt);
    `);
  });
  it('drops the dead release.env fallback for the previous canonical descriptor', () => {
    scenario(`
      const host = fakeHost(requestBytes());
      host.files.delete(host.paths.previous);
      host.files.set(
        host.paths.previous.replace('installed-components.env', 'release.env'),
        previousDescriptorBytes,
      );
      await assert.rejects(() => runAdoptManualBaseline(operatorPath, host.options), /previous_baseline_missing/);
    `);
  });
});
