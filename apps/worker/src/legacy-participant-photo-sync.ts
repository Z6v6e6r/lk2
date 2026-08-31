import type { WorkerConfig } from '@phub/config';
import type {
  LegacyGameSourceSnapshot,
  LegacyParticipantPhotoSource,
} from '@phub/legacy-games-adapter';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { synchronizeProfilePhoto, type ProfilePhotoObjectStore } from './profile-photo-sync.js';
import {
  persistProfilePhoto,
  reserveProfilePhotoObjectUpload,
  resolveLegacyParticipantPhotoTargets,
} from './viva-home-repository.js';

export interface LegacyParticipantPhotoSyncResult {
  readonly stored: number;
  readonly unchanged: number;
  readonly failed: number;
}

interface LegacyParticipantPhotoSyncPorts {
  readonly resolveTargets: typeof resolveLegacyParticipantPhotoTargets;
  readonly synchronizePhoto: typeof synchronizeProfilePhoto;
  readonly persistPhoto: typeof persistProfilePhoto;
  readonly reserveObject?: typeof reserveProfilePhotoObjectUpload;
}

const defaultPorts: LegacyParticipantPhotoSyncPorts = {
  resolveTargets: resolveLegacyParticipantPhotoTargets,
  synchronizePhoto: synchronizeProfilePhoto,
  persistPhoto: persistProfilePhoto,
  reserveObject: reserveProfilePhotoObjectUpload,
};

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'PROFILE_PHOTO_SYNC_FAILED';
}

export async function synchronizeLegacyParticipantPhotos(
  input: {
    readonly pool: Pool;
    readonly tenantId: string;
    readonly snapshots: readonly LegacyGameSourceSnapshot[];
    readonly participants?: readonly LegacyParticipantPhotoSource[];
    readonly config: WorkerConfig;
    readonly store: ProfilePhotoObjectStore;
    readonly logger: Logger;
    readonly correlationId: string;
    readonly fetchedAt: string;
  },
  ports: LegacyParticipantPhotoSyncPorts = defaultPorts,
): Promise<LegacyParticipantPhotoSyncResult> {
  const targets = await ports.resolveTargets({
    pool: input.pool,
    tenantId: input.tenantId,
    snapshots: input.snapshots,
    ...(input.participants ? { participants: input.participants } : {}),
  });
  let stored = 0;
  let unchanged = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const result = await ports.synchronizePhoto({
        pool: input.pool,
        store: input.store,
        tenantId: input.tenantId,
        userId: target.userId,
        sourceUrl: target.sourceUrl,
        fetchedAt: input.fetchedAt,
        allowedHosts: input.config.PROFILE_PHOTO_ALLOWED_HOSTS.split(',')
          .map((host) => host.trim())
          .filter(Boolean),
        maxBytes: input.config.PROFILE_PHOTO_MAX_BYTES,
        maxDimension: input.config.PROFILE_PHOTO_MAX_DIMENSION,
        webpQuality: input.config.PROFILE_PHOTO_WEBP_QUALITY,
        previousObjectRetentionSeconds:
          input.config.PROFILE_PHOTO_URL_TTL_SECONDS +
          input.config.HOME_PROJECTION_MAX_STALE_SECONDS +
          60,
        timeoutMs: input.config.VIVA_TIMEOUT_MS,
        replaceExistingSource: false,
        deferStorePut: true,
      });
      if (result.preparedObject) {
        const shouldUpload = await (ports.reserveObject ?? reserveProfilePhotoObjectUpload)({
          pool: input.pool,
          tenantId: input.tenantId,
          userId: target.userId,
          objectKey: result.preparedObject.key,
          deleteAfter: result.preparedObject.deleteAfter,
        });
        if (shouldUpload) await input.store.put(result.preparedObject);
      }
      if (!result.errorCode || result.persistence.objectKey) {
        await ports.persistPhoto({
          pool: input.pool,
          tenantId: input.tenantId,
          userId: target.userId,
          photo: result.persistence,
        });
      }
      if (result.outcome === 'stored') stored += 1;
      else if (result.outcome === 'unchanged') unchanged += 1;
      else failed += 1;
      if (result.errorCode) {
        input.logger.warn(
          {
            tenantId: input.tenantId,
            userId: target.userId,
            correlationId: input.correlationId,
            code: result.errorCode,
          },
          'legacy participant photo synchronization retained the local photo',
        );
      }
    } catch (error) {
      failed += 1;
      input.logger.warn(
        {
          tenantId: input.tenantId,
          userId: target.userId,
          correlationId: input.correlationId,
          code: failureCode(error),
        },
        'legacy participant photo synchronization failed',
      );
    }
  }
  return { stored, unchanged, failed };
}
