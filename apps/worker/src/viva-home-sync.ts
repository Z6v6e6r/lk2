import { randomUUID } from 'node:crypto';

import { IdentityProviderError, type VivaOAuthProviderPort } from '@phub/auth';
import {
  VivaDelegationCryptoError,
  decryptVivaDelegationToken,
  encryptVivaDelegationToken,
  vivaRefreshLockRedisKey,
} from '@phub/auth/viva-delegation';
import type { AppConfig } from '@phub/config';
import { VivaHomeSourceError, type VivaHomeSourceAdapter } from '@phub/viva-adapter';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { synchronizeVivaProfilePhoto, type ProfilePhotoObjectStore } from './profile-photo-sync.js';
import {
  completeProfilePhotoObjectGc,
  listDueVivaHomeDelegations,
  listDueProfilePhotoObjects,
  persistVivaHomeSource,
  recordProfilePhotoObjectGcFailure,
  recordVivaHomeSyncFailure,
  saveRefreshedVivaHomeDelegation,
  type VivaHomeDelegation,
} from './viva-home-repository.js';

const REFRESH_LOCK_TTL_SECONDS = 30;

export interface VivaHomeSyncCycleResult {
  readonly attempted: number;
  readonly synced: number;
  readonly busy: number;
  readonly failed: number;
}

function failureCode(error: unknown): string {
  if (error instanceof IdentityProviderError) {
    return error.code === 'AUTH_CODE_INVALID' ? 'VIVA_REAUTH_REQUIRED' : error.code;
  }
  if (error instanceof VivaDelegationCryptoError) return `VIVA_DELEGATION_${error.code}`;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as Partial<VivaHomeSourceError>).code;
    if (typeof code === 'string') return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'VIVA_HOME_SYNC_FAILED';
}

async function releaseRefreshLock(redis: Redis, key: string, claimId: string): Promise<void> {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    1,
    key,
    claimId,
  );
}

async function refreshDelegation(input: {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly config: AppConfig;
  readonly provider: VivaOAuthProviderPort;
  readonly delegation: VivaHomeDelegation;
  readonly correlationId: string;
  readonly now: Date;
}): Promise<
  { readonly outcome: 'busy' } | { readonly outcome: 'ready'; readonly accessToken: string }
> {
  const key = vivaRefreshLockRedisKey(`${input.delegation.tenantId}:${input.delegation.userId}`);
  const claimId = randomUUID();
  const claimed =
    (await input.redis.set(key, claimId, 'EX', REFRESH_LOCK_TTL_SECONDS, 'NX')) === 'OK';
  if (!claimed) return { outcome: 'busy' };
  try {
    const refreshToken = decryptVivaDelegationToken({
      value: input.delegation.refreshTokenCiphertext,
      keyText: input.config.VIVA_DELEGATION_ENCRYPTION_KEY,
      keyVersion: input.delegation.encryptionKeyVersion,
      expectedKeyVersion: input.config.VIVA_DELEGATION_KEY_VERSION,
    });
    const refreshed = await input.provider.refreshUserDelegation({
      refreshToken,
      correlationId: input.correlationId,
    });
    const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
    await saveRefreshedVivaHomeDelegation({
      pool: input.pool,
      delegation: input.delegation,
      refreshTokenCiphertext: encryptVivaDelegationToken(
        nextRefreshToken,
        input.config.VIVA_DELEGATION_ENCRYPTION_KEY,
      ),
      encryptionKeyVersion: input.config.VIVA_DELEGATION_KEY_VERSION,
      ...(refreshed.refreshExpiresIn
        ? {
            refreshExpiresAt: new Date(input.now.getTime() + refreshed.refreshExpiresIn * 1_000),
          }
        : {}),
      correlationId: input.correlationId,
    });
    return { outcome: 'ready', accessToken: refreshed.accessToken };
  } finally {
    await releaseRefreshLock(input.redis, key, claimId);
  }
}

export async function runVivaHomeSyncCycle(input: {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly provider: VivaOAuthProviderPort;
  readonly getAdapter: (providerTenantKey: string) => VivaHomeSourceAdapter;
  readonly profilePhotoStore: ProfilePhotoObjectStore;
  readonly now?: Date;
}): Promise<VivaHomeSyncCycleResult> {
  if (!input.config.HOME_VIVA_SYNC_ENABLED) {
    return { attempted: 0, synced: 0, busy: 0, failed: 0 };
  }
  const now = input.now ?? new Date();
  const dueBefore = new Date(now.getTime() - input.config.HOME_VIVA_SYNC_INTERVAL_MS);
  const failureBefore = new Date(now.getTime() - input.config.HOME_VIVA_SYNC_FAILURE_BACKOFF_MS);
  const tenants = await input.pool.query<{ id: string }>(
    `select id from identity.tenants where active = true order by id`,
  );
  let attempted = 0;
  let synced = 0;
  let busy = 0;
  let failed = 0;
  let remaining = input.config.HOME_VIVA_SYNC_BATCH_SIZE;
  for (const tenant of tenants.rows) {
    if (remaining <= 0) break;
    const delegations = await listDueVivaHomeDelegations({
      pool: input.pool,
      tenantId: tenant.id,
      dueBefore,
      failureBefore,
      limit: remaining,
    });
    remaining -= delegations.length;
    for (const delegation of delegations) {
      attempted += 1;
      const correlationId = randomUUID();
      try {
        const refreshed = await refreshDelegation({
          pool: input.pool,
          redis: input.redis,
          config: input.config,
          provider: input.provider,
          delegation,
          correlationId,
          now,
        });
        if (refreshed.outcome === 'busy') {
          busy += 1;
          continue;
        }
        const snapshot = await input.getAdapter(delegation.providerTenantKey).read({
          accessToken: refreshed.accessToken,
          correlationId,
        });
        const profilePhoto = await synchronizeVivaProfilePhoto({
          pool: input.pool,
          store: input.profilePhotoStore,
          tenantId: delegation.tenantId,
          userId: delegation.userId,
          ...(snapshot.profile.photoUrl ? { sourceUrl: snapshot.profile.photoUrl } : {}),
          fetchedAt: snapshot.fetchedAt,
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
        });
        if (profilePhoto.errorCode) {
          input.logger.warn(
            {
              tenantId: delegation.tenantId,
              userId: delegation.userId,
              correlationId,
              code: profilePhoto.errorCode,
            },
            'Viva profile photo synchronization retained the local photo',
          );
        }
        const components = await persistVivaHomeSource({
          pool: input.pool,
          delegation,
          snapshot,
          profilePhoto: profilePhoto.persistence,
          correlationId,
        });
        synced += 1;
        input.logger.info(
          {
            tenantId: delegation.tenantId,
            userId: delegation.userId,
            correlationId,
            components: components.map((component) => ({
              name: component.component,
              revision: component.revision,
            })),
          },
          'Viva Home source synchronized',
        );
      } catch (error) {
        failed += 1;
        const code = failureCode(error);
        await recordVivaHomeSyncFailure({
          pool: input.pool,
          delegation,
          code,
          correlationId,
        }).catch(() => undefined);
        input.logger.warn(
          {
            tenantId: delegation.tenantId,
            userId: delegation.userId,
            correlationId,
            code,
            ...(error instanceof VivaHomeSourceError && error.issues
              ? { issues: error.issues }
              : {}),
          },
          'Viva Home source synchronization failed',
        );
      }
    }
  }
  for (const tenant of tenants.rows) {
    const dueObjects = await listDueProfilePhotoObjects({
      pool: input.pool,
      tenantId: tenant.id,
      limit: input.config.PROFILE_PHOTO_GC_BATCH_SIZE,
    }).catch(() => []);
    for (const item of dueObjects) {
      try {
        await input.profilePhotoStore.delete(item.objectKey);
        await completeProfilePhotoObjectGc({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey: item.objectKey,
        });
      } catch {
        await recordProfilePhotoObjectGcFailure({
          pool: input.pool,
          tenantId: tenant.id,
          objectKey: item.objectKey,
          errorCode: 'PROFILE_PHOTO_OBJECT_DELETE_FAILED',
        }).catch(() => undefined);
        input.logger.warn(
          { tenantId: tenant.id, code: 'PROFILE_PHOTO_OBJECT_DELETE_FAILED' },
          'Profile photo object cleanup deferred',
        );
      }
    }
  }
  return { attempted, synced, busy, failed };
}
