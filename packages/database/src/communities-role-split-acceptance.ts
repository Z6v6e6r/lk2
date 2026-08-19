import {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  assertCommunitiesRoleSplitInputC,
  communitiesRoleSplitCanonicalJson,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCManifestSha256,
  communitiesRoleSplitMappingSha256,
  type CommunitiesRoleSplitAclEntry,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitNormalizedCategory,
  type CommunitiesRoleSplitNormalizedRecord,
  type CommunitiesRoleSplitRoleCategory,
} from './communities-role-split-input-c.js';

export const COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION = 'communities-role-split-acceptance-v1';
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

export type CommunitiesRoleSplitOwnershipDecision = {
  readonly objectKind: CommunitiesRoleSplitObjectKind;
  readonly objectKeySha256: string;
  readonly ownerFieldKeySha256: string;
  readonly beforeOwnerCategory: CommunitiesRoleSplitRoleCategory;
  readonly targetOwnerCategory: CommunitiesRoleSplitRoleCategory | 'PRESERVE_CURRENT';
  readonly beforeOwnerValueSha256: string;
  readonly afterOwnerValueSha256: string;
  readonly ownerEvidenceSha256: string;
};
export type CommunitiesRoleSplitGrantDecision = {
  readonly objectKind: CommunitiesRoleSplitGrantObjectKind;
  readonly objectKeySha256: string;
  readonly fieldKeySha256: string;
  readonly action: 'PRESERVE' | 'ADD' | 'REMOVE';
  readonly granteeCategory: CommunitiesRoleSplitRoleCategory;
  readonly granteeEvidenceSha256: string | null;
  readonly grantorCategory: CommunitiesRoleSplitRoleCategory | 'PUBLIC' | 'THIRD_PARTY' | null;
  readonly grantorEvidenceSha256: string | null;
  readonly occurrenceSha256: string | null;
  readonly privileges: readonly CommunitiesRoleSplitPrivilege[];
  readonly beforeStateSha256: string;
  readonly targetStateSha256: string;
  readonly evidenceSha256: string;
  readonly grantOption: false;
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
  readonly expectedMappingDigest: string;
  readonly markerDigest: string;
  readonly markerEvidenceDigest: string;
  readonly requestDigest: string;
  readonly creationReceiptSha256: string;
  readonly objectManifestDigest: string;
  readonly ledgerDigest: string;
};
export type CommunitiesRoleSplitAcceptanceEnvelope = {
  readonly contractVersion: typeof COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION;
  readonly observedBefore: CommunitiesRoleSplitInputC;
  readonly observedAfter: CommunitiesRoleSplitInputC;
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
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function assertSnapshot(snapshot: CommunitiesRoleSplitInputC): void {
  try {
    assertCommunitiesRoleSplitInputC(snapshot);
  } catch (error) {
    if (error instanceof Error && error.message === 'INPUT_C_MANIFEST_INVALID')
      fail('INPUT_C_MANIFEST_INVALID');
    if (error instanceof Error && error.message === 'INPUT_C_MAPPING_INVALID')
      fail('MAPPING_DIGEST_INVALID');
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
  if (
    !hasExactKeys(pins, [
      'beforeArtifactSha256',
      'afterArtifactSha256',
      'beforeManifestSha256',
      'afterManifestSha256',
      'expectedMappingDigest',
      'markerDigest',
      'markerEvidenceDigest',
      'requestDigest',
      'creationReceiptSha256',
      'objectManifestDigest',
      'ledgerDigest',
    ])
  )
    fail('EXPECTED_PIN_INVALID');
  for (const pin of Object.values(pins)) assertSha256(pin, 'EXPECTED_PIN_INVALID');
  if (
    communitiesRoleSplitInputCArtifactSha256(before) !== pins.beforeArtifactSha256 ||
    communitiesRoleSplitInputCArtifactSha256(after) !== pins.afterArtifactSha256 ||
    before.manifestSha256 !== pins.beforeManifestSha256 ||
    after.manifestSha256 !== pins.afterManifestSha256
  )
    fail('INPUT_C_ARTIFACT_PIN_INVALID');
  if (
    before.mapping.mappingDigest !== pins.expectedMappingDigest ||
    after.mapping.mappingDigest !== pins.expectedMappingDigest ||
    communitiesRoleSplitMappingSha256(before.mapping) !== pins.expectedMappingDigest ||
    communitiesRoleSplitCanonicalJson(before.mapping) !==
      communitiesRoleSplitCanonicalJson(after.mapping)
  )
    fail('MAPPING_DIGEST_INVALID');
  for (const snapshot of [before, after])
    if (
      snapshot.provenance.markerDigest !== pins.markerDigest ||
      snapshot.provenance.markerEvidenceDigest !== pins.markerEvidenceDigest ||
      snapshot.provenance.requestDigest !== pins.requestDigest ||
      snapshot.provenance.creationReceiptSha256 !== pins.creationReceiptSha256 ||
      snapshot.provenance.objectManifestDigest !== pins.objectManifestDigest ||
      snapshot.provenance.ledgerDigest !== pins.ledgerDigest ||
      snapshot.provenance.mappingDigest !== pins.expectedMappingDigest
    )
      fail('INPUT_C_BINDING_INVALID');
}

type Equivalence = (
  left: CommunitiesRoleSplitRoleCategory,
  right: CommunitiesRoleSplitRoleCategory,
) => boolean;
function mappingEquivalence(snapshot: CommunitiesRoleSplitInputC): Equivalence {
  for (const role of snapshot.mapping.categories)
    if (
      role.capabilities.superuser ||
      role.capabilities.bypassRls ||
      role.capabilities.createDatabase ||
      role.capabilities.createRole ||
      role.capabilities.replication
    )
      fail('ROLE_CAPABILITY_FORBIDDEN');
  const edges = new Map(
    COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => [
      category,
      new Set<CommunitiesRoleSplitRoleCategory>([category]),
    ]),
  );
  snapshot.mapping.identityRelations.forEach((relation, index) => {
    const expected = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS[index];
    if (
      !expected ||
      relation.left !== expected[0] ||
      relation.right !== expected[1] ||
      relation.requirement !== expected[2]
    )
      fail('MAPPING_DIGEST_INVALID');
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
const objectPlanKey = (kind: CommunitiesRoleSplitObjectKind, object: string): string =>
  `${kind}|${object}`;
const fieldPlanKey = (
  kind: CommunitiesRoleSplitGrantObjectKind,
  object: string,
  field: string,
): string => `${kind}|${object}|${field}`;
const recordKey = (category: string, record: CommunitiesRoleSplitNormalizedRecord): string =>
  `${category}|${record.objectKeySha256}|${record.fieldKeySha256}`;
function snapshotRecords(
  snapshot: CommunitiesRoleSplitInputC,
): Map<string, CommunitiesRoleSplitNormalizedRecord> {
  const result = new Map<string, CommunitiesRoleSplitNormalizedRecord>();
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES)
    for (const record of snapshot.normalized[category])
      result.set(recordKey(category, record), record);
  return result;
}
function ownerRecords(
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
function aclRecords(
  snapshot: CommunitiesRoleSplitInputC,
): Map<string, CommunitiesRoleSplitNormalizedRecord> {
  const result = new Map<string, CommunitiesRoleSplitNormalizedRecord>();
  for (const kind of COMMUNITIES_ROLE_SPLIT_GRANT_OBJECT_KINDS)
    for (const record of snapshot.normalized[objectCategoryByKind[kind]]) {
      if (record.fieldKind !== 'ACL_EXPLICIT' && record.fieldKind !== 'ACL_EFFECTIVE') continue;
      const key = fieldPlanKey(kind, record.objectKeySha256, record.fieldKeySha256);
      if (result.has(key)) fail('GRANT_PLAN_SET_INVALID');
      result.set(key, record);
    }
  if (result.size === 0) fail('GRANT_PLAN_SET_INVALID');
  return result;
}
function mappingRole(
  snapshot: CommunitiesRoleSplitInputC,
  category: CommunitiesRoleSplitRoleCategory,
) {
  return snapshot.mapping.categories.find((entry) => entry.category === category)!;
}
function ownerCategory(
  record: CommunitiesRoleSplitNormalizedRecord,
): CommunitiesRoleSplitRoleCategory {
  if (!record.semantic || !('ownerCategory' in record.semantic))
    fail('OWNER_EVIDENCE_BINDING_INVALID');
  return record.semantic.ownerCategory;
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
    if (
      !hasExactKeys(row, [
        'objectKind',
        'objectKeySha256',
        'ownerFieldKeySha256',
        'beforeOwnerCategory',
        'targetOwnerCategory',
        'beforeOwnerValueSha256',
        'afterOwnerValueSha256',
        'ownerEvidenceSha256',
      ])
    )
      fail('OWNERSHIP_PLAN_INVALID');
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
    ])
      assertSha256(digest, 'OWNERSHIP_PLAN_INVALID');
    const beforeCategory = ownerCategory(before),
      afterCategory = ownerCategory(after);
    if (
      before.fieldKeySha256 !== row.ownerFieldKeySha256 ||
      after.fieldKeySha256 !== row.ownerFieldKeySha256 ||
      before.valueSha256 !== row.beforeOwnerValueSha256 ||
      after.valueSha256 !== row.afterOwnerValueSha256 ||
      before.provenanceSha256 !== row.ownerEvidenceSha256 ||
      after.provenanceSha256 !== row.ownerEvidenceSha256 ||
      row.beforeOwnerCategory !== beforeCategory ||
      mappingRole(envelope.observedBefore, beforeCategory).roleNameSha256 !== before.valueSha256 ||
      mappingRole(envelope.observedAfter, afterCategory).roleNameSha256 !== after.valueSha256
    )
      fail('OWNER_EVIDENCE_BINDING_INVALID');
    if (
      ['RESTORE_EXECUTOR', 'FUTURE_RUNTIME', 'INVENTORY_READER'].some((category) =>
        equivalent(beforeCategory, category as CommunitiesRoleSplitRoleCategory),
      )
    )
      fail('OWNERSHIP_PREIMAGE_FORBIDDEN');
    if (row.targetOwnerCategory === 'PRESERVE_CURRENT') {
      if (beforeCategory !== afterCategory || before.valueSha256 !== after.valueSha256)
        fail('OWNERSHIP_PLAN_DELTA_MISMATCH');
    } else {
      if (
        row.objectKind === 'database' ||
        row.objectKind === 'extension' ||
        row.targetOwnerCategory !== afterCategory ||
        row.targetOwnerCategory !== 'FUTURE_MIGRATOR' ||
        ['RESTORE_EXECUTOR', 'FUTURE_RUNTIME', 'INVENTORY_READER'].some((category) =>
          equivalent(afterCategory, category as CommunitiesRoleSplitRoleCategory),
        ) ||
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
function aclEntries(
  record: CommunitiesRoleSplitNormalizedRecord,
): readonly CommunitiesRoleSplitAclEntry[] {
  if (!record.semantic || !('entries' in record.semantic)) fail('GRANT_PLAN_INVALID');
  return record.semantic.entries;
}
function entryKey(entry: CommunitiesRoleSplitAclEntry): string {
  return communitiesRoleSplitCanonicalJson(entry);
}
function actualAclDelta(
  before: CommunitiesRoleSplitNormalizedRecord,
  after: CommunitiesRoleSplitNormalizedRecord,
): { added: Set<string>; removed: Set<string> } {
  const left = new Set(aclEntries(before).map(entryKey)),
    right = new Set(aclEntries(after).map(entryKey));
  return {
    added: new Set([...right].filter((entry) => !left.has(entry))),
    removed: new Set([...left].filter((entry) => !right.has(entry))),
  };
}
function assertGrantPlan(
  envelope: CommunitiesRoleSplitAcceptanceEnvelope,
  beforeAcls: ReadonlyMap<string, CommunitiesRoleSplitNormalizedRecord>,
  afterAcls: ReadonlyMap<string, CommunitiesRoleSplitNormalizedRecord>,
  equivalent: Equivalence,
): Set<string> {
  if (beforeAcls.size !== afterAcls.size) fail('GRANT_PLAN_SET_INVALID');
  const plans = new Map<string, CommunitiesRoleSplitGrantDecision[]>();
  for (const row of envelope.grantPlan) {
    if (
      !hasExactKeys(row, [
        'objectKind',
        'objectKeySha256',
        'fieldKeySha256',
        'action',
        'granteeCategory',
        'granteeEvidenceSha256',
        'grantorCategory',
        'grantorEvidenceSha256',
        'occurrenceSha256',
        'privileges',
        'beforeStateSha256',
        'targetStateSha256',
        'evidenceSha256',
        'grantOption',
      ])
    )
      fail('GRANT_PLAN_INVALID');
    const key = fieldPlanKey(row.objectKind, row.objectKeySha256, row.fieldKeySha256),
      before = beforeAcls.get(key),
      after = afterAcls.get(key);
    if (!before || !after) fail('GRANT_PLAN_SET_INVALID');
    for (const digest of [
      row.objectKeySha256,
      row.fieldKeySha256,
      row.beforeStateSha256,
      row.targetStateSha256,
      row.evidenceSha256,
    ])
      assertSha256(digest, 'GRANT_PLAN_INVALID');
    if (
      row.beforeStateSha256 !== before.valueSha256 ||
      row.targetStateSha256 !== after.valueSha256 ||
      row.evidenceSha256 !== before.provenanceSha256 ||
      row.evidenceSha256 !== after.provenanceSha256 ||
      row.grantOption !== false ||
      !COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.includes(row.granteeCategory) ||
      !['PRESERVE', 'ADD', 'REMOVE'].includes(row.action)
    )
      fail('GRANT_PLAN_INVALID');
    const allowed: readonly CommunitiesRoleSplitPrivilege[] = privilegesByKind[row.objectKind];
    if (
      new Set(row.privileges).size !== row.privileges.length ||
      row.privileges.some((privilege) => !allowed.includes(privilege)) ||
      row.privileges.join('\0') !== [...row.privileges].sort().join('\0') ||
      (row.action === 'PRESERVE'
        ? row.privileges.length !== 0 ||
          row.granteeEvidenceSha256 !== null ||
          row.grantorCategory !== null ||
          row.grantorEvidenceSha256 !== null ||
          row.occurrenceSha256 !== null
        : row.privileges.length !== 1 ||
          !isSha256(row.granteeEvidenceSha256) ||
          !row.grantorCategory ||
          ![...COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES, 'PUBLIC', 'THIRD_PARTY'].includes(
            row.grantorCategory,
          ) ||
          !isSha256(row.grantorEvidenceSha256) ||
          !isSha256(row.occurrenceSha256))
    )
      fail('GRANT_PRIVILEGE_SET_INVALID');
    if (row.action === 'ADD' && equivalent(row.granteeCategory, 'INVENTORY_READER'))
      fail('INVENTORY_READER_GRANT_FORBIDDEN');
    if (
      row.objectKind === 'schema' &&
      row.action === 'ADD' &&
      row.privileges.includes('CREATE') &&
      equivalent(row.granteeCategory, 'FUTURE_RUNTIME')
    )
      fail('RUNTIME_CREATE_FORBIDDEN');
    plans.set(key, [...(plans.get(key) ?? []), row]);
  }
  if (plans.size !== beforeAcls.size || [...beforeAcls.keys()].some((key) => !plans.has(key)))
    fail('GRANT_PLAN_SET_INVALID');
  const changed = new Set<string>();
  for (const [key, before] of beforeAcls) {
    const after = afterAcls.get(key)!,
      rows = plans.get(key)!,
      delta = actualAclDelta(before, after);
    const preserve = rows.filter((row) => row.action === 'PRESERVE');
    if (delta.added.size === 0 && delta.removed.size === 0) {
      if (rows.length !== 1 || preserve.length !== 1 || before.valueSha256 !== after.valueSha256)
        fail('GRANT_PLAN_DELTA_MISMATCH');
      continue;
    }
    if (preserve.length > 0) fail('GRANT_PLAN_DELTA_MISMATCH');
    const plannedAdded = new Set<string>(),
      plannedRemoved = new Set<string>();
    for (const row of rows)
      for (const privilege of row.privileges) {
        if (
          !row.granteeEvidenceSha256 ||
          !row.grantorCategory ||
          !row.grantorEvidenceSha256 ||
          !row.occurrenceSha256
        )
          fail('GRANT_PLAN_INVALID');
        const entry = entryKey({
          granteeCategory: row.granteeCategory,
          granteeEvidenceSha256: row.granteeEvidenceSha256,
          grantorCategory: row.grantorCategory,
          grantorEvidenceSha256: row.grantorEvidenceSha256,
          privilege,
          grantOption: row.grantOption,
          occurrenceSha256: row.occurrenceSha256,
        });
        const target = row.action === 'ADD' ? plannedAdded : plannedRemoved;
        if (target.has(entry)) fail('GRANT_PLAN_DELTA_MISMATCH');
        target.add(entry);
      }
    if (
      plannedAdded.size !== delta.added.size ||
      plannedRemoved.size !== delta.removed.size ||
      [...plannedAdded].some((entry) => !delta.added.has(entry)) ||
      [...plannedRemoved].some((entry) => !delta.removed.has(entry))
    )
      fail('GRANT_PLAN_DELTA_MISMATCH');
    const representative = rows[0];
    if (!representative) fail('GRANT_PLAN_SET_INVALID');
    changed.add(recordKey(objectCategoryByKind[representative.objectKind], before));
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
      record.provenanceSha256 !== candidate.provenanceSha256 ||
      communitiesRoleSplitCanonicalJson(record.semantic) !==
        communitiesRoleSplitCanonicalJson(candidate.semantic)
    )
      changed.add(key);
  }
  for (const key of right.keys()) if (!left.has(key)) added++;
  return { changed, added, removed };
}
export function assertCommunitiesRoleSplitAcceptancePass(
  envelope: CommunitiesRoleSplitAcceptanceEnvelope,
  pins: CommunitiesRoleSplitExpectedPins,
): CommunitiesRoleSplitComparison {
  if (
    !hasExactKeys(envelope, [
      'contractVersion',
      'observedBefore',
      'observedAfter',
      'ownershipPlan',
      'grantPlan',
      'comparison',
      'decision',
    ]) ||
    !hasExactKeys(envelope.comparison, [
      'sortVersion',
      'beforeManifestSha256',
      'afterManifestSha256',
      'changedCount',
      'addedCount',
      'removedCount',
      'forbiddenTransitionCodes',
    ]) ||
    !hasExactKeys(envelope.decision, [
      'status',
      'blockerCodes',
      'authorizesRoleCreation',
      'authorizesRoleAlteration',
      'authorizesAclMutation',
      'authorizesMigration',
      'authorizesDeploy',
      'authorizesRuntimeActivation',
    ])
  )
    fail('CONTRACT_SHAPE_INVALID');
  if (envelope.contractVersion !== COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION)
    fail('CONTRACT_VERSION_INVALID');
  assertSnapshot(envelope.observedBefore);
  assertSnapshot(envelope.observedAfter);
  assertPins(envelope.observedBefore, envelope.observedAfter, pins);
  const equivalent = mappingEquivalence(envelope.observedBefore);
  const ownerChanges = assertOwnershipPlan(
    envelope,
    ownerRecords(envelope.observedBefore),
    ownerRecords(envelope.observedAfter),
    equivalent,
  );
  const grantChanges = assertGrantPlan(
    envelope,
    aclRecords(envelope.observedBefore),
    aclRecords(envelope.observedAfter),
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
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCManifestSha256,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitRoleCategory,
};
