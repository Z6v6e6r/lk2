import { describe, expect, it, vi } from 'vitest';

import { createTrainerAvatarRepository } from './trainer-avatar-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const trainerId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function repositoryWithQuery(
  implementation: (
    text: string,
    values: readonly unknown[],
  ) => {
    rows: readonly Record<string, unknown>[];
    rowCount: number;
  },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve(implementation(text, values));
  });
  return createTrainerAvatarRepository({
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  } as never);
}

describe('trainer avatar repository', () => {
  it('returns undefined when the provider identity is not cached', async () => {
    const repository = repositoryWithQuery((text) => {
      if (text.includes('from integration.trainer_avatar_sync')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.getByProviderIdentity(tenantId, 'VIVA', 'trainer-42')).resolves.toBe(
      undefined,
    );
  });

  it('maps a complete cached provider avatar', async () => {
    const repository = repositoryWithQuery((text) => {
      if (text.includes('from integration.trainer_avatar_sync')) {
        return {
          rows: [
            {
              trainer_id: trainerId,
              display_name: 'Анна Тренер',
              source_url: 'https://vivacrm.ru/avatar.jpg',
              object_key: 'trainer/avatar.webp',
              content_sha256: 'a'.repeat(64),
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(repository.getByProviderIdentity(tenantId, 'VIVA', 'trainer-42')).resolves.toEqual(
      {
        trainerId,
        displayName: 'Анна Тренер',
        sourceUrl: 'https://vivacrm.ru/avatar.jpg',
        objectKey: 'trainer/avatar.webp',
        contentSha256: 'a'.repeat(64),
      },
    );
  });

  it('creates a trainer and stores optional provider media metadata', async () => {
    const repository = repositoryWithQuery((text) => {
      if (text.includes('select trainer_id')) return { rows: [], rowCount: 0 };
      if (text.includes('insert into catalog.trainers')) {
        return {
          rows: [
            {
              trainer_id: trainerId,
              display_name: 'Новый тренер',
              source_url: null,
              object_key: null,
              content_sha256: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('insert into integration.trainer_avatar_sync')) {
        return {
          rows: [
            {
              trainer_id: trainerId,
              display_name: 'Новый тренер',
              source_url: 'https://vivacrm.ru/new.jpg',
              object_key: 'trainer/new.webp',
              content_sha256: 'b'.repeat(64),
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.save({
        tenantId,
        provider: 'VIVA',
        providerTrainerId: 'trainer-new',
        displayName: 'Новый тренер',
        sourceUrl: 'https://vivacrm.ru/new.jpg',
        objectKey: 'trainer/new.webp',
        contentSha256: 'b'.repeat(64),
        syncedAt: '2026-08-04T12:00:00.000Z',
      }),
    ).resolves.toEqual({
      trainerId,
      displayName: 'Новый тренер',
      sourceUrl: 'https://vivacrm.ru/new.jpg',
      objectKey: 'trainer/new.webp',
      contentSha256: 'b'.repeat(64),
    });
  });

  it('updates an existing trainer while preserving omitted avatar fields', async () => {
    const repository = repositoryWithQuery((text) => {
      if (text.includes('select trainer_id')) {
        return { rows: [{ trainer_id: trainerId }], rowCount: 1 };
      }
      if (text.includes('update catalog.trainers')) {
        return {
          rows: [
            {
              trainer_id: trainerId,
              display_name: 'Обновлённый тренер',
              source_url: null,
              object_key: null,
              content_sha256: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('insert into integration.trainer_avatar_sync')) {
        return {
          rows: [
            {
              trainer_id: trainerId,
              display_name: 'Обновлённый тренер',
              source_url: null,
              object_key: null,
              content_sha256: null,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      repository.save({
        tenantId,
        provider: 'VIVA',
        providerTrainerId: 'trainer-existing',
        displayName: 'Обновлённый тренер',
        lastErrorCode: 'SOURCE_UNAVAILABLE',
      }),
    ).resolves.toEqual({ trainerId, displayName: 'Обновлённый тренер' });
  });
});
