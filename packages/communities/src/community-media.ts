import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const positiveRevision = z.number().int().positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const COMMUNITY_MEDIA_MAX_SOURCE_BYTES = 15 * 1_024 * 1_024;
export const COMMUNITY_MEDIA_MAX_PER_POST = 10;
export const COMMUNITY_MEDIA_MAX_OUTSTANDING_UPLOADS_PER_USER = 10;
export const COMMUNITY_MEDIA_MAX_PIPELINE_ITEMS_PER_USER = 20;
export const COMMUNITY_MEDIA_MAX_DAILY_ISSUES_PER_USER = 100;
export const COMMUNITY_MEDIA_MAX_DAILY_BYTES_PER_USER =
  COMMUNITY_MEDIA_MAX_SOURCE_BYTES * COMMUNITY_MEDIA_MAX_PER_POST;
export const COMMUNITY_MEDIA_MAX_TENANT_PIPELINE_ITEMS = 100;
export const COMMUNITY_MEDIA_UNATTACHED_READY_TTL_HOURS = 24;
export const COMMUNITY_DURABLE_EVENT_RETENTION_DAYS = 30;

export const COMMUNITY_MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const COMMUNITY_MEDIA_STATES = [
  'UPLOADING',
  'SCANNING',
  'READY',
  'REJECTED',
  'EXPIRED',
  'PURGED',
] as const;
export const COMMUNITY_MEDIA_VARIANTS = ['THUMBNAIL', 'FEED'] as const;

export const COMMUNITY_MEDIA_UPLOAD_REQUESTED_EVENT =
  'community.media.upload_requested.v1' as const;
export const COMMUNITY_MEDIA_SCAN_REQUESTED_EVENT = 'community.media.scan_requested.v1' as const;
export const COMMUNITY_MEDIA_READY_EVENT = 'community.media.ready.v1' as const;
export const COMMUNITY_MEDIA_REJECTED_EVENT = 'community.media.rejected.v1' as const;
export const COMMUNITY_MEDIA_EXPIRED_EVENT = 'community.media.expired.v1' as const;
export const COMMUNITY_MEDIA_PURGED_EVENT = 'community.media.purged.v1' as const;

export const communityMediaContentTypeSchema = z.enum(COMMUNITY_MEDIA_CONTENT_TYPES);
export const communityMediaStateSchema = z.enum(COMMUNITY_MEDIA_STATES);
export const communityMediaVariantNameSchema = z.enum(COMMUNITY_MEDIA_VARIANTS);

export const communityMediaVariantSchema = z
  .object({
    variant: communityMediaVariantNameSchema,
    url: z.string().startsWith('/user/api/v1/'),
    contentType: z.literal('image/webp'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byteSize: z.number().int().positive(),
  })
  .strict();

export const communityPostMediaSchema = z
  .object({
    id: uuid,
    mediaType: z.literal('IMAGE'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    variants: z
      .array(communityMediaVariantSchema)
      .min(1)
      .max(COMMUNITY_MEDIA_VARIANTS.length)
      .refine(
        (items) => new Set(items.map((item) => item.variant)).size === items.length,
        'Community media variants must be unique.',
      ),
  })
  .strict();

export const communityPostMediaSnapshotSchema = z
  .object({
    postId: uuid,
    postRevision: positiveRevision,
    media: z
      .array(communityPostMediaSchema)
      .max(COMMUNITY_MEDIA_MAX_PER_POST)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        'Community post media must be unique.',
      ),
  })
  .strict();

const communityMediaBaseSchema = z
  .object({
    id: uuid,
    communityId: uuid,
    uploaderUserId: uuid,
    mediaType: z.literal('IMAGE'),
    revision: positiveRevision,
    declaredContentType: communityMediaContentTypeSchema,
    declaredByteSize: z.number().int().positive().max(COMMUNITY_MEDIA_MAX_SOURCE_BYTES),
    declaredSha256: sha256,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

export const communityMediaUploadTargetSchema = z
  .object({
    method: z.literal('PUT'),
    url: z.string().url(),
    requiredHeaders: z.record(z.string().min(1), z.string().min(1)),
    expiresAt: dateTime,
  })
  .strict();

export const communityMediaUploadIssuedSchema = communityMediaBaseSchema
  .extend({
    state: z.literal('UPLOADING'),
    upload: communityMediaUploadTargetSchema,
  })
  .strict();

export const communityMediaStatusSchema = z.discriminatedUnion('state', [
  communityMediaBaseSchema
    .extend({
      state: z.literal('UPLOADING'),
      uploadExpiresAt: dateTime,
    })
    .strict(),
  communityMediaBaseSchema
    .extend({
      state: z.literal('SCANNING'),
      finalizedAt: dateTime,
    })
    .strict(),
  communityMediaBaseSchema
    .extend({
      state: z.literal('READY'),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      variants: z
        .array(communityMediaVariantSchema)
        .min(1)
        .max(COMMUNITY_MEDIA_VARIANTS.length)
        .refine(
          (items) => new Set(items.map((item) => item.variant)).size === items.length,
          'Community media variants must be unique.',
        ),
      readyAt: dateTime,
      unattachedExpiresAt: dateTime.nullable(),
    })
    .strict(),
  communityMediaBaseSchema
    .extend({
      state: z.literal('REJECTED'),
      rejectionCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      rejectedAt: dateTime,
    })
    .strict(),
  communityMediaBaseSchema
    .extend({
      state: z.literal('EXPIRED'),
      expiredAt: dateTime,
    })
    .strict(),
  communityMediaBaseSchema
    .extend({
      state: z.literal('PURGED'),
      purgedAt: dateTime,
    })
    .strict(),
]);

export type CommunityMediaContentType = z.infer<typeof communityMediaContentTypeSchema>;
export type CommunityMediaState = z.infer<typeof communityMediaStateSchema>;
export type CommunityMediaVariantName = z.infer<typeof communityMediaVariantNameSchema>;
export type CommunityMediaVariant = z.infer<typeof communityMediaVariantSchema>;
export type CommunityPostMedia = z.infer<typeof communityPostMediaSchema>;
export type CommunityPostMediaSnapshot = z.infer<typeof communityPostMediaSnapshotSchema>;
export type CommunityMediaUploadIssued = z.infer<typeof communityMediaUploadIssuedSchema>;
export type CommunityMediaStatus = z.infer<typeof communityMediaStatusSchema>;

export const communityMediaUploadIntentSchema = communityMediaBaseSchema
  .extend({
    state: z.literal('UPLOADING'),
    objectKey: z.string().min(1).max(1_024),
    uploadExpiresAt: dateTime,
  })
  .strict();
export const communityMediaObservedObjectSchema = z
  .object({
    byteSize: z.number().int().positive(),
    contentType: z.string().min(1).max(255),
    etag: z.string().min(1).max(512),
    versionId: z.string().min(1).max(1_024),
    checksumSha256: sha256,
  })
  .strict();

export type CommunityMediaUploadIntent = z.infer<typeof communityMediaUploadIntentSchema>;
export type CommunityMediaObservedObject = z.infer<typeof communityMediaObservedObjectSchema>;

interface CommunityMediaCommandContext {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface CommunityIssueMediaUploadInput extends CommunityMediaCommandContext {
  readonly contentType: CommunityMediaContentType;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface CommunityFinalizeMediaUploadInput extends CommunityMediaCommandContext {
  readonly mediaId: string;
  readonly expectedRevision: number;
}

export interface CommunityGetMediaInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly mediaId: string;
  readonly correlationId: string;
}

export type CommunityMediaFailure =
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'membership_required' }
  | { readonly outcome: 'publishing_forbidden' }
  | { readonly outcome: 'outstanding_upload_quota_exceeded'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'actor_pipeline_quota_exceeded'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'daily_issue_count_quota_exceeded'; readonly retryAfterSeconds: number }
  | {
      readonly outcome: 'daily_declared_bytes_quota_exceeded';
      readonly retryAfterSeconds: number;
    }
  | { readonly outcome: 'scan_backlog_quota_exceeded'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'media_not_found' }
  | { readonly outcome: 'upload_expired' }
  | { readonly outcome: 'object_missing' }
  | { readonly outcome: 'object_mismatch' }
  | { readonly outcome: 'invalid_state' }
  | { readonly outcome: 'revision_conflict'; readonly currentRevision: number };

export type CommunityIssueMediaUploadPersistenceResult =
  | {
      readonly outcome: 'issued';
      readonly intent: CommunityMediaUploadIntent;
      readonly replayed: boolean;
    }
  | CommunityMediaFailure;

export type CommunityIssueMediaUploadResult =
  | {
      readonly outcome: 'issued';
      readonly media: CommunityMediaUploadIssued;
      readonly replayed: boolean;
    }
  | CommunityMediaFailure;

export interface CommunityFinalizeMediaUploadPersistenceInput extends CommunityFinalizeMediaUploadInput {
  readonly observed: CommunityMediaObservedObject;
}

export type CommunityMediaFinalizeTargetResult =
  | { readonly outcome: 'inspect'; readonly objectKey: string }
  | { readonly outcome: 'replayed'; readonly media: CommunityMediaStatus }
  | Extract<
      CommunityMediaFailure,
      {
        readonly outcome:
          | 'idempotency_conflict'
          | 'actor_not_active'
          | 'media_not_found'
          | 'upload_expired'
          | 'invalid_state';
      }
    >;

export type CommunityFinalizeMediaUploadResult =
  | {
      readonly outcome: 'finalized';
      readonly media: CommunityMediaStatus;
      readonly replayed: boolean;
    }
  | CommunityMediaFailure;

export type CommunityGetMediaResult =
  | { readonly outcome: 'found'; readonly media: CommunityMediaStatus }
  | Extract<CommunityMediaFailure, { readonly outcome: 'media_not_found' | 'actor_not_active' }>;

export interface CommunityMediaRepository {
  issueUpload(
    input: CommunityIssueMediaUploadInput,
  ): Promise<CommunityIssueMediaUploadPersistenceResult>;
  getFinalizeTarget(
    input: CommunityFinalizeMediaUploadInput,
  ): Promise<CommunityMediaFinalizeTargetResult>;
  finalizeUpload(
    input: CommunityFinalizeMediaUploadPersistenceInput,
  ): Promise<CommunityFinalizeMediaUploadResult>;
  getMedia(input: CommunityGetMediaInput): Promise<CommunityGetMediaResult>;
}

export interface CommunityMediaUploadSigner {
  issueUploadTarget(input: {
    readonly mediaId: string;
    readonly objectKey: string;
    readonly contentType: CommunityMediaContentType;
    readonly byteSize: number;
    readonly sha256: string;
    readonly expiresAt: string;
  }): Promise<z.infer<typeof communityMediaUploadTargetSchema>>;
}

export interface CommunityMediaObjectInspector {
  inspectCurrentVersion(objectKey: string): Promise<CommunityMediaObservedObject | undefined>;
}

export interface CommunityMediaService {
  issueUpload(input: CommunityIssueMediaUploadInput): Promise<CommunityIssueMediaUploadResult>;
  finalizeUpload(
    input: CommunityFinalizeMediaUploadInput,
  ): Promise<CommunityFinalizeMediaUploadResult>;
  getMedia(input: CommunityGetMediaInput): Promise<CommunityGetMediaResult>;
}

const commandContextSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid,
    idempotencyKey: z.string().min(16).max(128),
    requestHash: sha256,
    correlationId: z.string().min(1).max(128),
  })
  .strict();

const issueInputSchema = commandContextSchema
  .extend({
    contentType: communityMediaContentTypeSchema,
    byteSize: z.number().int().positive().max(COMMUNITY_MEDIA_MAX_SOURCE_BYTES),
    sha256,
  })
  .strict();
const finalizeInputSchema = commandContextSchema
  .extend({ mediaId: uuid, expectedRevision: positiveRevision })
  .strict();
const getInputSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid,
    mediaId: uuid,
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CommunityMediaError extends Error {
  public constructor(
    public readonly code: 'COMMUNITY_MEDIA_COMMAND_INVALID' | 'COMMUNITY_MEDIA_STATE_INVALID',
  ) {
    super(code);
    this.name = 'CommunityMediaError';
  }
}

export function createCommunityMediaService(options: {
  readonly repository: CommunityMediaRepository;
  readonly uploadSigner: CommunityMediaUploadSigner;
  readonly objectInspector: CommunityMediaObjectInspector;
}): CommunityMediaService {
  return {
    async issueUpload(input) {
      const parsed = issueInputSchema.safeParse(input);
      if (!parsed.success) throw new CommunityMediaError('COMMUNITY_MEDIA_COMMAND_INVALID');
      const result = await options.repository.issueUpload(parsed.data);
      if (!('intent' in result)) return result;
      const intent = communityMediaUploadIntentSchema.safeParse(result.intent);
      if (!intent.success) {
        throw new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID');
      }
      if (Date.parse(intent.data.uploadExpiresAt) - Date.now() < 2_000) {
        return { outcome: 'upload_expired' };
      }
      const upload = await options.uploadSigner.issueUploadTarget({
        mediaId: intent.data.id,
        objectKey: intent.data.objectKey,
        contentType: intent.data.declaredContentType,
        byteSize: intent.data.declaredByteSize,
        sha256: intent.data.declaredSha256,
        expiresAt: intent.data.uploadExpiresAt,
      });
      const media = communityMediaUploadIssuedSchema.parse({
        id: intent.data.id,
        communityId: intent.data.communityId,
        uploaderUserId: intent.data.uploaderUserId,
        mediaType: intent.data.mediaType,
        state: intent.data.state,
        revision: intent.data.revision,
        declaredContentType: intent.data.declaredContentType,
        declaredByteSize: intent.data.declaredByteSize,
        declaredSha256: intent.data.declaredSha256,
        createdAt: intent.data.createdAt,
        updatedAt: intent.data.updatedAt,
        upload,
      });
      return { outcome: 'issued', media, replayed: result.replayed };
    },
    async finalizeUpload(input) {
      const parsed = finalizeInputSchema.safeParse(input);
      if (!parsed.success) throw new CommunityMediaError('COMMUNITY_MEDIA_COMMAND_INVALID');
      const target = await options.repository.getFinalizeTarget(parsed.data);
      if (target.outcome === 'replayed') {
        if (!communityMediaStatusSchema.safeParse(target.media).success) {
          throw new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID');
        }
        return { outcome: 'finalized', media: target.media, replayed: true };
      }
      if (target.outcome !== 'inspect') return target;
      const observed = await options.objectInspector.inspectCurrentVersion(target.objectKey);
      if (!observed) return { outcome: 'object_missing' };
      const parsedObserved = communityMediaObservedObjectSchema.safeParse(observed);
      if (!parsedObserved.success) {
        throw new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID');
      }
      const result = await options.repository.finalizeUpload({
        ...parsed.data,
        observed: parsedObserved.data,
      });
      if ('media' in result && !communityMediaStatusSchema.safeParse(result.media).success) {
        throw new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID');
      }
      return result;
    },
    async getMedia(input) {
      const parsed = getInputSchema.safeParse(input);
      if (!parsed.success) throw new CommunityMediaError('COMMUNITY_MEDIA_COMMAND_INVALID');
      const result = await options.repository.getMedia(parsed.data);
      if ('media' in result && !communityMediaStatusSchema.safeParse(result.media).success) {
        throw new CommunityMediaError('COMMUNITY_MEDIA_STATE_INVALID');
      }
      return result;
    },
  };
}
