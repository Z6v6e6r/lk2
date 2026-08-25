import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALL_SERVICES = ['web', 'api', 'worker', 'realtime', 'migrator'];
const BACKEND_WITH_MIGRATOR = ['api', 'worker', 'realtime', 'migrator'];

const APP_SERVICE_PREFIXES = new Map([
  ['apps/web/', 'web'],
  ['apps/api/', 'api'],
  ['apps/worker/', 'worker'],
  ['apps/realtime/', 'realtime'],
  ['apps/migrator/', 'migrator'],
]);

const CRITICAL_PATH_FRAGMENT =
  /acl|auth|booking|capacity|deploy|discount|identity|migrat|oauth|payment|pii|provider|rating|rbac|refund|release|rls|roster|schema|security|secret|session|signup|subscription|tenant|tournament|viva/i;

function isDocumentationOnly(path) {
  return (
    path === 'AGENTS.md' ||
    path === 'README.md' ||
    (!path.includes('/') && path.endsWith('.md')) ||
    path.startsWith('docs/') ||
    path.startsWith('.agents/') ||
    path.startsWith('.codex/') ||
    path === '.github/PULL_REQUEST_TEMPLATE.md' ||
    path.startsWith('.github/ISSUE_TEMPLATE/')
  );
}

function isCriticalPath(path) {
  const appRelativePath = path.replace(/^apps\/[^/]+\//, '');
  return CRITICAL_PATH_FRAGMENT.test(appRelativePath);
}

export function selectPrDockerServices(paths) {
  const selected = new Set();

  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')) {
      return [...ALL_SERVICES];
    }
    if (isDocumentationOnly(path)) continue;

    if (path.startsWith('packages/database/migrations/')) {
      for (const service of BACKEND_WITH_MIGRATOR) selected.add(service);
      continue;
    }

    if (
      path.startsWith('packages/') ||
      path.startsWith('contracts/') ||
      path.startsWith('scripts/') ||
      path.startsWith('.github/workflows/') ||
      path.startsWith('.github/actions/') ||
      path.startsWith('deploy/') ||
      path.startsWith('infra/') ||
      /^apps\/[^/]+\/package\.json$/.test(path) ||
      path === 'openapi.yaml' ||
      path === 'package.json' ||
      path === 'package-lock.json' ||
      path === '.npmrc' ||
      path === '.dockerignore' ||
      /^tsconfig(?:\.[^/]+)?\.json$/.test(path) ||
      /^compose(?:\.[^/]+)?\.ya?ml$/.test(path) ||
      isCriticalPath(path)
    ) {
      return [...ALL_SERVICES];
    }

    let matchedApp = false;
    for (const [prefix, service] of APP_SERVICE_PREFIXES) {
      if (path.startsWith(prefix)) {
        selected.add(service);
        matchedApp = true;
        break;
      }
    }
    if (matchedApp) continue;

    if (path.startsWith('apps/mobile/') || path.startsWith('apps/cup-admin/')) continue;

    // Unknown paths fail closed. The classifier only skips proven non-Docker paths.
    return [...ALL_SERVICES];
  }

  return ALL_SERVICES.filter((service) => selected.has(service));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = readFileSync(0).toString('utf8').split('\0').filter(Boolean);
  process.stdout.write(`${JSON.stringify(selectPrDockerServices(paths))}\n`);
}
