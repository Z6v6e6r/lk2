import {
  CommunityEventGapExpiredError,
  type CommunityRealtimeEvent,
  type CommunityRealtimeEventPage,
} from '@phub/api-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createCommunityDurableEventController } from './community-durable-event-controller.js';

const communityId = '11111111-1111-4111-8111-111111111111';

function event(sequence: number): CommunityRealtimeEvent {
  return {
    communityId,
    sequence,
    eventType: 'community.post.edited.v1',
    targetType: 'POST',
    targetId: '22222222-2222-4222-8222-222222222222',
    targetRevision: sequence,
    targetStatus: 'PUBLISHED',
    occurredAt: '2026-08-04T12:00:00.000Z',
  };
}

function page(
  afterSequence: number,
  items: readonly CommunityRealtimeEvent[],
  latestSequence: number,
  hasMore = false,
): CommunityRealtimeEventPage {
  const last = items.at(-1);
  return {
    items: [...items],
    afterSequence,
    latestSequence,
    retainedFromSequence: 1,
    ...(last ? { nextAfterSequence: last.sequence } : {}),
    hasMore,
  };
}

describe('Community durable event controller', () => {
  it('recovers every page after the stored cursor and emits ordered canonical triggers', async () => {
    const recoverCommunityEvents = vi
      .fn()
      .mockResolvedValueOnce(page(4, [event(5), event(6)], 7, true))
      .mockResolvedValueOnce(page(6, [event(7)], 7));
    const applied: number[] = [];
    const controller = createCommunityDurableEventController({
      gateway: { recoverCommunityEvents },
      onCanonicalEventBatch: ({ events }) => {
        applied.push(...events.map((recovered) => recovered.sequence));
        return Promise.resolve();
      },
      reloadCanonicalState: vi.fn(),
    });
    controller.setLastSequence(communityId, 4);

    await controller.handleHint({ communityId, sequence: 7 });

    expect(recoverCommunityEvents).toHaveBeenNthCalledWith(1, communityId, {
      afterSequence: 4,
      limit: 100,
    });
    expect(recoverCommunityEvents).toHaveBeenNthCalledWith(2, communityId, {
      afterSequence: 6,
      limit: 100,
    });
    expect(applied).toEqual([5, 6, 7]);
    expect(controller.getLastSequence(communityId)).toBe(7);
  });

  it('coalesces concurrent hints and never applies hint payload as canonical state', async () => {
    let release: ((value: CommunityRealtimeEventPage) => void) | undefined;
    const recoverCommunityEvents = vi.fn(
      () =>
        new Promise<CommunityRealtimeEventPage>((resolve) => {
          release = resolve;
        }),
    );
    const onCanonicalEventBatch = vi.fn().mockResolvedValue(undefined);
    const controller = createCommunityDurableEventController({
      gateway: { recoverCommunityEvents },
      onCanonicalEventBatch,
      reloadCanonicalState: vi.fn(),
    });

    const first = controller.handleHint({ communityId, sequence: 1 });
    const second = controller.handleHint({ communityId, sequence: 2 });
    expect(recoverCommunityEvents).toHaveBeenCalledTimes(1);
    release?.(page(0, [event(1), event(2)], 2));
    await Promise.all([first, second]);

    expect(onCanonicalEventBatch).toHaveBeenCalledTimes(1);
    expect(onCanonicalEventBatch).toHaveBeenCalledWith({
      communityId,
      events: [event(1), event(2)],
    });
    expect(controller.getLastSequence(communityId)).toBe(2);
  });

  it('does not advance the cursor when the canonical page refresh fails', async () => {
    const controller = createCommunityDurableEventController({
      gateway: {
        recoverCommunityEvents: vi.fn().mockResolvedValue(page(4, [event(5), event(6)], 6)),
      },
      onCanonicalEventBatch: vi.fn().mockRejectedValue(new Error('canonical feed unavailable')),
      reloadCanonicalState: vi.fn(),
    });
    controller.setLastSequence(communityId, 4);

    await expect(controller.handleHint({ communityId, sequence: 6 })).rejects.toThrow(
      'canonical feed unavailable',
    );
    expect(controller.getLastSequence(communityId)).toBe(4);
  });

  it('turns a hot recovery page of 100 events into one awaited canonical refresh', async () => {
    const events = Array.from({ length: 100 }, (_, index) => event(index + 1));
    const onCanonicalEventBatch = vi.fn().mockResolvedValue(undefined);
    const controller = createCommunityDurableEventController({
      gateway: {
        recoverCommunityEvents: vi.fn().mockResolvedValue(page(0, events, 100)),
      },
      onCanonicalEventBatch,
      reloadCanonicalState: vi.fn(),
    });

    await controller.handleHint({ communityId, sequence: 100 });

    expect(onCanonicalEventBatch).toHaveBeenCalledOnce();
    expect(onCanonicalEventBatch).toHaveBeenCalledWith({ communityId, events });
    expect(controller.getLastSequence(communityId)).toBe(100);
  });

  it('clears the cursor, reloads detail/feed/media and resumes at latest after an expired gap', async () => {
    const reloadCanonicalState = vi.fn().mockResolvedValue(undefined);
    const controller = createCommunityDurableEventController({
      gateway: {
        recoverCommunityEvents: vi
          .fn()
          .mockRejectedValue(new CommunityEventGapExpiredError('expired', 'correlation', 40, 20)),
      },
      onCanonicalEventBatch: vi.fn(),
      reloadCanonicalState: async (request) => {
        expect(controller.getLastSequence(communityId)).toBe(0);
        await reloadCanonicalState(request);
      },
    });
    controller.setLastSequence(communityId, 4);

    await controller.handleHint({ communityId, sequence: 41 });

    expect(reloadCanonicalState).toHaveBeenCalledWith({
      communityId,
      reason: 'GAP_EXPIRED',
      scopes: ['DETAIL', 'FEED', 'MEDIA'],
      latestSequence: 40,
      retainedFromSequence: 20,
    });
    expect(controller.getLastSequence(communityId)).toBe(40);
  });

  it('keeps the cursor cleared when canonical reload fails', async () => {
    const controller = createCommunityDurableEventController({
      gateway: {
        recoverCommunityEvents: vi
          .fn()
          .mockRejectedValue(new CommunityEventGapExpiredError('expired', 'correlation', 40, 20)),
      },
      onCanonicalEventBatch: vi.fn(),
      reloadCanonicalState: vi.fn().mockRejectedValue(new Error('feed unavailable')),
    });
    controller.setLastSequence(communityId, 4);

    await expect(controller.handleHint({ communityId, sequence: 41 })).rejects.toThrow(
      'feed unavailable',
    );
    expect(controller.getLastSequence(communityId)).toBe(0);
  });

  it('fails closed to a canonical reload when a recovery page is not contiguous', async () => {
    const reloadCanonicalState = vi.fn().mockResolvedValue(undefined);
    const controller = createCommunityDurableEventController({
      gateway: { recoverCommunityEvents: vi.fn().mockResolvedValue(page(4, [event(6)], 6)) },
      onCanonicalEventBatch: vi.fn(),
      reloadCanonicalState,
    });
    controller.setLastSequence(communityId, 4);

    await controller.handleHint({ communityId, sequence: 6 });

    expect(reloadCanonicalState).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId,
        reason: 'SEQUENCE_DISCONTINUITY',
        scopes: ['DETAIL', 'FEED', 'MEDIA'],
        latestSequence: 6,
      }),
    );
    expect(controller.getLastSequence(communityId)).toBe(6);
  });

  it('ignores a stale hint at or behind the committed cursor', async () => {
    const recoverCommunityEvents = vi.fn();
    const controller = createCommunityDurableEventController({
      gateway: { recoverCommunityEvents },
      onCanonicalEventBatch: vi.fn(),
      reloadCanonicalState: vi.fn(),
    });
    controller.setLastSequence(communityId, 12);

    await controller.handleHint({ communityId, sequence: 12 });

    expect(recoverCommunityEvents).not.toHaveBeenCalled();
  });

  it('does not repopulate a cursor after the community is reset during recovery', async () => {
    let release: ((value: CommunityRealtimeEventPage) => void) | undefined;
    const onCanonicalEventBatch = vi.fn().mockResolvedValue(undefined);
    const controller = createCommunityDurableEventController({
      gateway: {
        recoverCommunityEvents: vi.fn(
          () =>
            new Promise<CommunityRealtimeEventPage>((resolve) => {
              release = resolve;
            }),
        ),
      },
      onCanonicalEventBatch,
      reloadCanonicalState: vi.fn(),
    });

    const recovery = controller.handleHint({ communityId, sequence: 1 });
    controller.resetCommunity(communityId);
    release?.(page(0, [event(1)], 1));
    await recovery;

    expect(onCanonicalEventBatch).not.toHaveBeenCalled();
    expect(controller.getLastSequence(communityId)).toBe(0);
  });
});
