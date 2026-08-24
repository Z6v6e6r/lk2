import { resolve } from 'node:path';

import { validateRepositoryPackage } from './viva-provider-clarification-contract.js';

const responseFlagIndex = process.argv.indexOf('--response');
const responseArgument = responseFlagIndex < 0 ? undefined : process.argv[responseFlagIndex + 1];
if (!responseArgument) {
  throw new Error(
    'Usage: node --import tsx scripts/verify-viva-provider-response.ts --response <redacted-response.json>',
  );
}

const root = process.cwd();
const responsePath = resolve(root, responseArgument);
const errors = validateRepositoryPackage(root, responsePath, false);

if (errors.length > 0) {
  console.error('Viva provider response validation failed:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    'Viva provider response validation passed: 12 questions, 34 requirements, 9 NO-GO gates.',
  );
}
