import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Descriptor = {
  readonly digest?: string;
  readonly platform?: { readonly os?: string; readonly architecture?: string };
  readonly annotations?: Readonly<Record<string, string>>;
};
type OciIndex = { readonly mediaType?: string; readonly manifests?: readonly Descriptor[] };
type RuntimeManifest = {
  readonly mediaType?: string;
  readonly config?: { readonly digest?: string };
  readonly layers?: readonly { readonly digest?: string }[];
};
type AttestationManifest = {
  readonly mediaType?: string;
  readonly artifactType?: string;
  readonly config?: { readonly digest?: string };
  readonly layers?: readonly {
    readonly digest?: string;
    readonly mediaType?: string;
    readonly annotations?: Readonly<Record<string, string>>;
  }[];
};
type ImageConfig = {
  readonly os?: string;
  readonly architecture?: string;
  readonly config?: { readonly Labels?: Readonly<Record<string, string>> };
};
type AttestationLayer = {
  readonly digest: string;
  readonly predicateType: string;
};
type InTotoStatement = {
  readonly _type?: string;
  readonly subject?: readonly {
    readonly digest?: Readonly<Record<string, string>>;
  }[];
  readonly predicateType?: string;
  readonly predicate?: unknown;
};

const sha40Pattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const runIdPattern = /^[1-9][0-9]*$/u;

function fail(code: string): never {
  throw new Error(code);
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function requireDigest(bytes: Buffer, expectedDigest: string, code: string): void {
  if (!digestPattern.test(expectedDigest) || `sha256:${sha256(bytes)}` !== expectedDigest) {
    fail(code);
  }
}

export function selectDockerArchiveConfigPath(
  entries: readonly string[],
  configDigest: string,
): string {
  if (!digestPattern.test(configDigest)) {
    fail('COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_DIGEST_INVALID');
  }
  const configSha = configDigest.slice('sha256:'.length);
  const supportedPaths = new Set([`${configSha}.json`, `blobs/sha256/${configSha}`]);
  const matches = entries.filter((entry) => supportedPaths.has(entry));
  if (matches.length !== 1) {
    fail('COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_ARCHIVE_PATH_INVALID');
  }
  return matches[0]!;
}

export function createCandidateReleaseBytes(candidateSha: string, migratorDigest: string): Buffer {
  if (!sha40Pattern.test(candidateSha)) fail('COMMUNITIES_REHEARSAL_CANDIDATE_SHA_INVALID');
  if (!digestPattern.test(migratorDigest)) fail('COMMUNITIES_REHEARSAL_MIGRATOR_DIGEST_INVALID');
  return Buffer.from(`RELEASE=${candidateSha}\nMIGRATOR_IMAGE_DIGEST=${migratorDigest}\n`, 'utf8');
}

export function validateOciIndex(index: OciIndex): {
  readonly runtimeDigest: string;
  readonly attestationDigests: readonly string[];
} {
  if (index.mediaType !== 'application/vnd.oci.image.index.v1+json') {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_NOT_OCI_INDEX');
  }
  if (!Array.isArray(index.manifests)) {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_MANIFESTS_INVALID');
  }
  const manifests = index.manifests as readonly Descriptor[];
  const runnable = manifests.filter(
    (manifest) =>
      manifest.platform?.os !== 'unknown' || manifest.platform?.architecture !== 'unknown',
  );
  const runtime = runnable[0];
  const runtimeDigest = runtime?.digest;
  if (
    runnable.length !== 1 ||
    runtime?.platform?.os !== 'linux' ||
    runtime.platform.architecture !== 'arm64' ||
    !runtimeDigest ||
    !digestPattern.test(runtimeDigest)
  ) {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_PLATFORM_MISMATCH');
  }
  const attestations = manifests.filter((manifest) => !runnable.includes(manifest));
  if (
    attestations.length < 1 ||
    attestations.some(
      (manifest) =>
        manifest.platform?.os !== 'unknown' ||
        manifest.platform.architecture !== 'unknown' ||
        manifest.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest' ||
        manifest.annotations['vnd.docker.reference.digest'] !== runtimeDigest ||
        !digestPattern.test(manifest.digest ?? ''),
    )
  ) {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_ATTESTATION_MISMATCH');
  }
  return {
    runtimeDigest,
    attestationDigests: attestations.map((manifest) => manifest.digest!),
  };
}

export function validateAttestationManifests(
  manifests: readonly AttestationManifest[],
): readonly AttestationLayer[] {
  const layers: AttestationLayer[] = [];
  for (const manifest of manifests) {
    if (
      manifest.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
      manifest.artifactType !== 'application/vnd.docker.attestation.manifest.v1+json' ||
      !digestPattern.test(manifest.config?.digest ?? '') ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length < 1
    ) {
      fail('COMMUNITIES_REHEARSAL_ATTESTATION_MANIFEST_INVALID');
    }
    const manifestLayers = manifest.layers as NonNullable<AttestationManifest['layers']>;
    for (const layer of manifestLayers) {
      if (
        layer.mediaType !== 'application/vnd.in-toto+json' ||
        !digestPattern.test(layer.digest ?? '')
      ) {
        fail('COMMUNITIES_REHEARSAL_ATTESTATION_LAYER_INVALID');
      }
      const predicateType = layer.annotations?.['in-toto.io/predicate-type'];
      if (!predicateType) fail('COMMUNITIES_REHEARSAL_ATTESTATION_PREDICATE_MISSING');
      layers.push({ digest: layer.digest!, predicateType });
    }
  }
  const predicateTypes = new Set(layers.map((layer) => layer.predicateType));
  if (
    ![...predicateTypes].some((value) => value.startsWith('https://slsa.dev/provenance/')) ||
    !predicateTypes.has('https://spdx.dev/Document')
  ) {
    fail('COMMUNITIES_REHEARSAL_REQUIRED_ATTESTATIONS_MISSING');
  }
  return layers;
}

export function validateAttestationStatements(
  layers: readonly AttestationLayer[],
  statements: readonly InTotoStatement[],
  runtimeDigest: string,
): readonly string[] {
  if (layers.length !== statements.length || !digestPattern.test(runtimeDigest)) {
    fail('COMMUNITIES_REHEARSAL_ATTESTATION_STATEMENT_COUNT_MISMATCH');
  }
  const runtimeSha = runtimeDigest.slice('sha256:'.length);
  const predicateTypes = new Set<string>();
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index]!;
    const statement = statements[index]!;
    if (
      statement._type !== 'https://in-toto.io/Statement/v0.1' ||
      statement.predicateType !== layer.predicateType ||
      statement.predicate === undefined ||
      !Array.isArray(statement.subject) ||
      !(statement.subject as NonNullable<InTotoStatement['subject']>).some(
        (subject) => subject.digest?.sha256 === runtimeSha,
      )
    ) {
      fail('COMMUNITIES_REHEARSAL_ATTESTATION_STATEMENT_INVALID');
    }
    predicateTypes.add(layer.predicateType);
  }
  return [...predicateTypes].sort();
}

async function fetchGhcrBlob(digest: string, outputPath: string): Promise<void> {
  if (!digestPattern.test(digest)) fail('COMMUNITIES_REHEARSAL_BLOB_DIGEST_INVALID');
  const actor = process.env.GHCR_ACTOR;
  const githubToken = process.env.GHCR_TOKEN;
  if (!actor || !githubToken || !actorPattern.test(actor)) {
    fail('COMMUNITIES_REHEARSAL_GHCR_AUTH_MISSING');
  }
  const tokenUrl = new URL('https://ghcr.io/token');
  tokenUrl.searchParams.set('service', 'ghcr.io');
  tokenUrl.searchParams.set('scope', 'repository:z6v6e6r/phub-migrator:pull');
  const tokenResponse = await fetch(tokenUrl, {
    headers: {
      authorization: `Basic ${Buffer.from(`${actor}:${githubToken}`, 'utf8').toString('base64')}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) fail('COMMUNITIES_REHEARSAL_GHCR_TOKEN_FAILED');
  const tokenBody = (await tokenResponse.json()) as { readonly token?: string };
  if (!tokenBody.token) fail('COMMUNITIES_REHEARSAL_GHCR_TOKEN_INVALID');
  const blobResponse = await fetch(`https://ghcr.io/v2/z6v6e6r/phub-migrator/blobs/${digest}`, {
    headers: { authorization: `Bearer ${tokenBody.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!blobResponse.ok) fail('COMMUNITIES_REHEARSAL_GHCR_BLOB_FETCH_FAILED');
  const bytes = Buffer.from(await blobResponse.arrayBuffer());
  requireDigest(bytes, digest, 'COMMUNITIES_REHEARSAL_GHCR_BLOB_MISMATCH');
  await writeFile(resolve(outputPath), bytes, { flag: 'wx', mode: 0o600 });
}

export function validateRuntimeManifest(manifest: RuntimeManifest): string {
  const configDigest = manifest.config?.digest;
  if (
    manifest.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
    !configDigest ||
    !digestPattern.test(configDigest) ||
    !Array.isArray(manifest.layers) ||
    (manifest.layers as readonly { readonly digest?: string }[]).some(
      (layer) => !digestPattern.test(layer.digest ?? ''),
    )
  ) {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_RUNTIME_MANIFEST_INVALID');
  }
  return configDigest;
}

export function validateImageConfig(image: ImageConfig, candidateSha: string): void {
  if (image.os !== 'linux' || image.architecture !== 'arm64') {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_CONFIG_PLATFORM_MISMATCH');
  }
  if (image.config?.Labels?.['org.opencontainers.image.revision'] !== candidateSha) {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_REVISION_MISMATCH');
  }
  if (
    image.config?.Labels?.['org.opencontainers.image.source'] !== 'https://github.com/Z6v6e6r/lk2'
  ) {
    fail('COMMUNITIES_REHEARSAL_MIGRATOR_SOURCE_MISMATCH');
  }
}

async function buildMigrationManifest(repositoryRoot: string): Promise<Buffer> {
  const migrationsRoot = join(repositoryRoot, 'packages/database/migrations');
  const filenames = (await readdir(migrationsRoot))
    .filter((filename) => filename.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const lines: string[] = [];
  for (const filename of filenames) {
    const bytes = await readFile(join(migrationsRoot, filename));
    lines.push(`${sha256(bytes)}|${basename(filename)}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function parseArguments(arguments_: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith('--') || value === undefined || result.has(name)) {
      fail('COMMUNITIES_REHEARSAL_EVIDENCE_ARGUMENTS_INVALID');
    }
    result.set(name, value);
  }
  return result;
}

function required(arguments_: ReadonlyMap<string, string>, name: string): string {
  const value = arguments_.get(name);
  if (!value) fail(`COMMUNITIES_REHEARSAL_EVIDENCE_ARGUMENT_MISSING_${name.slice(2)}`);
  return value;
}

async function prepare(arguments_: ReadonlyMap<string, string>): Promise<void> {
  const candidateSha = required(arguments_, '--candidate-sha');
  const workflowSha = required(arguments_, '--workflow-sha');
  const gitTreeSha = required(arguments_, '--git-tree-sha');
  const migratorDigest = required(arguments_, '--migrator-digest');
  const repository = required(arguments_, '--repository');
  const actor = required(arguments_, '--actor');
  const runId = required(arguments_, '--run-id');
  const runAttempt = required(arguments_, '--run-attempt');
  const publicationTag = required(arguments_, '--publication-tag');
  const repositoryRoot = resolve(required(arguments_, '--repository-root'));
  const outputRoot = resolve(required(arguments_, '--output-root'));
  if (
    !sha40Pattern.test(candidateSha) ||
    workflowSha !== candidateSha ||
    !sha40Pattern.test(gitTreeSha) ||
    !digestPattern.test(migratorDigest) ||
    repository !== 'Z6v6e6r/lk2' ||
    !actorPattern.test(actor) ||
    !runIdPattern.test(runId) ||
    runAttempt !== '1' ||
    publicationTag !== `rehearsal-${candidateSha}-${runId}`
  ) {
    fail('COMMUNITIES_REHEARSAL_EVIDENCE_BINDING_INVALID');
  }

  const indexBytes = await readFile(resolve(required(arguments_, '--oci-index')));
  const runtimeManifestBytes = await readFile(resolve(required(arguments_, '--runtime-manifest')));
  const imageConfigBytes = await readFile(resolve(required(arguments_, '--image-config')));
  const provenanceBytes = await readFile(resolve(required(arguments_, '--provenance')));
  const sbomBytes = await readFile(resolve(required(arguments_, '--sbom')));
  requireDigest(indexBytes, migratorDigest, 'COMMUNITIES_REHEARSAL_OCI_INDEX_DIGEST_MISMATCH');
  const { runtimeDigest: runtimeManifestDigest, attestationDigests } = validateOciIndex(
    JSON.parse(indexBytes.toString('utf8')) as OciIndex,
  );
  requireDigest(
    runtimeManifestBytes,
    runtimeManifestDigest,
    'COMMUNITIES_REHEARSAL_RUNTIME_MANIFEST_DIGEST_MISMATCH',
  );
  const runtimeConfigDigest = validateRuntimeManifest(
    JSON.parse(runtimeManifestBytes.toString('utf8')) as RuntimeManifest,
  );
  requireDigest(
    imageConfigBytes,
    runtimeConfigDigest,
    'COMMUNITIES_REHEARSAL_RUNTIME_CONFIG_DIGEST_MISMATCH',
  );
  validateImageConfig(JSON.parse(imageConfigBytes.toString('utf8')) as ImageConfig, candidateSha);
  const attestationDirectory = resolve(required(arguments_, '--attestation-directory'));
  const attestationBytes = await Promise.all(
    attestationDigests.map((digest) =>
      readFile(join(attestationDirectory, `${digest.slice('sha256:'.length)}.json`)),
    ),
  );
  for (let index = 0; index < attestationBytes.length; index += 1) {
    requireDigest(
      attestationBytes[index]!,
      attestationDigests[index]!,
      'COMMUNITIES_REHEARSAL_ATTESTATION_MANIFEST_DIGEST_MISMATCH',
    );
  }
  const attestationLayers = validateAttestationManifests(
    attestationBytes.map((bytes) => JSON.parse(bytes.toString('utf8')) as AttestationManifest),
  );
  const statementDirectory = resolve(required(arguments_, '--statement-directory'));
  const statementBytes = await Promise.all(
    attestationLayers.map((layer) =>
      readFile(join(statementDirectory, `${layer.digest.slice('sha256:'.length)}.json`)),
    ),
  );
  for (let index = 0; index < statementBytes.length; index += 1) {
    requireDigest(
      statementBytes[index]!,
      attestationLayers[index]!.digest,
      'COMMUNITIES_REHEARSAL_ATTESTATION_STATEMENT_DIGEST_MISMATCH',
    );
  }
  const predicateTypes = validateAttestationStatements(
    attestationLayers,
    statementBytes.map((bytes) => JSON.parse(bytes.toString('utf8')) as InTotoStatement),
    runtimeManifestDigest,
  );
  const provenance = JSON.parse(provenanceBytes.toString('utf8')) as Record<string, unknown>;
  const sbom = JSON.parse(sbomBytes.toString('utf8')) as Record<string, unknown>;
  if (typeof provenance.buildType !== 'string' || sbom.SPDXID !== 'SPDXRef-DOCUMENT') {
    fail('COMMUNITIES_REHEARSAL_ATTESTATION_CONTENT_INVALID');
  }

  const releaseBytes = createCandidateReleaseBytes(candidateSha, migratorDigest);
  const migrationManifestBytes = await buildMigrationManifest(repositoryRoot);
  const dockerfileBytes = await readFile(join(repositoryRoot, 'apps/migrator/Dockerfile'));
  const lockfileBytes = await readFile(join(repositoryRoot, 'package-lock.json'));
  const releaseFilename = `release.communities-rehearsal-${candidateSha}.env`;
  const evidence = [
    `META|candidateSha|${candidateSha}`,
    `META|workflowSha|${workflowSha}`,
    `META|gitTreeSha|${gitTreeSha}`,
    `META|repository|${repository}`,
    `META|actor|${actor}`,
    `META|runId|${runId}`,
    `META|runAttempt|${runAttempt}`,
    `META|publicationTag|${publicationTag}`,
    `META|imageReference|ghcr.io/z6v6e6r/phub-migrator@${migratorDigest}`,
    `META|migratorDigest|${migratorDigest}`,
    'META|platform|linux/arm64',
    `META|runtimeManifestDigest|${runtimeManifestDigest}`,
    `META|runtimeConfigDigest|${runtimeConfigDigest}`,
    `META|ociIndexSha|${sha256(indexBytes)}`,
    `META|runtimeManifestSha|${sha256(runtimeManifestBytes)}`,
    `META|runtimeConfigSha|${sha256(imageConfigBytes)}`,
    `META|attestationManifestShas|${attestationBytes.map((bytes) => sha256(bytes)).join(',')}`,
    `META|attestationStatementShas|${statementBytes.map((bytes) => sha256(bytes)).join(',')}`,
    `META|attestationPredicateTypes|${predicateTypes.join(',')}`,
    `META|provenanceSha|${sha256(provenanceBytes)}`,
    `META|sbomSha|${sha256(sbomBytes)}`,
    `META|dockerfileSha|${sha256(dockerfileBytes)}`,
    `META|lockfileSha|${sha256(lockfileBytes)}`,
    `META|migrationManifestSha|${sha256(migrationManifestBytes)}`,
    `META|releaseEnvSha|${sha256(releaseBytes)}`,
    'META|authorizesRehearsal|false',
    'META|authorizesDeploy|false',
    'META|authorizesSharedMigration|false',
    'META|authorizesImport|false',
    'META|authorizesActivation|false',
  ];

  await Promise.all([
    writeFile(join(outputRoot, releaseFilename), releaseBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(
      join(outputRoot, 'communities-rehearsal-migrations.manifest'),
      migrationManifestBytes,
      { flag: 'wx', mode: 0o600 },
    ),
    writeFile(
      join(outputRoot, 'communities-rehearsal-migrator.evidence'),
      `${evidence.join('\n')}\n`,
      { flag: 'wx', mode: 0o600 },
    ),
  ]);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const arguments_ = parseArguments(rest);
  if (command === 'runtime-digest') {
    const indexBytes = await readFile(resolve(required(arguments_, '--oci-index')));
    process.stdout.write(
      `${validateOciIndex(JSON.parse(indexBytes.toString('utf8')) as OciIndex).runtimeDigest}\n`,
    );
    return;
  }
  if (command === 'attestation-digests') {
    const indexBytes = await readFile(resolve(required(arguments_, '--oci-index')));
    process.stdout.write(
      `${validateOciIndex(JSON.parse(indexBytes.toString('utf8')) as OciIndex).attestationDigests.join('\n')}\n`,
    );
    return;
  }
  if (command === 'config-digest') {
    const manifestBytes = await readFile(resolve(required(arguments_, '--runtime-manifest')));
    process.stdout.write(
      `${validateRuntimeManifest(JSON.parse(manifestBytes.toString('utf8')) as RuntimeManifest)}\n`,
    );
    return;
  }
  if (command === 'config-archive-path') {
    const entries = (await readFile(resolve(required(arguments_, '--archive-list')), 'utf8')).split(
      '\n',
    );
    process.stdout.write(
      `${selectDockerArchiveConfigPath(entries, required(arguments_, '--config-digest'))}\n`,
    );
    return;
  }
  if (command === 'attestation-layer-digests') {
    const indexBytes = await readFile(resolve(required(arguments_, '--oci-index')));
    const { attestationDigests } = validateOciIndex(
      JSON.parse(indexBytes.toString('utf8')) as OciIndex,
    );
    const attestationDirectory = resolve(required(arguments_, '--attestation-directory'));
    const manifests = await Promise.all(
      attestationDigests.map(
        async (digest) =>
          JSON.parse(
            (
              await readFile(join(attestationDirectory, `${digest.slice('sha256:'.length)}.json`))
            ).toString('utf8'),
          ) as AttestationManifest,
      ),
    );
    process.stdout.write(
      `${validateAttestationManifests(manifests)
        .map((layer) => layer.digest)
        .join('\n')}\n`,
    );
    return;
  }
  if (command === 'fetch-blob') {
    await fetchGhcrBlob(required(arguments_, '--digest'), required(arguments_, '--output'));
    return;
  }
  if (command === 'prepare') {
    await prepare(arguments_);
    return;
  }
  fail('COMMUNITIES_REHEARSAL_EVIDENCE_COMMAND_INVALID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
