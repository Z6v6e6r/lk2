import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const planUrl = new URL('../docs/plans/communities-role-split-acceptance-v1.md', import.meta.url);
const schemaUrl = new URL(
  '../docs/plans/communities-role-split-acceptance-v1.schema.json',
  import.meta.url,
);
const plan = readFileSync(planUrl, 'utf8');
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as Record<string, unknown> & {
  $defs: Record<string, Record<string, unknown>>;
  'x-role-categories': string[];
  'x-observation-states': string[];
  'x-identity-relation-states': string[];
  'x-required-distinct-pairs': string[];
  'x-frozen-contracts': string[];
  'x-input-c-required': string[];
  'x-forbidden-transition-codes': string[];
  'x-redacted-34-v1-sidecar-template': string[];
};

const expectedCategories = [
  'RESTORE_OWNER',
  'RESTORE_EXECUTOR',
  'SHARED_OWNER',
  'FUTURE_MIGRATOR',
  'FUTURE_RUNTIME',
  'INVENTORY_READER',
];

describe('Communities role-split acceptance v1 contract', () => {
  it('pins the six abstract categories and fail-closed observation states', () => {
    expect(schema['x-role-categories']).toEqual(expectedCategories);
    expect(schema['x-observation-states']).toEqual(['OBSERVED', 'UNKNOWN', 'UNOBSERVED']);
    expect(schema['x-identity-relation-states']).toEqual([
      'SAME',
      'DISTINCT',
      'UNKNOWN',
      'UNOBSERVED',
    ]);
    expect(schema['x-required-distinct-pairs']).toEqual(['FUTURE_MIGRATOR|FUTURE_RUNTIME']);
    expect(schema.$defs.roleMapping.required).toEqual([...expectedCategories, 'identityRelations']);
    expect(schema.$defs.roleMapping.properties).toHaveProperty('identityRelations.minItems', 15);
    expect(schema.$defs.roleMapping.properties).toHaveProperty('identityRelations.maxItems', 15);
    for (const category of expectedCategories) {
      expect(schema.$defs.roleMapping.properties).toHaveProperty(category);
      const categorySchema = (schema.$defs.roleMapping.properties as Record<string, unknown>)[
        category
      ];
      expect(JSON.stringify(categorySchema)).toContain(`\"const\":\"${category}\"`);
    }
    expect(schema.$defs.normalizedRecord).toHaveProperty('oneOf');
    expect(plan).toContain('Absence of an observation never implies `SAME`');
    expect(plan).toContain('`REQUIRED_DISTINCT_NOT_OBSERVED`');
    expect(plan).toContain('`UNKNOWN` and `UNOBSERVED` carry null value/provenance digests');
    expect(plan).toContain('contains no role name, role OID, current owner');
  });

  it('requires every INPUT_C provenance, normalized catalog and comparison group', () => {
    expect(schema['x-input-c-required']).toEqual(
      expect.arrayContaining([
        'provenance.markerDigest',
        'provenance.requestDigest',
        'provenance.cloneOidBound',
        'provenance.sourceOidBound',
        'provenance.systemIdentifierDigest',
        'provenance.pgMajor',
        'provenance.objectManifestDigest',
        'provenance.ledgerDigest',
        'provenance.ledgerCount',
        'normalized.roles',
        'normalized.memberships',
        'normalized.databaseAcl',
        'normalized.schemas',
        'normalized.defaultAcls',
        'normalized.relations',
        'normalized.columnAcls',
        'normalized.rlsPolicies',
        'normalized.sequences',
        'normalized.functions',
        'normalized.types',
        'normalized.extensions',
        'comparison.beforeManifestSha',
        'comparison.afterManifestSha',
        'comparison.forbiddenTransitionCodes',
      ]),
    );
    expect(schema.$defs.provenance.properties).toMatchObject({
      cloneNamePatternValid: { const: true },
      cloneOidBound: { const: true },
      sourceOidBound: { const: true },
      pgMajor: { const: 16 },
    });
  });

  it('pins forbidden transitions and rejects every authorization capability', () => {
    expect(schema['x-forbidden-transition-codes']).toEqual(
      [...schema['x-forbidden-transition-codes']].sort(),
    );
    expect(schema['x-forbidden-transition-codes']).toEqual(
      expect.arrayContaining([
        'ROLE_CAPABILITY_FORBIDDEN',
        'ROLE_MEMBERSHIP_FORBIDDEN',
        'PUBLIC_GRANT_FORBIDDEN',
        'THIRD_PARTY_GRANT_FORBIDDEN',
        'COLUMN_GRANT_FORBIDDEN',
        'DEFAULT_ACL_CHANGE_FORBIDDEN',
        'GRANT_OPTION_FORBIDDEN',
        'SHARED_DATABASE_CHANGE_FORBIDDEN',
        'RESTORE_EXECUTOR_OWNERSHIP_FORBIDDEN',
        'RUNTIME_OWNERSHIP_FORBIDDEN',
        'INVENTORY_READER_WRITE_FORBIDDEN',
      ]),
    );
    expect(schema.$defs.decision.properties).toMatchObject({
      authorizesRoleCreation: { const: false },
      authorizesRoleAlteration: { const: false },
      authorizesAclMutation: { const: false },
      authorizesMigration: { const: false },
      authorizesDeploy: { const: false },
      authorizesRuntimeActivation: { const: false },
    });
  });

  it('keeps the existing rehearsal contracts frozen and defines a separate 34_V1 sidecar', () => {
    expect(schema['x-frozen-contracts']).toEqual(['29_V1', '32_V1', '33_V1', '34_V1']);
    const sidecar = `${schema['x-redacted-34-v1-sidecar-template'].join('\n')}\n`;
    expect(plan).toContain(sidecar);
    expect(plan).toContain('not an extra line in the frozen 36-line `34_V1` report');
    expect(sidecar).toContain('role_categories=6');
    expect(sidecar).toContain('authorizes_role_creation=false');
    expect(sidecar).not.toMatch(/role_name=|role_oid=|database_name=|system_identifier=/u);
  });

  it('defines a deterministic redacted before/after diff', () => {
    expect(plan).toContain('Sort records by');
    expect(plan).toContain('(objectKind, canonicalKey, field, ruleCode)');
    expect(plan).toContain(
      'counts changed=<COUNT> added=<COUNT> removed=<COUNT> forbidden=<COUNT>',
    );
    expect(plan).toContain(
      'CHANGE|<OBJECT_KIND>|<CANONICAL_KEY>|<FIELD>|<BEFORE_STATE>|<BEFORE_VALUE_SHA256_OR_NULL>|<AFTER_STATE>|<AFTER_VALUE_SHA256_OR_NULL>|<RULE_CODE>|<PROVENANCE_SHA256>',
    );
    expect(plan).toContain('Hash the exact bytes including the final LF');
  });
});
