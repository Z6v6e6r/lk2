import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const plan = readFileSync(
  new URL('../docs/plans/communities-role-split-acceptance-v1.md', import.meta.url),
  'utf8',
);
const schema = JSON.parse(
  readFileSync(
    new URL('../docs/plans/communities-role-split-acceptance-v1.schema.json', import.meta.url),
    'utf8',
  ),
) as {
  required: string[];
  properties: Record<string, unknown>;
  $defs: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  'x-role-categories': string[];
  'x-frozen-contracts': string[];
  'x-input-c-artifact-pins': string[];
  'x-forbidden-transition-codes': string[];
};

const categories = [
  'roles',
  'memberships',
  'databaseAcl',
  'schemas',
  'defaultAcls',
  'relations',
  'columnAcls',
  'rlsPolicies',
  'sequences',
  'functions',
  'types',
  'extensions',
];

describe('Communities role-split acceptance v1 contract', () => {
  it('requires two full INPUT_C snapshots and independently supplied artifact pins', () => {
    expect(schema.required).toEqual([
      'contractVersion',
      'observedBefore',
      'observedAfter',
      'ownershipPlan',
      'grantPlan',
      'comparison',
      'decision',
    ]);
    expect(schema.properties).toHaveProperty('observedBefore.$ref', '#/$defs/inputC');
    expect(schema.properties).toHaveProperty('observedAfter.$ref', '#/$defs/inputC');
    expect(schema['x-input-c-artifact-pins']).toEqual([
      'beforeArtifactSha256',
      'afterArtifactSha256',
      'expectedMappingDigest',
      'creationReceiptSha256',
    ]);
    expect(plan).toContain('independently pinned');
  });

  it('pins the exact twelve-category object/field INPUT_C wire shape', () => {
    expect(schema.$defs.normalizedInventory!.required).toEqual(categories);
    expect(schema.$defs.normalizedRecord!.required).toEqual([
      'objectKeySha256',
      'fieldKeySha256',
      'fieldKind',
      'observationState',
      'valueSha256',
      'provenanceSha256',
      'semantic',
    ]);
    expect(schema.$defs.provenance!.required).toContain('markerEvidenceDigest');
    expect(schema.$defs.provenance!.required).toContain('creationReceiptSha256');
    expect(schema.$defs.provenance!.required).toContain('mappingDigest');
    expect(schema.$defs.inputC!.required).toContain('mapping');
    expect(schema.$defs.mappingArtifact!.required).toEqual([
      'schemaVersion',
      'categories',
      'identityRelations',
      'mappingDigest',
    ]);
    expect(schema.$defs.anomaly!.required).toEqual(['code', 'count', 'evidenceSha256']);
    expect(schema.$defs.aclEntry!.required).toEqual([
      'granteeCategory',
      'granteeEvidenceSha256',
      'grantorCategory',
      'grantorEvidenceSha256',
      'privilege',
      'grantOption',
      'occurrenceSha256',
    ]);
    expect(plan).toContain('objectKeySha256');
    expect(plan).toContain('fieldKeySha256');
  });

  it('declares complete mapping and semantic anomaly vocabulary', () => {
    expect(schema['x-role-categories']).toEqual([
      'RESTORE_OWNER',
      'RESTORE_EXECUTOR',
      'SHARED_OWNER',
      'FUTURE_MIGRATOR',
      'FUTURE_RUNTIME',
      'INVENTORY_READER',
    ]);
    expect(schema['x-forbidden-transition-codes']).toEqual(
      [...schema['x-forbidden-transition-codes']].sort(),
    );
    expect(schema['x-forbidden-transition-codes']).toContain('MAPPING_INCOMPLETE');
    expect(schema['x-forbidden-transition-codes']).toContain('MIXED_OWNER_FORBIDDEN');
    expect(plan).toContain('SAME');
    expect(plan).toContain('equivalence');
  });

  it('keeps 29/32/33/34 frozen and all authorization booleans false', () => {
    expect(schema['x-frozen-contracts']).toEqual(['29_V1', '32_V1', '33_V1', '34_V1']);
    expect(schema.$defs.decision!.properties).toMatchObject({
      authorizesRoleCreation: { const: false },
      authorizesRoleAlteration: { const: false },
      authorizesAclMutation: { const: false },
      authorizesMigration: { const: false },
      authorizesDeploy: { const: false },
      authorizesRuntimeActivation: { const: false },
    });
    expect(plan).toContain('not an extra line in the frozen 36-line `34_V1` report');
  });

  it('exports the shared INPUT_C contract and evaluator from built @phub/database', () => {
    const root = new URL('..', import.meta.url);
    execFileSync('npm', ['run', 'build', '-w', '@phub/database'], { cwd: root, stdio: 'ignore' });
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import('./packages/database/dist/index.js').then((m)=>process.stdout.write([typeof m.assertCommunitiesRoleSplitInputC,typeof m.assertCommunitiesRoleSplitAcceptancePass,m.COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION].join('|')))",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(output).toBe('function|function|communities-role-split-input-c-v1');
  }, 30_000);
});
