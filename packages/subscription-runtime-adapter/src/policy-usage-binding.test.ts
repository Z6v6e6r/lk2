import { describe, expect, it } from 'vitest';

import {
  CommercialBindingRefError,
  commercialBindingRefsEqual,
  commercialPolicyRefsEqual,
  commercialUsageRefsEqual,
  parseCommercialBindingRefs,
  parseCommercialPolicyRef,
  parseCommercialUsageRef,
} from './policy-usage-binding.js';

const digest = `sha256:${'a'.repeat(64)}`;
const decisionId = '11111111-1111-4111-8111-111111111111';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof CommercialBindingRefError ? error.code : 'UNEXPECTED';
  }
}

describe('parseCommercialPolicyRef', () => {
  it('accepts a published policy version and digest', () => {
    expect(parseCommercialPolicyRef({ policyVersion: 3, policyDigest: digest })).toEqual({
      policyVersion: 3,
      policyDigest: digest,
    });
  });

  it.each([
    ['version 0', { policyVersion: 0, policyDigest: digest }],
    ['negative version', { policyVersion: -1, policyDigest: digest }],
    ['fractional version', { policyVersion: 1.5, policyDigest: digest }],
    ['string version', { policyVersion: '3', policyDigest: digest }],
    ['missing digest', { policyVersion: 3 }],
    ['empty digest', { policyVersion: 3, policyDigest: '' }],
    ['uppercase digest', { policyVersion: 3, policyDigest: `sha256:${'A'.repeat(64)}` }],
    ['short digest', { policyVersion: 3, policyDigest: `sha256:${'a'.repeat(63)}` }],
    ['wrong algorithm', { policyVersion: 3, policyDigest: `sha256x:${'a'.repeat(64)}` }],
    ['extra key', { policyVersion: 3, policyDigest: digest, appliedRule: 'rule:any' }],
    ['array', []],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(codeOf(() => parseCommercialPolicyRef(value))).toBe('COMMERCIAL_POLICY_REF_INVALID');
  });
});

describe('parseCommercialUsageRef', () => {
  it('accepts an opaque usage ref without units', () => {
    expect(parseCommercialUsageRef({ usageRef: 'usage:abc-1' })).toEqual({
      usageRef: 'usage:abc-1',
    });
  });

  it('accepts an optional positive reservation size', () => {
    expect(parseCommercialUsageRef({ usageRef: 'usage:abc-1', reservationUnits: 2 })).toEqual({
      usageRef: 'usage:abc-1',
      reservationUnits: 2,
    });
  });

  it.each([
    ['empty ref', { usageRef: '' }],
    ['blank ref', { usageRef: ' ' }],
    ['ref with spaces', { usageRef: 'usage ref' }],
    ['ref with slash', { usageRef: 'usage/ref' }],
    ['too long ref', { usageRef: 'a'.repeat(201) }],
    ['zero units', { usageRef: 'usage:abc', reservationUnits: 0 }],
    ['negative units', { usageRef: 'usage:abc', reservationUnits: -1 }],
    ['fractional units', { usageRef: 'usage:abc', reservationUnits: 0.5 }],
    ['extra key', { usageRef: 'usage:abc', policyVersion: 3 }],
    ['missing ref', { reservationUnits: 1 }],
    ['array', []],
  ])('rejects %s', (_label, value) => {
    expect(codeOf(() => parseCommercialUsageRef(value))).toBe('COMMERCIAL_USAGE_REF_INVALID');
  });
});

describe('parseCommercialBindingRefs', () => {
  it('accepts policy ref only', () => {
    expect(
      parseCommercialBindingRefs({ policyRef: { policyVersion: 3, policyDigest: digest } }),
    ).toEqual({ policyRef: { policyVersion: 3, policyDigest: digest } });
  });

  it('accepts a decision id and usage reservation', () => {
    expect(
      parseCommercialBindingRefs({
        policyRef: { policyVersion: 3, policyDigest: digest },
        decisionId,
        usageRef: { usageRef: 'usage:abc', reservationUnits: 1 },
      }),
    ).toEqual({
      policyRef: { policyVersion: 3, policyDigest: digest },
      decisionId,
      usageRef: { usageRef: 'usage:abc', reservationUnits: 1 },
    });
  });

  it.each([
    ['missing policy ref', { usageRef: { usageRef: 'usage:abc' } }],
    [
      'invalid decision id',
      { policyRef: { policyVersion: 3, policyDigest: digest }, decisionId: 'not-a-uuid' },
    ],
    [
      'null decision id',
      { policyRef: { policyVersion: 3, policyDigest: digest }, decisionId: null },
    ],
    [
      'extra key',
      { policyRef: { policyVersion: 3, policyDigest: digest }, appliedRule: 'rule:any' },
    ],
    ['string', 'policy'],
  ])('rejects %s', (_label, value) => {
    expect(codeOf(() => parseCommercialBindingRefs(value))).toBe('COMMERCIAL_BINDING_REF_INVALID');
  });

  it('propagates the precise nested policy ref rejection', () => {
    expect(
      codeOf(() =>
        parseCommercialBindingRefs({ policyRef: { policyVersion: 0, policyDigest: digest } }),
      ),
    ).toBe('COMMERCIAL_POLICY_REF_INVALID');
  });
});

describe('binding equality', () => {
  const left = { policyVersion: 3, policyDigest: digest };
  const other = { policyVersion: 3, policyDigest: `sha256:${'b'.repeat(64)}` };

  it('compares policy refs by version and digest', () => {
    expect(commercialPolicyRefsEqual(left, { ...left })).toBe(true);
    expect(commercialPolicyRefsEqual(left, other)).toBe(false);
    expect(commercialPolicyRefsEqual(left, { ...left, policyVersion: 4 })).toBe(false);
  });

  it('compares usage refs including the optional reservation size', () => {
    expect(commercialUsageRefsEqual({ usageRef: 'usage:abc' }, { usageRef: 'usage:abc' })).toBe(
      true,
    );
    expect(
      commercialUsageRefsEqual(
        { usageRef: 'usage:abc', reservationUnits: 1 },
        { usageRef: 'usage:abc' },
      ),
    ).toBe(false);
    expect(
      commercialUsageRefsEqual(
        { usageRef: 'usage:abc', reservationUnits: 1 },
        { usageRef: 'usage:abc', reservationUnits: 2 },
      ),
    ).toBe(false);
  });

  it('requires the same usage presence and decision on both sides', () => {
    const bare = { policyRef: left };
    expect(commercialBindingRefsEqual(bare, { policyRef: { ...left } })).toBe(true);
    expect(
      commercialBindingRefsEqual(bare, {
        policyRef: { ...left },
        usageRef: { usageRef: 'usage:abc' },
      }),
    ).toBe(false);
    expect(commercialBindingRefsEqual(bare, { policyRef: { ...left }, decisionId })).toBe(false);
    expect(
      commercialBindingRefsEqual(
        { policyRef: { ...left }, decisionId },
        { policyRef: { ...left }, decisionId },
      ),
    ).toBe(true);
  });
});
