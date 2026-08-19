import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
  assertCommunitiesRoleSplitAcceptancePass,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitExpectedPins,
  type CommunitiesRoleSplitGrantDecision,
  type CommunitiesRoleSplitGrantObjectKind,
  type CommunitiesRoleSplitObjectKind,
} from './communities-role-split-acceptance.js';
import {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  communitiesRoleSplitCanonicalJson,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCManifestSha256,
  communitiesRoleSplitMappingSha256,
  type CommunitiesRoleSplitAclEntry,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitMappingArtifact,
  type CommunitiesRoleSplitNormalizedCategory,
  type CommunitiesRoleSplitNormalizedRecord,
  type CommunitiesRoleSplitRoleCategory,
} from './communities-role-split-input-c.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const fixed = (value: string): string => sha(`fixed:${value}`);

function mapping(aliasRuntimeToShared = false): CommunitiesRoleSplitMappingArtifact {
  const categories = COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => {
    const identity =
      aliasRuntimeToShared && category === 'FUTURE_RUNTIME' ? 'SHARED_OWNER' : category;
    return {
      category,
      roleNameSha256: sha(`role:${identity}`),
      roleOidSha256: fixed(`oid:${identity}`),
      capabilities: {
        canLogin: true,
        superuser: false,
        bypassRls: false,
        createDatabase: false,
        createRole: false,
        replication: false,
      },
      evidenceSha256: fixed(`mapping:${category}:${identity}`),
    };
  });
  const identityRelations = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.map(
    ([left, right, requirement]) => {
      const a = categories.find((entry) => entry.category === left)!;
      const b = categories.find((entry) => entry.category === right)!;
      const relation =
        a.roleNameSha256 === b.roleNameSha256 && a.roleOidSha256 === b.roleOidSha256
          ? ('SAME' as const)
          : ('DISTINCT' as const);
      return {
        left,
        right,
        requirement,
        relation,
        evidenceSha256: fixed(`relation:${left}:${right}:${relation}`),
      };
    },
  );
  const draft = {
    schemaVersion: COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION,
    categories,
    identityRelations,
  } satisfies Omit<CommunitiesRoleSplitMappingArtifact, 'mappingDigest'>;
  return { ...draft, mappingDigest: communitiesRoleSplitMappingSha256(draft) };
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
type AclState = Partial<Record<string, readonly CommunitiesRoleSplitAclEntry[]>>;
const aclKey = (kind: CommunitiesRoleSplitGrantObjectKind, field: string): string =>
  `${kind}:${field}`;
const sortedEntries = (
  entries: readonly CommunitiesRoleSplitAclEntry[],
): readonly CommunitiesRoleSplitAclEntry[] =>
  [...entries].sort((a, b) =>
    communitiesRoleSplitCanonicalJson(a).localeCompare(communitiesRoleSplitCanonicalJson(b)),
  );

function record(
  category: CommunitiesRoleSplitNormalizedCategory,
  object: string,
  field: string,
  fieldKind: CommunitiesRoleSplitNormalizedRecord['fieldKind'],
  value: string,
  semantic: CommunitiesRoleSplitNormalizedRecord['semantic'],
): CommunitiesRoleSplitNormalizedRecord {
  return {
    objectKeySha256: fixed(`object:${category}:${object}`),
    fieldKeySha256: fixed(`field:${category}:${object}:${field}`),
    fieldKind,
    observationState: 'OBSERVED',
    valueSha256: sha(value),
    provenanceSha256: fixed(`provenance:${category}:${object}:${field}`),
    semantic,
  };
}

function snapshot(
  roleMapping: CommunitiesRoleSplitMappingArtifact,
  acl: AclState = {},
): CommunitiesRoleSplitInputC {
  const normalized = Object.fromEntries(
    COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES.map((category) => [category, []]),
  ) as unknown as Record<
    CommunitiesRoleSplitNormalizedCategory,
    CommunitiesRoleSplitNormalizedRecord[]
  >;
  for (const kind of Object.keys(objectCategoryByKind) as CommunitiesRoleSplitObjectKind[]) {
    const category = objectCategoryByKind[kind];
    normalized[category].push(
      record(category, kind, 'owner', 'OWNER', 'role:SHARED_OWNER', {
        ownerCategory: 'SHARED_OWNER',
      }),
    );
    if (kind !== 'extension')
      for (const [field, fieldKind] of [
        ['explicitAcl', 'ACL_EXPLICIT'],
        ['effectiveAcl', 'ACL_EFFECTIVE'],
      ] as const) {
        const entries = sortedEntries(acl[aclKey(kind, field)] ?? []);
        normalized[category].push(
          record(category, kind, field, fieldKind, communitiesRoleSplitCanonicalJson(entries), {
            entries,
          }),
        );
      }
  }
  for (const category of ['roles', 'memberships', 'defaultAcls', 'rlsPolicies'] as const) {
    const kind =
      category === 'roles'
        ? 'ROLE'
        : category === 'memberships'
          ? 'MEMBERSHIP'
          : category === 'defaultAcls'
            ? 'DEFAULT_ACL'
            : 'RLS';
    normalized[category].push(record(category, category, 'metadata', kind, 'unchanged', null));
  }
  const empty: readonly CommunitiesRoleSplitAclEntry[] = [];
  normalized.columnAcls.push(
    record(
      'columnAcls',
      'quoted.table|column',
      'explicitAcl',
      'ACL_EXPLICIT',
      communitiesRoleSplitCanonicalJson(empty),
      { entries: empty },
    ),
  );
  for (const category of COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES)
    normalized[category].sort((a, b) =>
      `${a.objectKeySha256}|${a.fieldKeySha256}`.localeCompare(
        `${b.objectKeySha256}|${b.fieldKeySha256}`,
      ),
    );
  const draft = {
    schemaVersion: COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
    canonicalizationVersion: COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
    sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
    provenance: {
      contractVersion: 'communities-role-split-clone-marker-evidence-v2',
      markerDigest: fixed('marker'),
      markerEvidenceDigest: fixed('marker-evidence'),
      requestDigest: fixed('request'),
      creationReceiptSha256: fixed('creation-receipt'),
      cloneNamePatternValid: true,
      cloneOidBound: true,
      sourceOidBound: true,
      systemIdentifierDigest: fixed('system'),
      pgMajor: 16,
      objectManifestDigest: fixed('object-manifest'),
      ledgerDigest: fixed('ledger'),
      ledgerCount: 1,
      mappingDigest: roleMapping.mappingDigest,
    },
    mapping: roleMapping,
    normalized,
    anomalies: [],
    forbiddenCodeContract: COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
    manifestSha256: '0'.repeat(64),
    authorizes: {
      roleCreation: false,
      roleRepair: false,
      roleSplit: false,
      aclMutation: false,
      schemaMutation: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  } satisfies CommunitiesRoleSplitInputC;
  return { ...draft, manifestSha256: communitiesRoleSplitInputCManifestSha256(draft) };
}

function pins(
  before: CommunitiesRoleSplitInputC,
  after: CommunitiesRoleSplitInputC,
): CommunitiesRoleSplitExpectedPins {
  return {
    beforeArtifactSha256: communitiesRoleSplitInputCArtifactSha256(before),
    afterArtifactSha256: communitiesRoleSplitInputCArtifactSha256(after),
    beforeManifestSha256: before.manifestSha256,
    afterManifestSha256: after.manifestSha256,
    expectedMappingDigest: before.mapping.mappingDigest,
    markerDigest: before.provenance.markerDigest,
    markerEvidenceDigest: before.provenance.markerEvidenceDigest,
    requestDigest: before.provenance.requestDigest,
    creationReceiptSha256: before.provenance.creationReceiptSha256,
    objectManifestDigest: before.provenance.objectManifestDigest,
    ledgerDigest: before.provenance.ledgerDigest,
  };
}
function semanticEntries(
  value: CommunitiesRoleSplitNormalizedRecord,
): readonly CommunitiesRoleSplitAclEntry[] {
  if (!value.semantic || !('entries' in value.semantic)) throw new Error('fixture invalid');
  return value.semantic.entries;
}

function envelope(
  before: CommunitiesRoleSplitInputC,
  after: CommunitiesRoleSplitInputC,
): CommunitiesRoleSplitAcceptanceEnvelope {
  const ownershipPlan = (Object.keys(objectCategoryByKind) as CommunitiesRoleSplitObjectKind[]).map(
    (objectKind) => {
      const owner = before.normalized[objectCategoryByKind[objectKind]].find(
        (entry) => entry.fieldKind === 'OWNER',
      )!;
      return {
        objectKind,
        objectKeySha256: owner.objectKeySha256,
        ownerFieldKeySha256: owner.fieldKeySha256,
        beforeOwnerCategory: 'SHARED_OWNER' as const,
        targetOwnerCategory: 'PRESERVE_CURRENT' as const,
        beforeOwnerValueSha256: owner.valueSha256!,
        afterOwnerValueSha256: owner.valueSha256!,
        ownerEvidenceSha256: owner.provenanceSha256!,
      };
    },
  );
  const grantPlan: CommunitiesRoleSplitGrantDecision[] = [];
  let changedCount = 0;
  for (const objectKind of [
    'database',
    'schema',
    'relation',
    'sequence',
    'function',
    'type',
  ] as const) {
    const category = objectCategoryByKind[objectKind];
    for (const leftRecord of before.normalized[category].filter(
      (entry) => entry.fieldKind === 'ACL_EXPLICIT' || entry.fieldKind === 'ACL_EFFECTIVE',
    )) {
      const rightRecord = after.normalized[category].find(
        (entry) => entry.fieldKeySha256 === leftRecord.fieldKeySha256,
      )!;
      const left = new Map(
        semanticEntries(leftRecord).map((entry) => [
          communitiesRoleSplitCanonicalJson(entry),
          entry,
        ]),
      );
      const right = new Map(
        semanticEntries(rightRecord).map((entry) => [
          communitiesRoleSplitCanonicalJson(entry),
          entry,
        ]),
      );
      const added = [...right].filter(([key]) => !left.has(key)).map(([, entry]) => entry);
      const removed = [...left].filter(([key]) => !right.has(key)).map(([, entry]) => entry);
      const common = {
        objectKind,
        objectKeySha256: leftRecord.objectKeySha256,
        fieldKeySha256: leftRecord.fieldKeySha256,
        beforeStateSha256: leftRecord.valueSha256!,
        targetStateSha256: rightRecord.valueSha256!,
        evidenceSha256: leftRecord.provenanceSha256!,
        grantOption: false as const,
      };
      if (added.length === 0 && removed.length === 0)
        grantPlan.push({
          ...common,
          action: 'PRESERVE',
          granteeCategory: 'FUTURE_RUNTIME',
          granteeEvidenceSha256: null,
          grantorCategory: null,
          grantorEvidenceSha256: null,
          occurrenceSha256: null,
          privileges: [],
        });
      else {
        changedCount++;
        for (const [action, entries] of [
          ['ADD', added],
          ['REMOVE', removed],
        ] as const)
          for (const entry of entries)
            grantPlan.push({
              ...common,
              action,
              granteeCategory: entry.granteeCategory as CommunitiesRoleSplitRoleCategory,
              granteeEvidenceSha256: entry.granteeEvidenceSha256,
              grantorCategory: entry.grantorCategory,
              grantorEvidenceSha256: entry.grantorEvidenceSha256,
              occurrenceSha256: entry.occurrenceSha256,
              privileges: [
                entry.privilege as CommunitiesRoleSplitGrantDecision['privileges'][number],
              ],
            });
      }
    }
  }
  return {
    contractVersion: COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
    observedBefore: before,
    observedAfter: after,
    ownershipPlan,
    grantPlan,
    comparison: {
      sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
      beforeManifestSha256: before.manifestSha256,
      afterManifestSha256: after.manifestSha256,
      changedCount,
      addedCount: 0,
      removedCount: 0,
      forbiddenTransitionCodes: [],
    },
    decision: {
      status: 'PASS',
      blockerCodes: [],
      authorizesRoleCreation: false,
      authorizesRoleAlteration: false,
      authorizesAclMutation: false,
      authorizesMigration: false,
      authorizesDeploy: false,
      authorizesRuntimeActivation: false,
    },
  };
}

describe('communities role split acceptance', () => {
  const aclEntry = (
    privilege: string,
    grantorEvidence: string,
    occurrence = 1,
  ): CommunitiesRoleSplitAclEntry => ({
    granteeCategory: 'FUTURE_RUNTIME',
    granteeEvidenceSha256: fixed('principal:runtime'),
    grantorCategory: 'FUTURE_MIGRATOR',
    grantorEvidenceSha256: fixed(`grantor:${grantorEvidence}`),
    privilege,
    grantOption: false,
    occurrenceSha256: fixed(`occurrence:${privilege}:${grantorEvidence}:${occurrence}`),
  });
  const select = aclEntry('SELECT', 'migrator');
  const update = aclEntry('UPDATE', 'migrator');

  it('accepts exact semantic ADD and REMOVE against stable ACL field identities', () => {
    const roleMapping = mapping();
    const before = snapshot(roleMapping, {
      [aclKey('sequence', 'explicitAcl')]: [update],
      [aclKey('sequence', 'effectiveAcl')]: [update],
    });
    const after = snapshot(roleMapping, {
      [aclKey('relation', 'explicitAcl')]: [select],
      [aclKey('relation', 'effectiveAcl')]: [select],
    });
    const candidate = envelope(before, after);
    expect(assertCommunitiesRoleSplitAcceptancePass(candidate, pins(before, after))).toEqual(
      candidate.comparison,
    );
    expect(
      before.normalized.relations.find((entry) => entry.fieldKind === 'ACL_EXPLICIT')!
        .fieldKeySha256,
    ).toBe(
      after.normalized.relations.find((entry) => entry.fieldKind === 'ACL_EXPLICIT')!
        .fieldKeySha256,
    );
  });

  it('rejects UPDATE for an observed SELECT delta and rejects a wrong grantee category', () => {
    const roleMapping = mapping();
    const before = snapshot(roleMapping);
    const after = snapshot(roleMapping, { [aclKey('relation', 'explicitAcl')]: [select] });
    const wrongPrivilege = structuredClone(envelope(before, after));
    (
      wrongPrivilege.grantPlan.find((entry) => entry.action === 'ADD') as unknown as {
        privileges: string[];
      }
    ).privileges = ['UPDATE'];
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(wrongPrivilege, pins(before, after)),
    ).toThrow('GRANT_PLAN_DELTA_MISMATCH');
    const wrongCategory = structuredClone(envelope(before, after));
    (
      wrongCategory.grantPlan.find((entry) => entry.action === 'ADD') as unknown as {
        granteeCategory: string;
      }
    ).granteeCategory = 'FUTURE_MIGRATOR';
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(wrongCategory, pins(before, after)),
    ).toThrow('GRANT_PLAN_DELTA_MISMATCH');
  });

  it('detects grantor-only transitions and binds duplicate occurrences exactly', () => {
    const roleMapping = mapping();
    const beforeGrantor = snapshot(roleMapping, {
      [aclKey('relation', 'explicitAcl')]: [aclEntry('SELECT', 'grantor-a')],
    });
    const afterGrantor = snapshot(roleMapping, {
      [aclKey('relation', 'explicitAcl')]: [aclEntry('SELECT', 'grantor-b')],
    });
    const missingGrantorPlan = structuredClone(envelope(beforeGrantor, afterGrantor));
    const changedField = beforeGrantor.normalized.relations.find(
      (entry) => entry.fieldKind === 'ACL_EXPLICIT',
    )!;
    (
      missingGrantorPlan as unknown as { grantPlan: CommunitiesRoleSplitGrantDecision[] }
    ).grantPlan = [
      ...missingGrantorPlan.grantPlan.filter(
        (entry) => entry.fieldKeySha256 !== changedField.fieldKeySha256,
      ),
      {
        objectKind: 'relation',
        objectKeySha256: changedField.objectKeySha256,
        fieldKeySha256: changedField.fieldKeySha256,
        action: 'PRESERVE',
        granteeCategory: 'FUTURE_RUNTIME',
        granteeEvidenceSha256: null,
        grantorCategory: null,
        grantorEvidenceSha256: null,
        occurrenceSha256: null,
        privileges: [],
        beforeStateSha256: changedField.valueSha256!,
        targetStateSha256: afterGrantor.normalized.relations.find(
          (entry) => entry.fieldKeySha256 === changedField.fieldKeySha256,
        )!.valueSha256!,
        evidenceSha256: changedField.provenanceSha256!,
        grantOption: false,
      },
    ];
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(
        missingGrantorPlan,
        pins(beforeGrantor, afterGrantor),
      ),
    ).toThrow('GRANT_PLAN_DELTA_MISMATCH');

    const first = aclEntry('SELECT', 'grantor-a', 1);
    const second = aclEntry('SELECT', 'grantor-a', 2);
    const beforeDuplicate = snapshot(roleMapping, {
      [aclKey('relation', 'explicitAcl')]: [first, second],
    });
    const afterDuplicate = snapshot(roleMapping, {
      [aclKey('relation', 'explicitAcl')]: [first],
    });
    const wrongOccurrence = structuredClone(envelope(beforeDuplicate, afterDuplicate));
    const remove = wrongOccurrence.grantPlan.find((entry) => entry.action === 'REMOVE')!;
    (remove as { occurrenceSha256: string }).occurrenceSha256 = first.occurrenceSha256;
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(
        wrongOccurrence,
        pins(beforeDuplicate, afterDuplicate),
      ),
    ).toThrow('GRANT_PLAN_DELTA_MISMATCH');
  });

  it('rejects a forged mapping even when the candidate recomputes its self digest', () => {
    const original = mapping();
    const forged = structuredClone(original);
    const runtime = forged.categories.find((entry) => entry.category === 'FUTURE_RUNTIME')!;
    (runtime.capabilities as { superuser: boolean }).superuser = true;
    (forged as { mappingDigest: string }).mappingDigest = communitiesRoleSplitMappingSha256(forged);
    const before = snapshot(forged),
      after = snapshot(forged),
      expected = pins(before, after);
    (expected as { expectedMappingDigest: string }).expectedMappingDigest = original.mappingDigest;
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(envelope(before, after), expected),
    ).toThrow('MAPPING_DIGEST_INVALID');
    const candidateControlled = {
      ...envelope(snapshot(original), snapshot(original)),
      mapping: original,
    } as unknown as CommunitiesRoleSplitAcceptanceEnvelope;
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(
        candidateControlled,
        pins(candidateControlled.observedBefore, candidateControlled.observedAfter),
      ),
    ).toThrow('CONTRACT_SHAPE_INVALID');
  });

  it('rejects a full-snapshot record addition even when all plan rows are otherwise exact', () => {
    const roleMapping = mapping();
    const before = snapshot(roleMapping);
    const after = structuredClone(before);
    (after.normalized.relations as CommunitiesRoleSplitNormalizedRecord[]).push(
      record('relations', 'unexpected-object', 'metadata', 'METADATA', 'unexpected', null),
    );
    (after.normalized.relations as CommunitiesRoleSplitNormalizedRecord[]).sort((left, right) =>
      `${left.objectKeySha256}|${left.fieldKeySha256}`.localeCompare(
        `${right.objectKeySha256}|${right.fieldKeySha256}`,
      ),
    );
    (after as { manifestSha256: string }).manifestSha256 =
      communitiesRoleSplitInputCManifestSha256(after);
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(envelope(before, after), pins(before, after)),
    ).toThrow('OUT_OF_MANIFEST_CHANGE_FORBIDDEN');
  });

  it('inherits ownership prohibitions through SAME identity equivalence', () => {
    const aliased = mapping(true),
      before = snapshot(aliased),
      after = snapshot(aliased);
    expect(() =>
      assertCommunitiesRoleSplitAcceptancePass(envelope(before, after), pins(before, after)),
    ).toThrow('OWNERSHIP_PREIMAGE_FORBIDDEN');
  });
});
