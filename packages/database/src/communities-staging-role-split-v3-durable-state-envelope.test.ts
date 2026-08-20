import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  parseCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
} from './index.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const requestSha256 = sha('request');
const receiptSha256 = sha('receipt');
const evidenceSha256 = sha('evidence');

function envelope(phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED') {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
    phase,
    requestSha256,
    creationReceiptSha256: receiptSha256,
    restoreExecutionEvidenceSha256: evidenceSha256,
    cloneDatabaseOid: '45678',
    state: {
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
      requestSha256,
      phase,
      cloneDatabaseOid: '45678',
      restoreExecutionEvidenceSha256: evidenceSha256,
      markerPayloadSha256: null,
    },
  } as const satisfies CommunitiesStagingRoleSplitV3DurableStateEnvelope;
}

describe('communitiesStagingRoleSplitV3DurableStateEnvelope', () => {
  it('is strict canonical JSON+LF with deterministic phase-specific hashes', () => {
    const owned = envelope('OWNED');
    const canonical = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(owned);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(parseCommunitiesStagingRoleSplitV3DurableStateEnvelope(canonical)).toEqual(owned);
    expect(communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(owned)).toBe(
      'cb0d87fafb64e8293c11a41873902a93cdaa3293a029d8468206262333020530',
    );
    expect(
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(envelope('RESTORE_PENDING')),
    ).toBe('9bda18d38ae96a5fde926a9cbd3846b6dc671b1188d36ef86128258d54ebd5d3');
    expect(communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(envelope('RESTORED'))).toBe(
      '1da50229d9d3e15913061850947abe84c14b13386faf12aeb8afc2488203f74b',
    );
  });

  it('rejects noncanonical bytes, extra keys, V2 state and every binding/phase mutation', () => {
    const owned = envelope('OWNED');
    expect(() =>
      parseCommunitiesStagingRoleSplitV3DurableStateEnvelope(JSON.stringify(owned)),
    ).toThrow('V3_DURABLE_STATE_ENVELOPE_CANONICAL_ENCODING_INVALID');
    for (const changed of [
      { ...owned, ignored: true },
      { ...owned, requestSha256: sha('other-request') },
      { ...owned, phase: 'RESTORE_PENDING' },
      { ...owned, state: { ...owned.state, phase: 'RESTORE_PENDING' } },
      { ...owned, state: { ...owned.state, requestSha256: sha('other-request') } },
      {
        ...owned,
        state: { ...owned.state, restoreExecutionEvidenceSha256: sha('other-evidence') },
      },
      { ...owned, state: { ...owned.state, cloneDatabaseOid: '45679' } },
      { ...owned, state: { ...owned.state, schemaVersion: 'v2' } },
    ]) {
      expect(() =>
        canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(
          changed as unknown as CommunitiesStagingRoleSplitV3DurableStateEnvelope,
        ),
      ).toThrow();
    }
  });
});
