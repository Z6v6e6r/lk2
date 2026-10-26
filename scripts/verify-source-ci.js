import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

export function verifySourceCi(run, jobs, sha) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    run.head_sha !== sha ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/pull-request.yaml' ||
    run.run_attempt !== 1 ||
    run.repository?.full_name !== 'Z6v6e6r/lk2'
  )
    throw new Error('Untrusted or incomplete source CI');
  for (const name of [
    'ci-plan',
    'source-quality',
    'quality-full',
    'quality',
    'dependency-security',
    'secret-scan',
    'deployment-contract',
    'docker-build',
    'pr-gate',
  ]) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    ) {
      throw new Error(`Required source job did not succeed: ${name}`);
    }
  }
  return true;
}

export async function readSourceCi(runId, sha, token = process.env.GH_TOKEN) {
  if (!/^[1-9][0-9]*$/.test(runId ?? '') || !token) throw new Error('Missing source CI authority');
  async function get(path) {
    const response = await fetch(
      `https://api.github.com/repos/Z6v6e6r/lk2/actions/runs/${runId}${path}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Source CI lookup failed (${response.status})`);
    return response.json();
  }
  const run = await get('');
  const jobs = await get('/attempts/1/jobs?per_page=100');
  if (jobs.total_count !== jobs.jobs?.length) throw new Error('Truncated source CI job inventory');
  verifySourceCi(run, jobs.jobs, sha);
}

// A controller-only promotion preserves the frozen application tree. The legacy
// main-push verifier above is deliberately unchanged.
export const CONTROLLER_PROMOTION_CHANGED_PATHS = Object.freeze([
  '.github/workflows/pull-request.yaml',
  'apps/mobile/android/app/build.gradle',
  'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidHttpSenderTest.java',
  'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidSessionTest.java',
  'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidUpcomingBookingsRefreshTest.java',
  'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidHttpSender.java',
  'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidSessionEngine.java',
  'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidUpcomingBookingsRefresh.java',
  'apps/mobile/android/app/src/main/java/ru/padlhub/app/PadlHubAndroidSessionPlugin.java',
  'apps/mobile/src/MobileApp.test.tsx',
  'apps/mobile/src/MobileApp.tsx',
  'apps/mobile/src/MobileSession.test.tsx',
  'apps/mobile/src/native-api-fetch.test.ts',
  'apps/mobile/src/native-api-fetch.ts',
  'apps/mobile/src/native-bookings-refresh.test.ts',
  'apps/mobile/src/native-gateway.test.ts',
  'apps/mobile/src/session-failure.test.ts',
  'apps/mobile/src/session-failure.ts',
  'docs/adr/0005-viva-user-delegation-and-direct-transport.md',
  'docs/adr/0020-client-assisted-booking-screen-snapshots.md',
  'docs/adr/0023-browser-only-viva-end-user-transport.md',
  'docs/runbooks/android-chats-fcm.md',
  'docs/runbooks/android-development.md',
  'docs/runbooks/timeweb-standard-delivery.md',
  'scripts/control-timeweb-database-backup.py',
  'scripts/control-timeweb-database-backup.test.ts',
  'scripts/control-timeweb-location-photo-acl.py',
  'scripts/control-timeweb-location-photo-acl.test.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'scripts/pull-request-ci-workflow.test.ts',
  'scripts/rehearse-timeweb-standard-compose.js',
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/test-timeweb-database-backup.py',
  'scripts/timeweb-adopt-manual-baseline.js',
  'scripts/timeweb-adopt-manual-baseline.d.ts',
  'scripts/timeweb-adopt-manual-baseline.test.ts',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-worker-adapter.test.ts',
  'scripts/timeweb-api-worker-contract.d.ts',
  'scripts/timeweb-api-worker-contract.js',
  'scripts/timeweb-api-worker-migration-role.d.ts',
  'scripts/timeweb-api-worker-migration-role.js',
  'scripts/timeweb-api-worker-migration-role.test.ts',
  'scripts/timeweb-api-worker-migration.adapter.test.ts',
  'scripts/timeweb-api-worker-migration.d.ts',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-migration.test.ts',
  'scripts/timeweb-api-worker-upgrade.d.ts',
  'scripts/timeweb-api-worker-upgrade.js',
  'scripts/timeweb-api-worker-upgrade.test.ts',
  'scripts/timeweb-api-worker.fixture.ts',
  'scripts/timeweb-standard-compose.test.ts',
  'scripts/verify-source-ci.js',
  'scripts/verify-source-ci.test.ts',
]);
export const CONTROLLER_PROMOTION_EXECUTABLE_PATHS = Object.freeze([
  'deploy/timeweb/api-web-observability.v1.json',
  'deploy/timeweb/base-images.lock.json',
  'deploy/timeweb/compose.beta.yaml',
  'deploy/timeweb/github-release-reader.contract.json',
  'deploy/timeweb/release-manifest.schema.json',
  'deploy/timeweb/release-manifest.v1.schema.json',
  'deploy/timeweb/runtime-environment.contract.json',
  'deploy/timeweb/target.json',
  'deploy/timeweb/yandex-public-beta-rollback-floor.json',
  'package-lock.json',
  'package.json',
  'scripts/control-timeweb-database-backup.py',
  'scripts/control-timeweb-location-photo-acl.py',
  'scripts/control-timeweb-location-photo-acl.test.ts',
  'scripts/presentation-boundary.js',
  'scripts/produce-timeweb-api-web-observability-evidence.js',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/render-timeweb-beta-release-env.js',
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/safe-web-boundary.js',
  'scripts/strict-json.js',
  'scripts/timeweb-adopt-manual-baseline.js',
  'scripts/timeweb-adopt-manual-baseline.d.ts',
  'scripts/timeweb-adopt-manual-baseline.test.ts',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-worker-contract.d.ts',
  'scripts/timeweb-api-worker-contract.js',
  'scripts/timeweb-api-worker-migration-role.js',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-upgrade.js',
  'scripts/timeweb-cors-origins.js',
  'scripts/timeweb-critical-web.js',
  'scripts/timeweb-release-manifest-contract.js',
  'scripts/timeweb-standard-diagnostic.js',
  'scripts/timeweb-standard-policy.js',
  'scripts/verify-source-ci.js',
  'scripts/verify-timeweb-api-web-observability.js',
  'scripts/verify-timeweb-base-images.js',
  'scripts/verify-timeweb-deployment-contract.js',
  'scripts/verify-timeweb-frozen-source.js',
]);
const PROMOTION_BASE = '11954ffd6d7bf7bd9b198e7e68d2123011f091c1';
const SHA = /^[a-f0-9]{40}$/,
  HASH = /^[a-f0-9]{64}$/,
  RUN = /^[1-9][0-9]*$/;
const PROMOTION_KEYS = [
  'schema',
  'controllerSha',
  'controllerTree',
  'prNumber',
  'headBranch',
  'baseSha',
  'prCiRunId',
  'mergeSha',
  'mergeTree',
  'mainCiRunId',
  'executableManifestSha256',
  'resolutionManifestSha256',
  'sha256',
];
const REQUIRED_JOBS = [
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
const promotionFail = (code) => {
  throw new Error('CONTROLLER_PROMOTION_' + code);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value) + '\n')
    .digest('hex');
export function controllerPromotionDigest(value) {
  return digest(
    Object.fromEntries(
      Object.keys(value)
        .filter((k) => k !== 'sha256')
        .sort()
        .map((k) => [k, value[k]]),
    ),
  );
}
export function validateControllerPromotion(value, expected = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !equal(Object.keys(value).sort(), [...PROMOTION_KEYS].sort())
  )
    promotionFail('FIELDS');
  if (
    value.schema !== 1 ||
    !Number.isSafeInteger(value.prNumber) ||
    value.prNumber < 1 ||
    typeof value.headBranch !== 'string' ||
    !/^codex\/[a-z0-9][a-z0-9/_-]{0,199}$/.test(value.headBranch) ||
    value.headBranch.includes('..') ||
    value.headBranch.endsWith('/') ||
    !['controllerSha', 'controllerTree', 'baseSha', 'mergeSha', 'mergeTree'].every(
      (k) => typeof value[k] === 'string' && SHA.test(value[k]),
    ) ||
    !['prCiRunId', 'mainCiRunId'].every(
      (k) => typeof value[k] === 'string' && RUN.test(value[k]),
    ) ||
    value.prCiRunId === value.mainCiRunId ||
    !['executableManifestSha256', 'resolutionManifestSha256', 'sha256'].every(
      (k) => typeof value[k] === 'string' && HASH.test(value[k]),
    ) ||
    value.sha256 !== controllerPromotionDigest(value)
  )
    promotionFail('IDENTITY');
  for (const [key, actual] of [
    ['controllerSha', value.controllerSha],
    ['controllerTree', value.controllerTree],
    ['controllerSourceCiRunId', value.prCiRunId],
  ]) {
    if (Object.hasOwn(expected, key) && expected[key] !== actual) promotionFail('BINDING');
  }
  return value;
}
function fullJobs(inventory) {
  if (
    !inventory ||
    !Number.isSafeInteger(inventory.total_count) ||
    !Array.isArray(inventory.jobs) ||
    inventory.total_count !== inventory.jobs.length
  )
    promotionFail('JOBS_INCOMPLETE');
  for (const name of REQUIRED_JOBS) {
    const matches = inventory.jobs.filter((j) => j?.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    )
      promotionFail('JOB');
  }
  return inventory.jobs;
}
function treeRows(git, revision, paths) {
  const raw = git(['ls-tree', '-r', '-z', revision, '--', ...paths]);
  const rows = raw
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0\r\n]+)$/.exec(line);
      if (!match) promotionFail('TREE_ENTRY');
      return { path: match[3], mode: match[1], blobOid: match[2] };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(rows.map((r) => r.path)).size !== rows.length) promotionFail('TREE_DUPLICATE');
  return rows;
}
function byPath(rows) {
  return new Map(rows.map((r) => [r.path, r]));
}
function sorted(rows) {
  return [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function controllerPromotionManifestSha256(rows) {
  return digest(sorted(rows));
}
function checkedImportClosure(git, sha) {
  const expected = CONTROLLER_PROMOTION_EXECUTABLE_PATHS.filter((p) => p.endsWith('.js'));
  const visited = new Set(),
    queue = [
      'scripts/run-timeweb-standard-delivery.js',
      'scripts/timeweb-api-worker-upgrade.js',
      'scripts/timeweb-api-worker-migration.js',
      'scripts/verify-source-ci.js',
    ];
  while (queue.length) {
    const path = queue.pop();
    if (visited.has(path)) continue;
    if (!expected.includes(path)) promotionFail('IMPORT_CLOSURE');
    visited.add(path);
    const source = git(['show', sha + ':' + path]);
    const imports = ts.preProcessFile(source, true, true).importedFiles.map((i) => i.fileName);
    const syntax = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    if (syntax.parseDiagnostics.length) promotionFail('IMPORT_SYNTAX');
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
        (n.arguments.length !== 1 || !ts.isStringLiteralLike(n.arguments[0]))
      )
        promotionFail('DYNAMIC_IMPORT');
      ts.forEachChild(n, visit);
    };
    visit(syntax);
    for (const name of imports) {
      if (name.startsWith('.')) {
        const local = posix.normalize(posix.join(posix.dirname(path), name));
        if (!expected.includes(local)) promotionFail('IMPORT_CLOSURE');
        queue.push(local);
      } else if (!name.startsWith('node:') && !['yaml', 'typescript', 'postcss'].includes(name))
        promotionFail('PACKAGE_CLOSURE');
    }
  }
  if (!equal([...visited].sort(), [...expected].sort())) promotionFail('IMPORT_CLOSURE');
}
function resolutionRows(git, p) {
  const parts = git(['diff', '--no-renames', '--raw', '--abbrev=40', '-z', p.baseSha, p.mergeSha])
    .split('\0')
    .filter(Boolean);
  if (!parts.length || parts.length % 2) promotionFail('RESOLUTION');
  const rows = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(000000|100644) (100644) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])$/.exec(parts[i]),
      path = parts[i + 1];
    if (
      !m ||
      !CONTROLLER_PROMOTION_CHANGED_PATHS.includes(path) ||
      m[4] === '0'.repeat(40) ||
      (m[5] === 'A'
        ? m[1] !== '000000' || m[3] !== '0'.repeat(40)
        : m[1] !== '100644' || m[3] === '0'.repeat(40))
    )
      promotionFail('RESOLUTION');
    rows.push({ path, status: m[5], oldMode: m[1], newMode: m[2], oldOid: m[3], newOid: m[4] });
  }
  if (new Set(rows.map((r) => r.path)).size !== rows.length) promotionFail('RESOLUTION');
  return sorted(rows.filter((r) => !CONTROLLER_PROMOTION_EXECUTABLE_PATHS.includes(r.path)));
}

export function assertControllerPromotionGitConfig(git) {
  const descriptor =
    typeof git === 'function' && Object.getOwnPropertyDescriptor(git, 'sourcePath');
  const source = descriptor?.value;
  if (
    !descriptor ||
    descriptor.get ||
    descriptor.set ||
    descriptor.writable ||
    descriptor.configurable ||
    typeof source !== 'string' ||
    !posix.isAbsolute(source) ||
    posix.normalize(source) !== source ||
    /[\0\r\n]/.test(source)
  )
    promotionFail('GIT_METADATA');
  let before, directoryBefore;
  const configPath = posix.join(source, '.git/config');
  try {
    for (const path of [source, posix.join(source, '.git')]) {
      const st = lstatSync(path);
      if (path.endsWith('/.git')) directoryBefore = st;
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        st.uid !== process.getuid?.() ||
        st.gid !== process.getgid?.() ||
        (st.mode & 0o022) !== 0 ||
        realpathSync(path) !== path
      )
        promotionFail('GIT_METADATA');
    }
    before = lstatSync(configPath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.gid !== process.getgid?.() ||
      (before.mode & 0o022) !== 0 ||
      before.size > 65536
    )
      promotionFail('GIT_CONFIG');
  } catch (error) {
    if (error?.message?.startsWith('CONTROLLER_PROMOTION_')) throw error;
    promotionFail('GIT_METADATA');
  }
  // --no-includes alone is too late: repository discovery already parses includes.
  // A non-repository git-dir plus an explicit, custody-checked file avoids discovery.
  const config = git([
    '--git-dir=/dev/null',
    'config',
    '--file',
    configPath,
    '--no-includes',
    '--null',
    '--list',
  ]);
  const after = lstatSync(configPath),
    directoryAfter = lstatSync(posix.join(source, '.git'));
  if (
    !['dev', 'ino', 'mode', 'uid', 'gid', 'mtimeMs', 'ctimeMs'].every(
      (key) => directoryBefore[key] === directoryAfter[key],
    )
  )
    promotionFail('GIT_METADATA');
  if (
    !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'].every(
      (key) => before[key] === after[key],
    )
  )
    promotionFail('GIT_CONFIG');
  for (const item of config.split('\0').filter(Boolean)) {
    // Subsection names may contain quoted newlines; match the whole NUL record.
    const record = item.toLowerCase();
    if (
      /^include(?:if)?(?:\.|\n|$)/.test(record) ||
      /^remote\.[\s\S]*\.(?:promisor|partialclonefilter)(?:\n|$)/.test(record) ||
      /^extensions\.(?:partialclone|worktreeconfig)(?:\n|$)/.test(record)
    )
      promotionFail('GIT_CONFIG');
  }
}

function promotionGitCustody(git) {
  assertControllerPromotionGitConfig(git);
  const metadata = (args) => {
    const raw = git(args);
    if (typeof raw !== 'string') promotionFail('GIT_METADATA');
    return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  };
  const common = metadata(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const directory = metadata(['rev-parse', '--absolute-git-dir']);
  const top = metadata(['rev-parse', '--show-toplevel']);
  if (
    ![common, directory, top].every(
      (p) => posix.isAbsolute(p) && posix.normalize(p) === p && !/[\0\r\n]/.test(p),
    ) ||
    common !== directory ||
    common !== posix.join(top, '.git')
  )
    promotionFail('GIT_METADATA');
  const identity = lstatSync(common);
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== process.getuid?.() ||
    identity.gid !== process.getgid?.() ||
    (identity.mode & 0o022) !== 0
  )
    promotionFail('GIT_METADATA');
  try {
    lstatSync(posix.join(common, 'info/grafts'));
    promotionFail('GRAFTS');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error?.message === 'CONTROLLER_PROMOTION_GRAFTS') throw error;
      promotionFail('GIT_METADATA');
    }
  }
  if (
    metadata(['rev-parse', '--is-shallow-repository']) !== 'false' ||
    /(?:^|\n)alternate:/.test(git(['count-objects', '-v']))
  )
    promotionFail('GIT_CUSTODY');
}
function rawPromotionCommit(git, sha) {
  const raw = git(['cat-file', 'commit', sha]),
    end = raw.indexOf('\n\n');
  if (end < 0) promotionFail('COMMIT');
  const headers = raw.slice(0, end).split('\n'),
    tree = /^tree ([a-f0-9]{40})$/.exec(headers[0]);
  const parents = headers
    .filter((line) => line.startsWith('parent '))
    .map((line) => {
      const match = /^parent ([a-f0-9]{40})$/.exec(line);
      if (!match) promotionFail('COMMIT');
      return match[1];
    });
  if (!tree || new Set(parents).size !== parents.length) promotionFail('COMMIT');
  return { tree: tree[1], parents };
}
function rawPromotionAncestry(git, controllerSha) {
  const pending = [controllerSha],
    seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === PROMOTION_BASE) return;
    if (seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 4096) promotionFail('ANCESTRY_LIMIT');
    pending.push(...rawPromotionCommit(git, current).parents);
  }
  promotionFail('ANCESTRY');
}

// git is supplied only by the held, custody-checked source executor, never by JSON.
export function collectControllerPromotionGitProof(p, git) {
  if (
    !p ||
    !['controllerSha', 'controllerTree', 'baseSha', 'mergeSha', 'mergeTree'].every(
      (k) => typeof p[k] === 'string' && SHA.test(p[k]),
    )
  )
    promotionFail('GIT_IDENTITY');
  if (typeof git !== 'function') promotionFail('GIT_CUSTODY');
  promotionGitCustody(git);
  git(['fsck', '--connectivity-only', '--no-reflogs', p.controllerSha, p.mergeSha, p.baseSha]);
  const controller = rawPromotionCommit(git, p.controllerSha),
    merge = rawPromotionCommit(git, p.mergeSha);
  rawPromotionCommit(git, p.baseSha);
  if (
    controller.tree !== p.controllerTree ||
    merge.tree !== p.mergeTree ||
    !equal(merge.parents, [p.baseSha, p.controllerSha])
  )
    promotionFail('PARENTS_TREE');
  rawPromotionAncestry(git, p.controllerSha);
  const changed = git(['diff', '--no-renames', '--name-only', PROMOTION_BASE, p.controllerSha])
    .split('\n')
    .filter(Boolean)
    .sort();
  if (!equal(changed, [...CONTROLLER_PROMOTION_CHANGED_PATHS].sort()))
    promotionFail('SOURCE_CLOSURE');
  const frozen = treeRows(git, PROMOTION_BASE, ['packages/database/migrations']).filter((r) =>
    r.path.endsWith('.sql'),
  );
  const sql = treeRows(git, p.controllerSha, ['packages/database/migrations']).filter((r) =>
    r.path.endsWith('.sql'),
  );
  if (sql.length !== 101 || !equal(sql, frozen)) promotionFail('FROZEN_LEDGER');
  const runtime = treeRows(git, p.controllerSha, CONTROLLER_PROMOTION_EXECUTABLE_PATHS);
  if (!equal(runtime.map((r) => r.path).sort(), [...CONTROLLER_PROMOTION_EXECUTABLE_PATHS].sort()))
    promotionFail('EXECUTABLE_CLOSURE');
  const executable = sorted([...runtime, ...sql]);
  const merged = byPath(
    treeRows(git, p.mergeSha, [
      ...CONTROLLER_PROMOTION_EXECUTABLE_PATHS,
      'packages/database/migrations',
    ]),
  );
  if (!executable.every((r) => equal(r, merged.get(r.path)))) promotionFail('EXECUTABLE_BLOB');
  checkedImportClosure(git, p.controllerSha);
  const resolution = resolutionRows(git, p);
  return { executableManifest: executable, resolutionManifest: resolution };
}
export function verifyControllerPromotion(promotion, evidence) {
  const p = validateControllerPromotion(promotion);
  if (!evidence || typeof evidence !== 'object') promotionFail('EVIDENCE');
  const { prRun, prJobs, mainRun, mainJobs, pullRequest, git } = evidence;
  if (
    !prRun ||
    String(prRun.id) !== p.prCiRunId ||
    prRun.head_sha !== p.controllerSha ||
    prRun.head_branch !== p.headBranch ||
    prRun.event !== 'pull_request' ||
    prRun.status !== 'completed' ||
    prRun.conclusion !== 'success' ||
    prRun.run_attempt !== 1 ||
    prRun.path !== '.github/workflows/pull-request.yaml' ||
    prRun.repository?.full_name !== 'Z6v6e6r/lk2' ||
    prRun.head_repository?.full_name !== 'Z6v6e6r/lk2'
  )
    promotionFail('PR_CI');
  fullJobs(prJobs);
  if (
    !pullRequest ||
    pullRequest.number !== p.prNumber ||
    pullRequest.state !== 'closed' ||
    pullRequest.merged !== true ||
    pullRequest.base?.ref !== 'main' ||
    pullRequest.base?.sha !== p.baseSha ||
    pullRequest.base?.repo?.full_name !== 'Z6v6e6r/lk2' ||
    pullRequest.head?.sha !== p.controllerSha ||
    pullRequest.head?.ref !== p.headBranch ||
    pullRequest.head?.repo?.full_name !== 'Z6v6e6r/lk2' ||
    pullRequest.merge_commit_sha !== p.mergeSha
  )
    promotionFail('PR');
  // GitHub returns [] for completed merged PR runs. Explicit PR metadata above
  // supplies the association; a nonempty run association must not contradict it.
  if (
    prRun.pull_requests !== undefined &&
    (!Array.isArray(prRun.pull_requests) ||
      prRun.pull_requests.length > 1 ||
      prRun.pull_requests.some(
        (r) => r.number !== p.prNumber || r.head?.sha !== p.controllerSha || r.base?.ref !== 'main',
      ))
  )
    promotionFail('PR_ASSOCIATION');
  if (!mainRun || String(mainRun.id) !== p.mainCiRunId) promotionFail('MAIN_CI');
  verifySourceCi(mainRun, fullJobs(mainJobs), p.mergeSha);
  const proof = collectControllerPromotionGitProof(p, git);
  if (
    controllerPromotionManifestSha256(proof.executableManifest) !== p.executableManifestSha256 ||
    controllerPromotionManifestSha256(proof.resolutionManifest) !== p.resolutionManifestSha256
  )
    promotionFail('MANIFEST');
  return {
    sha256: p.sha256,
    controllerSha: p.controllerSha,
    controllerTree: p.controllerTree,
    mergeSha: p.mergeSha,
    ...proof,
  };
}
export async function readControllerSourceAuthority(op, git, githubPublic) {
  if (
    !op ||
    typeof op.controllerSha !== 'string' ||
    !SHA.test(op.controllerSha) ||
    typeof op.controllerSourceCiRunId !== 'string' ||
    !RUN.test(op.controllerSourceCiRunId)
  )
    promotionFail('OPERATION');
  const lookup = async (id) => ({
    run: await githubPublic('actions/runs/' + id),
    jobs: await githubPublic('actions/runs/' + id + '/attempts/1/jobs?per_page=100'),
  });
  if (!Object.hasOwn(op, 'controllerPromotion')) {
    const { run, jobs } = await lookup(op.controllerSourceCiRunId);
    return verifySourceCi(run, fullJobs(jobs), op.controllerSha);
  }
  const p = validateControllerPromotion(op.controllerPromotion, op);
  const pr = await lookup(p.prCiRunId),
    main = await lookup(p.mainCiRunId);
  const pullRequest = await githubPublic('pulls/' + p.prNumber);
  return verifyControllerPromotion(p, {
    prRun: pr.run,
    prJobs: pr.jobs,
    mainRun: main.run,
    mainJobs: main.jobs,
    pullRequest,
    git,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await readSourceCi(process.env.SOURCE_CI_RUN_ID, process.env.EXPECTED_SOURCE_SHA);
}
