import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { parseStrictJson } from './strict-json.js';
import type { BaseImageLock } from './verify-timeweb-base-images.js';
import {
  parseCanonicalBuildkitPurl,
  ProvenanceMaterialsError,
  validateProvenanceMaterials,
} from './verify-timeweb-provenance-materials.js';

interface MutableDigest {
  sha1?: string;
  sha256?: string;
  sha512?: string;
}

interface MutableMaterial {
  [key: string]: unknown;
  uri: string;
  digest: MutableDigest;
}

interface MutableSubject {
  [key: string]: unknown;
  name: string;
  digest: MutableDigest;
}

interface MutableStatement {
  [key: string]: unknown;
  _type: string;
  predicateType: string;
  subject: MutableSubject[];
  predicate: {
    buildDefinition: {
      buildType: string;
      resolvedDependencies: MutableMaterial[];
      externalParameters: {
        configSource: { uri: string; digest: MutableDigest; path: string };
      };
    };
    runDetails: {
      builder: { id: string };
      metadata: { buildkit_completeness: { resolvedDependencies: boolean } };
    };
  };
}

interface IncidentFixture {
  incident: Readonly<Record<string, unknown>>;
  partialRegistryIdentities: readonly { service: string; tag: string; indexDigest: string }[];
  serviceEvidence: Record<
    Service,
    {
      runtimeDigest: string;
      subjectName: string;
      dockerfilePath: string;
      materialCount: number;
    }
  >;
  cases: Record<'web' | 'api', { runtimeDigest: string; statement: MutableStatement }>;
}

type Service = 'web' | 'api' | 'worker' | 'realtime' | 'migrator';

const sourceSha = '5a7d3c14c8c413f7243da9772b00b5ded6cdf81b';
const builderId = 'https://github.com/Z6v6e6r/lk2/actions/runs/33011023879/attempts/1';
const fixture = parseStrictJson<IncidentFixture>(
  readFileSync('scripts/fixtures/timeweb-provenance-run-33011023879.json'),
);
const baseLock = parseStrictJson<BaseImageLock>(
  readFileSync('deploy/timeweb/base-images.lock.json'),
);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function input(service: 'web' | 'api' = 'web') {
  return {
    statement: clone(fixture.cases[service].statement),
    service,
    sourceSha,
    builderId,
    runtimeDigest: fixture.cases[service].runtimeDigest,
    dockerfilePath: `apps/${service}/Dockerfile`,
    repository: 'Z6v6e6r/lk2',
    baseLock: clone(baseLock),
  };
}

function exactServiceInput(service: Service) {
  const evidence = fixture.serviceEvidence[service];
  const statement = clone(fixture.cases[service === 'web' ? 'web' : 'api'].statement);
  subject({ ...input(), statement }).name = evidence.subjectName;
  subject({ ...input(), statement }).digest.sha256 = evidence.runtimeDigest.slice('sha256:'.length);
  statement.predicate.buildDefinition.externalParameters.configSource.path =
    evidence.dockerfilePath;
  return {
    statement,
    service,
    sourceSha,
    builderId,
    runtimeDigest: evidence.runtimeDigest,
    dockerfilePath: evidence.dockerfilePath,
    repository: 'Z6v6e6r/lk2',
    baseLock: clone(baseLock),
  };
}

function material(value: ReturnType<typeof input>, name: string) {
  const candidate = value.statement.predicate.buildDefinition.resolvedDependencies.find(
    (candidate: { uri: string }) => candidate.uri.includes(name),
  );
  if (!candidate) throw new Error(`missing material fixture: ${name}`);
  return candidate;
}

function subject(value: ReturnType<typeof input>) {
  const candidate = value.statement.subject[0];
  if (!candidate) throw new Error('missing provenance subject fixture');
  return candidate;
}

function replacePurl(value: ReturnType<typeof input>, name: string, uri: string) {
  material(value, name).uri = uri;
  return value;
}

const nodeDigest = 'sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';
const nodePurl = `pkg:docker/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2Famd64`;

describe('canonical BuildKit PURL parser', () => {
  it.each([
    ['node', nodePurl, 'node'],
    [
      'nginx',
      'pkg:docker/nginx@1.27-alpine?digest=sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10&platform=linux%2Famd64',
      'nginx',
    ],
    [
      'scanner',
      'pkg:docker/docker/buildkit-syft-scanner@stable-1?digest=sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9&platform=linux%2Famd64',
      'docker/buildkit-syft-scanner',
    ],
    [
      'qualified node normalization',
      `pkg:docker/docker.io/library/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2Famd64`,
      'node',
    ],
    [
      'qualified nginx normalization',
      'pkg:docker/docker.io/library/nginx@1.27-alpine?digest=sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10&platform=linux%2Famd64',
      'nginx',
    ],
    [
      'qualified scanner normalization',
      'pkg:docker/docker.io/docker/buildkit-syft-scanner@stable-1?digest=sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9&platform=linux%2Famd64',
      'docker/buildkit-syft-scanner',
    ],
    [
      'qualifier order',
      `pkg:docker/node@22-bookworm-slim?platform=linux%2Famd64&digest=${nodeDigest}`,
      'node',
    ],
  ])('accepts %s', (_name, uri, packageName) => {
    expect(parseCanonicalBuildkitPurl(uri)).toMatchObject({
      type: 'docker',
      packageName,
      platform: 'linux/amd64',
    });
  });

  it.each([
    ['tag only', 'pkg:docker/node@22-bookworm-slim?platform=linux%2Famd64'],
    ['digest only version', `pkg:docker/node@${nodeDigest}?platform=linux%2Famd64`],
    ['digest only qualifier', `pkg:docker/node?digest=${nodeDigest}&platform=linux%2Famd64`],
    ['unknown qualifier', `${nodePurl}&arch=amd64`],
    ['duplicate digest', `${nodePurl}&digest=${nodeDigest}`],
    ['duplicate platform', `${nodePurl}&platform=linux%2Famd64`],
    ['empty qualifier', `pkg:docker/node@22-bookworm-slim?digest=&platform=linux%2Famd64`],
    ['missing platform', `pkg:docker/node@22-bookworm-slim?digest=${nodeDigest}`],
    [
      'wrong platform',
      `pkg:docker/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2Farm64`,
    ],
    [
      'noncanonical platform encoding',
      `pkg:docker/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux/amd64`,
    ],
    [
      'double encoding',
      `pkg:docker/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%252Famd64`,
    ],
    [
      'malformed encoding',
      `pkg:docker/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2`,
    ],
    [
      'encoded digest colon',
      `pkg:docker/node@22-bookworm-slim?digest=sha256%3Ad649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436&platform=linux%2Famd64`,
    ],
    ['fragment', `${nodePurl}#subpath`],
    [
      'userinfo trick',
      `pkg:docker/user@node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2Famd64`,
    ],
    [
      'subpath substitution',
      `pkg:docker/library/node@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2Famd64`,
    ],
    [
      'repository substring',
      `pkg:docker/evilnode@22-bookworm-slim?digest=${nodeDigest}&platform=linux%2Famd64`,
    ],
    ['Unicode', `${nodePurl}${String.fromCodePoint(0xa0)}`],
    ['control', `${nodePurl}\n`],
    ['wrong type', nodePurl.replace('pkg:docker/', 'pkg:oci/')],
    ['extra query marker', `${nodePurl}?x=y`],
  ])('rejects %s', (_name, uri) => {
    expect(() => parseCanonicalBuildkitPurl(uri)).toThrow(ProvenanceMaterialsError);
  });
});

describe('run 33011023879 semantic provenance custody', () => {
  it('records the failed, partial, non-authorizing incident exactly', () => {
    expect(fixture.incident).toEqual({
      runId: 33011023879,
      runAttempt: 1,
      event: 'workflow_dispatch',
      sourceSha,
      workflowSha: sourceSha,
      conclusion: 'failure',
      publicationArtifactPresent: false,
      canonicalArtifactPresent: false,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
    expect(fixture.partialRegistryIdentities).toHaveLength(5);
    expect(
      new Set(
        fixture.partialRegistryIdentities.map(
          ({ indexDigest }: { indexDigest: string }) => indexDigest,
        ),
      ).size,
    ).toBe(5);
  });

  it.each(['web', 'api', 'worker', 'realtime', 'migrator'] as const)(
    'accepts the exact captured %s statement identity and material closure',
    (service) => {
      const exact = exactServiceInput(service);
      expect(exact.statement.predicate.buildDefinition.resolvedDependencies).toHaveLength(
        fixture.serviceEvidence[service].materialCount,
      );
      expect(validateProvenanceMaterials(exact)).toMatchObject({
        service,
        sourceSha,
        builderId,
        repository: 'Z6v6e6r/lk2',
      });
    },
  );

  it('demonstrates the retired inline matcher rejects the exact combined form', () => {
    const retiredMatcher = (uri: string, tag: string, digest: string) =>
      uri.endsWith(`@${tag}?platform=linux%2Famd64`) ||
      uri.endsWith(`@${digest}?platform=linux%2Famd64`);
    expect(retiredMatcher(nodePurl, '22-bookworm-slim', nodeDigest)).toBe(false);
    expect(parseCanonicalBuildkitPurl(nodePurl)).toMatchObject({
      version: '22-bookworm-slim',
      digest: nodeDigest,
    });
  });

  it.each([
    [
      'wrong base repository',
      (value: ReturnType<typeof input>) =>
        replacePurl(value, 'node@', nodePurl.replace('/node@', '/evil/node@')),
    ],
    [
      'wrong tag',
      (value: ReturnType<typeof input>) =>
        replacePurl(value, 'node@', nodePurl.replace('22-bookworm-slim', 'latest')),
    ],
    [
      'wrong qualifier digest',
      (value: ReturnType<typeof input>) =>
        replacePurl(value, 'node@', nodePurl.replace(nodeDigest, `sha256:${'0'.repeat(64)}`)),
    ],
    [
      'wrong object digest',
      (value: ReturnType<typeof input>) => {
        material(value, 'node@').digest.sha256 = '0'.repeat(64);
        return value;
      },
    ],
    [
      'extra digest algorithm',
      (value: ReturnType<typeof input>) => {
        material(value, 'node@').digest.sha512 = '0'.repeat(128);
        return value;
      },
    ],
    [
      'material extra field',
      (value: ReturnType<typeof input>) => {
        material(value, 'node@').extra = true;
        return value;
      },
    ],
    [
      'duplicate base',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.resolvedDependencies[1] = clone(
          material(value, 'node@'),
        );
        return value;
      },
    ],
    [
      'missing base',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.resolvedDependencies.pop();
        return value;
      },
    ],
    [
      'extra base in nonweb closure',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.resolvedDependencies.push(
          clone(material(input('web'), 'nginx@')),
        );
        return value;
      },
      'api',
    ],
    [
      'wrong source URI',
      (value: ReturnType<typeof input>) => {
        material(value, 'github.com').uri = material(value, 'github.com').uri.replace(
          '/lk2.git',
          '/other.git',
        );
        return value;
      },
    ],
    [
      'wrong source digest',
      (value: ReturnType<typeof input>) => {
        material(value, 'github.com').digest.sha1 = '0'.repeat(40);
        return value;
      },
    ],
    [
      'source extra digest',
      (value: ReturnType<typeof input>) => {
        material(value, 'github.com').digest.sha256 = '0'.repeat(64);
        return value;
      },
    ],
    [
      'duplicate source',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.resolvedDependencies[0] = clone(
          material(value, 'github.com'),
        );
        return value;
      },
    ],
    [
      'builder attempt substitution',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.runDetails.builder.id = builderId.replace('/1', '/2');
        return value;
      },
    ],
    [
      'Dockerfile substitution',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.externalParameters.configSource.path =
          'apps/api/Dockerfile';
        return value;
      },
    ],
    [
      'config source substitution',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.externalParameters.configSource.uri =
          value.statement.predicate.buildDefinition.externalParameters.configSource.uri.replace(
            '/lk2.git',
            '/other.git',
          );
        return value;
      },
    ],
    [
      'incomplete materials',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.runDetails.metadata.buildkit_completeness.resolvedDependencies = false;
        return value;
      },
    ],
    [
      'wrong build type',
      (value: ReturnType<typeof input>) => {
        value.statement.predicate.buildDefinition.buildType = 'https://example.invalid/build';
        return value;
      },
    ],
    [
      'subject digest substitution',
      (value: ReturnType<typeof input>) => {
        subject(value).digest.sha256 = '0'.repeat(64);
        return value;
      },
    ],
    [
      'extra subject',
      (value: ReturnType<typeof input>) => {
        value.statement.subject.push(clone(subject(value)));
        return value;
      },
    ],
    [
      'statement extension',
      (value: ReturnType<typeof input>) => {
        value.statement.extra = true;
        return value;
      },
    ],
  ])('fails closed for %s', (_name, mutate, selectedService = 'web') => {
    const value = mutate(input(selectedService as 'web' | 'api'));
    expect(() => validateProvenanceMaterials(value)).toThrow(ProvenanceMaterialsError);
  });

  it.each([
    ['repository input', { repository: 'Z6v6e6r/other' }],
    ['Dockerfile input', { dockerfilePath: 'apps/api/Dockerfile' }],
    ['builder input', { builderId: builderId.replace('/1', '/2') }],
    ['runtime input', { runtimeDigest: `sha256:${'0'.repeat(64)}` }],
    ['source input', { sourceSha: '0'.repeat(40) }],
    ['service input', { service: 'unknown' }],
  ])('binds exact %s', (_name, override) => {
    expect(() => validateProvenanceMaterials({ ...input(), ...override })).toThrow(
      ProvenanceMaterialsError,
    );
  });

  it.each([
    ['malformed JSON', '{'],
    ['duplicate key JSON', '{"_type":"first","_type":"second"}'],
    ['trailing JSON', `${JSON.stringify(fixture.cases.web.statement)}\n{}`],
  ])('rejects %s before semantic verification', async (_name, contents) => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-provenance-strict-json-'));
    const statement = join(directory, 'statement.json');
    const diagnostic = join(directory, 'diagnostic.json');
    await writeFile(statement, contents);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-timeweb-provenance-materials.js',
        'verify',
        '--statement',
        statement,
        '--service',
        'web',
        '--source-sha',
        sourceSha,
        '--builder-id',
        builderId,
        '--runtime-digest',
        fixture.cases.web.runtimeDigest,
        '--dockerfile-path',
        'apps/web/Dockerfile',
        '--repository',
        'Z6v6e6r/lk2',
        '--base-lock',
        'deploy/timeweb/base-images.lock.json',
        '--diagnostic',
        diagnostic,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TIMEWEB_PROVENANCE_MATERIALS_FAILED|reason=statement_');
    expect(parseStrictJson<Record<string, unknown>>(readFileSync(diagnostic))).toMatchObject({
      verified: false,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
  });

  it('writes a non-authorizing diagnostic on CLI success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-provenance-'));
    const statement = join(directory, 'statement.json');
    const diagnostic = join(directory, 'diagnostic.json');
    await writeFile(statement, `${JSON.stringify(fixture.cases.web.statement)}\n`);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-timeweb-provenance-materials.js',
        'verify',
        '--statement',
        statement,
        '--service',
        'web',
        '--source-sha',
        sourceSha,
        '--builder-id',
        builderId,
        '--runtime-digest',
        fixture.cases.web.runtimeDigest,
        '--dockerfile-path',
        'apps/web/Dockerfile',
        '--repository',
        'Z6v6e6r/lk2',
        '--base-lock',
        'deploy/timeweb/base-images.lock.json',
        '--diagnostic',
        diagnostic,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(parseStrictJson<Record<string, unknown>>(readFileSync(diagnostic))).toMatchObject({
      verified: true,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
  });

  it('keeps CLI failure diagnostic non-authorizing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phub-provenance-'));
    const statement = join(directory, 'statement.json');
    const diagnostic = join(directory, 'diagnostic.json');
    const bad = input();
    material(bad, 'node@').uri = nodePurl.replace('22-bookworm-slim', 'latest');
    await writeFile(statement, `${JSON.stringify(bad.statement)}\n`);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-timeweb-provenance-materials.js',
        'verify',
        '--statement',
        statement,
        '--service',
        'web',
        '--source-sha',
        sourceSha,
        '--builder-id',
        builderId,
        '--runtime-digest',
        fixture.cases.web.runtimeDigest,
        '--dockerfile-path',
        'apps/web/Dockerfile',
        '--repository',
        'Z6v6e6r/lk2',
        '--base-lock',
        'deploy/timeweb/base-images.lock.json',
        '--diagnostic',
        diagnostic,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(parseStrictJson<Record<string, unknown>>(readFileSync(diagnostic))).toMatchObject({
      verified: false,
      authorizesPublication: false,
      authorizesDeploy: false,
    });
  });
});
