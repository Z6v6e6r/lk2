import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesSourceConnectAclObservation,
  assertCommunitiesSourceMembershipObservation,
  canonicalCommunitiesSourceConnectAclObservation,
  canonicalCommunitiesSourceMembershipObservation,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
} from './communities-staging-role-split-source-write-denial-observations.js';

describe('Communities source write-denial observations', () => {
  it('uses stable canonical golden vectors', () => {
    const acl = {
      schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
      databaseOid: '16385',
      databaseOwnerOid: '16384',
      aclState: 'EXPLICIT',
      rows: [{ grantorOid: '16384', granteeOid: '16386', privilege: 'CONNECT', grantable: false }],
    } as const;
    const membership = {
      schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
      principalOid: '16386',
      rows: [
        {
          roleOid: '16387',
          memberOid: '16386',
          grantorOid: '16384',
          adminOption: false,
          inheritOption: false,
          setOption: false,
        },
      ],
    } as const;
    expect(canonicalCommunitiesSourceConnectAclObservation(acl)).toBe(
      '{"aclState":"EXPLICIT","databaseOid":"16385","databaseOwnerOid":"16384","rows":[{"grantable":false,"granteeOid":"16386","grantorOid":"16384","privilege":"CONNECT"}],"schemaVersion":"communities-staging-role-split-source-connect-acl-observation-v1"}\n',
    );
    expect(communitiesSourceConnectAclObservationSha256(acl)).toBe(
      '821cce8e16e5d83c2b2a2b28a423e5e6bec8c4566346e9362f7708c3280c674c',
    );
    expect(canonicalCommunitiesSourceMembershipObservation(membership)).toBe(
      '{"principalOid":"16386","rows":[{"adminOption":false,"grantorOid":"16384","inheritOption":false,"memberOid":"16386","roleOid":"16387","setOption":false}],"schemaVersion":"communities-staging-role-split-restore-principal-membership-observation-v1"}\n',
    );
    expect(communitiesSourceMembershipObservationSha256(membership)).toBe(
      '81e47c898cc31c2cab307dc20d5f36be52c9f1e458e06b99b75dc708e555eac8',
    );
  });

  it('rejects unsorted and duplicate ACL or membership rows', () => {
    expect(() =>
      assertCommunitiesSourceConnectAclObservation({
        schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
        databaseOid: '1',
        databaseOwnerOid: '2',
        aclState: 'EXPLICIT',
        rows: [
          { grantorOid: '2', granteeOid: '3', privilege: 'CONNECT', grantable: false },
          { grantorOid: '2', granteeOid: '3', privilege: 'CONNECT', grantable: false },
        ],
      }),
    ).toThrow(/ACL_INVALID/);
    expect(() =>
      assertCommunitiesSourceMembershipObservation({
        schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
        principalOid: '1',
        rows: [
          {
            roleOid: '1',
            memberOid: '2',
            grantorOid: '1',
            adminOption: false,
            inheritOption: false,
            setOption: false,
          },
          {
            roleOid: '1',
            memberOid: '2',
            grantorOid: '1',
            adminOption: false,
            inheritOption: false,
            setOption: false,
          },
        ],
      }),
    ).toThrow(/MEMBERSHIP_INVALID/);
  });
});
