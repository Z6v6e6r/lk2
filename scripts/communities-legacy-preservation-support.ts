import { createHash } from 'node:crypto';

import { z } from 'zod';

const nonNegative = z.number().int().nonnegative();
const positive = z.number().int().positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const safeVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const tenantKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS = [
  'lk_communities',
  'lk_community_events',
  'lk_community_feed',
  'lk_community_feed_comments',
  'lk_community_feed_reactions',
  'lk_community_chat_messages',
  'lk_community_rankings',
  'community_rating_facts',
  'community_rating_player_aggregates',
  'community_rating_snapshots',
] as const;

const countedSlice = z.object({ total: nonNegative, digest: sha256 }).strict();
const content = z
  .object({
    posts: nonNegative,
    comments: nonNegative,
    reactions: nonNegative,
    mediaReferences: nonNegative,
    digest: sha256,
  })
  .strict();
const chat = z
  .object({
    conversations: nonNegative,
    messages: nonNegative,
    readCursors: nonNegative,
    digest: sha256,
  })
  .strict();
const invites = z.object({ active: nonNegative, historical: nonNegative, digest: sha256 }).strict();

export const communitiesLegacyPreservationManifestSchema = z
  .object({
    schemaVersion: z.literal('communities-preservation-inventory-v1'),
    tenantKey,
    sourceRelease: safeVersion,
    capturedAt: z.string().datetime({ offset: true }),
    sourceCheckpointDigest: sha256,
    snapshotConsistent: z.literal(true),
    mapping: z
      .object({
        sourceTenantIdHmac: sha256,
        externalSystem: z.literal('LK_LEGACY'),
        entityType: z.literal('community'),
        inputRows: positive,
        assignmentsDigest: sha256,
      })
      .strict(),
    writeRoutes: z
      .object({
        total: positive,
        inventoryDigest: sha256,
        unknown: nonNegative,
        duplicateHandlers: nonNegative,
      })
      .strict(),
    collections: z
      .array(
        z
          .object({
            name: z.enum(COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS),
            scanned: nonNegative,
            accepted: nonNegative,
            quarantined: nonNegative,
            acceptedDigest: sha256,
            quarantineDigest: sha256,
          })
          .strict(),
      )
      .length(COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS.length),
    communities: countedSlice
      .extend({
        total: positive,
        duplicateExternalIds: nonNegative,
        invalidExternalIds: nonNegative,
        missingStableMappings: nonNegative,
      })
      .strict(),
    memberships: countedSlice
      .extend({
        unresolvedIdentities: nonNegative,
        ambiguousIdentities: nonNegative,
        orphaned: nonNegative,
        ownerInvariantViolations: nonNegative,
      })
      .strict(),
    ratingResults: z
      .object({
        facts: nonNegative,
        snapshots: nonNegative,
        digest: sha256,
        orphanedCommunityRefs: nonNegative,
        orphanedMemberRefs: nonNegative,
        unknownSemantics: nonNegative,
      })
      .strict(),
    content: content.extend({ orphanedRefs: nonNegative, unknownSemantics: nonNegative }).strict(),
    chat: chat.extend({ orphanedRefs: nonNegative, unknownSemantics: nonNegative }).strict(),
    invites: invites.extend({ orphanedRefs: nonNegative, unknownSemantics: nonNegative }).strict(),
    aggregates: z
      .array(
        z
          .object({
            tenantKey,
            communityKeyHmac: sha256,
            padlHubCommunityId: z.string().uuid().nullable(),
            communityDigest: sha256,
            lifecycle: z.enum(['ACTIVE', 'ARCHIVED']),
            activeOwners: nonNegative,
            membershipRoles: z
              .object({
                owner: nonNegative,
                admin: nonNegative,
                moderator: nonNegative,
                member: nonNegative,
              })
              .strict(),
            membershipStatuses: z
              .object({
                pending: nonNegative,
                active: nonNegative,
                left: nonNegative,
                removed: nonNegative,
                banned: nonNegative,
              })
              .strict(),
            memberships: countedSlice,
            ratingFacts: nonNegative,
            ratingSnapshots: nonNegative,
            ratingDigest: sha256,
            content,
            chat,
            invites,
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
    idempotencyDigest: sha256,
  })
  .strict();

export type CommunitiesLegacyPreservationManifest = z.infer<
  typeof communitiesLegacyPreservationManifestSchema
>;
type Aggregate = CommunitiesLegacyPreservationManifest['aggregates'][number];

export const trustedCommunitiesLegacyMappingBaselineSchema = z
  .object({
    schemaVersion: z.literal('communities-legacy-mapping-baseline-v1'),
    tenantKey,
    sourceTenantIdHmac: sha256,
    externalSystem: z.literal('LK_LEGACY'),
    entityType: z.literal('community'),
    inputRows: positive,
    assignmentsDigest: sha256,
  })
  .strict();

export type TrustedCommunitiesLegacyMappingBaseline = z.infer<
  typeof trustedCommunitiesLegacyMappingBaselineSchema
>;

export type CommunitiesLegacyPreservationBlocker =
  | 'SOURCE_WRITE_ROUTES_UNKNOWN'
  | 'SOURCE_ROUTE_DUPLICATION'
  | 'SOURCE_COLLECTION_ACCOUNTING_GAP'
  | 'SOURCE_COLLECTION_DOMAIN_COUNT_MISMATCH'
  | 'SOURCE_COLLECTION_QUARANTINE_PENDING'
  | 'ROOT_TENANT_MISMATCH'
  | 'COMMUNITY_EXTERNAL_ID_DUPLICATES'
  | 'COMMUNITY_EXTERNAL_ID_INVALID'
  | 'COMMUNITY_STABLE_MAPPING_GAP'
  | 'STABLE_MAPPING_DIGEST_MISMATCH'
  | 'BASELINE_MAPPING_DIGEST_MISMATCH'
  | 'MAPPING_INPUT_ROW_COUNT_MISMATCH'
  | 'MEMBERSHIP_IDENTITY_UNRESOLVED'
  | 'MEMBERSHIP_IDENTITY_AMBIGUOUS'
  | 'MEMBERSHIP_ORPHANS'
  | 'COMMUNITY_OWNER_INVARIANT_VIOLATION'
  | 'MEMBERSHIP_ROLE_STATUS_COUNT_MISMATCH'
  | 'REFERENCE_OR_SEMANTICS_GAP'
  | 'AGGREGATE_COUNT_MISMATCH'
  | 'AGGREGATE_MAPPING_DUPLICATE'
  | 'AGGREGATE_COUNT_DRIFT'
  | 'AGGREGATE_DIGEST_MISMATCH'
  | 'MANIFEST_IDEMPOTENCY_DIGEST_MISMATCH';

export function assertCommunitiesPreservationManifestSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 32 * 1024 * 1024) {
    throw new Error('COMMUNITIES_PRESERVATION_MANIFEST_TOO_LARGE');
  }
}

function compareAggregates(left: Aggregate, right: Aggregate): number {
  return left.communityKeyHmac.localeCompare(right.communityKeyHmac);
}

function digest(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${part.length}:${part}\n`);
  return hash.digest('hex');
}

export function calculateStableMappingDigest(
  tenant: string,
  mapping: Pick<
    CommunitiesLegacyPreservationManifest['mapping'],
    'sourceTenantIdHmac' | 'externalSystem' | 'entityType'
  >,
  aggregates: readonly Aggregate[],
): string {
  return digest([
    'communities-legacy-stable-mapping-v1',
    ...[...aggregates]
      .sort(compareAggregates)
      .map((aggregate) =>
        [
          tenant,
          mapping.sourceTenantIdHmac,
          mapping.externalSystem,
          mapping.entityType,
          aggregate.communityKeyHmac,
          aggregate.padlHubCommunityId ?? 'UNMAPPED',
        ].join('\0'),
      ),
  ]);
}

export function calculatePreservationRollupDigest(
  aggregates: readonly Aggregate[],
  value: (aggregate: Aggregate) => string,
): string {
  return digest([
    'communities-legacy-rollup-v1',
    ...[...aggregates]
      .sort(compareAggregates)
      .map((aggregate) => `${aggregate.communityKeyHmac}\0${value(aggregate)}`),
  ]);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function calculateManifestIdempotencyDigest(
  manifest: Omit<CommunitiesLegacyPreservationManifest, 'idempotencyDigest'>,
): string {
  return digest(['communities-legacy-inventory-idempotency-v1', canonicalize(manifest)]);
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

export function buildCommunitiesLegacyPreservationReport(
  manifest: CommunitiesLegacyPreservationManifest,
  baseline: TrustedCommunitiesLegacyMappingBaseline,
) {
  const blockers: CommunitiesLegacyPreservationBlocker[] = [];
  const add = (blocker: CommunitiesLegacyPreservationBlocker, condition: boolean) => {
    if (condition) blockers.push(blocker);
  };
  add('SOURCE_WRITE_ROUTES_UNKNOWN', manifest.writeRoutes.unknown > 0);
  add('SOURCE_ROUTE_DUPLICATION', manifest.writeRoutes.duplicateHandlers > 0);
  const collectionNames = new Set(manifest.collections.map((collection) => collection.name));
  add(
    'SOURCE_COLLECTION_ACCOUNTING_GAP',
    collectionNames.size !== COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS.length ||
      COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS.some((name) => !collectionNames.has(name)) ||
      manifest.collections.some(
        (collection) => collection.scanned !== collection.accepted + collection.quarantined,
      ),
  );
  add(
    'SOURCE_COLLECTION_QUARANTINE_PENDING',
    manifest.collections.some((collection) => collection.quarantined > 0),
  );
  const collectionAccepted = new Map(
    manifest.collections.map((collection) => [collection.name, collection.accepted]),
  );
  add(
    'SOURCE_COLLECTION_DOMAIN_COUNT_MISMATCH',
    collectionAccepted.get('lk_communities') !== manifest.communities.total ||
      collectionAccepted.get('lk_community_feed') !== manifest.content.posts ||
      collectionAccepted.get('lk_community_feed_comments') !== manifest.content.comments ||
      collectionAccepted.get('lk_community_feed_reactions') !== manifest.content.reactions ||
      collectionAccepted.get('lk_community_chat_messages') !== manifest.chat.messages ||
      collectionAccepted.get('community_rating_facts') !== manifest.ratingResults.facts ||
      collectionAccepted.get('community_rating_snapshots') !== manifest.ratingResults.snapshots,
  );
  add(
    'ROOT_TENANT_MISMATCH',
    manifest.aggregates.some((aggregate) => aggregate.tenantKey !== manifest.tenantKey),
  );
  add('COMMUNITY_EXTERNAL_ID_DUPLICATES', manifest.communities.duplicateExternalIds > 0);
  add('COMMUNITY_EXTERNAL_ID_INVALID', manifest.communities.invalidExternalIds > 0);
  add('COMMUNITY_STABLE_MAPPING_GAP', manifest.communities.missingStableMappings > 0);
  const mappingDigest = calculateStableMappingDigest(
    manifest.tenantKey,
    manifest.mapping,
    manifest.aggregates,
  );
  add('STABLE_MAPPING_DIGEST_MISMATCH', manifest.mapping.assignmentsDigest !== mappingDigest);
  add(
    'BASELINE_MAPPING_DIGEST_MISMATCH',
    baseline.tenantKey !== manifest.tenantKey ||
      baseline.sourceTenantIdHmac !== manifest.mapping.sourceTenantIdHmac ||
      baseline.externalSystem !== manifest.mapping.externalSystem ||
      baseline.entityType !== manifest.mapping.entityType ||
      baseline.inputRows !== manifest.mapping.inputRows ||
      baseline.assignmentsDigest !== mappingDigest,
  );
  add(
    'MAPPING_INPUT_ROW_COUNT_MISMATCH',
    manifest.mapping.inputRows !== manifest.aggregates.length,
  );
  add('MEMBERSHIP_IDENTITY_UNRESOLVED', manifest.memberships.unresolvedIdentities > 0);
  add('MEMBERSHIP_IDENTITY_AMBIGUOUS', manifest.memberships.ambiguousIdentities > 0);
  add('MEMBERSHIP_ORPHANS', manifest.memberships.orphaned > 0);
  add(
    'COMMUNITY_OWNER_INVARIANT_VIOLATION',
    manifest.memberships.ownerInvariantViolations > 0 ||
      manifest.aggregates.some(
        (aggregate) =>
          aggregate.activeOwners > 1 ||
          (aggregate.lifecycle === 'ACTIVE' && aggregate.activeOwners !== 1) ||
          aggregate.membershipRoles.owner !== aggregate.activeOwners ||
          aggregate.activeOwners > aggregate.membershipStatuses.active,
      ),
  );
  add(
    'MEMBERSHIP_ROLE_STATUS_COUNT_MISMATCH',
    manifest.aggregates.some(
      (aggregate) =>
        Object.values(aggregate.membershipRoles).reduce((total, value) => total + value, 0) !==
          aggregate.memberships.total ||
        Object.values(aggregate.membershipStatuses).reduce((total, value) => total + value, 0) !==
          aggregate.memberships.total,
    ),
  );
  add(
    'REFERENCE_OR_SEMANTICS_GAP',
    manifest.ratingResults.orphanedCommunityRefs > 0 ||
      manifest.ratingResults.orphanedMemberRefs > 0 ||
      manifest.ratingResults.unknownSemantics > 0 ||
      manifest.content.orphanedRefs > 0 ||
      manifest.content.unknownSemantics > 0 ||
      manifest.chat.orphanedRefs > 0 ||
      manifest.chat.unknownSemantics > 0 ||
      manifest.invites.orphanedRefs > 0 ||
      manifest.invites.unknownSemantics > 0,
  );
  add(
    'AGGREGATE_COUNT_MISMATCH',
    manifest.aggregates.length !== manifest.communities.total ||
      manifest.aggregates.filter((aggregate) => aggregate.padlHubCommunityId === null).length !==
        manifest.communities.missingStableMappings,
  );
  const communityKeys = new Set(manifest.aggregates.map((aggregate) => aggregate.communityKeyHmac));
  const ids = new Set(
    manifest.aggregates.flatMap((aggregate) =>
      aggregate.padlHubCommunityId ? [aggregate.padlHubCommunityId] : [],
    ),
  );
  add(
    'AGGREGATE_MAPPING_DUPLICATE',
    communityKeys.size !== manifest.aggregates.length ||
      ids.size !== manifest.aggregates.filter((aggregate) => aggregate.padlHubCommunityId).length,
  );
  add(
    'AGGREGATE_COUNT_DRIFT',
    sum(manifest.aggregates, (a) => a.memberships.total) !== manifest.memberships.total ||
      sum(manifest.aggregates, (a) => a.ratingFacts) !== manifest.ratingResults.facts ||
      sum(manifest.aggregates, (a) => a.ratingSnapshots) !== manifest.ratingResults.snapshots ||
      sum(manifest.aggregates, (a) => a.content.posts) !== manifest.content.posts ||
      sum(manifest.aggregates, (a) => a.content.comments) !== manifest.content.comments ||
      sum(manifest.aggregates, (a) => a.content.reactions) !== manifest.content.reactions ||
      sum(manifest.aggregates, (a) => a.content.mediaReferences) !==
        manifest.content.mediaReferences ||
      sum(manifest.aggregates, (a) => a.chat.conversations) !== manifest.chat.conversations ||
      sum(manifest.aggregates, (a) => a.chat.messages) !== manifest.chat.messages ||
      sum(manifest.aggregates, (a) => a.chat.readCursors) !== manifest.chat.readCursors ||
      sum(manifest.aggregates, (a) => a.invites.active) !== manifest.invites.active ||
      sum(manifest.aggregates, (a) => a.invites.historical) !== manifest.invites.historical,
  );
  add(
    'AGGREGATE_DIGEST_MISMATCH',
    [
      [
        manifest.communities.digest,
        calculatePreservationRollupDigest(manifest.aggregates, (a) => a.communityDigest),
      ],
      [
        manifest.memberships.digest,
        calculatePreservationRollupDigest(manifest.aggregates, (a) => a.memberships.digest),
      ],
      [
        manifest.ratingResults.digest,
        calculatePreservationRollupDigest(manifest.aggregates, (a) => a.ratingDigest),
      ],
      [
        manifest.content.digest,
        calculatePreservationRollupDigest(manifest.aggregates, (a) => a.content.digest),
      ],
      [
        manifest.chat.digest,
        calculatePreservationRollupDigest(manifest.aggregates, (a) => a.chat.digest),
      ],
      [
        manifest.invites.digest,
        calculatePreservationRollupDigest(manifest.aggregates, (a) => a.invites.digest),
      ],
    ].some(([declared, calculated]) => declared !== calculated),
  );
  const unsignedManifest = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'idempotencyDigest'),
  ) as Omit<CommunitiesLegacyPreservationManifest, 'idempotencyDigest'>;
  add(
    'MANIFEST_IDEMPOTENCY_DIGEST_MISMATCH',
    manifest.idempotencyDigest !== calculateManifestIdempotencyDigest(unsignedManifest),
  );
  return {
    purpose: 'LEGACY_PRESERVATION_INVENTORY_ONLY',
    outcome: blockers.length === 0 ? 'INVENTORY_STRUCTURALLY_CONSISTENT' : 'NO_GO',
    activationReady: false,
    authorizesMutation: false,
    blockers,
    counts: {
      communities: manifest.communities.total,
      memberships: manifest.memberships.total,
      ratingFacts: manifest.ratingResults.facts,
      ratingSnapshots: manifest.ratingResults.snapshots,
      posts: manifest.content.posts,
      comments: manifest.content.comments,
      reactions: manifest.content.reactions,
      chatMessages: manifest.chat.messages,
      activeInvites: manifest.invites.active,
      quarantined: sum(manifest.collections, (collection) => collection.quarantined),
      aggregateChecks: manifest.aggregates.length,
    },
  } as const;
}
