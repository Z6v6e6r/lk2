import { createHash } from 'node:crypto';

export const ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION = 'eligibility-payment-acl-v1';
export const ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256 =
  '065df6510c35ea1be09dad9b6415b25c30543902837336739911555ec3dcad26';
export const ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION =
  'eligibility-payment-cup-projection-acl-v2';
export const ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256 =
  '83cba43d957e8104fc91b139020342dc154f571155c5fadafe36874583310310';

export type EligibilityPaymentRuntimePrivilege = 'SELECT' | 'INSERT' | 'UPDATE';

export type EligibilityPaymentAclRelation = {
  readonly schemaName: 'eligibility' | 'games';
  readonly relationName:
    | 'canonical_levels'
    | 'player_sport_levels'
    | 'player_level_commands'
    | 'level_policies'
    | 'policy_commands'
    | 'activation_readiness'
    | 'personal_invitations'
    | 'decisions'
    | 'payment_snapshots'
    | 'payment_confirmation_evidence'
    | 'cup_player_level_projections'
    | 'cup_player_level_projection_events';
  readonly policyName: string;
  readonly runtimePrivileges: readonly EligibilityPaymentRuntimePrivilege[];
};

export const ELIGIBILITY_PAYMENT_ACL_RELATIONS = [
  {
    schemaName: 'eligibility',
    relationName: 'canonical_levels',
    policyName: 'eligibility_canonical_levels_tenant_isolation',
    runtimePrivileges: ['SELECT'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'player_sport_levels',
    policyName: 'eligibility_player_levels_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'player_level_commands',
    policyName: 'eligibility_player_level_commands_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'level_policies',
    policyName: 'eligibility_level_policies_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'policy_commands',
    policyName: 'eligibility_policy_commands_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'activation_readiness',
    policyName: 'eligibility_activation_readiness_tenant_isolation',
    runtimePrivileges: ['SELECT'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'personal_invitations',
    policyName: 'eligibility_personal_invitations_tenant_isolation',
    runtimePrivileges: ['SELECT', 'UPDATE'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'decisions',
    policyName: 'eligibility_decisions_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'payment_snapshots',
    policyName: 'eligibility_payment_snapshots_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT'],
  },
  {
    schemaName: 'games',
    relationName: 'payment_confirmation_evidence',
    policyName: 'games_payment_confirmation_evidence_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
] as const satisfies readonly EligibilityPaymentAclRelation[];

export const CUP_PLAYER_LEVEL_PROJECTION_ACL_RELATIONS = [
  {
    schemaName: 'eligibility',
    relationName: 'cup_player_level_projections',
    policyName: 'cup_player_level_projections_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
  {
    schemaName: 'eligibility',
    relationName: 'cup_player_level_projection_events',
    policyName: 'cup_player_level_projection_events_tenant_isolation',
    runtimePrivileges: ['SELECT', 'INSERT'],
  },
] as const satisfies readonly EligibilityPaymentAclRelation[];

export const ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS = [
  ...ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  ...CUP_PLAYER_LEVEL_PROJECTION_ACL_RELATIONS,
] as const satisfies readonly EligibilityPaymentAclRelation[];

export const ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES = [
  {
    schemaName: 'eligibility',
    runtimePrivileges: ['USAGE'],
    migratorOwnerRequired: true,
    migratorCreateRequired: true,
  },
  {
    schemaName: 'games',
    runtimePrivileges: ['USAGE'],
    migratorOwnerRequired: true,
    migratorCreateRequired: true,
  },
] as const;

export const ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS = [
  { schemaName: 'games', relationName: 'games' },
  { schemaName: 'games', relationName: 'participations' },
  { schemaName: 'games', relationName: 'seat_reservations' },
  { schemaName: 'games', relationName: 'waitlist_entries' },
] as const;

export type EligibilityPaymentRoleAclSnapshot = {
  readonly migratorSessionIdentityExact: boolean;
  readonly runtimeExists: boolean;
  readonly runtimeDistinctFromMigrator: boolean;
  readonly runtimeSuperuser: boolean;
  readonly runtimeBypassRls: boolean;
  readonly runtimeMemberships: number;
  readonly migratorSuperuser: boolean;
  readonly migratorBypassRls: boolean;
  readonly migratorMemberships: number;
};

export type EligibilityPaymentPolicySnapshot = {
  readonly name: string;
  readonly command: string;
  readonly roles: readonly string[];
  readonly permissive: boolean;
  readonly qual: string | null;
  readonly withCheck: string | null;
};

export type EligibilityPaymentSchemaAclSnapshot = {
  readonly schemaName: 'eligibility' | 'games';
  readonly exists: boolean;
  readonly ownedByMigrator: boolean;
  readonly runtimeUsage: boolean;
  readonly runtimeCreate: boolean;
  readonly migratorCreate: boolean;
  readonly runtimeGrantOptions: number;
  readonly publicPrivileges: number;
  readonly unexpectedGranteePrivileges: number;
  readonly nonOwnerTableDefaultPrivileges: number;
};

export type EligibilityPaymentPreexistingRelationSnapshot = {
  readonly schemaName: 'games';
  readonly relationName: string;
  readonly exists: boolean;
  readonly ownedByMigrator: boolean;
};

export type EligibilityPaymentRelationAclSnapshot = {
  readonly schemaName: 'eligibility' | 'games';
  readonly relationName: string;
  readonly exists: boolean;
  readonly ownedByMigrator: boolean;
  readonly forceRls: boolean;
  readonly policies: readonly EligibilityPaymentPolicySnapshot[];
  readonly runtimePrivileges: readonly string[];
  readonly runtimeGrantOptions: number;
  readonly publicPrivileges: number;
  readonly unexpectedGranteePrivileges: number;
  readonly columnPrivileges: number;
};

export class EligibilityPaymentAclMatrixError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EligibilityPaymentAclMatrixError';
  }
}

function fail(code: string): never {
  throw new EligibilityPaymentAclMatrixError(code);
}

const canonicalTenantIsolationExpression =
  "(tenant_id=(nullif(current_setting('app.tenant_id'::text,true),''::text))::uuid)";

function normalizedPolicyExpression(value: string | null): string | null {
  return value?.toLowerCase().replaceAll(/\s+/g, '') ?? null;
}

function hasExactPolicy(
  expectedName: string,
  policies: readonly EligibilityPaymentPolicySnapshot[],
): boolean {
  const policy = policies[0];
  return (
    policies.length === 1 &&
    policy !== undefined &&
    policy.name === expectedName &&
    policy.command === '*' &&
    policy.roles.length === 1 &&
    policy.roles[0] === 'PUBLIC' &&
    policy.permissive &&
    normalizedPolicyExpression(policy.qual) === canonicalTenantIsolationExpression &&
    normalizedPolicyExpression(policy.withCheck) === canonicalTenantIsolationExpression
  );
}

export function assertEligibilityPaymentAclBoundary(input: {
  readonly phase: 'pre' | 'post';
  readonly roles: EligibilityPaymentRoleAclSnapshot;
  readonly schemas: readonly EligibilityPaymentSchemaAclSnapshot[];
  readonly preexistingRelations: readonly EligibilityPaymentPreexistingRelationSnapshot[];
  readonly relations?: readonly EligibilityPaymentRelationAclSnapshot[];
  readonly expectedRelations?: readonly EligibilityPaymentAclRelation[];
}): void {
  if (
    !input.roles.migratorSessionIdentityExact ||
    !input.roles.runtimeExists ||
    !input.roles.runtimeDistinctFromMigrator ||
    input.roles.runtimeSuperuser ||
    input.roles.runtimeBypassRls ||
    input.roles.runtimeMemberships > 0 ||
    input.roles.migratorSuperuser ||
    input.roles.migratorBypassRls ||
    input.roles.migratorMemberships > 0
  ) {
    fail('ELIGIBILITY_PAYMENT_ACL_ROLE_BOUNDARY_INVALID');
  }
  if (input.schemas.length !== ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES.length) {
    fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_SET_INVALID');
  }
  for (const expected of ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES) {
    const matchingSchemas = input.schemas.filter(
      (candidate) => candidate.schemaName === expected.schemaName,
    );
    if (matchingSchemas.length !== 1) fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_SET_INVALID');
    const schema = matchingSchemas[0];
    if (!schema?.exists) fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_MISSING');
    if (expected.migratorOwnerRequired && !schema.ownedByMigrator) {
      fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_OWNER_INVALID');
    }
    if (expected.migratorCreateRequired && !schema.migratorCreate) {
      fail('ELIGIBILITY_PAYMENT_ACL_MIGRATOR_CREATE_MISSING');
    }
    if (!schema.runtimeUsage || schema.runtimeCreate) {
      fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES_INVALID');
    }
    if (schema.runtimeGrantOptions > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_GRANT_OPTION_FORBIDDEN');
    }
    if (schema.publicPrivileges > 0) fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_PUBLIC_FORBIDDEN');
    if (schema.unexpectedGranteePrivileges > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_SCHEMA_THIRD_PARTY_FORBIDDEN');
    }
    if (schema.nonOwnerTableDefaultPrivileges > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_DEFAULT_ACL_FORBIDDEN');
    }
  }
  if (input.preexistingRelations.length !== ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS.length) {
    fail('ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATION_SET_INVALID');
  }
  for (const expected of ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS) {
    const matching = input.preexistingRelations.filter(
      (candidate) =>
        candidate.schemaName === expected.schemaName &&
        candidate.relationName === expected.relationName,
    );
    if (matching.length !== 1) {
      fail('ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATION_SET_INVALID');
    }
    if (!matching[0]?.exists || !matching[0].ownedByMigrator) {
      fail('ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATION_OWNER_INVALID');
    }
  }
  if (input.phase === 'pre') return;

  const relations = input.relations ?? [];
  const expectedRelations = input.expectedRelations ?? ELIGIBILITY_PAYMENT_ACL_RELATIONS;
  if (relations.length !== expectedRelations.length) {
    fail('ELIGIBILITY_PAYMENT_ACL_RELATION_SET_INVALID');
  }
  for (const expected of expectedRelations) {
    const matchingRelations = relations.filter(
      (candidate) =>
        candidate.schemaName === expected.schemaName &&
        candidate.relationName === expected.relationName,
    );
    if (matchingRelations.length !== 1) fail('ELIGIBILITY_PAYMENT_ACL_RELATION_SET_INVALID');
    const relation = matchingRelations[0];
    if (!relation?.exists) fail('ELIGIBILITY_PAYMENT_ACL_RELATION_MISSING');
    if (!relation.ownedByMigrator) fail('ELIGIBILITY_PAYMENT_ACL_RELATION_OWNER_INVALID');
    if (!relation.forceRls) fail('ELIGIBILITY_PAYMENT_ACL_RLS_INVALID');
    if (!hasExactPolicy(expected.policyName, relation.policies)) {
      fail('ELIGIBILITY_PAYMENT_ACL_POLICY_INVALID');
    }
    if (
      relation.runtimePrivileges.length !== expected.runtimePrivileges.length ||
      [...new Set(relation.runtimePrivileges)].sort().join(',') !==
        [...expected.runtimePrivileges].sort().join(',')
    ) {
      fail('ELIGIBILITY_PAYMENT_ACL_RUNTIME_PRIVILEGES_INVALID');
    }
    if (relation.runtimeGrantOptions > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_GRANT_OPTION_FORBIDDEN');
    }
    if (relation.publicPrivileges > 0) fail('ELIGIBILITY_PAYMENT_ACL_PUBLIC_FORBIDDEN');
    if (relation.unexpectedGranteePrivileges > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_THIRD_PARTY_FORBIDDEN');
    }
    if (relation.columnPrivileges > 0) fail('ELIGIBILITY_PAYMENT_ACL_COLUMN_ACL_FORBIDDEN');
  }
}

export function assertEligibilityPaymentAclProvisioningBoundary(input: {
  readonly roles: EligibilityPaymentRoleAclSnapshot;
  readonly schemas: readonly EligibilityPaymentSchemaAclSnapshot[];
  readonly preexistingRelations: readonly EligibilityPaymentPreexistingRelationSnapshot[];
  readonly relations: readonly EligibilityPaymentRelationAclSnapshot[];
}): void {
  assertEligibilityPaymentAclBoundary({ phase: 'pre', ...input });
  if (input.relations.length !== ELIGIBILITY_PAYMENT_ACL_RELATIONS.length) {
    fail('ELIGIBILITY_PAYMENT_ACL_RELATION_SET_INVALID');
  }
  let freshRelationCount = 0;
  let exactRelationCount = 0;
  for (const expected of ELIGIBILITY_PAYMENT_ACL_RELATIONS) {
    const matching = input.relations.filter(
      (candidate) =>
        candidate.schemaName === expected.schemaName &&
        candidate.relationName === expected.relationName,
    );
    if (matching.length !== 1) fail('ELIGIBILITY_PAYMENT_ACL_RELATION_SET_INVALID');
    const relation = matching[0];
    if (!relation?.exists) fail('ELIGIBILITY_PAYMENT_ACL_RELATION_MISSING');
    if (!relation.ownedByMigrator) fail('ELIGIBILITY_PAYMENT_ACL_RELATION_OWNER_INVALID');
    if (!relation.forceRls) fail('ELIGIBILITY_PAYMENT_ACL_RLS_INVALID');
    if (!hasExactPolicy(expected.policyName, relation.policies)) {
      fail('ELIGIBILITY_PAYMENT_ACL_POLICY_INVALID');
    }
    const actualPrivileges = [...new Set(relation.runtimePrivileges)].sort();
    const expectedPrivileges = [...expected.runtimePrivileges].sort();
    const isUngrantableFreshState = actualPrivileges.length === 0;
    const isExactIdempotentState =
      actualPrivileges.length === expectedPrivileges.length &&
      actualPrivileges.join(',') === expectedPrivileges.join(',');
    if (!isUngrantableFreshState && !isExactIdempotentState) {
      fail('ELIGIBILITY_PAYMENT_ACL_PROVISIONING_STATE_INVALID');
    }
    if (isUngrantableFreshState) freshRelationCount += 1;
    if (isExactIdempotentState) exactRelationCount += 1;
    if (relation.runtimeGrantOptions > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_GRANT_OPTION_FORBIDDEN');
    }
    if (relation.publicPrivileges > 0) fail('ELIGIBILITY_PAYMENT_ACL_PUBLIC_FORBIDDEN');
    if (relation.unexpectedGranteePrivileges > 0) {
      fail('ELIGIBILITY_PAYMENT_ACL_THIRD_PARTY_FORBIDDEN');
    }
    if (relation.columnPrivileges > 0) fail('ELIGIBILITY_PAYMENT_ACL_COLUMN_ACL_FORBIDDEN');
  }
  if (freshRelationCount > 0 && exactRelationCount > 0) {
    fail('ELIGIBILITY_PAYMENT_ACL_PROVISIONING_STATE_INVALID');
  }
}

export function eligibilityPaymentAclMatrixCanonicalText(): string {
  return aclMatrixCanonicalText(
    ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
    ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  );
}

function aclMatrixCanonicalText(
  version: string,
  relations: readonly EligibilityPaymentAclRelation[],
): string {
  const roleLine =
    'ROLES|RUNTIME=EXISTS,DISTINCT,NOSUPERUSER,NOBYPASSRLS,NO_MEMBERSHIP_EDGES|MIGRATOR=SESSION_USER_EXACT,NOSUPERUSER,NOBYPASSRLS,NO_MEMBERSHIP_EDGES';
  const schemaLines = ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES.map(
    (schema) =>
      `SCHEMA|${schema.schemaName}|RUNTIME_PRIVILEGES=${schema.runtimePrivileges.join(',')}|RUNTIME_CREATE=FORBIDDEN|MIGRATOR_CREATE=${schema.migratorCreateRequired ? 'REQUIRED' : 'NOT_REQUIRED'}|MIGRATOR_OWNER=${schema.migratorOwnerRequired ? 'REQUIRED' : 'NOT_REQUIRED'}|GRANT_OPTION=FORBIDDEN|PUBLIC=FORBIDDEN|THIRD_PARTY=FORBIDDEN|NON_OWNER_TABLE_DEFAULT_ACL=FORBIDDEN`,
  );
  const preexistingLines = ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS.map(
    (relation) =>
      `PREEXISTING_RELATION|${relation.schemaName}|${relation.relationName}|OWNER=MIGRATOR`,
  );
  const relationLines = relations.map(
    (relation) =>
      `RELATION|${relation.schemaName}|${relation.relationName}|OWNER=MIGRATOR|FORCE_RLS=REQUIRED|POLICY=${relation.policyName}:PERMISSIVE:ALL:PUBLIC:TENANT_EXACT|PRIVILEGES=${relation.runtimePrivileges.join(',')}|GRANT_OPTION=FORBIDDEN|PUBLIC=FORBIDDEN|THIRD_PARTY=FORBIDDEN|COLUMN_ACL=FORBIDDEN`,
  );
  return (
    [`VERSION|${version}`, roleLine, ...schemaLines, ...preexistingLines, ...relationLines].join(
      '\n',
    ) + '\n'
  );
}

export function eligibilityPaymentCupProjectionAclMatrixCanonicalText(): string {
  return aclMatrixCanonicalText(
    ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION,
    ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS,
  );
}

export function eligibilityPaymentAclMatrixSha256(): string {
  return createHash('sha256').update(eligibilityPaymentAclMatrixCanonicalText()).digest('hex');
}

export function eligibilityPaymentCupProjectionAclMatrixSha256(): string {
  return createHash('sha256')
    .update(eligibilityPaymentCupProjectionAclMatrixCanonicalText())
    .digest('hex');
}

export function assertEligibilityPaymentAclMatrixBinding(input: {
  readonly version: string;
  readonly sha256: string;
}): void {
  if (
    input.version !== ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION ||
    input.sha256 !== ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256 ||
    eligibilityPaymentAclMatrixSha256() !== ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256
  ) {
    throw new Error('ELIGIBILITY_PAYMENT_ACL_MATRIX_BINDING_INVALID');
  }
}

export function assertEligibilityPaymentCupProjectionAclMatrixBinding(input: {
  readonly version: string;
  readonly sha256: string;
}): void {
  if (
    input.version !== ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_VERSION ||
    input.sha256 !== ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256 ||
    eligibilityPaymentCupProjectionAclMatrixSha256() !==
      ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_SHA256
  ) {
    throw new Error('ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_MATRIX_BINDING_INVALID');
  }
}
