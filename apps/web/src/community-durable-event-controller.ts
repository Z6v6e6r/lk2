import {
  CommunityEventGapExpiredError,
  type CommunityRealtimeEvent,
  type CommunityRealtimeEventPage,
} from '@phub/api-sdk';

const RECOVERY_PAGE_LIMIT = 100;
const CANONICAL_RELOAD_SCOPES = ['DETAIL', 'FEED', 'MEDIA'] as const;

export interface CommunityDurableEventHint {
  readonly communityId: string;
  readonly sequence: number;
}

export interface CommunityEventRecoveryGateway {
  recoverCommunityEvents(
    communityId: string,
    input: { readonly afterSequence: number; readonly limit: number },
  ): Promise<CommunityRealtimeEventPage>;
}

export interface CommunityEventCursorStore {
  get(communityId: string): number | undefined;
  set(communityId: string, sequence: number): void;
  delete(communityId: string): void;
  clear(): void;
}

export interface CommunityCanonicalEventBatch {
  readonly communityId: string;
  readonly events: readonly CommunityRealtimeEvent[];
}

export interface CommunityCanonicalReloadRequest {
  readonly communityId: string;
  readonly reason: 'GAP_EXPIRED' | 'SEQUENCE_DISCONTINUITY';
  readonly scopes: typeof CANONICAL_RELOAD_SCOPES;
  readonly latestSequence: number;
  readonly retainedFromSequence: number;
}

export interface CommunityDurableEventController {
  getLastSequence(communityId: string): number;
  setLastSequence(communityId: string, sequence: number): void;
  handleHint(hint: CommunityDurableEventHint): Promise<void>;
  recover(communityId: string): Promise<void>;
  resetCommunity(communityId: string): void;
  clear(): void;
}

interface CommunityRecoveryState {
  requestedSequence: number;
  active: boolean;
  running?: Promise<void>;
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('COMMUNITY_EVENT_SEQUENCE_INVALID');
  }
}

function createCursorStore(): CommunityEventCursorStore {
  const cursors = new Map<string, number>();
  return {
    get: (communityId) => cursors.get(communityId),
    set: (communityId, sequence) => cursors.set(communityId, sequence),
    delete: (communityId) => cursors.delete(communityId),
    clear: () => cursors.clear(),
  };
}

function gapMetadata(
  error: unknown,
): { readonly latestSequence: number; readonly retainedFromSequence: number } | undefined {
  if (error instanceof CommunityEventGapExpiredError) {
    return {
      latestSequence: error.latestSequence,
      retainedFromSequence: error.retainedFromSequence,
    };
  }
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'COMMUNITY_EVENT_GAP_EXPIRED' ||
    !('recoveryAction' in error) ||
    error.recoveryAction !== 'FULL_CANONICAL_RELOAD' ||
    !('latestSequence' in error) ||
    !('retainedFromSequence' in error) ||
    !Number.isSafeInteger(error.latestSequence) ||
    !Number.isSafeInteger(error.retainedFromSequence) ||
    (error.latestSequence as number) < 0 ||
    (error.retainedFromSequence as number) < 1
  ) {
    return undefined;
  }
  return {
    latestSequence: error.latestSequence as number,
    retainedFromSequence: error.retainedFromSequence as number,
  };
}

export function createCommunityDurableEventController(options: {
  readonly gateway: CommunityEventRecoveryGateway;
  readonly onCanonicalEventBatch: (batch: CommunityCanonicalEventBatch) => Promise<void>;
  readonly reloadCanonicalState: (request: CommunityCanonicalReloadRequest) => Promise<void>;
  readonly cursorStore?: CommunityEventCursorStore;
}): CommunityDurableEventController {
  const cursors = options.cursorStore ?? createCursorStore();
  const states = new Map<string, CommunityRecoveryState>();

  const lastSequence = (communityId: string): number => cursors.get(communityId) ?? 0;

  const canonicalReload = async (
    state: CommunityRecoveryState,
    communityId: string,
    reason: CommunityCanonicalReloadRequest['reason'],
    latestSequence: number,
    retainedFromSequence: number,
  ): Promise<void> => {
    if (!state.active) return;
    assertSequence(latestSequence);
    if (!Number.isSafeInteger(retainedFromSequence) || retainedFromSequence < 1) {
      throw new Error('COMMUNITY_EVENT_RETAINED_SEQUENCE_INVALID');
    }
    // Clearing first prevents a failed reload from preserving a cursor whose canonical state is
    // no longer available. The cursor advances only after every requested canonical scope loads.
    cursors.delete(communityId);
    await options.reloadCanonicalState({
      communityId,
      reason,
      scopes: CANONICAL_RELOAD_SCOPES,
      latestSequence,
      retainedFromSequence,
    });
    if (state.active) cursors.set(communityId, latestSequence);
  };

  const recoverPages = async (
    state: CommunityRecoveryState,
    communityId: string,
  ): Promise<'RECOVERED' | 'CANONICAL_RELOADED' | 'CANCELLED'> => {
    let afterSequence = lastSequence(communityId);
    while (state.active) {
      let page: CommunityRealtimeEventPage;
      try {
        page = await options.gateway.recoverCommunityEvents(communityId, {
          afterSequence,
          limit: RECOVERY_PAGE_LIMIT,
        });
        if (!state.active) return 'CANCELLED';
      } catch (error) {
        if (!state.active) return 'CANCELLED';
        const gap = gapMetadata(error);
        if (!gap) throw error;
        await canonicalReload(
          state,
          communityId,
          'GAP_EXPIRED',
          gap.latestSequence,
          gap.retainedFromSequence,
        );
        return 'CANONICAL_RELOADED';
      }

      if (
        page.afterSequence !== afterSequence ||
        page.latestSequence < afterSequence ||
        page.retainedFromSequence < 1
      ) {
        throw new Error('COMMUNITY_EVENT_RECOVERY_PAGE_INVALID');
      }

      let expectedSequence = afterSequence + 1;
      const recoveredEvents: CommunityRealtimeEvent[] = [];
      for (const event of page.items) {
        if (
          event.communityId !== communityId ||
          event.sequence !== expectedSequence ||
          event.sequence > page.latestSequence
        ) {
          await canonicalReload(
            state,
            communityId,
            'SEQUENCE_DISCONTINUITY',
            page.latestSequence,
            page.retainedFromSequence,
          );
          return 'CANONICAL_RELOADED';
        }
        recoveredEvents.push(event);
        afterSequence = event.sequence;
        expectedSequence += 1;
      }
      if (recoveredEvents.length > 0) {
        // A recovered page is one invalidation batch. The awaited canonical refresh prevents a
        // hot page of 100 identifier-only events from causing 100 feed reloads, and the cursor
        // advances only after that canonical refresh succeeds.
        await options.onCanonicalEventBatch({ communityId, events: recoveredEvents });
        if (!state.active) return 'CANCELLED';
        cursors.set(communityId, afterSequence);
      }

      if (page.hasMore) {
        if (page.items.length === 0 || page.nextAfterSequence !== afterSequence) {
          await canonicalReload(
            state,
            communityId,
            'SEQUENCE_DISCONTINUITY',
            page.latestSequence,
            page.retainedFromSequence,
          );
          return 'CANONICAL_RELOADED';
        }
        continue;
      }
      if (afterSequence !== page.latestSequence) {
        await canonicalReload(
          state,
          communityId,
          'SEQUENCE_DISCONTINUITY',
          page.latestSequence,
          page.retainedFromSequence,
        );
        return 'CANONICAL_RELOADED';
      }
      return 'RECOVERED';
    }
    return 'CANCELLED';
  };

  const scheduleRecovery = (communityId: string, requestedSequence: number): Promise<void> => {
    const state = states.get(communityId) ?? { requestedSequence: 0, active: true };
    state.requestedSequence = Math.max(state.requestedSequence, requestedSequence);
    states.set(communityId, state);
    if (state.running) return state.running;
    const running = (async () => {
      while (state.active && lastSequence(communityId) < state.requestedSequence) {
        const before = lastSequence(communityId);
        const result = await recoverPages(state, communityId);
        if (result !== 'RECOVERED') return;
        if (lastSequence(communityId) <= before) return;
      }
    })();
    const tracked = running.finally(() => {
      if (state.running === tracked) delete state.running;
    });
    state.running = tracked;
    return tracked;
  };

  return {
    getLastSequence: lastSequence,
    setLastSequence(communityId, sequence) {
      assertSequence(sequence);
      cursors.set(communityId, sequence);
    },
    handleHint(hint) {
      assertSequence(hint.sequence);
      if (hint.sequence <= lastSequence(hint.communityId)) return Promise.resolve();
      return scheduleRecovery(hint.communityId, hint.sequence);
    },
    recover(communityId) {
      return scheduleRecovery(communityId, lastSequence(communityId) + 1);
    },
    resetCommunity(communityId) {
      const state = states.get(communityId);
      if (state) state.active = false;
      cursors.delete(communityId);
      states.delete(communityId);
    },
    clear() {
      for (const state of states.values()) state.active = false;
      cursors.clear();
      states.clear();
    },
  };
}
