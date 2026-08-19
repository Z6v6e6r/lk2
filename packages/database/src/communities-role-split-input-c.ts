import { createHash } from 'node:crypto';

export const COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION = 'communities-role-split-input-c-v1';
export const COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION = 'utf8-byte-digest-v1';
export const COMMUNITIES_ROLE_SPLIT_SORT_VERSION = 'sha256-byte-v1';

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

export type CommunitiesRoleSplitNormalizedRecord = {
  readonly objectKeySha256: string;
  readonly fieldKeySha256: string;
  readonly fieldKind: CommunitiesRoleSplitFieldKind;
  readonly observationState: 'OBSERVED' | 'UNKNOWN' | 'UNOBSERVED';
  readonly valueSha256: string | null;
  readonly provenanceSha256: string | null;
};

export type CommunitiesRoleSplitInputC = {
  readonly schemaVersion: typeof COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION;
  readonly canonicalizationVersion: typeof COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION;
  readonly sortVersion: typeof COMMUNITIES_ROLE_SPLIT_SORT_VERSION;
  readonly provenance: {
    readonly contractVersion: 'communities-role-split-clone-marker-evidence-v1';
    readonly markerDigest: string;
    readonly markerEvidenceDigest: string;
    readonly requestDigest: string;
    readonly cloneNamePatternValid: true;
    readonly cloneOidBound: true;
    readonly sourceOidBound: true;
    readonly systemIdentifierDigest: string;
    readonly pgMajor: 16;
    readonly objectManifestDigest: string;
    readonly ledgerDigest: string;
    readonly ledgerCount: number;
    readonly mappingObservationState: 'OBSERVED' | 'UNKNOWN';
    readonly mappingDigest: string | null;
  };
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INPUT_C_CANONICAL_INVALID');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('INPUT_C_CANONICAL_INVALID');
  return `{${Object.keys(value)
    .sort(compareCommunitiesRoleSplitUtf8Bytes)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function communitiesRoleSplitInputCArtifactText(input: CommunitiesRoleSplitInputC): string {
  return `${canonicalJson(input)}\n`;
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
  ];
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) {
    for (const record of input.normalized[category]) {
      lines.push(
        [
          category,
          record.objectKeySha256,
          record.fieldKeySha256,
          record.fieldKind,
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
  return communitiesRoleSplitSha256(communitiesRoleSplitInputCManifestText(input));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return (
    Object.keys(value).sort(compareCommunitiesRoleSplitUtf8Bytes).join('\0') ===
    [...keys].sort(compareCommunitiesRoleSplitUtf8Bytes).join('\0')
  );
}

/** Runtime semantics paired with the published JSON Schema. */
export function assertCommunitiesRoleSplitInputC(
  value: unknown,
): asserts value is CommunitiesRoleSplitInputC {
  if (!isRecord(value)) throw new Error('INPUT_C_SCHEMA_INVALID');
  if (
    !exactKeys(value, [
      'schemaVersion',
      'canonicalizationVersion',
      'sortVersion',
      'provenance',
      'normalized',
      'anomalies',
      'forbiddenCodeContract',
      'manifestSha256',
      'authorizes',
    ]) ||
    value.schemaVersion !== COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION ||
    value.canonicalizationVersion !== COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION ||
    value.sortVersion !== COMMUNITIES_ROLE_SPLIT_SORT_VERSION ||
    !isRecord(value.normalized) ||
    !exactKeys(value.normalized, COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) ||
    !isRecord(value.provenance) ||
    !Array.isArray(value.anomalies) ||
    !Array.isArray(value.forbiddenCodeContract) ||
    !isRecord(value.authorizes) ||
    !sha256Pattern.test(String(value.manifestSha256))
  )
    throw new Error('INPUT_C_SCHEMA_INVALID');
  const provenance = value.provenance;
  if (
    !exactKeys(provenance, [
      'contractVersion',
      'markerDigest',
      'markerEvidenceDigest',
      'requestDigest',
      'cloneNamePatternValid',
      'cloneOidBound',
      'sourceOidBound',
      'systemIdentifierDigest',
      'pgMajor',
      'objectManifestDigest',
      'ledgerDigest',
      'ledgerCount',
      'mappingObservationState',
      'mappingDigest',
    ]) ||
    provenance.contractVersion !== 'communities-role-split-clone-marker-evidence-v1' ||
    provenance.cloneNamePatternValid !== true ||
    provenance.cloneOidBound !== true ||
    provenance.sourceOidBound !== true ||
    provenance.pgMajor !== 16 ||
    !Number.isSafeInteger(provenance.ledgerCount) ||
    Number(provenance.ledgerCount) < 0 ||
    !['OBSERVED', 'UNKNOWN'].includes(String(provenance.mappingObservationState)) ||
    (provenance.mappingObservationState === 'OBSERVED') !==
      sha256Pattern.test(String(provenance.mappingDigest))
  )
    throw new Error('INPUT_C_SCHEMA_INVALID');
  for (const digest of [
    provenance.markerDigest,
    provenance.markerEvidenceDigest,
    provenance.requestDigest,
    provenance.systemIdentifierDigest,
    provenance.objectManifestDigest,
    provenance.ledgerDigest,
  ])
    if (!sha256Pattern.test(String(digest))) throw new Error('INPUT_C_SCHEMA_INVALID');
  if (
    JSON.stringify(value.forbiddenCodeContract) !==
      JSON.stringify(COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT) ||
    Object.values(value.authorizes).length !== 9 ||
    Object.values(value.authorizes).some((item) => item !== false)
  )
    throw new Error('INPUT_C_SCHEMA_INVALID');
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES) {
    const records = value.normalized[category];
    if (!Array.isArray(records)) throw new Error('INPUT_C_SCHEMA_INVALID');
    let previous = '';
    const seen = new Set<string>();
    for (const candidate of records) {
      if (
        !isRecord(candidate) ||
        !exactKeys(candidate, [
          'objectKeySha256',
          'fieldKeySha256',
          'fieldKind',
          'observationState',
          'valueSha256',
          'provenanceSha256',
        ]) ||
        !sha256Pattern.test(String(candidate.objectKeySha256)) ||
        !sha256Pattern.test(String(candidate.fieldKeySha256)) ||
        !COMMUNITIES_ROLE_SPLIT_FIELD_KINDS.includes(candidate.fieldKind as never)
      )
        throw new Error('INPUT_C_SCHEMA_INVALID');
      const observed = candidate.observationState === 'OBSERVED';
      if (
        (!observed && !['UNKNOWN', 'UNOBSERVED'].includes(String(candidate.observationState))) ||
        (observed &&
          (!sha256Pattern.test(String(candidate.valueSha256)) ||
            !sha256Pattern.test(String(candidate.provenanceSha256)))) ||
        (!observed && (candidate.valueSha256 !== null || candidate.provenanceSha256 !== null))
      )
        throw new Error('INPUT_C_SCHEMA_INVALID');
      const key = `${String(candidate.objectKeySha256)}|${String(candidate.fieldKeySha256)}`;
      if (seen.has(key) || (previous && compareCommunitiesRoleSplitUtf8Bytes(previous, key) >= 0))
        throw new Error('INPUT_C_SCHEMA_INVALID');
      seen.add(key);
      previous = key;
    }
  }
  for (const candidate of value.anomalies) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ['code', 'count', 'evidenceSha256']) ||
      !/^[A-Z][A-Z0-9_]{2,127}$/u.test(String(candidate.code)) ||
      !Number.isSafeInteger(candidate.count) ||
      Number(candidate.count) < 1 ||
      !sha256Pattern.test(String(candidate.evidenceSha256))
    )
      throw new Error('INPUT_C_SCHEMA_INVALID');
  }
  if (
    communitiesRoleSplitInputCManifestSha256(value as CommunitiesRoleSplitInputC) !==
    value.manifestSha256
  )
    throw new Error('INPUT_C_MANIFEST_INVALID');
}
