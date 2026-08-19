import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
  ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION,
  ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS,
  EligibilityPaymentAclMatrixError,
  assertEligibilityPaymentAclBoundary,
  assertEligibilityPaymentAclMatrixBinding,
  assertEligibilityPaymentAclProvisioningBoundary,
  assertEligibilityPaymentCupProjectionAclMatrixBinding,
  eligibilityPaymentAclMatrixCanonicalText,
  eligibilityPaymentAclMatrixSha256,
  eligibilityPaymentCupProjectionAclMatrixCanonicalText,
  eligibilityPaymentCupProjectionAclMatrixSha256,
} from './eligibility-payment-acl-matrix.js';

function schemas() {
  return ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES.map((schema) => ({
    schemaName: schema.schemaName,
    exists: true,
    ownedByMigrator: schema.migratorOwnerRequired,
    runtimeUsage: true,
    runtimeCreate: false,
    migratorCreate: true,
    runtimeGrantOptions: 0,
    publicPrivileges: 0,
    unexpectedGranteePrivileges: 0,
    nonOwnerTableDefaultPrivileges: 0,
  }));
}

function roles() {
  return {
    migratorSessionIdentityExact: true,
    runtimeExists: true,
    runtimeDistinctFromMigrator: true,
    runtimeSuperuser: false,
    runtimeBypassRls: false,
    runtimeMemberships: 0,
    migratorSuperuser: false,
    migratorBypassRls: false,
    migratorMemberships: 0,
  };
}

function preexistingRelations() {
  return ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS.map((relation) => ({
    ...relation,
    exists: true,
    ownedByMigrator: true,
  }));
}

function relations() {
  const expression =
    "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";
  return ELIGIBILITY_PAYMENT_ACL_RELATIONS.map((relation) => ({
    schemaName: relation.schemaName,
    relationName: relation.relationName,
    exists: true,
    ownedByMigrator: true,
    forceRls: true,
    policies: [
      {
        name: relation.policyName,
        command: '*',
        roles: ['PUBLIC'],
        permissive: true,
        qual: expression,
        withCheck: expression,
      },
    ],
    runtimePrivileges: [...relation.runtimePrivileges].reverse(),
    runtimeGrantOptions: 0,
    publicPrivileges: 0,
    unexpectedGranteePrivileges: 0,
    columnPrivileges: 0,
  }));
}

function expectBoundaryError(run: () => void, code: string): void {
  try {
    run();
    throw new Error('expected ACL boundary failure');
  } catch (error) {
    expect(error).toBeInstanceOf(EligibilityPaymentAclMatrixError);
    expect((error as EligibilityPaymentAclMatrixError).code).toBe(code);
  }
}

describe('eligibility/payment runtime ACL matrix', () => {
  it('pins one canonical least-privilege matrix', () => {
    expect(ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION).toBe('eligibility-payment-acl-v1');
    expect(ELIGIBILITY_PAYMENT_ACL_RELATIONS).toHaveLength(10);
    expect(eligibilityPaymentAclMatrixSha256()).toBe(ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256);
    expect(
      ELIGIBILITY_PAYMENT_ACL_RELATIONS.flatMap((relation) => relation.runtimePrivileges),
    ).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE']));
    expect(eligibilityPaymentAclMatrixCanonicalText()).toContain('CREATE=FORBIDDEN');
    expect(eligibilityPaymentAclMatrixCanonicalText()).toContain('GRANT_OPTION=FORBIDDEN');
  });

  it('pins the CUP projection extension without changing the frozen v1 matrix', () => {
    const projectionSource = readFileSync(
      new URL('./cup-player-level-projection-repository.ts', import.meta.url),
      'utf8',
    );
    expect(ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION).toBe(
      'eligibility-payment-cup-projection-acl-v2',
    );
    expect(ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS).toHaveLength(12);
    expect(eligibilityPaymentCupProjectionAclMatrixSha256()).toBe(
      ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256,
    );
    expect(eligibilityPaymentCupProjectionAclMatrixCanonicalText()).toContain(
      'RELATION|eligibility|cup_player_level_projections',
    );
    expect(eligibilityPaymentCupProjectionAclMatrixCanonicalText()).toContain(
      'RELATION|eligibility|cup_player_level_projection_events',
    );
    for (const relation of ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS.slice(-2)) {
      expect(projectionSource).toContain(`eligibility.${relation.relationName}`);
      expect(relation.runtimePrivileges).not.toContain('DELETE');
    }
    expect(eligibilityPaymentAclMatrixSha256()).toBe(ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256);
  });

  it('matches the runtime SQL operations without granting broader table privileges', () => {
    const sources = [
      readFileSync(new URL('./player-level-repository.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./level-eligibility-policy-repository.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./game-roster-repository.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./game-repository.ts', import.meta.url), 'utf8'),
    ].join('\n');

    for (const relation of ELIGIBILITY_PAYMENT_ACL_RELATIONS) {
      expect(sources).toContain(`${relation.schemaName}.${relation.relationName}`);
      expect(relation.runtimePrivileges).not.toContain('DELETE');
    }

    expect(
      ELIGIBILITY_PAYMENT_ACL_RELATIONS.find(
        (relation) => relation.relationName === 'canonical_levels',
      )?.runtimePrivileges,
    ).toEqual(['SELECT']);
    expect(
      ELIGIBILITY_PAYMENT_ACL_RELATIONS.find(
        (relation) => relation.relationName === 'payment_confirmation_evidence',
      )?.runtimePrivileges,
    ).toEqual(['SELECT', 'INSERT', 'UPDATE']);
  });

  it('rejects a different version or digest', () => {
    const valid = {
      version: ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
      sha256: eligibilityPaymentAclMatrixSha256(),
    };
    expect(() => assertEligibilityPaymentAclMatrixBinding(valid)).not.toThrow();
    expect(() => assertEligibilityPaymentAclMatrixBinding({ ...valid, version: 'v2' })).toThrow(
      'ELIGIBILITY_PAYMENT_ACL_MATRIX_BINDING_INVALID',
    );
    expect(() =>
      assertEligibilityPaymentAclMatrixBinding({ ...valid, sha256: '0'.repeat(64) }),
    ).toThrow('ELIGIBILITY_PAYMENT_ACL_MATRIX_BINDING_INVALID');
  });

  it('binds the CUP projection matrix independently from v1', () => {
    const valid = {
      version: ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION,
      sha256: ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256,
    };
    expect(() => assertEligibilityPaymentCupProjectionAclMatrixBinding(valid)).not.toThrow();
    expect(() =>
      assertEligibilityPaymentCupProjectionAclMatrixBinding({
        version: ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
        sha256: ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
      }),
    ).toThrow('ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_BINDING_INVALID');
  });

  it('accepts the exact post boundary for all 12 CUP projection relations', () => {
    const extendedRelations = ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS.map((relation) => ({
      schemaName: relation.schemaName,
      relationName: relation.relationName,
      exists: true,
      ownedByMigrator: true,
      forceRls: true,
      policies: [
        {
          name: relation.policyName,
          command: '*',
          roles: ['PUBLIC'],
          permissive: true,
          qual: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
          withCheck:
            "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
        },
      ],
      runtimePrivileges: [...relation.runtimePrivileges],
      runtimeGrantOptions: 0,
      publicPrivileges: 0,
      unexpectedGranteePrivileges: 0,
      columnPrivileges: 0,
    }));
    expect(() =>
      assertEligibilityPaymentAclBoundary({
        phase: 'post',
        roles: roles(),
        schemas: schemas(),
        preexistingRelations: preexistingRelations(),
        relations: extendedRelations,
        expectedRelations: ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS,
      }),
    ).not.toThrow();
  });

  it('accepts the exact pre and post migration ACL boundary', () => {
    expect(() =>
      assertEligibilityPaymentAclBoundary({
        phase: 'pre',
        roles: roles(),
        schemas: schemas(),
        preexistingRelations: preexistingRelations(),
      }),
    ).not.toThrow();
    expect(() =>
      assertEligibilityPaymentAclBoundary({
        phase: 'post',
        roles: roles(),
        schemas: schemas(),
        preexistingRelations: preexistingRelations(),
        relations: relations(),
      }),
    ).not.toThrow();
  });

  it('accepts only a wholly ungranted or exact idempotent provisioning state', () => {
    const exact = {
      roles: roles(),
      schemas: schemas(),
      preexistingRelations: preexistingRelations(),
      relations: relations(),
    };
    expect(() => assertEligibilityPaymentAclProvisioningBoundary(exact)).not.toThrow();
    expect(() =>
      assertEligibilityPaymentAclProvisioningBoundary({
        ...exact,
        relations: exact.relations.map((relation) => ({
          ...relation,
          runtimePrivileges: [],
        })),
      }),
    ).not.toThrow();
    expectBoundaryError(
      () =>
        assertEligibilityPaymentAclProvisioningBoundary({
          ...exact,
          relations: exact.relations.map((relation, index) => ({
            ...relation,
            runtimePrivileges: index === 0 ? relation.runtimePrivileges : [],
          })),
        }),
      'ELIGIBILITY_PAYMENT_ACL_PROVISIONING_STATE_INVALID',
    );
    expectBoundaryError(
      () =>
        assertEligibilityPaymentAclProvisioningBoundary({
          ...exact,
          relations: exact.relations.map((relation, index) => ({
            ...relation,
            runtimePrivileges: index === 0 ? ['SELECT', 'UPDATE'] : [],
          })),
        }),
      'ELIGIBILITY_PAYMENT_ACL_PROVISIONING_STATE_INVALID',
    );
  });

  it('rejects privileged, identical or role-inheriting identities', () => {
    for (const invalid of [
      { ...roles(), migratorSessionIdentityExact: false },
      { ...roles(), runtimeExists: false },
      { ...roles(), runtimeDistinctFromMigrator: false },
      { ...roles(), runtimeSuperuser: true },
      { ...roles(), runtimeBypassRls: true },
      { ...roles(), runtimeMemberships: 1 },
      { ...roles(), migratorSuperuser: true },
      { ...roles(), migratorBypassRls: true },
      { ...roles(), migratorMemberships: 1 },
    ]) {
      expectBoundaryError(
        () =>
          assertEligibilityPaymentAclBoundary({
            phase: 'pre',
            roles: invalid,
            schemas: schemas(),
            preexistingRelations: preexistingRelations(),
          }),
        'ELIGIBILITY_PAYMENT_ACL_ROLE_BOUNDARY_INVALID',
      );
    }
  });

  it.each([
    ['missing schema', () => schemas().slice(1), 'ELIGIBILITY_PAYMENT_ACL_SCHEMA_SET_INVALID'],
    [
      'wrong schema owner',
      () => schemas().map((schema) => ({ ...schema, ownedByMigrator: false })),
      'ELIGIBILITY_PAYMENT_ACL_SCHEMA_OWNER_INVALID',
    ],
    [
      'missing runtime usage',
      () => schemas().map((schema) => ({ ...schema, runtimeUsage: false })),
      'ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES_INVALID',
    ],
    [
      'runtime schema create',
      () => schemas().map((schema) => ({ ...schema, runtimeCreate: true })),
      'ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES_INVALID',
    ],
    [
      'schema grant option',
      () => schemas().map((schema) => ({ ...schema, runtimeGrantOptions: 1 })),
      'ELIGIBILITY_PAYMENT_ACL_SCHEMA_GRANT_OPTION_FORBIDDEN',
    ],
    [
      'schema PUBLIC privilege',
      () => schemas().map((schema) => ({ ...schema, publicPrivileges: 1 })),
      'ELIGIBILITY_PAYMENT_ACL_SCHEMA_PUBLIC_FORBIDDEN',
    ],
    [
      'schema third-party privilege',
      () => schemas().map((schema) => ({ ...schema, unexpectedGranteePrivileges: 1 })),
      'ELIGIBILITY_PAYMENT_ACL_SCHEMA_THIRD_PARTY_FORBIDDEN',
    ],
    [
      'missing migrator CREATE',
      () => schemas().map((schema) => ({ ...schema, migratorCreate: false })),
      'ELIGIBILITY_PAYMENT_ACL_MIGRATOR_CREATE_MISSING',
    ],
    [
      'non-owner default table privilege',
      () => schemas().map((schema) => ({ ...schema, nonOwnerTableDefaultPrivileges: 1 })),
      'ELIGIBILITY_PAYMENT_ACL_DEFAULT_ACL_FORBIDDEN',
    ],
  ])('rejects pre-migration boundary drift: %s', (_name, mutate, code) => {
    expectBoundaryError(
      () =>
        assertEligibilityPaymentAclBoundary({
          phase: 'pre',
          roles: roles(),
          schemas: mutate(),
          preexistingRelations: preexistingRelations(),
        }),
      code,
    );
  });

  it('rejects missing or non-owned tables altered by migration 0084', () => {
    expect(() =>
      assertEligibilityPaymentAclBoundary({
        phase: 'pre',
        roles: roles(),
        schemas: schemas(),
        preexistingRelations: preexistingRelations().slice(1),
      }),
    ).toThrow('ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATION_SET_INVALID');
    expect(() =>
      assertEligibilityPaymentAclBoundary({
        phase: 'pre',
        roles: roles(),
        schemas: schemas(),
        preexistingRelations: preexistingRelations().map((relation, index) => ({
          ...relation,
          ownedByMigrator: index !== 0,
        })),
      }),
    ).toThrow('ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATION_OWNER_INVALID');
  });

  it.each([
    [
      'missing relation',
      () => relations().slice(1),
      'ELIGIBILITY_PAYMENT_ACL_RELATION_SET_INVALID',
    ],
    [
      'wrong owner',
      () => relations().map((relation, index) => ({ ...relation, ownedByMigrator: index !== 0 })),
      'ELIGIBILITY_PAYMENT_ACL_RELATION_OWNER_INVALID',
    ],
    [
      'RLS not forced',
      () => relations().map((relation, index) => ({ ...relation, forceRls: index !== 0 })),
      'ELIGIBILITY_PAYMENT_ACL_RLS_INVALID',
    ],
    [
      'wrong policy',
      () =>
        relations().map((relation, index) =>
          index === 0
            ? { ...relation, policies: [{ ...relation.policies[0]!, name: 'unexpected' }] }
            : relation,
        ),
      'ELIGIBILITY_PAYMENT_ACL_POLICY_INVALID',
    ],
    [
      'extra runtime privilege',
      () =>
        relations().map((relation, index) =>
          index === 0
            ? { ...relation, runtimePrivileges: [...relation.runtimePrivileges, 'DELETE'] }
            : relation,
        ),
      'ELIGIBILITY_PAYMENT_ACL_RUNTIME_PRIVILEGES_INVALID',
    ],
    [
      'grant option',
      () =>
        relations().map((relation, index) => ({
          ...relation,
          runtimeGrantOptions: index === 0 ? 1 : 0,
        })),
      'ELIGIBILITY_PAYMENT_ACL_GRANT_OPTION_FORBIDDEN',
    ],
    [
      'PUBLIC privilege',
      () =>
        relations().map((relation, index) => ({
          ...relation,
          publicPrivileges: index === 0 ? 1 : 0,
        })),
      'ELIGIBILITY_PAYMENT_ACL_PUBLIC_FORBIDDEN',
    ],
    [
      'third-party grantee',
      () =>
        relations().map((relation, index) => ({
          ...relation,
          unexpectedGranteePrivileges: index === 0 ? 1 : 0,
        })),
      'ELIGIBILITY_PAYMENT_ACL_THIRD_PARTY_FORBIDDEN',
    ],
    [
      'column ACL',
      () =>
        relations().map((relation, index) => ({
          ...relation,
          columnPrivileges: index === 0 ? 1 : 0,
        })),
      'ELIGIBILITY_PAYMENT_ACL_COLUMN_ACL_FORBIDDEN',
    ],
  ])('rejects post-migration boundary drift: %s', (_name, mutate, code) => {
    expectBoundaryError(
      () =>
        assertEligibilityPaymentAclBoundary({
          phase: 'post',
          roles: roles(),
          schemas: schemas(),
          preexistingRelations: preexistingRelations(),
          relations: mutate(),
        }),
      code,
    );
  });
});
