import { createHash } from 'node:crypto';

export const COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION = 'communities-role-split-acceptance-v1';
export const COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION = 'communities-role-split-input-c-v1';
export const COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION = 'utf8-byte-digest-v1';
export const COMMUNITIES_ROLE_SPLIT_SORT_VERSION = 'sha256-byte-v1';

export const COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES = [
  'RESTORE_OWNER',
  'RESTORE_EXECUTOR',
  'SHARED_OWNER',
  'FUTURE_MIGRATOR',
  'FUTURE_RUNTIME',
  'INVENTORY_READER',
] as const;
export type CommunitiesRoleSplitRoleCategory =
  (typeof COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES)[number];

export const COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES = [
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
] as const;
export type CommunitiesRoleSplitNormalizedCategory =
  (typeof COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES)[number];

export const COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS = [
  ['RESTORE_OWNER', 'RESTORE_EXECUTOR', 'ALIAS_ALLOWED'],
  ['RESTORE_OWNER', 'SHARED_OWNER', 'ALIAS_ALLOWED'],
  ['RESTORE_OWNER', 'FUTURE_MIGRATOR', 'ALIAS_ALLOWED'],
  ['RESTORE_OWNER', 'FUTURE_RUNTIME', 'ALIAS_ALLOWED'],
  ['RESTORE_OWNER', 'INVENTORY_READER', 'ALIAS_ALLOWED'],
  ['RESTORE_EXECUTOR', 'SHARED_OWNER', 'ALIAS_ALLOWED'],
  ['RESTORE_EXECUTOR', 'FUTURE_MIGRATOR', 'ALIAS_ALLOWED'],
  ['RESTORE_EXECUTOR', 'FUTURE_RUNTIME', 'ALIAS_ALLOWED'],
  ['RESTORE_EXECUTOR', 'INVENTORY_READER', 'ALIAS_ALLOWED'],
  ['SHARED_OWNER', 'FUTURE_MIGRATOR', 'ALIAS_ALLOWED'],
  ['SHARED_OWNER', 'FUTURE_RUNTIME', 'ALIAS_ALLOWED'],
  ['SHARED_OWNER', 'INVENTORY_READER', 'ALIAS_ALLOWED'],
  ['FUTURE_MIGRATOR', 'FUTURE_RUNTIME', 'REQUIRED_DISTINCT'],
  ['FUTURE_MIGRATOR', 'INVENTORY_READER', 'ALIAS_ALLOWED'],
  ['FUTURE_RUNTIME', 'INVENTORY_READER', 'ALIAS_ALLOWED'],
] as const satisfies readonly (readonly [
  CommunitiesRoleSplitRoleCategory,
  CommunitiesRoleSplitRoleCategory,
  'ALIAS_ALLOWED' | 'REQUIRED_DISTINCT',
])[];

export const COMMUNITIES_ROLE_SPLIT_GRANT_OBJECT_KINDS = [
  'database',
  'schema',
  'relation',
  'sequence',
  'function',
  'type',
] as const;
export type CommunitiesRoleSplitGrantObjectKind =
  (typeof COMMUNITIES_ROLE_SPLIT_GRANT_OBJECT_KINDS)[number];
export type CommunitiesRoleSplitObjectKind = CommunitiesRoleSplitGrantObjectKind | 'extension';

export const COMMUNITIES_ROLE_SPLIT_PRIVILEGES = [
  'CONNECT',
  'TEMPORARY',
  'USAGE',
  'CREATE',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'EXECUTE',
] as const;
export type CommunitiesRoleSplitPrivilege = (typeof COMMUNITIES_ROLE_SPLIT_PRIVILEGES)[number];

type Sha256 = string;
type ObservationState = 'OBSERVED' | 'UNKNOWN' | 'UNOBSERVED';

export type CommunitiesRoleSplitDigestObservation = {
  readonly observationState: ObservationState;
  readonly valueSha256: Sha256 | null;
  readonly provenanceSha256: Sha256 | null;
};

export type CommunitiesRoleSplitBooleanObservation = {
  readonly observationState: ObservationState;
  readonly value: boolean | null;
  readonly provenanceSha256: Sha256 | null;
};

export type CommunitiesRoleSplitRoleBinding = {
  readonly category: CommunitiesRoleSplitRoleCategory;
  readonly roleName: CommunitiesRoleSplitDigestObservation;
  readonly roleOid: CommunitiesRoleSplitDigestObservation;
  readonly canLogin: CommunitiesRoleSplitBooleanObservation;
  readonly superuser: CommunitiesRoleSplitBooleanObservation;
  readonly bypassRls: CommunitiesRoleSplitBooleanObservation;
  readonly createDatabase: CommunitiesRoleSplitBooleanObservation;
  readonly createRole: CommunitiesRoleSplitBooleanObservation;
  readonly replication: CommunitiesRoleSplitBooleanObservation;
};

export type CommunitiesRoleSplitIdentityRelation = {
  readonly left: CommunitiesRoleSplitRoleCategory;
  readonly right: CommunitiesRoleSplitRoleCategory;
  readonly requirement: 'ALIAS_ALLOWED' | 'REQUIRED_DISTINCT';
  readonly relation: 'SAME' | 'DISTINCT' | 'UNKNOWN' | 'UNOBSERVED';
  readonly provenanceSha256: Sha256 | null;
};

export type CommunitiesRoleSplitNormalizedRecord = {
  readonly canonicalKeySha256: Sha256;
  readonly observationState: ObservationState;
  readonly valueSha256: Sha256 | null;
  readonly provenanceSha256: Sha256 | null;
};

export type CommunitiesRoleSplitInputC = {
  readonly schemaVersion: string;
  readonly canonicalizationVersion: string;
  readonly sortVersion: string;
  readonly manifestSha256: Sha256;
  readonly provenance: {
    readonly contractVersion: string;
    readonly markerDigest: Sha256;
    readonly requestDigest: Sha256;
    readonly cloneNamePatternValid: boolean;
    readonly cloneOidBound: boolean;
    readonly sourceOidBound: boolean;
    readonly systemIdentifierDigest: Sha256;
    readonly pgMajor: number;
    readonly objectManifestDigest: Sha256;
    readonly ledgerDigest: Sha256;
    readonly ledgerCount: number;
  };
  readonly normalized: Record<
    CommunitiesRoleSplitNormalizedCategory,
    readonly CommunitiesRoleSplitNormalizedRecord[]
  >;
  readonly anomalies: readonly {
    readonly code: string;
    readonly canonicalKeySha256: Sha256;
    readonly evidenceSha256: Sha256;
  }[];
};

export type CommunitiesRoleSplitOwnershipDecision = {
  readonly objectKind: CommunitiesRoleSplitObjectKind;
  readonly canonicalKeySha256: Sha256;
  readonly beforeOwnerCategory: CommunitiesRoleSplitRoleCategory;
  readonly targetOwnerCategory: CommunitiesRoleSplitRoleCategory | 'PRESERVE_CURRENT';
  readonly ruleSha256: Sha256;
  readonly provenanceSha256: Sha256;
};

export type CommunitiesRoleSplitGrantDecision = {
  readonly objectKind: CommunitiesRoleSplitGrantObjectKind;
  readonly canonicalKeySha256: Sha256;
  readonly action: 'PRESERVE' | 'ADD' | 'REMOVE';
  readonly granteeCategory: CommunitiesRoleSplitRoleCategory;
  readonly privileges: readonly CommunitiesRoleSplitPrivilege[];
  readonly beforeStateSha256: Sha256;
  readonly targetStateSha256: Sha256;
  readonly grantOption: false;
  readonly ruleSha256: Sha256;
  readonly provenanceSha256: Sha256;
};

export type CommunitiesRoleSplitComparison = {
  readonly sortVersion: string;
  readonly beforeManifestSha: Sha256;
  readonly afterManifestSha: Sha256;
  readonly changedCount: number;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly forbiddenTransitionCodes: readonly string[];
};

export type CommunitiesRoleSplitAcceptanceEnvelope = {
  readonly contractVersion: string;
  /** Independently pinned raw artifact digest. It is deliberately outside INPUT_C. */
  readonly artifactSha256: Sha256;
  readonly inputC: CommunitiesRoleSplitInputC;
  readonly mapping: Record<CommunitiesRoleSplitRoleCategory, CommunitiesRoleSplitRoleBinding> & {
    readonly identityRelations: readonly CommunitiesRoleSplitIdentityRelation[];
  };
  readonly ownershipPlan: readonly CommunitiesRoleSplitOwnershipDecision[];
  readonly grantPlan: readonly CommunitiesRoleSplitGrantDecision[];
  readonly comparison: CommunitiesRoleSplitComparison;
  readonly decision: {
    readonly status: 'PASS' | 'FAIL';
    readonly blockerCodes: readonly string[];
    readonly authorizesRoleCreation: false;
    readonly authorizesRoleAlteration: false;
    readonly authorizesAclMutation: false;
    readonly authorizesMigration: false;
    readonly authorizesDeploy: false;
    readonly authorizesRuntimeActivation: false;
  };
};

export class CommunitiesRoleSplitAcceptanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommunitiesRoleSplitAcceptanceError';
  }
}

function fail(code: string): never {
  throw new CommunitiesRoleSplitAcceptanceError(`COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_${code}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function assertSha256(value: unknown, code: string): asserts value is string {
  if (!isSha256(value)) fail(code);
}

function assertDigestObservation(value: CommunitiesRoleSplitDigestObservation, code: string): void {
  if (
    value.observationState !== 'OBSERVED' ||
    !isSha256(value.valueSha256) ||
    !isSha256(value.provenanceSha256)
  )
    fail(code);
}

function assertBooleanObservation(
  value: CommunitiesRoleSplitBooleanObservation,
  code: string,
): void {
  if (
    value.observationState !== 'OBSERVED' ||
    typeof value.value !== 'boolean' ||
    !isSha256(value.provenanceSha256)
  )
    fail(code);
}

export function communitiesRoleSplitInputCManifestText(input: CommunitiesRoleSplitInputC): string {
  const lines = [
    COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
    `canonicalizationVersion=${COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION}`,
    `sortVersion=${COMMUNITIES_ROLE_SPLIT_SORT_VERSION}`,
  ];
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) {
    for (const record of input.normalized[category]) {
      lines.push(
        [
          category,
          record.canonicalKeySha256,
          record.observationState,
          record.valueSha256 ?? 'null',
          record.provenanceSha256 ?? 'null',
        ].join('|'),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function communitiesRoleSplitInputCManifestSha256(
  input: CommunitiesRoleSplitInputC,
): string {
  return sha256(communitiesRoleSplitInputCManifestText(input));
}

const objectCategoryByKind = {
  database: 'databaseAcl',
  schema: 'schemas',
  relation: 'relations',
  sequence: 'sequences',
  function: 'functions',
  type: 'types',
  extension: 'extensions',
} as const satisfies Record<CommunitiesRoleSplitObjectKind, CommunitiesRoleSplitNormalizedCategory>;

const privilegesByKind = {
  database: ['CONNECT', 'TEMPORARY'],
  schema: ['USAGE', 'CREATE'],
  relation: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
  function: ['EXECUTE'],
  type: ['USAGE'],
} as const satisfies Record<
  CommunitiesRoleSplitGrantObjectKind,
  readonly CommunitiesRoleSplitPrivilege[]
>;

function objectKey(objectKind: CommunitiesRoleSplitObjectKind, digest: string): string {
  return `${objectKind}|${digest}`;
}

function expectedObjects(input: CommunitiesRoleSplitInputC): Map<string, string> {
  const result = new Map<string, string>();
  for (const objectKind of [...COMMUNITIES_ROLE_SPLIT_GRANT_OBJECT_KINDS, 'extension'] as const) {
    for (const record of input.normalized[objectCategoryByKind[objectKind]]) {
      if (!isSha256(record.valueSha256)) fail('NORMALIZED_RECORD_NOT_OBSERVED');
      const key = objectKey(objectKind, record.canonicalKeySha256);
      if (result.has(key)) fail('OBJECT_MANIFEST_DUPLICATE');
      result.set(key, record.valueSha256);
    }
  }
  if (result.size === 0) fail('OBJECT_MANIFEST_EMPTY');
  return result;
}

function grantTransitionText(
  grant: Omit<CommunitiesRoleSplitGrantDecision, 'targetStateSha256'>,
  ownership: CommunitiesRoleSplitOwnershipDecision,
): string {
  return `${[
    'COMMUNITIES_ROLE_SPLIT_GRANT_TRANSITION_V1',
    `objectKind=${grant.objectKind}`,
    `canonicalKeySha256=${grant.canonicalKeySha256}`,
    `beforeStateSha256=${grant.beforeStateSha256}`,
    `action=${grant.action}`,
    `granteeCategory=${grant.granteeCategory}`,
    `privileges=${grant.privileges.join(',')}`,
    'grantOption=false',
    `beforeOwnerCategory=${ownership.beforeOwnerCategory}`,
    `targetOwnerCategory=${ownership.targetOwnerCategory}`,
    `grantRuleSha256=${grant.ruleSha256}`,
    `grantProvenanceSha256=${grant.provenanceSha256}`,
    `ownerRuleSha256=${ownership.ruleSha256}`,
    `ownerProvenanceSha256=${ownership.provenanceSha256}`,
  ].join('\n')}\n`;
}

export function communitiesRoleSplitGrantTargetStateSha256(
  grant: Omit<CommunitiesRoleSplitGrantDecision, 'targetStateSha256'>,
  ownership: CommunitiesRoleSplitOwnershipDecision,
): string {
  if (grant.action === 'PRESERVE' && ownership.targetOwnerCategory === 'PRESERVE_CURRENT')
    return grant.beforeStateSha256;
  return sha256(grantTransitionText(grant, ownership));
}

export function communitiesRoleSplitObjectStateManifestSha256(
  entries: readonly [string, string][],
): string {
  return sha256(
    `${[
      'COMMUNITIES_ROLE_SPLIT_OBJECT_STATE_MANIFEST_V1',
      `sortVersion=${COMMUNITIES_ROLE_SPLIT_SORT_VERSION}`,
      ...entries.map(([key, state]) => `${key}|${state}`),
    ].join('\n')}\n`,
  );
}

function assertInputC(input: CommunitiesRoleSplitInputC): void {
  if (
    input.schemaVersion !== COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION ||
    input.canonicalizationVersion !== COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION ||
    input.sortVersion !== COMMUNITIES_ROLE_SPLIT_SORT_VERSION
  )
    fail('INPUT_C_VERSION_INVALID');
  if (
    !hasExactKeys(input.normalized, COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) ||
    typeof input.provenance.contractVersion !== 'string' ||
    input.provenance.contractVersion.length === 0 ||
    input.provenance.pgMajor !== 16 ||
    !input.provenance.cloneNamePatternValid ||
    !input.provenance.cloneOidBound ||
    !input.provenance.sourceOidBound ||
    !Number.isSafeInteger(input.provenance.ledgerCount) ||
    input.provenance.ledgerCount < 0
  )
    fail('INPUT_C_BINDING_INVALID');
  for (const digest of [
    input.provenance.markerDigest,
    input.provenance.requestDigest,
    input.provenance.systemIdentifierDigest,
    input.provenance.objectManifestDigest,
    input.provenance.ledgerDigest,
  ])
    assertSha256(digest, 'INPUT_C_BINDING_INVALID');
  if (input.anomalies.length > 0) fail('INPUT_C_ANOMALY_PRESENT');
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) {
    let previous = '';
    const seen = new Set<string>();
    for (const record of input.normalized[category]) {
      if (
        !hasExactKeys(record, [
          'canonicalKeySha256',
          'observationState',
          'valueSha256',
          'provenanceSha256',
        ]) ||
        !isSha256(record.canonicalKeySha256) ||
        record.observationState !== 'OBSERVED' ||
        !isSha256(record.valueSha256) ||
        !isSha256(record.provenanceSha256)
      )
        fail('NORMALIZED_RECORD_NOT_OBSERVED');
      if (seen.has(record.canonicalKeySha256)) fail('NORMALIZED_RECORD_DUPLICATE');
      if (previous && previous >= record.canonicalKeySha256) fail('INPUT_C_SORT_INVALID');
      previous = record.canonicalKeySha256;
      seen.add(record.canonicalKeySha256);
    }
  }
  if (input.normalized.memberships.length > 0) fail('ROLE_MEMBERSHIP_FORBIDDEN');
  if (input.normalized.defaultAcls.length > 0) fail('DEFAULT_ACL_FORBIDDEN');
  if (input.normalized.columnAcls.length > 0) fail('COLUMN_GRANT_FORBIDDEN');
  if (communitiesRoleSplitInputCManifestSha256(input) !== input.manifestSha256)
    fail('INPUT_C_MANIFEST_INVALID');
}

function assertMapping(input: CommunitiesRoleSplitAcceptanceEnvelope['mapping']): void {
  if (!hasExactKeys(input, [...COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES, 'identityRelations']))
    fail('MAPPING_CATEGORY_SET_INVALID');
  for (const category of COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES) {
    const role = input[category];
    if (role.category !== category) fail('MAPPING_CATEGORY_SET_INVALID');
    assertDigestObservation(role.roleName, 'ROLE_IDENTITY_NOT_OBSERVED');
    assertDigestObservation(role.roleOid, 'ROLE_IDENTITY_NOT_OBSERVED');
    for (const capability of [
      role.canLogin,
      role.superuser,
      role.bypassRls,
      role.createDatabase,
      role.createRole,
      role.replication,
    ])
      assertBooleanObservation(capability, 'ROLE_CAPABILITY_NOT_OBSERVED');
    if (
      role.superuser.value ||
      role.bypassRls.value ||
      role.createDatabase.value ||
      role.createRole.value ||
      role.replication.value
    )
      fail('ROLE_CAPABILITY_FORBIDDEN');
  }
  if (input.identityRelations.length !== COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.length)
    fail('IDENTITY_RELATION_SET_INVALID');
  input.identityRelations.forEach((relation, index) => {
    const expected = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS[index];
    if (
      !expected ||
      relation.left !== expected[0] ||
      relation.right !== expected[1] ||
      relation.left === relation.right ||
      relation.requirement !== expected[2]
    )
      fail('IDENTITY_RELATION_SET_INVALID');
    if (!['SAME', 'DISTINCT'].includes(relation.relation) || !isSha256(relation.provenanceSha256))
      fail('IDENTITY_RELATION_NOT_OBSERVED');
    if (relation.requirement === 'REQUIRED_DISTINCT' && relation.relation !== 'DISTINCT')
      fail('REQUIRED_DISTINCT_NOT_OBSERVED');
    const left = input[relation.left];
    const right = input[relation.right];
    const sameIdentity =
      left.roleName.valueSha256 === right.roleName.valueSha256 &&
      left.roleOid.valueSha256 === right.roleOid.valueSha256;
    if (
      (relation.relation === 'SAME' && !sameIdentity) ||
      (relation.relation === 'DISTINCT' && sameIdentity)
    )
      fail('IDENTITY_RELATION_EVIDENCE_MISMATCH');
  });
}

function assertOwnershipPlan(
  input: CommunitiesRoleSplitAcceptanceEnvelope,
  objects: ReadonlyMap<string, string>,
): Map<string, CommunitiesRoleSplitOwnershipDecision> {
  if (input.ownershipPlan.length !== objects.size) fail('OWNERSHIP_PLAN_SET_INVALID');
  const result = new Map<string, CommunitiesRoleSplitOwnershipDecision>();
  for (const row of input.ownershipPlan) {
    const key = objectKey(row.objectKind, row.canonicalKeySha256);
    if (!objects.has(key) || result.has(key)) fail('OWNERSHIP_PLAN_SET_INVALID');
    for (const digest of [row.canonicalKeySha256, row.ruleSha256, row.provenanceSha256])
      assertSha256(digest, 'OWNERSHIP_PLAN_INVALID');
    if (
      ['RESTORE_EXECUTOR', 'FUTURE_RUNTIME', 'INVENTORY_READER'].includes(row.beforeOwnerCategory)
    )
      fail('OWNERSHIP_PREIMAGE_FORBIDDEN');
    if (
      ((row.objectKind === 'database' || row.objectKind === 'extension') &&
        row.targetOwnerCategory !== 'PRESERVE_CURRENT') ||
      (row.targetOwnerCategory !== 'PRESERVE_CURRENT' &&
        row.targetOwnerCategory !== 'FUTURE_MIGRATOR')
    )
      fail('OWNERSHIP_TARGET_FORBIDDEN');
    result.set(key, row);
  }
  return result;
}

function assertGrantPlan(
  input: CommunitiesRoleSplitAcceptanceEnvelope,
  objects: ReadonlyMap<string, string>,
  ownership: ReadonlyMap<string, CommunitiesRoleSplitOwnershipDecision>,
): Map<string, CommunitiesRoleSplitGrantDecision> {
  const expectedKeys = [...objects.keys()].filter((key) => !key.startsWith('extension|'));
  if (input.grantPlan.length !== expectedKeys.length || input.grantPlan.length === 0)
    fail('GRANT_PLAN_SET_INVALID');
  const result = new Map<string, CommunitiesRoleSplitGrantDecision>();
  for (const row of input.grantPlan) {
    const key = objectKey(row.objectKind, row.canonicalKeySha256);
    const before = objects.get(key);
    const owner = ownership.get(key);
    if (!before || !owner || result.has(key)) fail('GRANT_PLAN_SET_INVALID');
    for (const digest of [
      row.canonicalKeySha256,
      row.beforeStateSha256,
      row.targetStateSha256,
      row.ruleSha256,
      row.provenanceSha256,
    ])
      assertSha256(digest, 'GRANT_PLAN_INVALID');
    if (row.beforeStateSha256 !== before || row.grantOption !== false) fail('GRANT_PLAN_INVALID');
    if (!['PRESERVE', 'ADD', 'REMOVE'].includes(row.action)) fail('GRANT_ACTION_INVALID');
    if (!COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.includes(row.granteeCategory))
      fail('GRANTEE_CATEGORY_FORBIDDEN');
    if (row.action === 'PRESERVE' ? row.privileges.length !== 0 : row.privileges.length === 0)
      fail('GRANT_PRIVILEGE_SET_INVALID');
    const allowed: readonly CommunitiesRoleSplitPrivilege[] = privilegesByKind[row.objectKind];
    if (
      new Set(row.privileges).size !== row.privileges.length ||
      row.privileges.some((privilege) => !allowed.includes(privilege)) ||
      row.privileges.join('\0') !== [...row.privileges].sort().join('\0')
    )
      fail('GRANT_PRIVILEGE_SET_INVALID');
    if (row.granteeCategory === 'FUTURE_RUNTIME' && row.privileges.includes('CREATE'))
      fail('RUNTIME_CREATE_FORBIDDEN');
    if (row.granteeCategory === 'INVENTORY_READER' && row.action === 'ADD')
      fail('INVENTORY_READER_GRANT_FORBIDDEN');
    const withoutTarget: Omit<CommunitiesRoleSplitGrantDecision, 'targetStateSha256'> = {
      objectKind: row.objectKind,
      canonicalKeySha256: row.canonicalKeySha256,
      action: row.action,
      granteeCategory: row.granteeCategory,
      privileges: row.privileges,
      beforeStateSha256: row.beforeStateSha256,
      grantOption: row.grantOption,
      ruleSha256: row.ruleSha256,
      provenanceSha256: row.provenanceSha256,
    };
    if (communitiesRoleSplitGrantTargetStateSha256(withoutTarget, owner) !== row.targetStateSha256)
      fail('GRANT_TARGET_STATE_INVALID');
    result.set(key, row);
  }
  if (expectedKeys.some((key) => !result.has(key))) fail('GRANT_PLAN_SET_INVALID');
  return result;
}

export function assertCommunitiesRoleSplitAcceptancePass(
  input: CommunitiesRoleSplitAcceptanceEnvelope,
): CommunitiesRoleSplitComparison {
  if (input.contractVersion !== COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION)
    fail('CONTRACT_VERSION_INVALID');
  assertSha256(input.artifactSha256, 'INPUT_C_ARTIFACT_PIN_INVALID');
  assertInputC(input.inputC);
  assertMapping(input.mapping);
  const objects = expectedObjects(input.inputC);
  const ownership = assertOwnershipPlan(input, objects);
  const grants = assertGrantPlan(input, objects, ownership);

  const orderedKeys = [...objects.keys()].sort();
  const beforeEntries = orderedKeys.map((key) => [key, objects.get(key)!] as [string, string]);
  const afterEntries = orderedKeys.map((key) => {
    const grant = grants.get(key);
    return [key, grant?.targetStateSha256 ?? objects.get(key)!] as [string, string];
  });
  const computed: CommunitiesRoleSplitComparison = {
    sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
    beforeManifestSha: communitiesRoleSplitObjectStateManifestSha256(beforeEntries),
    afterManifestSha: communitiesRoleSplitObjectStateManifestSha256(afterEntries),
    changedCount: afterEntries.filter((entry, index) => entry[1] !== beforeEntries[index]?.[1])
      .length,
    addedCount: input.grantPlan.filter((row) => row.action === 'ADD').length,
    removedCount: input.grantPlan.filter((row) => row.action === 'REMOVE').length,
    forbiddenTransitionCodes: [],
  };
  if (JSON.stringify(input.comparison) !== JSON.stringify(computed)) fail('COMPARISON_MISMATCH');
  if (
    input.decision.status !== 'PASS' ||
    input.decision.blockerCodes.length > 0 ||
    input.decision.authorizesRoleCreation !== false ||
    input.decision.authorizesRoleAlteration !== false ||
    input.decision.authorizesAclMutation !== false ||
    input.decision.authorizesMigration !== false ||
    input.decision.authorizesDeploy !== false ||
    input.decision.authorizesRuntimeActivation !== false
  )
    fail('DECISION_NOT_PASS');
  return computed;
}
