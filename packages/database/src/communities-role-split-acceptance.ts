import {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  assertCommunitiesRoleSplitInputC,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCManifestSha256,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitNormalizedCategory,
  type CommunitiesRoleSplitNormalizedRecord,
} from './communities-role-split-input-c.js';

export const COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION = 'communities-role-split-acceptance-v1';
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

type DigestObservation = {
  readonly observationState: 'OBSERVED' | 'UNKNOWN' | 'UNOBSERVED';
  readonly valueSha256: string | null;
  readonly provenanceSha256: string | null;
};
type BooleanObservation = {
  readonly observationState: 'OBSERVED' | 'UNKNOWN' | 'UNOBSERVED';
  readonly value: boolean | null;
  readonly provenanceSha256: string | null;
};
export type CommunitiesRoleSplitRoleBinding = {
  readonly category: CommunitiesRoleSplitRoleCategory;
  readonly roleName: DigestObservation;
  readonly roleOid: DigestObservation;
  readonly canLogin: BooleanObservation;
  readonly superuser: BooleanObservation;
  readonly bypassRls: BooleanObservation;
  readonly createDatabase: BooleanObservation;
  readonly createRole: BooleanObservation;
  readonly replication: BooleanObservation;
};
export type CommunitiesRoleSplitIdentityRelation = {
  readonly left: CommunitiesRoleSplitRoleCategory;
  readonly right: CommunitiesRoleSplitRoleCategory;
  readonly requirement: 'ALIAS_ALLOWED' | 'REQUIRED_DISTINCT';
  readonly relation: 'SAME' | 'DISTINCT' | 'UNKNOWN' | 'UNOBSERVED';
  readonly provenanceSha256: string | null;
};
export type CommunitiesRoleSplitOwnershipDecision = {
  readonly objectKind: CommunitiesRoleSplitObjectKind;
  readonly objectKeySha256: string;
  readonly ownerFieldKeySha256: string;
  readonly beforeOwnerCategory: CommunitiesRoleSplitRoleCategory;
  readonly targetOwnerCategory: CommunitiesRoleSplitRoleCategory | 'PRESERVE_CURRENT';
  readonly beforeOwnerValueSha256: string;
  readonly afterOwnerValueSha256: string;
  readonly ownerEvidenceSha256: string;
  readonly ruleSha256: string;
};
export type CommunitiesRoleSplitGrantDecision = {
  readonly objectKind: CommunitiesRoleSplitGrantObjectKind;
  readonly objectKeySha256: string;
  readonly fieldKeySha256: string;
  readonly action: 'PRESERVE' | 'ADD' | 'REMOVE';
  readonly granteeCategory: CommunitiesRoleSplitRoleCategory;
  readonly privileges: readonly CommunitiesRoleSplitPrivilege[];
  readonly beforeStateSha256: string;
  readonly targetStateSha256: string;
  readonly evidenceSha256: string;
  readonly grantOption: false;
  readonly ruleSha256: string;
};
export type CommunitiesRoleSplitComparison = {
  readonly sortVersion: typeof COMMUNITIES_ROLE_SPLIT_SORT_VERSION;
  readonly beforeManifestSha256: string;
  readonly afterManifestSha256: string;
  readonly changedCount: number;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly forbiddenTransitionCodes: readonly string[];
};
export type CommunitiesRoleSplitExpectedPins = {
  readonly beforeArtifactSha256: string;
  readonly afterArtifactSha256: string;
  readonly beforeManifestSha256: string;
  readonly afterManifestSha256: string;
  readonly mappingDigest: string;
  readonly markerDigest: string;
  readonly markerEvidenceDigest: string;
  readonly requestDigest: string;
  readonly objectManifestDigest: string;
  readonly ledgerDigest: string;
};
export type CommunitiesRoleSplitAcceptanceEnvelope = {
  readonly contractVersion: typeof COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION;
  readonly observedBefore: CommunitiesRoleSplitInputC;
  readonly observedAfter: CommunitiesRoleSplitInputC;
  readonly mapping: Record<CommunitiesRoleSplitRoleCategory, CommunitiesRoleSplitRoleBinding> & {
    readonly mappingDigest: string;
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
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function assertSha256(value: unknown, code: string): asserts value is string {
  if (!isSha256(value)) fail(code);
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function assertObservedDigest(value: DigestObservation, code: string): void {
  if (
    value.observationState !== 'OBSERVED' ||
    !isSha256(value.valueSha256) ||
    !isSha256(value.provenanceSha256)
  )
    fail(code);
}
function assertObservedBoolean(value: BooleanObservation, code: string): void {
  if (
    value.observationState !== 'OBSERVED' ||
    typeof value.value !== 'boolean' ||
    !isSha256(value.provenanceSha256)
  )
    fail(code);
}
function assertSnapshot(snapshot: CommunitiesRoleSplitInputC): void {
  try {
    assertCommunitiesRoleSplitInputC(snapshot);
  } catch (error) {
    if (error instanceof Error && error.message === 'INPUT_C_MANIFEST_INVALID')
      fail('INPUT_C_MANIFEST_INVALID');
    fail('INPUT_C_SCHEMA_INVALID');
  }
  if (snapshot.anomalies.length > 0) fail('INPUT_C_ANOMALY_PRESENT');
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES)
    for (const record of snapshot.normalized[category])
      if (record.observationState !== 'OBSERVED') fail('NORMALIZED_RECORD_NOT_OBSERVED');
  if (
    JSON.stringify(snapshot.forbiddenCodeContract) !==
    JSON.stringify(COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT)
  )
    fail('FORBIDDEN_CODE_CONTRACT_INVALID');
}
function assertPins(
  before: CommunitiesRoleSplitInputC,
  after: CommunitiesRoleSplitInputC,
  pins: CommunitiesRoleSplitExpectedPins,
): void {
  for (const pin of Object.values(pins)) assertSha256(pin, 'EXPECTED_PIN_INVALID');
  if (
    communitiesRoleSplitInputCArtifactSha256(before) !== pins.beforeArtifactSha256 ||
    communitiesRoleSplitInputCArtifactSha256(after) !== pins.afterArtifactSha256 ||
    before.manifestSha256 !== pins.beforeManifestSha256 ||
    after.manifestSha256 !== pins.afterManifestSha256
  )
    fail('INPUT_C_ARTIFACT_PIN_INVALID');
  for (const snapshot of [before, after])
    if (
      snapshot.provenance.mappingObservationState !== 'OBSERVED' ||
      snapshot.provenance.mappingDigest !== pins.mappingDigest ||
      snapshot.provenance.markerDigest !== pins.markerDigest ||
      snapshot.provenance.markerEvidenceDigest !== pins.markerEvidenceDigest ||
      snapshot.provenance.requestDigest !== pins.requestDigest ||
      snapshot.provenance.objectManifestDigest !== pins.objectManifestDigest ||
      snapshot.provenance.ledgerDigest !== pins.ledgerDigest
    )
      fail('INPUT_C_BINDING_INVALID');
}

type Equivalence = (
  left: CommunitiesRoleSplitRoleCategory,
  right: CommunitiesRoleSplitRoleCategory,
) => boolean;
function assertMapping(
  mapping: CommunitiesRoleSplitAcceptanceEnvelope['mapping'],
  expectedMappingDigest: string,
): Equivalence {
  if (
    !exactKeys(mapping, [
      ...COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
      'mappingDigest',
      'identityRelations',
    ]) ||
    mapping.mappingDigest !== expectedMappingDigest
  )
    fail('MAPPING_DIGEST_INVALID');
  for (const category of COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES) {
    const role = mapping[category];
    if (role.category !== category) fail('MAPPING_CATEGORY_SET_INVALID');
    assertObservedDigest(role.roleName, 'ROLE_IDENTITY_NOT_OBSERVED');
    assertObservedDigest(role.roleOid, 'ROLE_IDENTITY_NOT_OBSERVED');
    for (const capability of [
      role.canLogin,
      role.superuser,
      role.bypassRls,
      role.createDatabase,
      role.createRole,
      role.replication,
    ])
      assertObservedBoolean(capability, 'ROLE_CAPABILITY_NOT_OBSERVED');
    if (
      role.superuser.value ||
      role.bypassRls.value ||
      role.createDatabase.value ||
      role.createRole.value ||
      role.replication.value
    )
      fail('ROLE_CAPABILITY_FORBIDDEN');
  }
  if (mapping.identityRelations.length !== COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.length)
    fail('IDENTITY_RELATION_SET_INVALID');
  const edges = new Map(
    COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => [
      category,
      new Set<CommunitiesRoleSplitRoleCategory>([category]),
    ]),
  );
  mapping.identityRelations.forEach((relation, index) => {
    const expected = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS[index];
    if (
      !expected ||
      relation.left !== expected[0] ||
      relation.right !== expected[1] ||
      relation.requirement !== expected[2]
    )
      fail('IDENTITY_RELATION_SET_INVALID');
    if (!['SAME', 'DISTINCT'].includes(relation.relation) || !isSha256(relation.provenanceSha256))
      fail('IDENTITY_RELATION_NOT_OBSERVED');
    if (relation.requirement === 'REQUIRED_DISTINCT' && relation.relation !== 'DISTINCT')
      fail('REQUIRED_DISTINCT_NOT_OBSERVED');
    const left = mapping[relation.left],
      right = mapping[relation.right];
    const sameDigest =
      left.roleName.valueSha256 === right.roleName.valueSha256 &&
      left.roleOid.valueSha256 === right.roleOid.valueSha256;
    if ((relation.relation === 'SAME') !== sameDigest) fail('IDENTITY_RELATION_EVIDENCE_MISMATCH');
    if (relation.relation === 'SAME') {
      edges.get(relation.left)!.add(relation.right);
      edges.get(relation.right)!.add(relation.left);
    }
  });
  return (left, right) => {
    const visited = new Set<CommunitiesRoleSplitRoleCategory>(),
      queue = [left];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === right) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...edges.get(current)!);
    }
    return false;
  };
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
  schema: ['CREATE', 'USAGE'],
  relation: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  sequence: ['SELECT', 'UPDATE', 'USAGE'],
  function: ['EXECUTE'],
  type: ['USAGE'],
} as const satisfies Record<
  CommunitiesRoleSplitGrantObjectKind,
  readonly CommunitiesRoleSplitPrivilege[]
>;
const recordKey = (category: string, record: CommunitiesRoleSplitNormalizedRecord): string =>
  `${category}|${record.objectKeySha256}|${record.fieldKeySha256}`;
const objectPlanKey = (kind: CommunitiesRoleSplitObjectKind, object: string): string =>
  `${kind}|${object}`;
const fieldPlanKey = (
  kind: CommunitiesRoleSplitGrantObjectKind,
  object: string,
  field: string,
): string => `${kind}|${object}|${field}`;
function snapshotRecords(
  snapshot: CommunitiesRoleSplitInputC,
): Map<string, CommunitiesRoleSplitNormalizedRecord> {
  const result = new Map<string, CommunitiesRoleSplitNormalizedRecord>();
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES)
    for (const record of snapshot.normalized[category])
      result.set(recordKey(category, record), record);
  return result;
}
function expectedOwnerRecords(
  snapshot: CommunitiesRoleSplitInputC,
): Map<string, CommunitiesRoleSplitNormalizedRecord> {
  const result = new Map<string, CommunitiesRoleSplitNormalizedRecord>();
  for (const kind of [...COMMUNITIES_ROLE_SPLIT_GRANT_OBJECT_KINDS, 'extension'] as const)
    for (const record of snapshot.normalized[objectCategoryByKind[kind]]) {
      if (record.fieldKind !== 'OWNER') continue;
      const key = objectPlanKey(kind, record.objectKeySha256);
      if (result.has(key)) fail('MIXED_OWNER_FORBIDDEN');
      result.set(key, record);
    }
  if (result.size === 0) fail('OWNER_UNOBSERVED');
  return result;
}
function expectedAclRecords(
  snapshot: CommunitiesRoleSplitInputC,
): Map<string, CommunitiesRoleSplitNormalizedRecord> {
  const result = new Map<string, CommunitiesRoleSplitNormalizedRecord>();
  for (const kind of COMMUNITIES_ROLE_SPLIT_GRANT_OBJECT_KINDS)
    for (const record of snapshot.normalized[objectCategoryByKind[kind]]) {
      if (!['ACL_EXPLICIT', 'ACL_EFFECTIVE'].includes(record.fieldKind)) continue;
      const key = fieldPlanKey(kind, record.objectKeySha256, record.fieldKeySha256);
      if (result.has(key)) fail('GRANT_PLAN_SET_INVALID');
      result.set(key, record);
    }
  if (result.size === 0) fail('GRANT_PLAN_SET_INVALID');
  return result;
}
function assertOwnershipPlan(
  envelope: CommunitiesRoleSplitAcceptanceEnvelope,
  beforeOwners: ReadonlyMap<string, CommunitiesRoleSplitNormalizedRecord>,
  afterOwners: ReadonlyMap<string, CommunitiesRoleSplitNormalizedRecord>,
  equivalent: Equivalence,
): Set<string> {
  if (envelope.ownershipPlan.length !== beforeOwners.size || beforeOwners.size !== afterOwners.size)
    fail('OWNERSHIP_PLAN_SET_INVALID');
  const changed = new Set<string>(),
    seen = new Set<string>();
  for (const row of envelope.ownershipPlan) {
    const key = objectPlanKey(row.objectKind, row.objectKeySha256),
      before = beforeOwners.get(key),
      after = afterOwners.get(key);
    if (!before || !after || seen.has(key)) fail('OWNERSHIP_PLAN_SET_INVALID');
    seen.add(key);
    for (const digest of [
      row.objectKeySha256,
      row.ownerFieldKeySha256,
      row.beforeOwnerValueSha256,
      row.afterOwnerValueSha256,
      row.ownerEvidenceSha256,
      row.ruleSha256,
    ])
      assertSha256(digest, 'OWNERSHIP_PLAN_INVALID');
    if (
      before.fieldKeySha256 !== row.ownerFieldKeySha256 ||
      after.fieldKeySha256 !== row.ownerFieldKeySha256 ||
      before.valueSha256 !== row.beforeOwnerValueSha256 ||
      after.valueSha256 !== row.afterOwnerValueSha256 ||
      before.provenanceSha256 !== row.ownerEvidenceSha256 ||
      envelope.mapping[row.beforeOwnerCategory].roleName.valueSha256 !== before.valueSha256
    )
      fail('OWNER_EVIDENCE_BINDING_INVALID');
    if (
      ['RESTORE_EXECUTOR', 'FUTURE_RUNTIME', 'INVENTORY_READER'].some((category) =>
        equivalent(row.beforeOwnerCategory, category as CommunitiesRoleSplitRoleCategory),
      )
    )
      fail('OWNERSHIP_PREIMAGE_FORBIDDEN');
    if (row.targetOwnerCategory === 'PRESERVE_CURRENT') {
      if (before.valueSha256 !== after.valueSha256) fail('OWNERSHIP_PLAN_DELTA_MISMATCH');
    } else {
      if (
        row.objectKind === 'database' ||
        row.objectKind === 'extension' ||
        row.targetOwnerCategory !== 'FUTURE_MIGRATOR' ||
        ['RESTORE_EXECUTOR', 'FUTURE_RUNTIME', 'INVENTORY_READER'].some((category) =>
          equivalent(
            row.targetOwnerCategory as CommunitiesRoleSplitRoleCategory,
            category as CommunitiesRoleSplitRoleCategory,
          ),
        ) ||
        envelope.mapping[row.targetOwnerCategory].roleName.valueSha256 !== after.valueSha256 ||
        before.valueSha256 === after.valueSha256
      )
        fail('OWNERSHIP_TARGET_FORBIDDEN');
      changed.add(
        `${objectCategoryByKind[row.objectKind]}|${row.objectKeySha256}|${row.ownerFieldKeySha256}`,
      );
    }
  }
  return changed;
}
function assertGrantPlan(
  envelope: CommunitiesRoleSplitAcceptanceEnvelope,
  beforeAcls: ReadonlyMap<string, CommunitiesRoleSplitNormalizedRecord>,
  afterAcls: ReadonlyMap<string, CommunitiesRoleSplitNormalizedRecord>,
  equivalent: Equivalence,
): Set<string> {
  if (envelope.grantPlan.length !== beforeAcls.size || beforeAcls.size !== afterAcls.size)
    fail('GRANT_PLAN_SET_INVALID');
  const changed = new Set<string>(),
    seen = new Set<string>();
  for (const row of envelope.grantPlan) {
    const key = fieldPlanKey(row.objectKind, row.objectKeySha256, row.fieldKeySha256),
      before = beforeAcls.get(key),
      after = afterAcls.get(key);
    if (!before || !after || seen.has(key)) fail('GRANT_PLAN_SET_INVALID');
    seen.add(key);
    for (const digest of [
      row.objectKeySha256,
      row.fieldKeySha256,
      row.beforeStateSha256,
      row.targetStateSha256,
      row.evidenceSha256,
      row.ruleSha256,
    ])
      assertSha256(digest, 'GRANT_PLAN_INVALID');
    if (
      before.valueSha256 !== row.beforeStateSha256 ||
      after.valueSha256 !== row.targetStateSha256 ||
      before.provenanceSha256 !== row.evidenceSha256 ||
      row.grantOption !== false ||
      !['PRESERVE', 'ADD', 'REMOVE'].includes(row.action) ||
      !COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.includes(row.granteeCategory)
    )
      fail('GRANT_PLAN_INVALID');
    const allowed: readonly CommunitiesRoleSplitPrivilege[] = privilegesByKind[row.objectKind];
    if (
      new Set(row.privileges).size !== row.privileges.length ||
      row.privileges.some((privilege) => !allowed.includes(privilege)) ||
      row.privileges.join('\0') !== [...row.privileges].sort().join('\0') ||
      (row.action === 'PRESERVE' ? row.privileges.length !== 0 : row.privileges.length === 0)
    )
      fail('GRANT_PRIVILEGE_SET_INVALID');
    if (row.action === 'ADD' && equivalent(row.granteeCategory, 'INVENTORY_READER'))
      fail('INVENTORY_READER_GRANT_FORBIDDEN');
    if (
      row.objectKind === 'schema' &&
      row.privileges.includes('CREATE') &&
      equivalent(row.granteeCategory, 'FUTURE_RUNTIME')
    )
      fail('RUNTIME_CREATE_FORBIDDEN');
    const differs = before.valueSha256 !== after.valueSha256;
    if ((row.action === 'PRESERVE') !== !differs) fail('GRANT_PLAN_DELTA_MISMATCH');
    if (differs)
      changed.add(
        `${objectCategoryByKind[row.objectKind]}|${row.objectKeySha256}|${row.fieldKeySha256}`,
      );
  }
  return changed;
}
function fullSnapshotDelta(
  before: CommunitiesRoleSplitInputC,
  after: CommunitiesRoleSplitInputC,
): { changed: Set<string>; added: number; removed: number } {
  const left = snapshotRecords(before),
    right = snapshotRecords(after),
    changed = new Set<string>();
  let added = 0,
    removed = 0;
  for (const [key, record] of left) {
    const candidate = right.get(key);
    if (!candidate) removed++;
    else if (
      record.fieldKind !== candidate.fieldKind ||
      record.valueSha256 !== candidate.valueSha256 ||
      record.provenanceSha256 !== candidate.provenanceSha256
    )
      changed.add(key);
  }
  for (const key of right.keys()) if (!left.has(key)) added++;
  return { changed, added, removed };
}

export function assertCommunitiesRoleSplitAcceptancePass(
  envelope: CommunitiesRoleSplitAcceptanceEnvelope,
  expectedPins: CommunitiesRoleSplitExpectedPins,
): CommunitiesRoleSplitComparison {
  if (envelope.contractVersion !== COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION)
    fail('CONTRACT_VERSION_INVALID');
  assertSnapshot(envelope.observedBefore);
  assertSnapshot(envelope.observedAfter);
  assertPins(envelope.observedBefore, envelope.observedAfter, expectedPins);
  const equivalent = assertMapping(envelope.mapping, expectedPins.mappingDigest);
  const ownerChanges = assertOwnershipPlan(
    envelope,
    expectedOwnerRecords(envelope.observedBefore),
    expectedOwnerRecords(envelope.observedAfter),
    equivalent,
  );
  const grantChanges = assertGrantPlan(
    envelope,
    expectedAclRecords(envelope.observedBefore),
    expectedAclRecords(envelope.observedAfter),
    equivalent,
  );
  const delta = fullSnapshotDelta(envelope.observedBefore, envelope.observedAfter);
  if (delta.added > 0 || delta.removed > 0) fail('OUT_OF_MANIFEST_CHANGE_FORBIDDEN');
  for (const category of [
    'roles',
    'memberships',
    'defaultAcls',
    'columnAcls',
    'rlsPolicies',
    'extensions',
  ] as const)
    if ([...delta.changed].some((key) => key.startsWith(`${category}|`)))
      fail(
        category === 'roles'
          ? 'ROLE_CAPABILITY_FORBIDDEN'
          : category === 'memberships'
            ? 'ROLE_MEMBERSHIP_FORBIDDEN'
            : category === 'defaultAcls'
              ? 'DEFAULT_ACL_CHANGE_FORBIDDEN'
              : category === 'columnAcls'
                ? 'COLUMN_GRANT_FORBIDDEN'
                : category === 'rlsPolicies'
                  ? 'RLS_POLICY_CHANGE_FORBIDDEN'
                  : 'EXTENSION_CHANGE_FORBIDDEN',
      );
  const planned = new Set([...ownerChanges, ...grantChanges]);
  if (
    planned.size !== delta.changed.size ||
    [...planned].some((key) => !delta.changed.has(key)) ||
    [...delta.changed].some((key) => !planned.has(key))
  )
    fail('PLAN_DELTA_MISMATCH');
  const computed: CommunitiesRoleSplitComparison = {
    sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
    beforeManifestSha256: communitiesRoleSplitInputCManifestSha256(envelope.observedBefore),
    afterManifestSha256: communitiesRoleSplitInputCManifestSha256(envelope.observedAfter),
    changedCount: delta.changed.size,
    addedCount: delta.added,
    removedCount: delta.removed,
    forbiddenTransitionCodes: [],
  };
  if (JSON.stringify(envelope.comparison) !== JSON.stringify(computed)) fail('COMPARISON_MISMATCH');
  if (
    envelope.decision.status !== 'PASS' ||
    envelope.decision.blockerCodes.length > 0 ||
    Object.entries(envelope.decision).some(
      ([key, value]) => key.startsWith('authorizes') && value !== false,
    )
  )
    fail('DECISION_NOT_PASS');
  return computed;
}

export {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCManifestSha256,
  type CommunitiesRoleSplitInputC,
};
