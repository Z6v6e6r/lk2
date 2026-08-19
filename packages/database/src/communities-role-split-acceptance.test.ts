import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  CommunitiesRoleSplitAcceptanceError,
  assertCommunitiesRoleSplitAcceptancePass,
  communitiesRoleSplitGrantTargetStateSha256,
  communitiesRoleSplitInputCManifestSha256,
  communitiesRoleSplitObjectStateManifestSha256,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitGrantDecision,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitObjectKind,
  type CommunitiesRoleSplitOwnershipDecision,
} from './communities-role-split-acceptance.js';

type DeepMutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T[Key] extends object
      ? DeepMutable<T[Key]>
      : T[Key];
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(key: string) {
  return {
    canonicalKeySha256: digest(`key:${key}`),
    observationState: 'OBSERVED' as const,
    valueSha256: digest(`value:${key}`),
    provenanceSha256: digest(`provenance:${key}`),
  };
}

function inputC(): CommunitiesRoleSplitInputC {
  const draft: CommunitiesRoleSplitInputC = {
    schemaVersion: COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
    canonicalizationVersion: COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
    sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
    manifestSha256: digest('pending'),
    provenance: {
      contractVersion: 'INPUT_C_PRODUCER_V1',
      markerDigest: digest('marker'),
      requestDigest: digest('request'),
      cloneNamePatternValid: true,
      cloneOidBound: true,
      sourceOidBound: true,
      systemIdentifierDigest: digest('system'),
      pgMajor: 16,
      objectManifestDigest: digest('object-manifest'),
      ledgerDigest: digest('ledger'),
      ledgerCount: 34,
    },
    normalized: {
      roles: [record('role')],
      memberships: [],
      databaseAcl: [record('database')],
      schemas: [record('schema')],
      defaultAcls: [],
      relations: [record('relation')],
      columnAcls: [],
      rlsPolicies: [record('rls-policy')],
      sequences: [record('sequence')],
      functions: [record('function')],
      types: [record('type')],
      extensions: [record('extension')],
    },
    anomalies: [],
  };
  return { ...draft, manifestSha256: communitiesRoleSplitInputCManifestSha256(draft) };
}

function mapping(): CommunitiesRoleSplitAcceptanceEnvelope['mapping'] {
  const observedDigest = (key: string) => ({
    observationState: 'OBSERVED' as const,
    valueSha256: digest(key),
    provenanceSha256: digest(`provenance:${key}`),
  });
  const observedBoolean = (key: string, value: boolean) => ({
    observationState: 'OBSERVED' as const,
    value,
    provenanceSha256: digest(`provenance:${key}`),
  });
  const roles = Object.fromEntries(
    COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => [
      category,
      {
        category,
        roleName: observedDigest(`name:${category}`),
        roleOid: observedDigest(`oid:${category}`),
        canLogin: observedBoolean(`login:${category}`, true),
        superuser: observedBoolean(`superuser:${category}`, false),
        bypassRls: observedBoolean(`bypass:${category}`, false),
        createDatabase: observedBoolean(`createdb:${category}`, false),
        createRole: observedBoolean(`createrole:${category}`, false),
        replication: observedBoolean(`replication:${category}`, false),
      },
    ]),
  ) as unknown as Omit<CommunitiesRoleSplitAcceptanceEnvelope['mapping'], 'identityRelations'>;
  return {
    ...roles,
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

const categoryForKind = {
  database: 'databaseAcl',
  schema: 'schemas',
  relation: 'relations',
  sequence: 'sequences',
  function: 'functions',
  type: 'types',
  extension: 'extensions',
} as const;

function objectStateEntries(
  inventory: CommunitiesRoleSplitInputC,
  grants: readonly CommunitiesRoleSplitGrantDecision[] = [],
): [string, string][] {
  const grantByKey = new Map(
    grants.map((grant) => [`${grant.objectKind}|${grant.canonicalKeySha256}`, grant]),
  );
  return (Object.keys(categoryForKind) as CommunitiesRoleSplitObjectKind[])
    .map((kind) => {
      const source = inventory.normalized[categoryForKind[kind]][0]!;
      const key = `${kind}|${source.canonicalKeySha256}`;
      return [key, grantByKey.get(key)?.targetStateSha256 ?? source.valueSha256!] as [
        string,
        string,
      ];
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

function envelope(): DeepMutable<CommunitiesRoleSplitAcceptanceEnvelope> {
  const inventory = inputC();
  const kinds = Object.keys(categoryForKind) as CommunitiesRoleSplitObjectKind[];
  const ownershipPlan = kinds.map((objectKind) => {
    const source = inventory.normalized[categoryForKind[objectKind]][0]!;
    return {
      objectKind,
      canonicalKeySha256: source.canonicalKeySha256,
      beforeOwnerCategory: 'SHARED_OWNER',
      targetOwnerCategory: 'PRESERVE_CURRENT',
      ruleSha256: digest(`owner-rule:${objectKind}`),
      provenanceSha256: digest(`owner-provenance:${objectKind}`),
    } satisfies CommunitiesRoleSplitOwnershipDecision;
  });
  const ownershipByKind = new Map(ownershipPlan.map((row) => [row.objectKind, row]));
  const grantPlan = kinds
    .filter((kind) => kind !== 'extension')
    .map((objectKind) => {
      const source = inventory.normalized[categoryForKind[objectKind]][0]!;
      const withoutTarget = {
        objectKind,
        canonicalKeySha256: source.canonicalKeySha256,
        action: 'PRESERVE',
        granteeCategory: 'FUTURE_RUNTIME',
        privileges: [],
        beforeStateSha256: source.valueSha256!,
        grantOption: false,
        ruleSha256: digest(`grant-rule:${objectKind}`),
        provenanceSha256: digest(`grant-provenance:${objectKind}`),
      } as const;
      return {
        ...withoutTarget,
        targetStateSha256: communitiesRoleSplitGrantTargetStateSha256(
          withoutTarget,
          ownershipByKind.get(objectKind)!,
        ),
      } satisfies CommunitiesRoleSplitGrantDecision;
    });
  const beforeEntries = objectStateEntries(inventory);
  return {
    contractVersion: COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
    artifactSha256: digest('independently-pinned-artifact'),
    inputC: inventory,
    mapping: mapping(),
    ownershipPlan,
    grantPlan,
    comparison: {
      sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
      beforeManifestSha: communitiesRoleSplitObjectStateManifestSha256(beforeEntries),
      afterManifestSha: communitiesRoleSplitObjectStateManifestSha256(beforeEntries),
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
  } as unknown as DeepMutable<CommunitiesRoleSplitAcceptanceEnvelope>;
}

function expectCode(run: () => unknown, suffix: string): void {
  try {
    run();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CommunitiesRoleSplitAcceptanceError);
    expect((error as CommunitiesRoleSplitAcceptanceError).code).toBe(
      `COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_${suffix}`,
    );
  }
}

describe('Communities role-split acceptance evaluator', () => {
  it('accepts only the exact complete observed redacted contract', () => {
    const candidate = envelope();
    expect(assertCommunitiesRoleSplitAcceptancePass(candidate)).toEqual(candidate.comparison);
  });

  it('recomputes and accepts one exact ADD transition and its comparison counts', () => {
    const candidate = envelope();
    const grantIndex = candidate.grantPlan.findIndex((row) => row.objectKind === 'relation');
    const current = candidate.grantPlan[grantIndex]!;
    const owner = candidate.ownershipPlan.find((row) => row.objectKind === 'relation')!;
    const transition = {
      objectKind: current.objectKind,
      canonicalKeySha256: current.canonicalKeySha256,
      action: 'ADD' as const,
      granteeCategory: current.granteeCategory,
      privileges: ['SELECT'] as DeepMutable<CommunitiesRoleSplitGrantDecision>['privileges'],
      beforeStateSha256: current.beforeStateSha256,
      grantOption: false as const,
      ruleSha256: current.ruleSha256,
      provenanceSha256: current.provenanceSha256,
    };
    candidate.grantPlan[grantIndex] = {
      ...transition,
      targetStateSha256: communitiesRoleSplitGrantTargetStateSha256(transition, owner),
    };
    const before = objectStateEntries(candidate.inputC);
    const after = objectStateEntries(candidate.inputC, candidate.grantPlan);
    candidate.comparison = {
      sortVersion: COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
      beforeManifestSha: communitiesRoleSplitObjectStateManifestSha256(before),
      afterManifestSha: communitiesRoleSplitObjectStateManifestSha256(after),
      changedCount: 1,
      addedCount: 1,
      removedCount: 0,
      forbiddenTransitionCodes: [],
    };
    expect(assertCommunitiesRoleSplitAcceptancePass(candidate)).toEqual(candidate.comparison);
  });

  it('rejects duplicate, missing and self identity pairs', () => {
    const duplicate = envelope();
    duplicate.mapping.identityRelations = [
      duplicate.mapping.identityRelations[0]!,
      duplicate.mapping.identityRelations[0]!,
      ...duplicate.mapping.identityRelations.slice(2),
    ];
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(duplicate),
      'IDENTITY_RELATION_SET_INVALID',
    );

    const missing = envelope();
    missing.mapping.identityRelations = missing.mapping.identityRelations.slice(0, -1);
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(missing),
      'IDENTITY_RELATION_SET_INVALID',
    );

    const self = envelope();
    self.mapping.identityRelations = [
      { ...self.mapping.identityRelations[0]!, right: 'RESTORE_OWNER' },
      ...self.mapping.identityRelations.slice(1),
    ];
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(self),
      'IDENTITY_RELATION_SET_INVALID',
    );
  });

  it('rejects a wrong required-distinct declaration or SAME result', () => {
    const wrongRequirement = envelope();
    wrongRequirement.mapping.identityRelations = wrongRequirement.mapping.identityRelations.map(
      (relation, index) =>
        index === 12 ? { ...relation, requirement: 'ALIAS_ALLOWED' } : relation,
    );
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(wrongRequirement),
      'IDENTITY_RELATION_SET_INVALID',
    );

    const same = envelope();
    same.mapping.identityRelations = same.mapping.identityRelations.map((relation, index) =>
      index === 12 ? { ...relation, relation: 'SAME' } : relation,
    );
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(same),
      'REQUIRED_DISTINCT_NOT_OBSERVED',
    );

    for (const relation of ['UNKNOWN', 'UNOBSERVED'] as const) {
      const unobserved = envelope();
      unobserved.mapping.identityRelations[0] = {
        ...unobserved.mapping.identityRelations[0]!,
        relation,
        provenanceSha256: null,
      };
      expectCode(
        () => assertCommunitiesRoleSplitAcceptancePass(unobserved),
        'IDENTITY_RELATION_NOT_OBSERVED',
      );
    }

    const contradicted = envelope();
    contradicted.mapping.identityRelations[0] = {
      ...contradicted.mapping.identityRelations[0]!,
      relation: 'SAME',
    };
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(contradicted),
      'IDENTITY_RELATION_EVIDENCE_MISMATCH',
    );
  });

  it('makes PASS impossible with unknown evidence, blockers, anomalies or incomplete categories', () => {
    const unknown = envelope();
    unknown.inputC.normalized.relations[0] = {
      ...unknown.inputC.normalized.relations[0]!,
      observationState: 'UNKNOWN',
      valueSha256: null,
      provenanceSha256: null,
    };
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(unknown),
      'NORMALIZED_RECORD_NOT_OBSERVED',
    );

    const blocker = envelope();
    blocker.decision.blockerCodes = ['INPUT_C_BLOCKED'];
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(blocker), 'DECISION_NOT_PASS');

    const anomaly = envelope();
    anomaly.inputC.anomalies = [
      {
        code: 'PUBLIC_GRANT',
        canonicalKeySha256: digest('key'),
        evidenceSha256: digest('evidence'),
      },
    ];
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(anomaly), 'INPUT_C_ANOMALY_PRESENT');

    const incomplete = envelope();
    delete (incomplete.inputC.normalized as Partial<typeof incomplete.inputC.normalized>)
      .extensions;
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(incomplete),
      'INPUT_C_BINDING_INVALID',
    );
  });

  it('rejects an empty, partial or out-of-manifest grant plan', () => {
    const empty = envelope();
    empty.grantPlan = [];
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(empty), 'GRANT_PLAN_SET_INVALID');

    const partial = envelope();
    partial.grantPlan = partial.grantPlan.slice(1);
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(partial), 'GRANT_PLAN_SET_INVALID');

    const extra = envelope();
    extra.grantPlan = [
      ...extra.grantPlan.slice(0, -1),
      { ...extra.grantPlan.at(-1)!, canonicalKeySha256: digest('not-in-manifest') },
    ];
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(extra), 'GRANT_PLAN_SET_INVALID');
  });

  it('rejects wildcard, ALL, PUBLIC, grant option and runtime CREATE', () => {
    for (const privilege of ['*', 'ALL']) {
      const candidate = envelope();
      candidate.grantPlan[2] = {
        ...candidate.grantPlan[2]!,
        action: 'ADD',
        privileges: [
          privilege,
        ] as unknown as DeepMutable<CommunitiesRoleSplitGrantDecision>['privileges'],
      };
      expectCode(
        () => assertCommunitiesRoleSplitAcceptancePass(candidate),
        'GRANT_PRIVILEGE_SET_INVALID',
      );
    }

    const publicGrant = envelope();
    publicGrant.grantPlan[2] = {
      ...publicGrant.grantPlan[2]!,
      granteeCategory: 'PUBLIC' as never,
    };
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(publicGrant),
      'GRANTEE_CATEGORY_FORBIDDEN',
    );

    const grantOption = envelope();
    grantOption.grantPlan[2] = { ...grantOption.grantPlan[2]!, grantOption: true as false };
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(grantOption), 'GRANT_PLAN_INVALID');

    const runtimeCreate = envelope();
    const schemaIndex = runtimeCreate.grantPlan.findIndex((row) => row.objectKind === 'schema');
    runtimeCreate.grantPlan[schemaIndex] = {
      ...runtimeCreate.grantPlan[schemaIndex]!,
      action: 'ADD',
      privileges: ['CREATE'],
    };
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(runtimeCreate),
      'RUNTIME_CREATE_FORBIDDEN',
    );
  });

  it('recomputes target state and comparison instead of accepting arbitrary hashes', () => {
    const inputManifest = envelope();
    inputManifest.inputC.manifestSha256 = digest('arbitrary-input-manifest');
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(inputManifest),
      'INPUT_C_MANIFEST_INVALID',
    );

    const target = envelope();
    target.grantPlan[0] = {
      ...target.grantPlan[0]!,
      targetStateSha256: digest('arbitrary-target'),
    };
    expectCode(
      () => assertCommunitiesRoleSplitAcceptancePass(target),
      'GRANT_TARGET_STATE_INVALID',
    );

    const comparison = envelope();
    comparison.comparison.afterManifestSha = digest('arbitrary-comparison');
    expectCode(() => assertCommunitiesRoleSplitAcceptancePass(comparison), 'COMPARISON_MISMATCH');
  });
});
