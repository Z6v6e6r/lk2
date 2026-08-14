import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesPreservationManifestSize,
  buildCommunitiesLegacyPreservationReport as buildReport,
  calculateManifestIdempotencyDigest,
  calculatePreservationRollupDigest,
  calculateStableMappingDigest,
  communitiesLegacyPreservationManifestSchema,
  COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS,
  type CommunitiesLegacyPreservationManifest,
  type TrustedCommunitiesLegacyMappingBaseline,
} from './communities-legacy-preservation-support.js';

const digest = (character: string) => character.repeat(64);
const KNOWN_MAPPING_DIGEST = '341300fa12f38807adc45a809791ba4f3f80c628b8d5f49590cff62644f3b340';
const acceptedByCollection: Record<
  (typeof COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS)[number],
  number
> = {
  lk_communities: 2,
  lk_community_events: 1,
  lk_community_feed: 2,
  lk_community_feed_comments: 4,
  lk_community_feed_reactions: 6,
  lk_community_chat_messages: 8,
  lk_community_rankings: 1,
  community_rating_facts: 4,
  community_rating_player_aggregates: 1,
  community_rating_snapshots: 2,
};

function aggregate(index: number): CommunitiesLegacyPreservationManifest['aggregates'][number] {
  return {
    tenantKey: 'local-padel',
    communityKeyHmac: index.toString(16).padStart(64, '0'),
    padlHubCommunityId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    communityDigest: digest('b'),
    lifecycle: 'ACTIVE',
    activeOwners: 1,
    membershipRoles: { owner: 1, admin: 0, moderator: 0, member: 2 },
    membershipStatuses: { pending: 0, active: 3, left: 0, removed: 0, banned: 0 },
    memberships: { total: 3, digest: digest('c') },
    ratingFacts: 2,
    ratingSnapshots: 1,
    ratingDigest: digest('d'),
    content: { posts: 1, comments: 2, reactions: 3, mediaReferences: 1, digest: digest('e') },
    chat: { conversations: 1, messages: 4, readCursors: 3, digest: digest('f') },
    invites: { active: index === 0 ? 1 : 0, historical: 1, digest: digest('1') },
  };
}

function validManifest(): CommunitiesLegacyPreservationManifest {
  const aggregates = [aggregate(0), aggregate(1)];
  const mapping = {
    sourceTenantIdHmac: digest('6'),
    externalSystem: 'LK_LEGACY' as const,
    entityType: 'community' as const,
    inputRows: aggregates.length,
    assignmentsDigest: '',
  };
  mapping.assignmentsDigest = calculateStableMappingDigest('local-padel', mapping, aggregates);
  expect(mapping.assignmentsDigest).toBe(KNOWN_MAPPING_DIGEST);
  const unsigned = {
    schemaVersion: 'communities-preservation-inventory-v1' as const,
    tenantKey: 'local-padel',
    sourceRelease: 'legacy-release-2026-08-09',
    capturedAt: '2026-08-09T00:00:00.000Z',
    sourceCheckpointDigest: digest('a'),
    snapshotConsistent: true as const,
    mapping,
    writeRoutes: {
      outcome: 'NODE_RED_WRITER_INVENTORY_COMPLETE' as const,
      reportSha256: digest('9'),
      sourceFlowSha256: digest('7'),
      functionAllowlistSha256: digest('8'),
      total: 1,
      inventoryDigest: digest('2'),
      unknown: 0,
      duplicateHandlers: 0,
    },
    collections: COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS.map((name) => ({
      name,
      scanned: acceptedByCollection[name],
      accepted: acceptedByCollection[name],
      quarantined: 0,
      acceptedDigest: digest('4'),
      quarantineDigest: digest('5'),
    })),
    communities: {
      total: 2,
      digest: calculatePreservationRollupDigest(aggregates, (item) => item.communityDigest),
      duplicateExternalIds: 0,
      invalidExternalIds: 0,
      missingStableMappings: 0,
    },
    memberships: {
      total: 6,
      digest: calculatePreservationRollupDigest(aggregates, (item) => item.memberships.digest),
      unresolvedIdentities: 0,
      ambiguousIdentities: 0,
      orphaned: 0,
      ownerInvariantViolations: 0,
    },
    ratingResults: {
      facts: 4,
      snapshots: 2,
      digest: calculatePreservationRollupDigest(aggregates, (item) => item.ratingDigest),
      orphanedCommunityRefs: 0,
      orphanedMemberRefs: 0,
      unknownSemantics: 0,
    },
    content: {
      posts: 2,
      comments: 4,
      reactions: 6,
      mediaReferences: 2,
      digest: calculatePreservationRollupDigest(aggregates, (item) => item.content.digest),
      orphanedRefs: 0,
      unknownSemantics: 0,
    },
    chat: {
      conversations: 2,
      messages: 8,
      readCursors: 6,
      digest: calculatePreservationRollupDigest(aggregates, (item) => item.chat.digest),
      orphanedRefs: 0,
      unknownSemantics: 0,
    },
    invites: {
      active: 1,
      historical: 2,
      digest: calculatePreservationRollupDigest(aggregates, (item) => item.invites.digest),
      orphanedRefs: 0,
      unknownSemantics: 0,
    },
    aggregates,
  };
  return { ...unsigned, idempotencyDigest: calculateManifestIdempotencyDigest(unsigned) };
}

function withDigest(
  transform: (
    manifest: Omit<CommunitiesLegacyPreservationManifest, 'idempotencyDigest'>,
  ) => Omit<CommunitiesLegacyPreservationManifest, 'idempotencyDigest'>,
): CommunitiesLegacyPreservationManifest {
  const unsigned = transform(withoutIdempotencyDigest(validManifest()));
  return { ...unsigned, idempotencyDigest: calculateManifestIdempotencyDigest(unsigned) };
}

function withoutIdempotencyDigest(
  manifest: CommunitiesLegacyPreservationManifest,
): Omit<CommunitiesLegacyPreservationManifest, 'idempotencyDigest'> {
  const { idempotencyDigest, ...unsigned } = manifest;
  void idempotencyDigest;
  return unsigned;
}

function trustedBaseline(): TrustedCommunitiesLegacyMappingBaseline {
  return {
    schemaVersion: 'communities-legacy-mapping-baseline-v1',
    tenantKey: 'local-padel',
    sourceTenantIdHmac: digest('6'),
    externalSystem: 'LK_LEGACY',
    entityType: 'community',
    inputRows: 2,
    assignmentsDigest: KNOWN_MAPPING_DIGEST,
  };
}

function buildCommunitiesLegacyPreservationReport(manifest: CommunitiesLegacyPreservationManifest) {
  return buildReport(manifest, trustedBaseline());
}

describe('fixture-only Communities legacy inventory harness', () => {
  it('reports structural consistency only, never mutation authority, without exposing PII', () => {
    const inventoryReport = buildCommunitiesLegacyPreservationReport(validManifest());
    expect(inventoryReport).toMatchObject({
      outcome: 'INVENTORY_STRUCTURALLY_CONSISTENT',
      activationReady: false,
      authorizesMutation: false,
      blockers: [],
    });
    expect(JSON.stringify(inventoryReport)).not.toContain('sourceTenantIdHmac');
    expect(JSON.stringify(inventoryReport)).not.toContain('padlHubCommunityId');
  });

  it('rejects undeclared PII-shaped fields at the manifest boundary', () => {
    expect(
      communitiesLegacyPreservationManifestSchema.safeParse({
        ...validManifest(),
        phone: '+79990000000',
      }).success,
    ).toBe(false);
  });

  it('rejects a mixed aggregate tenant under one root tenant', () => {
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((manifest) => ({
        ...manifest,
        aggregates: [
          { ...manifest.aggregates[0]!, tenantKey: 'other-tenant' },
          ...manifest.aggregates.slice(1),
        ],
      })),
    );
    expect(report.blockers).toContain('ROOT_TENANT_MISMATCH');
  });

  it('keeps the trusted baseline unchanged when a UUID reassignment recomputes all candidate digests', () => {
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((manifest) => {
        const aggregates = [
          {
            ...manifest.aggregates[0]!,
            padlHubCommunityId: '00000000-0000-4000-8000-000000000099',
          },
          ...manifest.aggregates.slice(1),
        ];
        return {
          ...manifest,
          mapping: {
            ...manifest.mapping,
            assignmentsDigest: calculateStableMappingDigest(
              manifest.tenantKey,
              manifest.mapping,
              aggregates,
            ),
          },
          aggregates,
        };
      }),
    );
    expect(report).toMatchObject({ outcome: 'NO_GO' });
    expect(report.blockers).toContain('BASELINE_MAPPING_DIGEST_MISMATCH');
  });

  it('detects stale or extra mapping rows with exact input-row accounting', () => {
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((manifest) => ({
        ...manifest,
        aggregates: [...manifest.aggregates, aggregate(2)],
      })),
    );
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'MAPPING_INPUT_ROW_COUNT_MISMATCH',
        'AGGREGATE_COUNT_MISMATCH',
        'STABLE_MAPPING_DIGEST_MISMATCH',
      ]),
    );
  });

  it('detects duplicate source and target mappings globally within the root tenant', () => {
    const manifest = validManifest();
    const duplicate = {
      ...manifest.aggregates[1]!,
      communityKeyHmac: manifest.aggregates[0]!.communityKeyHmac,
      padlHubCommunityId: manifest.aggregates[0]!.padlHubCommunityId,
    };
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((current) => ({ ...current, aggregates: [current.aggregates[0]!, duplicate] })),
    );
    expect(report.blockers).toContain('AGGREGATE_MAPPING_DUPLICATE');
  });

  it.each([0, 2])(
    'requires exactly one active owner for ACTIVE communities (%i)',
    (activeOwners) => {
      const report = buildCommunitiesLegacyPreservationReport(
        withDigest((manifest) => ({
          ...manifest,
          aggregates: [
            {
              ...manifest.aggregates[0]!,
              activeOwners,
              membershipRoles: { ...manifest.aggregates[0]!.membershipRoles, owner: activeOwners },
            },
            ...manifest.aggregates.slice(1),
          ],
        })),
      );
      expect(report.blockers).toContain('COMMUNITY_OWNER_INVARIANT_VIOLATION');
    },
  );

  it('rejects two active owners for an archived community too', () => {
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((manifest) => ({
        ...manifest,
        aggregates: [
          {
            ...manifest.aggregates[0]!,
            lifecycle: 'ARCHIVED',
            activeOwners: 2,
            membershipRoles: { ...manifest.aggregates[0]!.membershipRoles, owner: 2, member: 1 },
          },
          ...manifest.aggregates.slice(1),
        ],
      })),
    );
    expect(report.blockers).toContain('COMMUNITY_OWNER_INVARIANT_VIOLATION');
  });

  it('always blocks any quarantine, even when accounting is exact', () => {
    const manifest = validManifest();
    const first = manifest.collections[0]!;
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((current) => ({
        ...current,
        collections: [
          { ...first, scanned: 2, accepted: 1, quarantined: 1 },
          ...current.collections.slice(1),
        ],
      })),
    );
    expect(report.blockers).toContain('SOURCE_COLLECTION_QUARANTINE_PENDING');
  });

  it('detects aggregate count drift', () => {
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((manifest) => ({
        ...manifest,
        content: { ...manifest.content, posts: manifest.content.posts + 1 },
      })),
    );
    expect(report.blockers).toContain('AGGREGATE_COUNT_DRIFT');
  });

  it('reconciles accepted collections to their exact domain slice', () => {
    const report = buildCommunitiesLegacyPreservationReport(
      withDigest((manifest) => ({
        ...manifest,
        collections: manifest.collections.map((collection) =>
          collection.name === 'lk_community_feed'
            ? { ...collection, accepted: collection.accepted + 1, scanned: collection.scanned + 1 }
            : collection,
        ),
      })),
    );
    expect(report.blockers).toContain('SOURCE_COLLECTION_DOMAIN_COUNT_MISMATCH');
  });

  it('keeps mapping and whole-manifest digests stable across aggregate and collection order', () => {
    const manifest = validManifest();
    const reversed = withDigest((current) => {
      const aggregates = [...current.aggregates].reverse();
      return {
        ...current,
        mapping: {
          ...current.mapping,
          assignmentsDigest: calculateStableMappingDigest(
            current.tenantKey,
            current.mapping,
            aggregates,
          ),
        },
        aggregates,
        collections: [...current.collections].reverse(),
      };
    });
    expect(reversed.mapping.assignmentsDigest).toBe(manifest.mapping.assignmentsDigest);
    expect(reversed.idempotencyDigest).toBe(manifest.idempotencyDigest);
  });

  it('is sensitive to checkpoint, count, quarantine, and aggregate mutations', () => {
    const manifest = validManifest();
    const unsigned = { ...withoutIdempotencyDigest(manifest), sourceCheckpointDigest: digest('9') };
    expect(calculateManifestIdempotencyDigest(unsigned)).not.toBe(manifest.idempotencyDigest);
    expect(
      calculateManifestIdempotencyDigest({
        ...withoutIdempotencyDigest(manifest),
        content: { ...manifest.content, posts: 3 },
      }),
    ).not.toBe(manifest.idempotencyDigest);
    expect(
      calculateManifestIdempotencyDigest({
        ...withoutIdempotencyDigest(manifest),
        collections: [
          { ...manifest.collections[0]!, scanned: 2, accepted: 1, quarantined: 1 },
          ...manifest.collections.slice(1),
        ],
      }),
    ).not.toBe(manifest.idempotencyDigest);
    expect(
      calculateManifestIdempotencyDigest({
        ...withoutIdempotencyDigest(manifest),
        aggregates: [
          { ...manifest.aggregates[0]!, ratingFacts: 3 },
          ...manifest.aggregates.slice(1),
        ],
      }),
    ).not.toBe(manifest.idempotencyDigest);
  });

  it('rejects manifest sizes outside the bounded fixture contract', () => {
    expect(() => assertCommunitiesPreservationManifestSize(32 * 1024 * 1024)).not.toThrow();
    expect(() => assertCommunitiesPreservationManifestSize(32 * 1024 * 1024 + 1)).toThrow(
      'COMMUNITIES_PRESERVATION_MANIFEST_TOO_LARGE',
    );
  });
});
