import { describe, expect, it, vi } from 'vitest';
import { localVivaExerciseAssociationId } from '@phub/legacy-games-adapter';

import {
  deleteProfilePhotoObjectIfSafe,
  listLegacyHistoryParticipantPhotoAliases,
  listDueProfilePhotoObjects,
  persistProfilePhoto,
  persistLegacyParticipantViewerProfile,
  persistVivaHomeSource,
  reserveProfilePhotoObjectUpload,
  resolveLegacyParticipantPhotoTargets,
  type VivaHomeDelegation,
} from './viva-home-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const bookingId = '55555555-5555-4555-8555-555555555555';
const gameId = '88888888-8888-4888-8888-888888888888';
const subscriptionId = '66666666-6666-4666-8666-666666666666';
const externalProfileId = '11111111-1111-4111-8111-111111111111';
const externalBookingId = '22222222-2222-4222-8222-222222222222';
const externalSubscriptionId = '33333333-3333-4333-8333-333333333333';
const externalExerciseId = '44444444-4444-4444-8444-444444444444';

const delegation: VivaHomeDelegation = {
  id: '77777777-7777-4777-8777-777777777777',
  tenantId,
  userId,
  providerTenantKey: 'tenant-key',
  issuer: 'https://issuer.invalid',
  subject: 'subject',
  refreshTokenCiphertext: 'encrypted',
  encryptionKeyVersion: 'v1',
};

describe('Viva Home producer repository', () => {
  it('fills a mapped legacy participant level from the confirmed Viva viewer profile', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('update profile.user_summaries p')) {
        expect(values).toEqual([tenantId, 'legacy-viewer-key', 'Alexey Sergeev', 'C', 3.15022]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      persistLegacyParticipantViewerProfile({
        pool: pool as never,
        tenantId,
        participantExternalId: 'legacy-viewer-key',
        displayName: 'Alexey Sergeev',
        level: 'C',
        levelValue: 3.15022,
      }),
    ).resolves.toBe(true);
  });

  it('resolves only locally mapped legacy participants that have source photos', async () => {
    const mappedUserId = 'b1dc7c9c-1aed-448d-987e-3235a839b505';
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("external_system = 'LK_LEGACY_SNAPSHOT'")) {
        expect(values).toEqual([tenantId, ['legacy-player-with-photo']]);
        return Promise.resolve({
          rows: [
            { external_id: 'legacy-player-with-photo', internal_id: mappedUserId },
            { external_id: 'not-requested', internal_id: userId },
          ],
          rowCount: 2,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      resolveLegacyParticipantPhotoTargets({
        pool: pool as never,
        tenantId,
        snapshots: [
          {
            participants: [
              {
                externalId: 'legacy-player-with-photo',
                avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/player-photo',
              },
              { externalId: 'legacy-player-without-photo', avatarSourceUrl: null },
            ],
          },
        ] as never,
      }),
    ).resolves.toEqual([
      {
        userId: mappedUserId,
        sourceUrl: 'https://562807.selcdn.ru/smstretching/player-photo',
      },
    ]);
  });

  it('lists only bounded raw aliases for completed-history players without a local photo', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('with history_players as')) {
        expect(text).toContain("h.status = 'COMPLETED'");
        expect(text).toContain('p.photo_url is null');
        expect(text).toContain("e.external_id !~ '^[0-9a-f]{64}$'");
        expect(values).toEqual([tenantId, 25]);
        return Promise.resolve({
          rows: [{ external_id: 'raw-cup-player-1' }, { external_id: 'raw-cup-player-2' }],
          rowCount: 2,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      listLegacyHistoryParticipantPhotoAliases({
        pool: pool as never,
        tenantId,
        limit: 25,
      }),
    ).resolves.toEqual(['raw-cup-player-1', 'raw-cup-player-2']);
  });

  it('combines a targeted participant photo with its canonical and raw mappings', async () => {
    const mappedUserId = 'b1dc7c9c-1aed-448d-987e-3235a839b505';
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("external_system = 'LK_LEGACY_SNAPSHOT'")) {
        expect(values).toEqual([tenantId, ['canonical-player', 'raw-cup-player']]);
        return Promise.resolve({
          rows: [{ external_id: 'raw-cup-player', internal_id: mappedUserId }],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      resolveLegacyParticipantPhotoTargets({
        pool: pool as never,
        tenantId,
        snapshots: [],
        participants: [
          {
            externalId: 'canonical-player',
            externalAliases: ['raw-cup-player'],
            avatarSourceUrl: 'https://562807.selcdn.ru/smstretching/player-photo',
          },
        ],
      }),
    ).resolves.toEqual([
      {
        userId: mappedUserId,
        sourceUrl: 'https://562807.selcdn.ru/smstretching/player-photo',
      },
    ]);
  });

  it('maps Viva IDs and writes PadlHub-only components through the outbox atomically', async () => {
    const outboxPayloads: string[] = [];
    let mapping = 0;
    let revision = 0;
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
      if (text.includes('insert into integration.external_entity_map')) {
        mapping += 1;
        return Promise.resolve({
          rows: [
            {
              internal_id: mapping === 1 ? userId : mapping === 2 ? bookingId : subscriptionId,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.external_entity_map e')) {
        expect(values).toEqual([
          tenantId,
          [externalExerciseId, localVivaExerciseAssociationId(externalExerciseId)],
        ]);
        return Promise.resolve({
          rows: [
            {
              exercise_external_id: externalExerciseId,
              game_id: gameId,
              capacity: 4,
              game_title: 'Вечерняя игра',
              game_kind: 'RATING',
              ends_at: '2026-07-16T10:30:00.000Z',
              court_name: 'Корт №4',
              station_id: '9b993668-ff54-4cce-8dfd-cad84c4a06fa',
              station_title: 'Ясенево',
              profile_id: 'b1dc7c9c-1aed-448d-987e-3235a839b505',
              display_name: 'Дмитрий Крикунов',
              photo_url: 'https://media.padlhub.test/profiles/dmitriy.webp',
              level_label: 'C',
              level_value: '3.44464',
            },
            {
              exercise_external_id: externalExerciseId,
              game_id: gameId,
              capacity: 4,
              game_title: 'Вечерняя игра',
              game_kind: 'RATING',
              ends_at: '2026-07-16T10:30:00.000Z',
              court_name: 'Корт №4',
              station_id: '9b993668-ff54-4cce-8dfd-cad84c4a06fa',
              station_title: 'Ясенево',
              profile_id: userId,
              display_name: 'Алексей Сергеев',
              photo_url:
                'https://media.padlhub.test/phub-local/profile-photo.webp?X-Amz-Signature=test',
              level_label: 'C',
              level_value: '3.15022',
            },
            {
              exercise_external_id: externalExerciseId,
              game_id: gameId,
              capacity: 4,
              game_title: 'Вечерняя игра',
              game_kind: 'RATING',
              ends_at: '2026-07-16T10:30:00.000Z',
              court_name: 'Корт №4',
              station_id: '9b993668-ff54-4cce-8dfd-cad84c4a06fa',
              station_title: 'Ясенево',
              profile_id: 'c4e17ec7-a696-4355-a0b9-7e1a5644a3a6',
              display_name: 'Александр Сосновский',
              photo_url: null,
              level_label: 'D+',
              level_value: '2.86793',
            },
          ],
          rowCount: 3,
        });
      }
      if (text.includes('select client_grant_issued_at, object_key, source_url, synced_at')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('update profile.user_summaries') ||
        text.includes('insert into integration.user_profile_photo_sync') ||
        text.includes('insert into integration.profile_photo_observation_watermarks') ||
        text.includes('delete from integration.profile_photo_object_gc')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into integration.viva_home_source_components')) {
        revision += 1;
        return Promise.resolve({
          rows: [{ source_revision: String(revision), payload_checksum: 'a'.repeat(64) }],
          rowCount: 1,
        });
      }
      if (text.includes('insert into audit.outbox_events')) {
        outboxPayloads.push(String(values[5]));
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.audit_log')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(
      persistVivaHomeSource({
        pool: pool as never,
        delegation,
        correlationId: 'producer-test-correlation',
        profilePhoto: {
          avatarUrl:
            'https://media.padlhub.test/phub-local/profile-photo.webp?X-Amz-Signature=test',
          deliveryId: '2d650d6c-207a-449a-85f5-50f226499992',
          sourceUrl: 'https://562807.selcdn.ru/smstretching/provider-photo',
          sourceEtag: '"photo-v1"',
          contentSha256: 'f'.repeat(64),
          objectKey: `profile-photos/${tenantId}/${userId}/${'f'.repeat(64)}.webp`,
          syncedAt: '2026-07-15T12:00:00.000Z',
        },
        snapshot: {
          profile: {
            externalId: externalProfileId,
            displayName: 'Алексей Петров',
            firstName: 'Алексей',
            lastName: 'Петров',
            balanceMinor: -100,
            level: { label: 'D', value: 0, assessmentRequired: true },
          },
          upcoming: [
            {
              externalId: externalBookingId,
              exerciseExternalId: externalExerciseId,
              title: 'Тренировка',
              startsAt: '2026-07-16T09:00:00+03:00',
              venue: 'ПаделХАБ',
              status: 'confirmed',
            },
          ],
          subscriptions: [
            {
              externalId: externalSubscriptionId,
              title: 'Абонемент',
              status: 'paused',
              remainingUnits: 2,
              validUntil: null,
            },
          ],
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      }),
    ).resolves.toEqual([
      { component: 'profile', revision: '1' },
      { component: 'upcoming', revision: '2' },
      { component: 'subscriptions', revision: '3' },
    ]);

    const serialized = outboxPayloads.join(' ');
    expect(serialized).not.toContain(externalProfileId);
    expect(serialized).not.toContain(externalBookingId);
    expect(serialized).not.toContain(externalSubscriptionId);
    expect(serialized).not.toContain(externalExerciseId);
    expect(serialized).not.toContain('562807.selcdn.ru');
    expect(serialized).toContain('media.padlhub.test');
    expect(serialized).toContain(`/games/${gameId}`);
    expect(serialized).not.toContain(`/bookings/${bookingId}`);
    expect(serialized).toContain(`/subscriptions/${subscriptionId}`);
    expect(serialized).toContain('"firstName":"Алексей"');
    expect(serialized).toContain('"lastName":"Петров"');
    expect(serialized).toContain('"nickname":null');
    expect(serialized).toContain('"displayName":"Дмитрий Крикунов"');
    expect(serialized).toContain('"displayName":"Александр Сосновский"');
    expect(serialized).toContain('"levelValue":3.44464');
    expect(serialized).toContain('"levelValue":2.86793');
    expect(serialized).toContain('"openSlots":1');
    expect(serialized).toContain('"title":"Вечерняя игра"');
    expect(serialized).toContain('"type":"rating"');
    expect(serialized).toContain('"title":"Ясенево"');
    expect(serialized).toContain('"courtName":"Корт №4"');
    expect(query.mock.calls.at(-1)?.[0]).toBe('commit');
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps a newer browser avatar in both the mapping and Home when a stale worker finishes late', async () => {
    const browserAvatarUrl =
      '/public/api/v1/media/profile-photos/86afbe01-0318-4dd2-bc25-303b7bf0d430/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const outboxPayloads: string[] = [];
    let revision = 0;
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
      if (text.includes('insert into integration.external_entity_map')) {
        return Promise.resolve({ rows: [{ internal_id: userId }], rowCount: 1 });
      }
      if (text.includes('set level_label')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('select client_grant_issued_at, object_key, source_url, synced_at')) {
        return Promise.resolve({
          rows: [
            {
              client_grant_issued_at: '2026-07-15T12:03:00.000Z',
              object_key: `profile-photos/${tenantId}/${userId}/${'a'.repeat(64)}.webp`,
              source_url: null,
              synced_at: '2026-07-15T12:03:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('select photo_url')) {
        return Promise.resolve({ rows: [{ photo_url: browserAvatarUrl }], rowCount: 1 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into integration.profile_photo_object_gc')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (
        text.includes('set photo_url') ||
        text.includes('insert into integration.user_profile_photo_sync')
      ) {
        throw new Error('stale worker must not overwrite the browser mapping');
      }
      if (text.includes('insert into integration.viva_home_source_components')) {
        revision += 1;
        return Promise.resolve({
          rows: [{ source_revision: String(revision), payload_checksum: 'b'.repeat(64) }],
          rowCount: 1,
        });
      }
      if (text.includes('insert into audit.outbox_events')) {
        outboxPayloads.push(String(values[5]));
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.audit_log')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await persistVivaHomeSource({
      pool: pool as never,
      delegation,
      correlationId: 'stale-worker-correlation',
      profilePhoto: {
        avatarUrl: '/public/api/v1/media/profile-photos/stale-worker',
        deliveryId: '2d650d6c-207a-449a-85f5-50f226499993',
        sourceUrl: 'https://cdn.vivacrm.invalid/stale.jpg',
        contentSha256: 'e'.repeat(64),
        objectKey: `profile-photos/${tenantId}/${userId}/${'e'.repeat(64)}.webp`,
        syncedAt: '2026-07-15T12:02:00.000Z',
      },
      snapshot: {
        profile: {
          externalId: externalProfileId,
          displayName: 'Алексей Сергеев',
          balanceMinor: 0,
          level: { label: 'C', value: 3.1, assessmentRequired: false },
        },
        upcoming: [],
        subscriptions: [],
        fetchedAt: '2026-07-15T12:02:00.000Z',
      },
    });

    expect(outboxPayloads.join(' ')).toContain(browserAvatarUrl);
    expect(outboxPayloads.join(' ')).not.toContain('stale-worker');
  });

  it('does not let a late older worker observation replace a newer worker photo', async () => {
    let rejectedObjectQueued = false;
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select client_grant_issued_at, object_key, source_url, synced_at')) {
        return Promise.resolve({
          rows: [
            {
              client_grant_issued_at: null,
              object_key: `profile-photos/${tenantId}/${userId}/${'b'.repeat(64)}.webp`,
              source_url: 'https://cdn.vivacrm.invalid/newer.jpg',
              synced_at: '2026-07-15T12:03:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('select photo_url')) {
        return Promise.resolve({ rows: [{ photo_url: '/public/newer.webp' }], rowCount: 1 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into integration.profile_photo_object_gc')) {
        rejectedObjectQueued = true;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected write by stale worker: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      persistProfilePhoto({
        pool: pool as never,
        tenantId,
        userId,
        photo: {
          avatarUrl: '/public/older.webp',
          deliveryId: '2d650d6c-207a-449a-85f5-50f226499994',
          sourceUrl: 'https://cdn.vivacrm.invalid/older.jpg',
          contentSha256: 'd'.repeat(64),
          objectKey: `profile-photos/${tenantId}/${userId}/${'d'.repeat(64)}.webp`,
          syncedAt: '2026-07-15T12:02:00.000Z',
        },
      }),
    ).resolves.toBeUndefined();
    expect(rejectedObjectQueued).toBe(true);
  });

  it('retains a browser grant watermark when the worker only replays its source-less fallback', async () => {
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select client_grant_issued_at, object_key, source_url, synced_at')) {
        return Promise.resolve({
          rows: [
            {
              client_grant_issued_at: '2026-07-15T12:01:00.000Z',
              object_key: `profile-photos/${tenantId}/${userId}/${'c'.repeat(64)}.webp`,
              source_url: null,
              synced_at: '2026-07-15T12:02:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('select photo_url')) {
        return Promise.resolve({ rows: [{ photo_url: '/public/browser.webp' }], rowCount: 1 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Source-less fallback must not mutate the browser mapping: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await expect(
      persistProfilePhoto({
        pool: pool as never,
        tenantId,
        userId,
        photo: {
          avatarUrl: '/public/browser.webp',
          deliveryId: '2d650d6c-207a-449a-85f5-50f226499995',
          contentSha256: 'c'.repeat(64),
          objectKey: `profile-photos/${tenantId}/${userId}/${'c'.repeat(64)}.webp`,
          syncedAt: '2026-07-15T12:02:00.000Z',
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps a removal watermark so a late older photo result cannot restore the avatar', async () => {
    let mapping:
      | {
          client_grant_issued_at: null;
          object_key: string;
          source_url: string;
          synced_at: string;
        }
      | undefined = {
      client_grant_issued_at: null,
      object_key: `profile-photos/${tenantId}/${userId}/${'a'.repeat(64)}.webp`,
      source_url: 'https://cdn.vivacrm.invalid/current.jpg',
      synced_at: '2026-07-15T12:02:00.000Z',
    };
    let watermark: string | undefined;
    let staleMappingWrite = false;
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
      if (text.includes('select client_grant_issued_at, object_key, source_url, synced_at')) {
        return Promise.resolve({ rows: mapping ? [mapping] : [], rowCount: mapping ? 1 : 0 });
      }
      if (text.includes('from integration.profile_photo_observation_watermarks')) {
        return Promise.resolve({
          rows: watermark ? [{ observed_at: watermark }] : [],
          rowCount: watermark ? 1 : 0,
        });
      }
      if (text.includes('insert into integration.profile_photo_observation_watermarks')) {
        watermark = String(values[2]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('delete from integration.user_profile_photo_sync')) {
        mapping = undefined;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into integration.user_profile_photo_sync')) {
        staleMappingWrite = true;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (
        text.includes('update profile.user_summaries') ||
        text.includes('insert into integration.profile_photo_object_gc') ||
        text.includes('select photo_url')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };

    await persistProfilePhoto({
      pool: pool as never,
      tenantId,
      userId,
      photo: {
        avatarUrl: null,
        supersededObjectKey: mapping.object_key,
        deleteAfter: '2026-07-16T12:00:00.000Z',
        syncedAt: '2026-07-15T12:03:00.000Z',
      },
    });
    await persistProfilePhoto({
      pool: pool as never,
      tenantId,
      userId,
      photo: {
        avatarUrl: '/public/stale.webp',
        deliveryId: '2d650d6c-207a-449a-85f5-50f226499996',
        sourceUrl: 'https://cdn.vivacrm.invalid/stale.jpg',
        contentSha256: 'b'.repeat(64),
        objectKey: `profile-photos/${tenantId}/${userId}/${'b'.repeat(64)}.webp`,
        syncedAt: '2026-07-15T12:01:00.000Z',
      },
    });

    expect(watermark).toBe('2026-07-15T12:03:00.000Z');
    expect(staleMappingWrite).toBe(false);
  });

  it('filters active and pending objects before GC and rechecks active mappings under the user lock', async () => {
    let listSql = '';
    const listQuery = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      listSql = text;
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const listPool = {
      connect: vi.fn().mockResolvedValue({ query: listQuery, release: vi.fn() }),
    };
    await listDueProfilePhotoObjects({ pool: listPool as never, tenantId, limit: 20 });
    expect(listSql).toContain('not exists');
    expect(listSql).toContain('user_profile_photo_sync active');
    expect(listSql).toContain('profile_photo_client_commands pending');

    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const safeQuery = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.profile_photo_object_gc')) {
        return Promise.resolve({ rows: [{ object_key: 'key' }], rowCount: 1 });
      }
      if (text.includes('from integration.user_profile_photo_sync')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      if (text.includes('delete from integration.profile_photo_object_gc')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const safePool = {
      connect: vi.fn().mockResolvedValue({ query: safeQuery, release: vi.fn() }),
    };
    const objectKey = `profile-photos/${tenantId}/${userId}/${'b'.repeat(64)}.webp`;
    await expect(
      deleteProfilePhotoObjectIfSafe({
        pool: safePool as never,
        tenantId,
        objectKey,
        deleteObject,
      }),
    ).resolves.toBe(false);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('moves a due GC deadline forward before a worker uploads an inactive object', async () => {
    let reservationSql = '';
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select object_key')) {
        return Promise.resolve({
          rows: [{ object_key: `profile-photos/${tenantId}/${userId}/${'a'.repeat(64)}.webp` }],
          rowCount: 1,
        });
      }
      if (text.includes('insert into integration.profile_photo_object_gc')) {
        reservationSql = text;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const objectKey = `profile-photos/${tenantId}/${userId}/${'f'.repeat(64)}.webp`;
    await expect(
      reserveProfilePhotoObjectUpload({
        pool: {
          connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
        } as never,
        tenantId,
        userId,
        objectKey,
        deleteAfter: '2026-07-16T12:00:00.000Z',
      }),
    ).resolves.toBe(true);
    expect(reservationSql).toContain('greatest');
  });
});
