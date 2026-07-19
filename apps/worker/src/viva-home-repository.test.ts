import { describe, expect, it, vi } from 'vitest';

import { persistVivaHomeSource, type VivaHomeDelegation } from './viva-home-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const bookingId = '55555555-5555-4555-8555-555555555555';
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
        expect(values).toEqual([tenantId, [externalExerciseId]]);
        return Promise.resolve({
          rows: [
            {
              exercise_external_id: externalExerciseId,
              capacity: 4,
              profile_id: 'b1dc7c9c-1aed-448d-987e-3235a839b505',
              display_name: 'Дмитрий Крикунов',
              photo_url: 'https://media.padlhub.test/profiles/dmitriy.webp',
              level_label: 'C',
            },
            {
              exercise_external_id: externalExerciseId,
              capacity: 4,
              profile_id: userId,
              display_name: 'Алексей Сергеев',
              photo_url:
                'https://media.padlhub.test/phub-local/profile-photo.webp?X-Amz-Signature=test',
              level_label: 'C',
            },
            {
              exercise_external_id: externalExerciseId,
              capacity: 4,
              profile_id: 'c4e17ec7-a696-4355-a0b9-7e1a5644a3a6',
              display_name: 'Александр Сосновский',
              photo_url: null,
              level_label: 'D+',
            },
          ],
          rowCount: 3,
        });
      }
      if (
        text.includes('update profile.user_summaries') ||
        text.includes('insert into integration.user_profile_photo_sync') ||
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
    expect(serialized).toContain(`/bookings/${bookingId}`);
    expect(serialized).toContain(`/subscriptions/${subscriptionId}`);
    expect(serialized).toContain('"firstName":"Алексей"');
    expect(serialized).toContain('"lastName":"Петров"');
    expect(serialized).toContain('"nickname":null');
    expect(serialized).toContain('"displayName":"Дмитрий Крикунов"');
    expect(serialized).toContain('"displayName":"Александр Сосновский"');
    expect(serialized).toContain('"openSlots":1');
    expect(query.mock.calls.at(-1)?.[0]).toBe('commit');
    expect(release).toHaveBeenCalledOnce();
  });
});
