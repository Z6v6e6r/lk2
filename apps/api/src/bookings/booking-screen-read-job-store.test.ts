import { describe, expect, it } from 'vitest';

import {
  MemoryBookingScreenReadJobStore,
  type BookingScreenReadJob,
} from './booking-screen-read-job-store.js';

const job: BookingScreenReadJob = {
  jobId: '10000000-0000-4000-8000-000000000001',
  screen: 'FOR_ME',
  tenantId: '20000000-0000-4000-8000-000000000001',
  userId: '30000000-0000-4000-8000-000000000001',
  createdAt: '2026-07-30T09:00:00.000Z',
  expiresAt: '2026-07-30T09:02:00.000Z',
  commands: [
    {
      commandId: '40000000-0000-4000-8000-000000000001',
      operation: 'schedule.read',
      date: '2026-07-30',
    },
  ],
};

describe('booking screen read job store', () => {
  it('keeps normalized results command-scoped and makes replays harmless', async () => {
    const store = new MemoryBookingScreenReadJobStore();
    await expect(store.create(job, 120)).resolves.toBe(true);
    await expect(store.get(job.jobId)).resolves.toEqual(job);

    const result = {
      commandId: job.commands[0]!.commandId,
      kind: 'schedule' as const,
      acceptedAt: '2026-07-30T09:00:01.000Z',
      activities: [
        {
          id: '50000000-0000-4000-8000-000000000001',
          kind: 'TRAINING' as const,
          title: 'Групповая тренировка',
          startsAt: '2026-07-30T15:00:00.000Z',
          endsAt: '2026-07-30T16:30:00.000Z',
          timezone: 'Europe/Moscow' as const,
          station: {
            id: '60000000-0000-4000-8000-000000000001',
            name: 'Терехово',
            shortAddress: null,
          },
          levelRange: { from: 'D+', to: 'C' },
          capacity: { total: 8, open: 3 },
          host: null,
          route: '/trainings?event=50000000-0000-4000-8000-000000000001',
        },
      ],
    };

    await expect(store.putResult(job.jobId, result, 120)).resolves.toBe('accepted');
    await expect(store.putResult(job.jobId, result, 120)).resolves.toBe('replayed');
    await expect(store.getResults(job.jobId, [result.commandId])).resolves.toEqual([result]);
  });

  it('claims a command before effects and releases or completes only the owning claim', async () => {
    const store = new MemoryBookingScreenReadJobStore();
    const commandId = job.commands[0]!.commandId;
    const payloadHash = 'a'.repeat(64);
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-1', payloadHash, 120),
    ).resolves.toBe('claimed');
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-2', payloadHash, 120),
    ).resolves.toBe('in_progress');
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-2', 'b'.repeat(64), 120),
    ).resolves.toBe('conflict');
    await store.releaseResultClaim(job.jobId, commandId, 'claim-2', payloadHash);
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-2', payloadHash, 120),
    ).resolves.toBe('in_progress');
    await store.releaseResultClaim(job.jobId, commandId, 'claim-1', payloadHash);
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-2', payloadHash, 120),
    ).resolves.toBe('claimed');

    const result = {
      commandId,
      kind: 'schedule' as const,
      acceptedAt: '2026-07-30T09:00:01.000Z',
      activities: [],
    };
    await expect(
      store.completeClaimedResult(job.jobId, 'wrong-claim', payloadHash, result, 120),
    ).resolves.toBe(false);
    await expect(
      store.completeClaimedResult(job.jobId, 'claim-2', payloadHash, result, 120),
    ).resolves.toBe(true);
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-3', payloadHash, 120),
    ).resolves.toBe('replayed');
    await expect(
      store.claimResult(job.jobId, commandId, 'claim-3', 'b'.repeat(64), 120),
    ).resolves.toBe('conflict');
  });

  it('enforces a principal and provider scoped egress budget before effects', async () => {
    const store = new MemoryBookingScreenReadJobStore();
    const input = {
      tenantId: job.tenantId,
      userId: job.userId,
      provider: 'VIVA' as const,
      principalLimit: 2,
      providerLimit: 2,
      windowSeconds: 60,
    };
    await expect(store.consumeEgressBudget({ ...input, units: 2 })).resolves.toEqual({
      allowed: true,
    });
    await expect(store.consumeEgressBudget({ ...input, units: 1 })).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });
    await expect(
      store.consumeEgressBudget({ ...input, userId: 'different-user', units: 1 }),
    ).resolves.toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    await expect(
      store.consumeEgressBudget({ ...input, tenantId: 'different-tenant', units: 1 }),
    ).resolves.toEqual({ allowed: true });
  });
});
