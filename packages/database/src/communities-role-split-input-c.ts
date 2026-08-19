import { createHash } from 'node:crypto';

export const COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION = 'communities-role-split-input-c-v1';
export const COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION = 'utf8-byte-digest-v1';
export const COMMUNITIES_ROLE_SPLIT_SORT_VERSION = 'sha256-byte-v1';
export const COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION = 'communities-role-split-mapping-v1';

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
export const COMMUNITIES_ROLE_SPLIT_FIELD_KINDS = [
  'ROLE',
  'MEMBERSHIP',
  'OWNER',
  'ACL_EXPLICIT',
  'ACL_EFFECTIVE',
  'METADATA',
  'DEFAULT_ACL',
  'COLUMN',
  'RLS',
  'POLICY',
  'EXTENSION_MEMBER',
] as const;
export type CommunitiesRoleSplitFieldKind = (typeof COMMUNITIES_ROLE_SPLIT_FIELD_KINDS)[number];
export type CommunitiesRoleSplitAclGranteeCategory =
  CommunitiesRoleSplitRoleCategory | 'PUBLIC' | 'THIRD_PARTY';
export type CommunitiesRoleSplitAclEntry = {
  readonly granteeCategory: CommunitiesRoleSplitAclGranteeCategory;
  readonly granteeEvidenceSha256: string;
  readonly grantorCategory: CommunitiesRoleSplitAclGranteeCategory;
  readonly grantorEvidenceSha256: string;
  readonly privilege: string;
  readonly grantOption: boolean;
  readonly occurrenceSha256: string;
};

export const COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT = [
  'ACL_PRIVILEGE_UNDECIDED',
  'COLUMN_GRANT_FORBIDDEN',
  'DEFAULT_ACL_CHANGE_FORBIDDEN',
  'EXTENSION_CHANGE_FORBIDDEN',
  'GRANT_OPTION_FORBIDDEN',
  'INPUT_C_ANOMALY_PRESENT',
  'INVENTORY_READER_OWNERSHIP_FORBIDDEN',
  'INVENTORY_READER_WRITE_FORBIDDEN',
  'MAPPING_INCOMPLETE',
  'MIXED_OWNER_FORBIDDEN',
  'NON_DETERMINISTIC_COMPARISON',
  'NORMALIZED_RECORD_UNKNOWN',
  'OUT_OF_MANIFEST_CHANGE_FORBIDDEN',
  'OWNER_TARGET_UNDECIDED',
  'OWNER_UNOBSERVED',
  'PUBLIC_GRANT_FORBIDDEN',
  'REQUIRED_DISTINCT_NOT_OBSERVED',
  'RESTORE_EXECUTOR_OWNERSHIP_FORBIDDEN',
  'RLS_POLICY_CHANGE_FORBIDDEN',
  'ROLE_CAPABILITY_FORBIDDEN',
  'ROLE_CATEGORY_IDENTITY_NOT_OBSERVED',
  'ROLE_MEMBERSHIP_FORBIDDEN',
  'RUNTIME_OWNERSHIP_FORBIDDEN',
  'RUNTIME_SCHEMA_CREATE_FORBIDDEN',
  'SHARED_DATABASE_CHANGE_FORBIDDEN',
  'THIRD_PARTY_GRANT_FORBIDDEN',
  'WILDCARD_GRANT_FORBIDDEN',
] as const;

export type CommunitiesRoleSplitMappingCategory = {
  readonly category: CommunitiesRoleSplitRoleCategory;
  readonly roleNameSha256: string;
  readonly roleOidSha256: string;
  readonly capabilities: {
    readonly canLogin: boolean;
    readonly superuser: boolean;
    readonly bypassRls: boolean;
    readonly createDatabase: boolean;
    readonly createRole: boolean;
    readonly replication: boolean;
  };
  readonly evidenceSha256: string;
};
export type CommunitiesRoleSplitMappingArtifact = {
  readonly schemaVersion: typeof COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION;
  readonly categories: readonly CommunitiesRoleSplitMappingCategory[];
  readonly identityRelations: readonly {
    readonly left: CommunitiesRoleSplitRoleCategory;
    readonly right: CommunitiesRoleSplitRoleCategory;
    readonly requirement: 'ALIAS_ALLOWED' | 'REQUIRED_DISTINCT';
    readonly relation: 'SAME' | 'DISTINCT';
    readonly evidenceSha256: string;
  }[];
  readonly mappingDigest: string;
};
export type CommunitiesRoleSplitNormalizedRecord = {
  readonly objectKeySha256: string;
  readonly fieldKeySha256: string;
  readonly fieldKind: CommunitiesRoleSplitFieldKind;
  readonly observationState: 'OBSERVED' | 'UNKNOWN' | 'UNOBSERVED';
  readonly valueSha256: string | null;
  readonly provenanceSha256: string | null;
  readonly semantic:
    | { readonly ownerCategory: CommunitiesRoleSplitRoleCategory }
    | { readonly entries: readonly CommunitiesRoleSplitAclEntry[] }
    | null;
};
export type CommunitiesRoleSplitInputC = {
  readonly schemaVersion: typeof COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION;
  readonly canonicalizationVersion: typeof COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION;
  readonly sortVersion: typeof COMMUNITIES_ROLE_SPLIT_SORT_VERSION;
  readonly provenance: {
    readonly contractVersion: 'communities-role-split-clone-marker-evidence-v2';
    readonly markerDigest: string;
    readonly markerEvidenceDigest: string;
    readonly requestDigest: string;
    readonly creationReceiptSha256: string;
    readonly cloneNamePatternValid: true;
    readonly cloneOidBound: true;
    readonly sourceOidBound: true;
    readonly systemIdentifierDigest: string;
    readonly pgMajor: 16;
    readonly objectManifestDigest: string;
    readonly ledgerDigest: string;
    readonly ledgerCount: number;
    readonly mappingDigest: string;
  };
  readonly mapping: CommunitiesRoleSplitMappingArtifact;
  readonly normalized: Readonly<
    Record<CommunitiesRoleSplitNormalizedCategory, readonly CommunitiesRoleSplitNormalizedRecord[]>
  >;
  readonly anomalies: readonly {
    readonly code: string;
    readonly count: number;
    readonly evidenceSha256: string;
  }[];
  readonly forbiddenCodeContract: readonly (typeof COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT)[number][];
  readonly manifestSha256: string;
  readonly authorizes: {
    readonly roleCreation: false;
    readonly roleRepair: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly schemaMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
};

const sha256Pattern = /^[a-f0-9]{64}$/u;
export function compareCommunitiesRoleSplitUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
export function communitiesRoleSplitSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function communitiesRoleSplitCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('CANONICAL_JSON_INVALID');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(communitiesRoleSplitCanonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('CANONICAL_JSON_INVALID');
  return `{${Object.keys(value)
    .sort(compareCommunitiesRoleSplitUtf8Bytes)
    .map((key) => `${JSON.stringify(key)}:${communitiesRoleSplitCanonicalJson(value[key])}`)
    .join(',')}}`;
}
export function communitiesRoleSplitMappingText(
  mapping:
    | Omit<CommunitiesRoleSplitMappingArtifact, 'mappingDigest'>
    | CommunitiesRoleSplitMappingArtifact,
): string {
  return `${communitiesRoleSplitCanonicalJson({ schemaVersion: mapping.schemaVersion, categories: mapping.categories, identityRelations: mapping.identityRelations })}\n`;
}
export function communitiesRoleSplitMappingSha256(
  mapping:
    | Omit<CommunitiesRoleSplitMappingArtifact, 'mappingDigest'>
    | CommunitiesRoleSplitMappingArtifact,
): string {
  return communitiesRoleSplitSha256(communitiesRoleSplitMappingText(mapping));
}
export function communitiesRoleSplitInputCArtifactText(input: CommunitiesRoleSplitInputC): string {
  return `${communitiesRoleSplitCanonicalJson(input)}\n`;
}
export function communitiesRoleSplitInputCArtifactSha256(
  input: CommunitiesRoleSplitInputC,
): string {
  return communitiesRoleSplitSha256(communitiesRoleSplitInputCArtifactText(input));
}
export function communitiesRoleSplitInputCManifestText(input: CommunitiesRoleSplitInputC): string {
  const lines = [
    COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
    `canonicalizationVersion=${COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION}`,
    `sortVersion=${COMMUNITIES_ROLE_SPLIT_SORT_VERSION}`,
    `mappingDigest=${input.mapping.mappingDigest}`,
  ];
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES)
    for (const record of input.normalized[category])
      lines.push(
        [
          category,
          record.objectKeySha256,
          record.fieldKeySha256,
          record.fieldKind,
          record.observationState,
          record.valueSha256 ?? 'null',
          record.provenanceSha256 ?? 'null',
          communitiesRoleSplitSha256(communitiesRoleSplitCanonicalJson(record.semantic)),
        ].join('|'),
      );
  return `${lines.join('\n')}\n`;
}
export function communitiesRoleSplitInputCManifestSha256(
  input: CommunitiesRoleSplitInputC,
): string {
  return communitiesRoleSplitSha256(communitiesRoleSplitInputCManifestText(input));
}
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).sort(compareCommunitiesRoleSplitUtf8Bytes).join('\0') ===
      [...keys].sort(compareCommunitiesRoleSplitUtf8Bytes).join('\0')
  );
}
function assertMapping(mapping: CommunitiesRoleSplitMappingArtifact): void {
  if (
    !isRecord(mapping) ||
    !exactKeys(mapping, ['schemaVersion', 'categories', 'identityRelations', 'mappingDigest']) ||
    mapping.schemaVersion !== COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION ||
    !Array.isArray(Reflect.get(mapping, 'categories')) ||
    !Array.isArray(Reflect.get(mapping, 'identityRelations')) ||
    !sha256Pattern.test(String(mapping.mappingDigest)) ||
    communitiesRoleSplitMappingSha256(mapping) !== mapping.mappingDigest
  )
    throw new Error('INPUT_C_MAPPING_INVALID');
  if (mapping.categories.length !== COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.length)
    throw new Error('INPUT_C_MAPPING_INVALID');
  mapping.categories.forEach((entry, index) => {
    const expected = COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES[index];
    if (
      !entry ||
      !exactKeys(entry, [
        'category',
        'roleNameSha256',
        'roleOidSha256',
        'capabilities',
        'evidenceSha256',
      ]) ||
      entry.category !== expected ||
      !sha256Pattern.test(entry.roleNameSha256) ||
      !sha256Pattern.test(entry.roleOidSha256) ||
      !sha256Pattern.test(entry.evidenceSha256) ||
      !exactKeys(entry.capabilities, [
        'canLogin',
        'superuser',
        'bypassRls',
        'createDatabase',
        'createRole',
        'replication',
      ]) ||
      Object.values(entry.capabilities).some((item) => typeof item !== 'boolean')
    )
      throw new Error('INPUT_C_MAPPING_INVALID');
  });
  if (mapping.identityRelations.length !== COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.length)
    throw new Error('INPUT_C_MAPPING_INVALID');
  mapping.identityRelations.forEach((relation, index) => {
    const expected = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS[index];
    if (
      !expected ||
      !exactKeys(relation, ['left', 'right', 'requirement', 'relation', 'evidenceSha256'])
    )
      throw new Error('INPUT_C_MAPPING_INVALID');
    const left = mapping.categories.find((entry) => entry.category === relation.left);
    const right = mapping.categories.find((entry) => entry.category === relation.right);
    const same =
      left?.roleNameSha256 === right?.roleNameSha256 &&
      left?.roleOidSha256 === right?.roleOidSha256;
    if (
      relation.left !== expected[0] ||
      relation.right !== expected[1] ||
      relation.requirement !== expected[2] ||
      relation.relation !== (same ? 'SAME' : 'DISTINCT') ||
      !sha256Pattern.test(relation.evidenceSha256) ||
      (relation.requirement === 'REQUIRED_DISTINCT' && relation.relation !== 'DISTINCT')
    )
      throw new Error('INPUT_C_MAPPING_INVALID');
  });
}
export function assertCommunitiesRoleSplitInputC(
  value: unknown,
): asserts value is CommunitiesRoleSplitInputC {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'canonicalizationVersion',
      'sortVersion',
      'provenance',
      'mapping',
      'normalized',
      'anomalies',
      'forbiddenCodeContract',
      'manifestSha256',
      'authorizes',
    ]) ||
    value.schemaVersion !== COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION ||
    value.canonicalizationVersion !== COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION ||
    value.sortVersion !== COMMUNITIES_ROLE_SPLIT_SORT_VERSION ||
    !isRecord(value.provenance) ||
    !isRecord(value.mapping) ||
    !isRecord(value.normalized) ||
    !Array.isArray(value.anomalies) ||
    !Array.isArray(value.forbiddenCodeContract) ||
    !isRecord(value.authorizes) ||
    !sha256Pattern.test(String(value.manifestSha256))
  )
    throw new Error('INPUT_C_SCHEMA_INVALID');
  assertMapping(value.mapping as CommunitiesRoleSplitMappingArtifact);
  const input = value as unknown as CommunitiesRoleSplitInputC;
  if (
    !exactKeys(input.provenance, [
      'contractVersion',
      'markerDigest',
      'markerEvidenceDigest',
      'requestDigest',
      'creationReceiptSha256',
      'cloneNamePatternValid',
      'cloneOidBound',
      'sourceOidBound',
      'systemIdentifierDigest',
      'pgMajor',
      'objectManifestDigest',
      'ledgerDigest',
      'ledgerCount',
      'mappingDigest',
    ]) ||
    !exactKeys(input.authorizes, [
      'roleCreation',
      'roleRepair',
      'roleSplit',
      'aclMutation',
      'schemaMutation',
      'sharedDatabaseMutation',
      'migration',
      'deploy',
      'activation',
    ]) ||
    input.provenance.mappingDigest !== input.mapping.mappingDigest ||
    !exactKeys(input.normalized, COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) ||
    JSON.stringify(input.forbiddenCodeContract) !==
      JSON.stringify(COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT) ||
    Object.values(input.authorizes).some((item) => item !== false)
  )
    throw new Error('INPUT_C_SCHEMA_INVALID');
  for (const digest of [
    input.provenance.markerDigest,
    input.provenance.markerEvidenceDigest,
    input.provenance.requestDigest,
    input.provenance.creationReceiptSha256,
    input.provenance.systemIdentifierDigest,
    input.provenance.objectManifestDigest,
    input.provenance.ledgerDigest,
  ])
    if (!sha256Pattern.test(digest)) throw new Error('INPUT_C_SCHEMA_INVALID');
  if (
    input.provenance.contractVersion !== 'communities-role-split-clone-marker-evidence-v2' ||
    input.provenance.pgMajor !== 16 ||
    !input.provenance.cloneNamePatternValid ||
    !input.provenance.cloneOidBound ||
    !input.provenance.sourceOidBound ||
    !Number.isSafeInteger(input.provenance.ledgerCount) ||
    input.provenance.ledgerCount < 0
  )
    throw new Error('INPUT_C_SCHEMA_INVALID');
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) {
    if (!Array.isArray(Reflect.get(input.normalized, category)))
      throw new Error('INPUT_C_SCHEMA_INVALID');
    let previous = '';
    for (const record of input.normalized[category]) {
      if (
        !exactKeys(record, [
          'objectKeySha256',
          'fieldKeySha256',
          'fieldKind',
          'observationState',
          'valueSha256',
          'provenanceSha256',
          'semantic',
        ]) ||
        !sha256Pattern.test(record.objectKeySha256) ||
        !sha256Pattern.test(record.fieldKeySha256) ||
        !COMMUNITIES_ROLE_SPLIT_FIELD_KINDS.includes(record.fieldKind)
      )
        throw new Error('INPUT_C_SCHEMA_INVALID');
      const observed = record.observationState === 'OBSERVED';
      if (
        (!observed && !['UNKNOWN', 'UNOBSERVED'].includes(record.observationState)) ||
        (observed &&
          (!record.valueSha256 ||
            !sha256Pattern.test(record.valueSha256) ||
            !record.provenanceSha256 ||
            !sha256Pattern.test(record.provenanceSha256))) ||
        (!observed &&
          (record.valueSha256 !== null ||
            record.provenanceSha256 !== null ||
            record.semantic !== null))
      )
        throw new Error('INPUT_C_SCHEMA_INVALID');
      if (!observed) {
        // UNKNOWN/UNOBSERVED have no semantic assertion by construction.
      } else if (record.fieldKind === 'OWNER') {
        if (
          !isRecord(record.semantic) ||
          !exactKeys(record.semantic, ['ownerCategory']) ||
          !('ownerCategory' in record.semantic) ||
          !COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.includes(record.semantic.ownerCategory)
        )
          throw new Error('INPUT_C_SCHEMA_INVALID');
      } else if (record.fieldKind === 'ACL_EXPLICIT' || record.fieldKind === 'ACL_EFFECTIVE') {
        if (
          !isRecord(record.semantic) ||
          !exactKeys(record.semantic, ['entries']) ||
          !('entries' in record.semantic) ||
          !Array.isArray(Reflect.get(record.semantic, 'entries'))
        )
          throw new Error('INPUT_C_SCHEMA_INVALID');
        let prior = '';
        for (const entry of record.semantic.entries) {
          if (
            !exactKeys(entry, [
              'granteeCategory',
              'granteeEvidenceSha256',
              'grantorCategory',
              'grantorEvidenceSha256',
              'privilege',
              'grantOption',
              'occurrenceSha256',
            ]) ||
            ![...COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES, 'PUBLIC', 'THIRD_PARTY'].includes(
              entry.granteeCategory,
            ) ||
            ![...COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES, 'PUBLIC', 'THIRD_PARTY'].includes(
              entry.grantorCategory,
            ) ||
            !sha256Pattern.test(entry.granteeEvidenceSha256) ||
            !sha256Pattern.test(entry.grantorEvidenceSha256) ||
            !sha256Pattern.test(entry.occurrenceSha256) ||
            !/^[A-Z][A-Z_]*$/u.test(entry.privilege) ||
            typeof entry.grantOption !== 'boolean'
          )
            throw new Error('INPUT_C_SCHEMA_INVALID');
          const current = communitiesRoleSplitCanonicalJson(entry);
          if (prior && compareCommunitiesRoleSplitUtf8Bytes(prior, current) >= 0)
            throw new Error('INPUT_C_SCHEMA_INVALID');
          prior = current;
        }
      } else if (record.semantic !== null) throw new Error('INPUT_C_SCHEMA_INVALID');
      const key = `${record.objectKeySha256}|${record.fieldKeySha256}`;
      if (previous && compareCommunitiesRoleSplitUtf8Bytes(previous, key) >= 0)
        throw new Error('INPUT_C_SCHEMA_INVALID');
      previous = key;
    }
  }
  for (const anomaly of input.anomalies)
    if (
      !exactKeys(anomaly, ['code', 'count', 'evidenceSha256']) ||
      !/^[A-Z][A-Z0-9_]{2,127}$/u.test(anomaly.code) ||
      !Number.isSafeInteger(anomaly.count) ||
      anomaly.count < 1 ||
      !sha256Pattern.test(anomaly.evidenceSha256)
    )
      throw new Error('INPUT_C_SCHEMA_INVALID');
  if (communitiesRoleSplitInputCManifestSha256(input) !== input.manifestSha256)
    throw new Error('INPUT_C_MANIFEST_INVALID');
}
