import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const expected = '8bd76396dd012f80b697ee7c39b0ccb080f0df1bd46fa6dacea5bd39554ac921';
const root = await readFile(resolve(process.cwd(), 'openapi.yaml'));
const imported = await readFile(
  resolve(process.cwd(), 'contracts/imported/cabinet-api/0.2.0/openapi.yaml'),
);
const digest = (input: Uint8Array): string => createHash('sha256').update(input).digest('hex');

if (digest(imported) !== expected) throw new Error('Immutable imported OpenAPI snapshot changed');
if (digest(root) !== expected) {
  process.stdout.write('Root OpenAPI evolved; immutable source snapshot remains unchanged.\n');
} else {
  process.stdout.write('Imported OpenAPI snapshot verified.\n');
}
