import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

type Row = { path: string; mode: string; blobOid: string };
type ManifestRow = { path: string } & Record<string, string>;
type Promotion = {
  schema: number;
  controllerSha: string;
  controllerTree: string;
  prNumber: number;
  headBranch: string;
  baseSha: string;
  prCiRunId: string;
  mergeSha: string;
  mergeTree: string;
  mainCiRunId: string;
  executableManifestSha256: string;
  resolutionManifestSha256: string;
  sha256: string;
};
type Git = ((args: string[]) => string) & { readonly sourcePath: string };
type Job = { name: string; status: string; conclusion: string };
type JobInventory = { total_count: number; jobs: Job[] };
type CiRun = Record<string, unknown>;
type PullRequest = Record<string, unknown>;
type Evidence = {
  prRun: CiRun;
  prJobs: JobInventory;
  mainRun: CiRun;
  mainJobs: JobInventory;
  pullRequest: PullRequest;
  git: Git;
};
type PromotionProof = {
  executableManifest: ManifestRow[];
  resolutionManifest: ManifestRow[];
  controllerSha: string;
  mergeSha: string;
};
type Verifier = {
  CONTROLLER_PROMOTION_CHANGED_PATHS: readonly string[];
  CONTROLLER_PROMOTION_EXECUTABLE_PATHS: readonly string[];
  collectControllerPromotionGitProof: (promotion: Promotion, git: Git) => PromotionProof;
  controllerPromotionDigest: (promotion: Omit<Promotion, 'sha256'> | Promotion) => string;
  controllerPromotionManifestSha256: (rows: ManifestRow[]) => string;
  validateControllerPromotion: (
    promotion: Promotion,
    expected?: Record<string, string>,
  ) => Promotion;
  verifyControllerPromotion: (promotion: Promotion, evidence: Evidence) => PromotionProof;
  readControllerSourceAuthority: (
    op: Record<string, unknown>,
    git: Git,
    githubPublic: (path: string) => Promise<unknown>,
  ) => Promise<PromotionProof | boolean>;
};
const modulePath = './verify-source-ci.js';
const verifier = (await import(modulePath)) as unknown as Verifier;
const {
  CONTROLLER_PROMOTION_CHANGED_PATHS,
  CONTROLLER_PROMOTION_EXECUTABLE_PATHS,
  collectControllerPromotionGitProof,
  controllerPromotionDigest,
  controllerPromotionManifestSha256,
  readControllerSourceAuthority,
  validateControllerPromotion,
  verifyControllerPromotion,
} = verifier;

const sha = 'a'.repeat(40);
const names = [
  'ci-plan',
  'source-quality',
  'quality-full',
  'quality',
  'dependency-security',
  'secret-scan',
  'deployment-contract',
  'docker-build',
  'pr-gate',
];
const run = {
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/pull-request.yaml',
  run_attempt: 1,
  repository: { full_name: 'Z6v6e6r/lk2' },
};
function verify(
  candidate: unknown,
  jobs = names.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {verifySourceCi} from './scripts/verify-source-ci.js'; verifySourceCi(${JSON.stringify(candidate)}, ${JSON.stringify(jobs)}, '${sha}');`,
    ],
    { encoding: 'utf8' },
  ).status;
}
describe('exact integrated source reuse before publication', () => {
  it('accepts one successful main run with the whole required closure', () =>
    expect(verify(run)).toBe(0));
  it.each(['failure', 'cancelled', 'skipped', ''])('rejects required job %s', (conclusion) => {
    expect(
      verify(
        run,
        names.map((name) => ({
          name,
          status: 'completed',
          conclusion: name === 'quality-full' ? conclusion : 'success',
        })),
      ),
    ).not.toBe(0);
  });
  it.each([
    { event: 'pull_request' },
    { repository: { full_name: 'someone/else' } },
    { path: '.github/workflows/untrusted.yaml' },
    { head_sha: 'b'.repeat(40) },
    { run_attempt: 2 },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_branch: 'codex/test' },
  ])('rejects nonidentical source authority %j', (override) =>
    expect(verify({ ...run, ...override })).not.toBe(0),
  );
  it('rejects a missing or duplicate job', () => {
    expect(verify(run, [])).not.toBe(0);
    const jobs = names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
    expect(verify(run, [...jobs, jobs[0]!])).not.toBe(0);
  });
});

const controller = 'c'.repeat(40);
const controllerTree = 'd'.repeat(40);
const base = '1'.repeat(40);
const merge = 'e'.repeat(40);
const mergeTree = 'f'.repeat(40);
const frozenBase = '11954ffd6d7bf7bd9b198e7e68d2123011f091c1';
const syntheticGitRoot = mkdtempSync(join(tmpdir(), 'verify-source-ci-synthetic-'));
const syntheticGitDir = join(syntheticGitRoot, '.git');
mkdirSync(syntheticGitDir, { recursive: true });
writeFileSync(join(syntheticGitDir, 'config'), '', 'utf8');
afterAll(() => rmSync(syntheticGitRoot, { recursive: true, force: true }));
const oid = (n: number) => n.toString(16).padStart(40, '0');
const fixtureRuntimeRows: Row[] = CONTROLLER_PROMOTION_EXECUTABLE_PATHS.map((path, i) => ({
  path,
  mode: '100644',
  blobOid: oid(i + 1),
}));
const fixtureSqlRows: Row[] = Array.from({ length: 101 }, (_, i) => ({
  path: `packages/database/migrations/${String(i + 1).padStart(4, '0')}.sql`,
  mode: '100644',
  blobOid: oid(500 + i),
}));
const fixtureResolutionRows = CONTROLLER_PROMOTION_CHANGED_PATHS.filter(
  (path) => !CONTROLLER_PROMOTION_EXECUTABLE_PATHS.includes(path),
).map((path, i) => ({
  path,
  status: 'M',
  oldMode: '100644',
  newMode: '100644',
  oldOid: oid(700 + i),
  newOid: oid(800 + i),
}));
function independentManifestDigest<T extends { path: string }>(rows: readonly T[]) {
  return createHash('sha256')
    .update(JSON.stringify([...rows].sort((a, b) => a.path.localeCompare(b.path))) + '\n')
    .digest('hex');
}
const jobs = (): JobInventory => ({
  total_count: names.length,
  jobs: names.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
});
const promotion = (overrides: Partial<Promotion> = {}): Promotion => {
  const value: Promotion = {
    schema: 1,
    controllerSha: controller,
    controllerTree,
    prNumber: 402,
    headBranch: 'codex/backup-supervisor-host-20261016',
    baseSha: base,
    prCiRunId: '1234',
    mergeSha: merge,
    mergeTree,
    mainCiRunId: '5678',
    executableManifestSha256: '0'.repeat(64),
    resolutionManifestSha256: '1'.repeat(64),
    sha256: '',
    ...overrides,
  };
  value.sha256 = controllerPromotionDigest(value);
  return value;
};
const ci = (id: string, sha: string, event: string, branch: string) => ({
  ...run,
  id,
  head_sha: sha,
  event,
  head_branch: branch,
  head_repository: { full_name: 'Z6v6e6r/lk2' },
});
const pull = () => ({
  number: 402,
  state: 'closed',
  merged: true,
  base: { ref: 'main', sha: base, repo: { full_name: 'Z6v6e6r/lk2' } },
  head: {
    sha: controller,
    ref: 'codex/backup-supervisor-host-20261016',
    repo: { full_name: 'Z6v6e6r/lk2' },
  },
  merge_commit_sha: merge,
});

/** A deterministic, disposable Git reader. It deliberately constructs evidence,
 * rather than deriving assertions from the verifier's result. */
function trustedGit(
  options: {
    changed?: string[];
    mergeParents?: string;
    shallow?: string;
    alternates?: string;
    config?: string;
    sourcePath?: string;
    commonDir?: string;
    topLevel?: string;
    fsck?: Error;
    badBlob?: boolean;
    sqlCount?: number;
    rootSourceSuffix?: string;
  } = {},
): Git {
  const runtimeRows = fixtureRuntimeRows;
  const sqlRows = Array.from({ length: options.sqlCount ?? 101 }, (_, i) => ({
    path: `packages/database/migrations/${String(i + 1).padStart(4, '0')}.sql`,
    mode: '100644',
    blobOid: oid(500 + i),
  }));
  const rowText = (rows: Row[]) =>
    rows.map((r) => `${r.mode} blob ${r.blobOid}\t${r.path}`).join('\0');
  const js = CONTROLLER_PROMOTION_EXECUTABLE_PATHS.filter((path) => path.endsWith('.js'));
  const sources = new Map(js.map((path) => [path, '']));
  const root = 'scripts/run-timeweb-standard-delivery.js';
  sources.set(
    root,
    js
      .filter((path) => path !== root)
      .map((path) => `import './${path.slice('scripts/'.length)}';`)
      .join('\n') + (options.rootSourceSuffix ?? ''),
  );
  const callback = (args: string[]) => {
    const joined = args.join(' ');
    if (
      joined ===
      `--git-dir=/dev/null config --file ${join(options.sourcePath ?? syntheticGitRoot, '.git/config')} --no-includes --null --list`
    )
      return options.config ?? '';
    if (joined === 'rev-parse --path-format=absolute --git-common-dir')
      return options.commonDir ?? syntheticGitDir;
    if (joined === 'rev-parse --absolute-git-dir') return options.commonDir ?? syntheticGitDir;
    if (joined === 'rev-parse --show-toplevel') return options.topLevel ?? syntheticGitRoot;
    if (joined === 'rev-parse --is-shallow-repository') return options.shallow ?? 'false';
    if (joined === 'count-objects -v') return options.alternates ?? 'count: 0';
    if (args[0] === 'fsck') {
      if (options.fsck) throw options.fsck;
      return '';
    }
    if (args[0] === 'cat-file' && args[1] === 'commit') {
      const mergeParents = (options.mergeParents ?? `${base} ${controller}`)
        .split(' ')
        .map((parent) => `parent ${parent}`)
        .join('\n');
      const commits: Record<string, string> = {
        [controller]: `tree ${controllerTree}\nparent ${frozenBase}\n\ncontroller`,
        [base]: `tree ${oid(2000)}\nparent ${frozenBase}\n\nbase`,
        [merge]: `tree ${mergeTree}\n${mergeParents}\n\nmerge`,
      };
      return commits[args[2]!] ?? `tree ${oid(3000)}\n\nbase`;
    }
    if (args[0] === 'show') {
      const object = args[1];
      if (!object) throw new Error('missing synthetic Git object');
      return sources.get(object.slice(object.indexOf(':') + 1)) ?? '';
    }
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'diff' && args.includes('--name-only'))
      return (options.changed ?? CONTROLLER_PROMOTION_CHANGED_PATHS).join('\n');
    if (args[0] === 'diff')
      return CONTROLLER_PROMOTION_CHANGED_PATHS.filter(
        (path) => !CONTROLLER_PROMOTION_EXECUTABLE_PATHS.includes(path),
      )
        .map((path, i) => `:100644 100644 ${oid(700 + i)} ${oid(800 + i)} M\0${path}`)
        .join('\0');
    if (args[0] === 'ls-tree') {
      const revision = args[3]!;
      const paths = args.slice(5);
      const rows =
        paths[0] === 'packages/database/migrations'
          ? sqlRows
          : revision === merge
            ? [...runtimeRows, ...sqlRows].map((row) =>
                row.path === runtimeRows[0]?.path && options.badBlob
                  ? { ...row, blobOid: oid(999) }
                  : row,
              )
            : runtimeRows;
      return rowText(rows);
    }
    throw new Error(`unexpected git: ${joined}`);
  };
  Object.defineProperty(callback, 'sourcePath', { value: options.sourcePath ?? syntheticGitRoot });
  return callback as Git;
}

function proofPromotion() {
  return promotion({
    executableManifestSha256: independentManifestDigest([...fixtureRuntimeRows, ...fixtureSqlRows]),
    resolutionManifestSha256: independentManifestDigest(fixtureResolutionRows),
  });
}
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    prRun: {
      ...ci('1234', controller, 'pull_request', 'codex/backup-supervisor-host-20261016'),
      pull_requests: [],
    },
    prJobs: jobs(),
    mainRun: ci('5678', merge, 'push', 'main'),
    mainJobs: jobs(),
    pullRequest: pull(),
    git: trustedGit(),
    ...overrides,
  };
}

describe('controller-only promotion authority', () => {
  it('accepts a closed two-parent merge with exact PR and main CI evidence', () => {
    const p = proofPromotion();
    expect(controllerPromotionManifestSha256([...fixtureRuntimeRows, ...fixtureSqlRows])).toBe(
      p.executableManifestSha256,
    );
    expect(controllerPromotionManifestSha256(fixtureResolutionRows)).toBe(
      p.resolutionManifestSha256,
    );
    expect(
      validateControllerPromotion(p, {
        controllerSha: controller,
        controllerTree,
        controllerSourceCiRunId: '1234',
      }),
    ).toEqual(p);
    expect(verifyControllerPromotion(p, evidence())).toMatchObject({
      controllerSha: controller,
      mergeSha: merge,
    });
  });

  it.each([
    [
      'foreign PR CI repository',
      { prRun: { ...evidence().prRun, repository: { full_name: 'evil/repo' } } },
    ],
    ['PR CI retry', { prRun: { ...evidence().prRun, run_attempt: 2 } }],
    [
      'main job failure',
      {
        mainJobs: {
          ...jobs(),
          jobs: jobs().jobs.map((job) =>
            job.name === 'quality' ? { ...job, conclusion: 'failure' } : job,
          ),
        },
      },
    ],
    [
      'duplicate job',
      { prJobs: { total_count: names.length + 1, jobs: [...jobs().jobs, jobs().jobs[0]!] } },
    ],
    ['truncated inventory', { mainJobs: { total_count: names.length + 1, jobs: jobs().jobs } }],
    [
      'merged PR head mismatch',
      { pullRequest: { ...pull(), head: { ...pull().head, sha: 'a'.repeat(40) } } },
    ],
    [
      'non-empty unrelated PR association',
      {
        prRun: {
          ...evidence().prRun,
          pull_requests: [{ number: 1, head: { sha: controller }, base: { ref: 'main' } }],
        },
      },
    ],
  ])('rejects %s', (_name, override) =>
    expect(() => verifyControllerPromotion(proofPromotion(), evidence(override))).toThrow(
      /CONTROLLER_PROMOTION_/,
    ),
  );

  it.each([
    ['missing parent', base],
    ['reversed parents', `${controller} ${base}`],
    ['extra parent', `${base} ${controller} ${'9'.repeat(40)}`],
  ])('rejects %s merge topology', (_name, mergeParents) =>
    expect(() =>
      collectControllerPromotionGitProof(promotion(), trustedGit({ mergeParents })),
    ).toThrow('CONTROLLER_PROMOTION_PARENTS_TREE'),
  );

  it.each([
    ['shallow repository', { shallow: 'true' }, 'GIT_CUSTODY'],
    ['alternate object store', { alternates: 'alternate: /tmp/objects' }, 'GIT_CUSTODY'],
    ['promisor repository config', { config: 'remote.origin.promisor\ntrue\0' }, 'GIT_CONFIG'],
    [
      'includeIf config subsection',
      { config: 'includeIf."gitdir:fixture".path\n/private/tmp/forbidden\0' },
      'GIT_CONFIG',
    ],
    [
      'quoted newline includeIf key',
      { config: 'includeif.gitdir:synthetic\n.path\nignored\0' },
      'GIT_CONFIG',
    ],
    [
      'foreign common directory',
      { commonDir: '/private/tmp/foreign-git-directory' },
      'GIT_METADATA',
    ],
    ['fsck error', { fsck: new Error('broken') }, 'broken'],
    [
      'source closure drift',
      { changed: CONTROLLER_PROMOTION_CHANGED_PATHS.slice(1) },
      'SOURCE_CLOSURE',
    ],
    ['migration count drift', { sqlCount: 100 }, 'FROZEN_LEDGER'],
    ['post-merge executable blob drift', { badBlob: true }, 'EXECUTABLE_BLOB'],
    [
      'undeclared local JavaScript import',
      { rootSourceSuffix: "\nimport './not-approved.js';" },
      'IMPORT_CLOSURE',
    ],
    [
      'computed dynamic import',
      { rootSourceSuffix: "\nconst name = './safe.js'; import(name);" },
      'DYNAMIC_IMPORT',
    ],
  ])('rejects untrusted Git proof: %s', (_name, options, code) =>
    expect(() => collectControllerPromotionGitProof(promotion(), trustedGit(options))).toThrow(
      code,
    ),
  );

  it('rejects actual local promisor/include config and grafts before integrity traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-source-ci-custody-'));
    const git = ((args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    }) as Git;
    Object.defineProperty(git, 'sourcePath', { value: root });
    try {
      expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
      expect(
        spawnSync('git', ['config', 'remote.origin.promisor', 'true'], { cwd: root }).status,
      ).toBe(0);
      expect(() => collectControllerPromotionGitProof(promotion(), git)).toThrow(
        'CONTROLLER_PROMOTION_GIT_CONFIG',
      );
      expect(
        spawnSync('git', ['config', '--unset', 'remote.origin.promisor'], { cwd: root }).status,
      ).toBe(0);
      const includeTarget = join(root, 'forbidden-include.config');
      writeFileSync(includeTarget, '[unterminated-invalid-config', 'utf8');
      expect(
        spawnSync('git', ['config', 'include.path', includeTarget], { cwd: root }).status,
      ).toBe(0);
      expect(() => collectControllerPromotionGitProof(promotion(), git)).toThrow(
        'CONTROLLER_PROMOTION_GIT_CONFIG',
      );
      expect(
        spawnSync(
          'git',
          [
            '--git-dir=/dev/null',
            'config',
            '--file',
            join(root, '.git', 'config'),
            '--no-includes',
            '--unset',
            'include.path',
          ],
          { cwd: root },
        ).status,
      ).toBe(0);
      mkdirSync(join(root, '.git', 'info'), { recursive: true });
      writeFileSync(join(root, '.git', 'info', 'grafts'), '# no traversal\n', 'utf8');
      expect(() => collectControllerPromotionGitProof(promotion(), git)).toThrow(
        'CONTROLLER_PROMOTION_GRAFTS',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads no metadata, objects, or history before rejecting local include configuration', () => {
    const calls: string[] = [];
    const fixture = trustedGit({ config: 'include.path\n/private/tmp/does-not-exist\0' });
    const git = ((args: string[]) => {
      calls.push(args.join(' '));
      return fixture(args);
    }) as unknown as Git;
    Object.defineProperty(git, 'sourcePath', { value: syntheticGitRoot });
    expect(() => collectControllerPromotionGitProof(promotion(), git)).toThrow(
      'CONTROLLER_PROMOTION_GIT_CONFIG',
    );
    expect(calls).toEqual([
      `--git-dir=/dev/null config --file ${join(syntheticGitRoot, '.git', 'config')} --no-includes --null --list`,
    ]);
  });

  it('rejects missing, empty, symlinked, and hard-linked source config custody', () => {
    const missing = (() => '') as unknown as Git;
    expect(() => collectControllerPromotionGitProof(promotion(), missing)).toThrow(
      'CONTROLLER_PROMOTION_GIT_METADATA',
    );
    Object.defineProperty(missing, 'sourcePath', { value: '' });
    expect(() => collectControllerPromotionGitProof(promotion(), missing)).toThrow(
      'CONTROLLER_PROMOTION_GIT_METADATA',
    );

    const root = mkdtempSync(join(tmpdir(), 'verify-source-ci-config-custody-'));
    const gitDir = join(root, '.git');
    const config = join(gitDir, 'config');
    const target = join(root, 'config-target');
    try {
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(target, '', 'utf8');
      symlinkSync(target, config);
      expect(() =>
        collectControllerPromotionGitProof(promotion(), trustedGit({ sourcePath: root })),
      ).toThrow('CONTROLLER_PROMOTION_GIT_CONFIG');
      unlinkSync(config);
      linkSync(target, config);
      expect(() =>
        collectControllerPromotionGitProof(promotion(), trustedGit({ sourcePath: root })),
      ).toThrow('CONTROLLER_PROMOTION_GIT_CONFIG');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, oversized, writable, malformed, and changed config custody', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-source-ci-config-integrity-'));
    const gitDir = join(root, '.git');
    const config = join(gitDir, 'config');
    try {
      mkdirSync(gitDir, { recursive: true });
      expect(() =>
        collectControllerPromotionGitProof(promotion(), trustedGit({ sourcePath: root })),
      ).toThrow('CONTROLLER_PROMOTION_GIT_METADATA');
      writeFileSync(config, 'x'.repeat(65537), 'utf8');
      expect(() =>
        collectControllerPromotionGitProof(promotion(), trustedGit({ sourcePath: root })),
      ).toThrow('CONTROLLER_PROMOTION_GIT_CONFIG');
      writeFileSync(config, '', 'utf8');
      chmodSync(config, 0o666);
      expect(() =>
        collectControllerPromotionGitProof(promotion(), trustedGit({ sourcePath: root })),
      ).toThrow('CONTROLLER_PROMOTION_GIT_CONFIG');
      chmodSync(config, 0o644);
      const malformed = (() => '') as unknown as Git;
      Object.defineProperty(malformed, 'sourcePath', { value: `${root}\n` });
      expect(() => collectControllerPromotionGitProof(promotion(), malformed)).toThrow(
        'CONTROLLER_PROMOTION_GIT_METADATA',
      );
      const drift = ((args: string[]) => {
        if (args.includes('--no-includes')) writeFileSync(config, 'changed', 'utf8');
        return '';
      }) as unknown as Git;
      Object.defineProperty(drift, 'sourcePath', { value: root });
      expect(() => collectControllerPromotionGitProof(promotion(), drift)).toThrow(
        'CONTROLLER_PROMOTION_GIT_CONFIG',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a real linked worktree before reading its commit graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-source-ci-worktree-'));
    const linked = join(root, 'linked');
    const git = ((args: string[]) => {
      const result = spawnSync('git', args, { cwd: linked, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    }) as Git;
    Object.defineProperty(git, 'sourcePath', { value: linked });
    try {
      expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
      expect(spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: root }).status).toBe(0);
      expect(
        spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root }).status,
      ).toBe(0);
      expect(
        spawnSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: root })
          .status,
      ).toBe(0);
      expect(
        spawnSync('git', ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'], { cwd: root })
          .status,
      ).toBe(0);
      expect(() => collectControllerPromotionGitProof(promotion(), git)).toThrow(
        'CONTROLLER_PROMOTION_GIT_METADATA',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest digest altered after independent proof collection', () => {
    const p = proofPromotion();
    p.executableManifestSha256 = 'f'.repeat(64);
    p.sha256 = controllerPromotionDigest(p);
    expect(() => verifyControllerPromotion(p, evidence())).toThrow('CONTROLLER_PROMOTION_MANIFEST');
  });

  it('binds every controller identity supplied by its caller and rejects null identity fields', () => {
    const p = proofPromotion();
    expect(() => validateControllerPromotion(p, { controllerSha: 'a'.repeat(40) })).toThrow(
      'CONTROLLER_PROMOTION_BINDING',
    );
    expect(() => validateControllerPromotion(p, { controllerTree: 'a'.repeat(40) })).toThrow(
      'CONTROLLER_PROMOTION_BINDING',
    );
    expect(() => validateControllerPromotion(p, { controllerSourceCiRunId: '1' })).toThrow(
      'CONTROLLER_PROMOTION_BINDING',
    );
    expect(() => validateControllerPromotion({ ...p, baseSha: null as unknown as string })).toThrow(
      'CONTROLLER_PROMOTION_IDENTITY',
    );
  });

  it.each([
    ['PR run identifier', { prRun: { ...evidence().prRun, id: '1' } }],
    ['PR event', { prRun: { ...evidence().prRun, event: 'push' } }],
    ['PR head branch', { prRun: { ...evidence().prRun, head_branch: 'codex/other' } }],
    ['PR workflow path', { prRun: { ...evidence().prRun, path: '.github/workflows/other.yaml' } }],
    [
      'PR source repository',
      { prRun: { ...evidence().prRun, head_repository: { full_name: 'fork/lk2' } } },
    ],
    ['main run identifier', { mainRun: { ...evidence().mainRun, id: '1' } }],
    ['main source SHA', { mainRun: { ...evidence().mainRun, head_sha: controller } }],
    ['main branch', { mainRun: { ...evidence().mainRun, head_branch: 'codex/other' } }],
    ['main event', { mainRun: { ...evidence().mainRun, event: 'pull_request' } }],
    [
      'main repository',
      { mainRun: { ...evidence().mainRun, repository: { full_name: 'fork/lk2' } } },
    ],
    ['PR base SHA', { pullRequest: { ...pull(), base: { ...pull().base, sha: 'a'.repeat(40) } } }],
  ])('rejects wrong %s', (_name, override) =>
    expect(() => verifyControllerPromotion(proofPromotion(), evidence(override))).toThrow(
      /CONTROLLER_PROMOTION_|Untrusted or incomplete source CI/,
    ),
  );

  it('keeps the legacy controller source authority route independent of promotion proof', async () => {
    const calls: string[] = [];
    await expect(
      readControllerSourceAuthority(
        { controllerSourceCiRunId: '7', controllerSha: sha },
        trustedGit(),
        (path: string) => {
          calls.push(path);
          return Promise.resolve(
            path.endsWith('/jobs?per_page=100') ? jobs() : ci('7', sha, 'push', 'main'),
          );
        },
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual(['actions/runs/7', 'actions/runs/7/attempts/1/jobs?per_page=100']);
  });

  it('fetches only the promotion proof records bound by the promotion', async () => {
    const p = proofPromotion();
    const calls: string[] = [];
    await expect(
      readControllerSourceAuthority(
        {
          controllerPromotion: p,
          controllerSha: controller,
          controllerTree,
          controllerSourceCiRunId: '1234',
        },
        trustedGit(),
        (path: string) => {
          calls.push(path);
          const responses: Record<string, unknown> = {
            'actions/runs/1234': { ...evidence().prRun },
            'actions/runs/1234/attempts/1/jobs?per_page=100': jobs(),
            'actions/runs/5678': evidence().mainRun,
            'actions/runs/5678/attempts/1/jobs?per_page=100': jobs(),
            'pulls/402': pull(),
          };
          return Promise.resolve(responses[path]);
        },
      ),
    ).resolves.toMatchObject({ controllerSha: controller, mergeSha: merge });
    expect(calls).toEqual([
      'actions/runs/1234',
      'actions/runs/1234/attempts/1/jobs?per_page=100',
      'actions/runs/5678',
      'actions/runs/5678/attempts/1/jobs?per_page=100',
      'pulls/402',
    ]);
  });

  it.each([
    ['missing outer PR CI binding', { controllerSha: controller, controllerTree }],
    [
      'mixed outer PR CI binding',
      { controllerSha: controller, controllerTree, controllerSourceCiRunId: '9999' },
    ],
    [
      'wrong outer controller SHA',
      { controllerSha: 'a'.repeat(40), controllerTree, controllerSourceCiRunId: '1234' },
    ],
  ])('rejects %s before any promotion authority fetch', async (_name, outer) => {
    const calls: string[] = [];
    await expect(
      readControllerSourceAuthority(
        { controllerPromotion: proofPromotion(), ...outer },
        trustedGit(),
        (path: string) => {
          calls.push(path);
          return Promise.reject(new Error('network must not be used'));
        },
      ),
    ).rejects.toThrow(/CONTROLLER_PROMOTION_/);
    expect(calls).toEqual([]);
  });
});
