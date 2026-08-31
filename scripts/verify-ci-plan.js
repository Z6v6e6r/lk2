import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALL_SERVICES = ['web', 'api', 'worker', 'realtime', 'migrator'];
const RESULT_VALUES = new Set(['success', 'failure', 'cancelled', 'skipped']);

export function parseAndValidateCiPlan(text) {
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw new Error(`CI plan is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('CI plan must be an object');
  }
  if (plan.schemaVersion !== 1) throw new Error('Unsupported CI plan schema');
  if (!['docs', 'leaf-web', 'full'].includes(plan.profile)) {
    throw new Error('Unsupported CI profile');
  }
  for (const key of [
    'docsQuality',
    'webQuality',
    'fullQuality',
    'deploymentContract',
    'provenanceProbe',
    'policyValidation',
  ]) {
    if (typeof plan[key] !== 'boolean') throw new Error(`CI plan ${key} must be boolean`);
  }
  if (typeof plan.reason !== 'string' || plan.reason.length === 0) {
    throw new Error('CI plan reason must be non-empty');
  }
  if (!Array.isArray(plan.dockerServices))
    throw new Error('CI plan dockerServices must be an array');
  if (
    plan.dockerServices.some((service) => !ALL_SERVICES.includes(service)) ||
    new Set(plan.dockerServices).size !== plan.dockerServices.length
  ) {
    throw new Error('CI plan Docker services are malformed');
  }
  const expectedFlags = {
    docs: [true, false, false],
    'leaf-web': [false, true, false],
    full: [false, false, true],
  }[plan.profile];
  const [docsQuality, webQuality, fullQuality] = expectedFlags;
  if (
    plan.docsQuality !== docsQuality ||
    plan.webQuality !== webQuality ||
    plan.fullQuality !== fullQuality
  ) {
    throw new Error('CI plan profile flags are inconsistent');
  }
  if (plan.profile === 'docs' && plan.dockerServices.length !== 0) {
    throw new Error('Docs profile cannot select Docker services');
  }
  if (
    plan.profile === 'leaf-web' &&
    JSON.stringify(plan.dockerServices) !== JSON.stringify(['web'])
  ) {
    throw new Error('Leaf Web profile must select only Web Docker');
  }
  if (plan.provenanceProbe && !plan.deploymentContract) {
    throw new Error('Provenance probe requires deployment contract');
  }
  return plan;
}

function requireResult(result, label) {
  if (!RESULT_VALUES.has(result)) throw new Error(`${label} has missing or malformed result`);
}

export function verifyConditionalResult(required, result, label) {
  requireResult(result, label);
  const expected = required ? 'success' : 'skipped';
  if (result !== expected) throw new Error(`${label} result ${result}; expected ${expected}`);
}

export function verifyQualityResults(plan, results) {
  parseAndValidateCiPlan(JSON.stringify(plan));
  verifyConditionalResult(plan.docsQuality, results.docs, 'docs quality');
  verifyConditionalResult(plan.webQuality, results.web, 'Web quality');
  verifyConditionalResult(plan.fullQuality, results.source, 'source quality');
  verifyConditionalResult(plan.fullQuality, results.full, 'full quality');
}

function planFromEnvironment() {
  return parseAndValidateCiPlan(process.env.PLAN_JSON ?? '');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'plan') {
    const fileIndex = process.argv.indexOf('--file');
    if (fileIndex < 0 || !process.argv[fileIndex + 1]) throw new Error('Missing --file');
    parseAndValidateCiPlan(readFileSync(process.argv[fileIndex + 1], 'utf8'));
  } else if (command === 'quality') {
    verifyQualityResults(planFromEnvironment(), {
      docs: process.env.DOCS_RESULT,
      web: process.env.WEB_RESULT,
      source: process.env.SOURCE_RESULT,
      full: process.env.FULL_RESULT,
    });
  } else if (command === 'conditional') {
    const plan = planFromEnvironment();
    const field = process.argv[3];
    if (!['deploymentContract', 'provenanceProbe'].includes(field)) {
      throw new Error(`Unsupported conditional field: ${field}`);
    }
    verifyConditionalResult(plan[field], process.env.ACTUAL_RESULT, field);
  } else if (command === 'gate') {
    const results = JSON.parse(process.env.GATE_RESULTS ?? '{}');
    for (const [label, result] of Object.entries(results)) {
      requireResult(result, label);
      if (result !== 'success') throw new Error(`${label} result ${result}; expected success`);
    }
  } else {
    throw new Error(`Unsupported verify-ci-plan command: ${command ?? '<missing>'}`);
  }
}
