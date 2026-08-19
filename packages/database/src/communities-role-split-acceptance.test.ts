import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  assertCommunitiesRoleSplitAcceptancePass,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCManifestSha256,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitAcceptanceError,
  type CommunitiesRoleSplitExpectedPins,
  type CommunitiesRoleSplitGrantObjectKind,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitObjectKind,
} from './communities-role-split-acceptance.js';
import {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  type CommunitiesRoleSplitFieldKind,
  type CommunitiesRoleSplitNormalizedRecord,
} from './communities-role-split-input-c.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer I)[]
    ? Mutable<I>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const objectCategory = {
  database: 'databaseAcl',
  schema: 'schemas',
  relation: 'relations',
  sequence: 'sequences',
  function: 'functions',
  type: 'types',
  extension: 'extensions',
} as const;

function record(
  object: string,
  field: string,
  kind: CommunitiesRoleSplitFieldKind,
  value: string,
): CommunitiesRoleSplitNormalizedRecord {
  return {
    objectKeySha256: digest(`object:${object}`),
    fieldKeySha256: digest(`field:${object}:${field}`),
    fieldKind: kind,
    observationState: 'OBSERVED',
    valueSha256: value,
    provenanceSha256: digest(`evidence:${object}:${field}`),
  };
}

function mapping(): CommunitiesRoleSplitAcceptanceEnvelope['mapping'] {
  const observedDigest = (value: string) => ({
    observationState: 'OBSERVED' as const,
    valueSha256: digest(value),
    provenanceSha256: digest(`evidence:${value}`),
  });
  const observedBoolean = (value: string, state: boolean) => ({
    observationState: 'OBSERVED' as const,
    value: state,
    provenanceSha256: digest(`evidence:${value}`),
  });
  const roles = Object.fromEntries(
    COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => [
      category,
      {
        category,
        roleName: observedDigest(`name:${category}`),
        roleOid: observedDigest(`oid:${category}`),
        canLogin: observedBoolean(`login:${category}`, true),
        superuser: observedBoolean(`super:${category}`, false),
        bypassRls: observedBoolean(`bypass:${category}`, false),
        createDatabase: observedBoolean(`createdb:${category}`, false),
        createRole: observedBoolean(`createrole:${category}`, false),
        replication: observedBoolean(`replication:${category}`, false),
      },
    ]),
  ) as unknown as Omit<
    CommunitiesRoleSplitAcceptanceEnvelope['mapping'],
    'identityRelations' | 'mappingDigest'
  >;
  return {
    ...roles,
    mappingDigest: digest('mapping'),
    identityRelations: COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.map(
      ([left, right, requirement]) => ({
        left,
        right,
        requirement,
        relation: 'DISTINCT',
        provenanceSha256: digest(`relation:${left}:${right}`),
      }),
    ),
  };
}

function snapshot(
  roleMapping: CommunitiesRoleSplitAcceptanceEnvelope['mapping'],
): CommunitiesRoleSplitInputC {
  const owner = roleMapping.SHARED_OWNER.roleName.valueSha256!;
  const normalized: Mutable<CommunitiesRoleSplitInputC['normalized']> = {
    roles: [record('role', 'metadata', 'ROLE', digest('role-state'))],
    memberships: [],
    databaseAcl: [],
    schemas: [],
    defaultAcls: [],
    relations: [],
    columnAcls: [
      record('relation', 'column-null', 'COLUMN', digest('null-column-acl-observation')),
    ],
    rlsPolicies: [record('relation', 'rls', 'RLS', digest('rls-preserved'))],
    sequences: [],
    functions: [],
    types: [],
    extensions: [],
  };
  for (const kind of Object.keys(objectCategory) as CommunitiesRoleSplitObjectKind[]) {
    const category = objectCategory[kind];
    normalized[category].push(record(kind, 'owner', 'OWNER', owner));
    if (kind === 'extension')
      normalized[category].push(record(kind, 'metadata', 'METADATA', digest('extension-metadata')));
    else {
      normalized[category].push(
        record(kind, 'acl-explicit', 'ACL_EXPLICIT', digest(`${kind}:acl-explicit`)),
      );
      normalized[category].push(
        record(kind, 'acl-effective', 'ACL_EFFECTIVE', digest(`${kind}:acl-effective`)),
      );
    }
    normalized[category].sort((a, b) =>
      `${a.objectKeySha256}|${a.fieldKeySha256}`.localeCompare(
        `${b.objectKeySha256}|${b.fieldKeySha256}`,
      ),
    );
  }
  const draft: CommunitiesRoleSplitInputC = {
    schemaVersion: COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
    canonicalizationVersion: COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
    sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
    provenance: {
      contractVersion: 'communities-role-split-clone-marker-evidence-v1',
      markerDigest: digest('marker'),
      markerEvidenceDigest: digest('marker-evidence'),
      requestDigest: digest('request'),
      cloneNamePatternValid: true,
      cloneOidBound: true,
      sourceOidBound: true,
      systemIdentifierDigest: digest('system'),
      pgMajor: 16,
      objectManifestDigest: digest('object-manifest'),
      ledgerDigest: digest('ledger'),
      ledgerCount: 34,
      mappingObservationState: 'OBSERVED',
      mappingDigest: digest('mapping'),
    },
    normalized,
    anomalies: [],
    forbiddenCodeContract: COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
    manifestSha256: digest('pending'),
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
  };
  return { ...draft, manifestSha256: communitiesRoleSplitInputCManifestSha256(draft) };
}

function fixture(): {
  envelope: Mutable<CommunitiesRoleSplitAcceptanceEnvelope>;
  pins: Mutable<CommunitiesRoleSplitExpectedPins>;
} {
  const roleMapping = mapping(),
    before = snapshot(roleMapping),
    after = structuredClone(before);
  const ownershipPlan = (Object.keys(objectCategory) as CommunitiesRoleSplitObjectKind[]).map(
    (objectKind) => {
      const owner = before.normalized[objectCategory[objectKind]].find(
        (item) => item.fieldKind === 'OWNER',
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
        ruleSha256: digest(`owner-rule:${objectKind}`),
      };
    },
  );
  const grantPlan = (
    Object.keys(objectCategory).filter(
      (kind) => kind !== 'extension',
    ) as CommunitiesRoleSplitGrantObjectKind[]
  ).flatMap((objectKind) =>
    before.normalized[objectCategory[objectKind]]
      .filter((item) => item.fieldKind === 'ACL_EXPLICIT' || item.fieldKind === 'ACL_EFFECTIVE')
      .map((item) => ({
        objectKind,
        objectKeySha256: item.objectKeySha256,
        fieldKeySha256: item.fieldKeySha256,
        action: 'PRESERVE' as const,
        granteeCategory: 'FUTURE_RUNTIME' as const,
        privileges: [],
        beforeStateSha256: item.valueSha256!,
        targetStateSha256: item.valueSha256!,
        evidenceSha256: item.provenanceSha256!,
        grantOption: false as const,
        ruleSha256: digest(`grant-rule:${objectKind}:${item.fieldKeySha256}`),
      })),
  );
  const envelope: CommunitiesRoleSplitAcceptanceEnvelope = {
    contractVersion: COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
    observedBefore: before,
    observedAfter: after,
    mapping: roleMapping,
    ownershipPlan,
    grantPlan,
    comparison: {
      sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
      beforeManifestSha256: before.manifestSha256,
      afterManifestSha256: after.manifestSha256,
      changedCount: 0,
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
  const pins: CommunitiesRoleSplitExpectedPins = {
    beforeArtifactSha256: communitiesRoleSplitInputCArtifactSha256(before),
    afterArtifactSha256: communitiesRoleSplitInputCArtifactSha256(after),
    beforeManifestSha256: before.manifestSha256,
    afterManifestSha256: after.manifestSha256,
    mappingDigest: before.provenance.mappingDigest!,
    markerDigest: before.provenance.markerDigest,
    markerEvidenceDigest: before.provenance.markerEvidenceDigest,
    requestDigest: before.provenance.requestDigest,
    objectManifestDigest: before.provenance.objectManifestDigest,
    ledgerDigest: before.provenance.ledgerDigest,
  };
  return {
    envelope: envelope as unknown as Mutable<CommunitiesRoleSplitAcceptanceEnvelope>,
    pins,
  };
}

function expectCode(run: () => unknown, suffix: string): void {
  expect(run).toThrowError(
    expect.objectContaining({
      code: `COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_${suffix}`,
    }) as CommunitiesRoleSplitAcceptanceError,
  );
}
function repinAfter(target: ReturnType<typeof fixture>): void {
  target.envelope.observedAfter.manifestSha256 = communitiesRoleSplitInputCManifestSha256(
    target.envelope.observedAfter,
  );
  target.pins.afterManifestSha256 = target.envelope.observedAfter.manifestSha256;
  target.pins.afterArtifactSha256 = communitiesRoleSplitInputCArtifactSha256(
    target.envelope.observedAfter,
  );
  target.envelope.comparison.afterManifestSha256 = target.envelope.observedAfter.manifestSha256;
}

describe('Communities role-split acceptance evaluator', () => {
  it('accepts only two independently pinned full INPUT_C snapshots', () => {
    const target = fixture();
    expect(assertCommunitiesRoleSplitAcceptancePass(target.envelope, target.pins)).toEqual(
      target.envelope.comparison,
    );
  });

  it('accepts an exact per-object/per-field ACL delta observed in the after snapshot', () => {
    const target = fixture();
    const grant = target.envelope.grantPlan.find(
      (item) => item.objectKind === 'relation' && item.action === 'PRESERVE',
    )!;
    const after = target.envelope.observedAfter.normalized.relations.find(
      (item) => item.fieldKeySha256 === grant.fieldKeySha256,
    )!;
    after.valueSha256 = digest('observed-after-select');
    grant.action = 'ADD';
    grant.privileges = ['SELECT'];
    grant.targetStateSha256 = after.valueSha256;
    target.envelope.comparison.changedCount = 1;
    repinAfter(target);
    expect(
      assertCommunitiesRoleSplitAcceptancePass(target.envelope, target.pins).changedCount,
    ).toBe(1);
  });

  it('rejects a forged self-signed snapshot when independent pins stay unchanged', () => {
    const target = fixture();
    target.envelope.observedBefore.normalized.roles[0]!.valueSha256 = digest('forged');
    target.envelope.observedBefore.manifestSha256 = communitiesRoleSplitInputCManifestSha256(
      target.envelope.observedBefore,
    );
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(target.envelope, target.pins),
      'INPUT_C_ARTIFACT_PIN_INVALID',
    );
  });

  it('preserves roles, memberships, default/column ACLs, RLS and extensions from full snapshots', () => {
    for (const [category, code] of [
      ['roles', 'ROLE_CAPABILITY_FORBIDDEN'],
      ['memberships', 'ROLE_MEMBERSHIP_FORBIDDEN'],
      ['defaultAcls', 'DEFAULT_ACL_CHANGE_FORBIDDEN'],
      ['columnAcls', 'COLUMN_GRANT_FORBIDDEN'],
      ['rlsPolicies', 'RLS_POLICY_CHANGE_FORBIDDEN'],
      ['extensions', 'EXTENSION_CHANGE_FORBIDDEN'],
    ] as const) {
      const target = fixture();
      const records = target.envelope.observedAfter.normalized[category];
      if (records.length === 0)
        records.push(
          record(
            category,
            'field',
            category === 'memberships'
              ? 'MEMBERSHIP'
              : category === 'defaultAcls'
                ? 'DEFAULT_ACL'
                : 'METADATA',
            digest('after'),
          ),
        );
      else {
        const target =
          category === 'extensions'
            ? records.find((item) => item.fieldKind === 'METADATA')!
            : records[0]!;
        target.valueSha256 = digest(`after:${category}`);
      }
      repinAfter(target);
      expectCode(
        () => assertCommunitiesRoleSplitAcceptancePass(target.envelope, target.pins),
        records.length > target.envelope.observedBefore.normalized[category].length
          ? 'OUT_OF_MANIFEST_CHANGE_FORBIDDEN'
          : code,
      );
    }
  });

  it('does not infer a forbidden column grant from a null column ACL observation', () => {
    const target = fixture();
    expect(target.envelope.observedBefore.normalized.columnAcls).toHaveLength(1);
    expect(
      assertCommunitiesRoleSplitAcceptancePass(target.envelope, target.pins).changedCount,
    ).toBe(0);
  });

  it('inherits ownership and CREATE prohibitions through SAME equivalence classes', () => {
    const ownerAlias = fixture();
    ownerAlias.envelope.mapping.FUTURE_RUNTIME.roleName = structuredClone(
      ownerAlias.envelope.mapping.SHARED_OWNER.roleName,
    );
    ownerAlias.envelope.mapping.FUTURE_RUNTIME.roleOid = structuredClone(
      ownerAlias.envelope.mapping.SHARED_OWNER.roleOid,
    );
    const relation = ownerAlias.envelope.mapping.identityRelations.find(
      (item) => item.left === 'SHARED_OWNER' && item.right === 'FUTURE_RUNTIME',
    )!;
    relation.relation = 'SAME';
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(ownerAlias.envelope, ownerAlias.pins),
      'OWNERSHIP_PREIMAGE_FORBIDDEN',
    );

    const createAlias = fixture();
    createAlias.envelope.mapping.RESTORE_OWNER.roleName = structuredClone(
      createAlias.envelope.mapping.FUTURE_RUNTIME.roleName,
    );
    createAlias.envelope.mapping.RESTORE_OWNER.roleOid = structuredClone(
      createAlias.envelope.mapping.FUTURE_RUNTIME.roleOid,
    );
    const same = createAlias.envelope.mapping.identityRelations.find(
      (item) => item.left === 'RESTORE_OWNER' && item.right === 'FUTURE_RUNTIME',
    )!;
    same.relation = 'SAME';
    const schema = createAlias.envelope.grantPlan.find((item) => item.objectKind === 'schema')!;
    const after = createAlias.envelope.observedAfter.normalized.schemas.find(
      (item) => item.fieldKeySha256 === schema.fieldKeySha256,
    )!;
    after.valueSha256 = digest('create-after');
    schema.action = 'ADD';
    schema.granteeCategory = 'RESTORE_OWNER';
    schema.privileges = ['CREATE'];
    schema.targetStateSha256 = after.valueSha256;
    createAlias.envelope.comparison.changedCount = 1;
    repinAfter(createAlias);
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(createAlias.envelope, createAlias.pins),
      'RUNTIME_CREATE_FORBIDDEN',
    );
  });

  it('rejects missing mapping pins, mixed-owner evidence and partial grant plans', () => {
    const mappingPin = fixture();
    mappingPin.pins.mappingDigest = digest('wrong');
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(mappingPin.envelope, mappingPin.pins),
      'INPUT_C_BINDING_INVALID',
    );
    const mixed = fixture();
    mixed.envelope.observedBefore.normalized.relations.push({
      ...mixed.envelope.observedBefore.normalized.relations.find(
        (item) => item.fieldKind === 'OWNER',
      )!,
      fieldKeySha256: digest('second-owner'),
    });
    mixed.envelope.observedBefore.normalized.relations.sort((a, b) =>
      `${a.objectKeySha256}|${a.fieldKeySha256}`.localeCompare(
        `${b.objectKeySha256}|${b.fieldKeySha256}`,
      ),
    );
    mixed.envelope.observedBefore.manifestSha256 = communitiesRoleSplitInputCManifestSha256(
      mixed.envelope.observedBefore,
    );
    mixed.pins.beforeManifestSha256 = mixed.envelope.observedBefore.manifestSha256;
    mixed.pins.beforeArtifactSha256 = communitiesRoleSplitInputCArtifactSha256(
      mixed.envelope.observedBefore,
    );
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(mixed.envelope, mixed.pins),
      'MIXED_OWNER_FORBIDDEN',
    );
    const partial = fixture();
    partial.envelope.grantPlan.pop();
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(partial.envelope, partial.pins),
      'GRANT_PLAN_SET_INVALID',
    );
  });

  it('rejects wildcard/ALL/PUBLIC/grant option/third-party and out-of-snapshot plan claims', () => {
    for (const privilege of ['*', 'ALL']) {
      const target = fixture();
      target.envelope.grantPlan[0]!.privileges = [privilege as never];
      expectCode(
        () => assertCommunitiesRoleSplitAcceptancePass(target.envelope, target.pins),
        'GRANT_PRIVILEGE_SET_INVALID',
      );
    }
    const publicGrant = fixture();
    publicGrant.envelope.grantPlan[0]!.granteeCategory = 'PUBLIC' as never;
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(publicGrant.envelope, publicGrant.pins),
      'GRANT_PLAN_INVALID',
    );
    const option = fixture();
    option.envelope.grantPlan[0]!.grantOption = true as false;
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(option.envelope, option.pins),
      'GRANT_PLAN_INVALID',
    );
    const fake = fixture();
    fake.envelope.grantPlan[0]!.objectKeySha256 = digest('outside');
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(fake.envelope, fake.pins),
      'GRANT_PLAN_SET_INVALID',
    );
  });
});
