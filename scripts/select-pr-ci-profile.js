import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectPrDockerServices } from './select-pr-docker-services.js';

const ALL_SERVICES = ['web', 'api', 'worker', 'realtime', 'migrator'];
const PROFILES = new Set(['docs', 'leaf-web', 'full']);

const SENSITIVE_FRAGMENT =
  /acl|auth|booking|capacity|contract|deploy|discount|identity|migrat|oauth|openapi|payment|permission|pii|provider|rating|rbac|refund|release|rls|roster|schema|security|secret|session|signup|subscription|tenant|tournament|viva/i;

const LEAF_WEB_ALLOWLIST = new Set([
  'apps/web/src/RecommendationGridCard.tsx',
  'apps/web/src/RecommendationGridCard.test.tsx',
  'apps/web/src/styles.css',
]);

function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').includes('..')
  );
}

function isPolicyPath(path) {
  return (
    path === 'AGENTS.md' ||
    path === '.github/PULL_REQUEST_TEMPLATE.md' ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.md$/u.test(path) ||
    /^\.agents\/[^/]+(?:\/[^/]+)*\.md$/u.test(path)
  );
}

function isSafeDocumentationPath(path) {
  if (path === 'AGENTS.md' || path === '.github/PULL_REQUEST_TEMPLATE.md') return true;
  const markdown =
    (/^[^/]+\.md$/u.test(path) || /^docs\/.+\.md$/u.test(path)) &&
    !path.startsWith('docs/audits/') &&
    !path.startsWith('docs/release-audit-');
  return markdown && !SENSITIVE_FRAGMENT.test(path);
}

function isLeafWebPath(path) {
  return LEAF_WEB_ALLOWLIST.has(path) && !SENSITIVE_FRAGMENT.test(path);
}

function needsDeploymentContract(path) {
  return (
    /^apps\/(?:web|api|worker|realtime|migrator)\/Dockerfile$/u.test(path) ||
    path === '.dockerignore' ||
    path.startsWith('deploy/timeweb/') ||
    path === '.github/workflows/pull-request.yaml' ||
    (/^\.github\/workflows\/.+\.ya?ml$/u.test(path) &&
      /deploy|publish|reconcile|release|timeweb/i.test(path)) ||
    (path.startsWith('scripts/') &&
      /timeweb/i.test(path) &&
      /base-image|custody|deploy|publication|provenance|reconcil|release/i.test(path))
  );
}

function needsProvenanceProbe(path) {
  return (
    /^apps\/(?:web|api|worker|realtime|migrator)\/Dockerfile$/u.test(path) ||
    path === '.dockerignore' ||
    path === '.github/workflows/pull-request.yaml' ||
    (/timeweb/i.test(path) &&
      /base-image|provenance|publication|publish|reconcil|release/i.test(path))
  );
}

function makePlan({
  profile,
  deploymentContract,
  provenanceProbe,
  policyValidation,
  reason,
  dockerServices,
}) {
  if (!PROFILES.has(profile)) throw new Error(`Unsupported CI profile: ${profile}`);
  return {
    schemaVersion: 1,
    profile,
    docsQuality: profile === 'docs',
    webQuality: profile === 'leaf-web',
    fullQuality: profile === 'full',
    deploymentContract,
    provenanceProbe,
    policyValidation,
    dockerServices:
      dockerServices ??
      (profile === 'docs' ? [] : profile === 'leaf-web' ? ['web'] : [...ALL_SERVICES]),
    reason,
  };
}

export function selectPrCiProfile(paths, { eventName = 'pull_request', ref = '' } = {}) {
  if (eventName === 'push') {
    if (ref !== 'refs/heads/main' && !ref.startsWith('refs/heads/integration/')) {
      throw new Error(`Unsupported push ref: ${ref}`);
    }
    return makePlan({
      profile: 'full',
      deploymentContract: true,
      provenanceProbe: true,
      policyValidation: false,
      reason: `push to ${ref} requires the full integration contour`,
    });
  }
  if (eventName !== 'pull_request') throw new Error(`Unsupported event: ${eventName}`);

  if (!Array.isArray(paths) || paths.length === 0) {
    return makePlan({
      profile: 'full',
      deploymentContract: false,
      provenanceProbe: false,
      policyValidation: false,
      reason: 'empty changed-path set fails closed',
    });
  }
  if (paths.some((path) => !validPath(path))) {
    return makePlan({
      profile: 'full',
      deploymentContract: false,
      provenanceProbe: false,
      policyValidation: false,
      reason: 'invalid changed path fails closed',
    });
  }

  const uniquePaths = [...new Set(paths)].sort();
  const deploymentContract = uniquePaths.some(needsDeploymentContract);
  const provenanceProbe = uniquePaths.some(needsProvenanceProbe);
  const policyValidation = uniquePaths.some(isPolicyPath);

  if (uniquePaths.every(isSafeDocumentationPath)) {
    return makePlan({
      profile: 'docs',
      deploymentContract,
      provenanceProbe,
      policyValidation,
      reason: `all ${uniquePaths.length} changed paths are proven-safe documentation or policy`,
    });
  }
  if (policyValidation) {
    return makePlan({
      profile: 'full',
      deploymentContract,
      provenanceProbe,
      policyValidation,
      dockerServices: selectPrDockerServices(uniquePaths),
      reason: 'policy mixed with non-documentation changes requires full closure',
    });
  }
  if (uniquePaths.every((path) => isLeafWebPath(path) || isSafeDocumentationPath(path))) {
    return makePlan({
      profile: 'leaf-web',
      deploymentContract,
      provenanceProbe,
      policyValidation,
      reason: `all ${uniquePaths.length} changed paths are proven presentation-only Web or documentation`,
    });
  }

  return makePlan({
    profile: 'full',
    deploymentContract,
    provenanceProbe,
    policyValidation,
    dockerServices: selectPrDockerServices(uniquePaths),
    reason: 'sensitive, shared, build, workflow, runtime, or unknown path requires full closure',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const eventIndex = process.argv.indexOf('--event');
  const refIndex = process.argv.indexOf('--ref');
  if (eventIndex < 0 || !process.argv[eventIndex + 1] || refIndex < 0) {
    throw new Error('Usage: select-pr-ci-profile.js --event <event> --ref <ref>');
  }
  const paths = readFileSync(0).toString('utf8').split('\0').filter(Boolean);
  const plan = selectPrCiProfile(paths, {
    eventName: process.argv[eventIndex + 1],
    ref: process.argv[refIndex + 1] ?? '',
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
