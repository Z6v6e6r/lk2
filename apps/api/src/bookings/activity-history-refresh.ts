import { createHash } from 'node:crypto';

import type {
  ActivityHistoryRepository,
  ActivityHistorySyncState,
  PersistActivityHistoryItemInput,
  PersistActivityHistorySyncInput,
} from '@phub/database';
import { localVivaExerciseAssociationId } from '@phub/legacy-games-adapter';
import type { VivaBookingHistoryPage, VivaBookingHistorySourcePort } from '@phub/viva-adapter';

import type { ActivityHistoryRefreshService } from './activity-history-routes.js';

export interface ActivityHistoryRefreshCoordinatorOptions {
  readonly repository: ActivityHistoryRepository;
  readonly source: VivaBookingHistorySourcePort;
  readonly getAccessToken: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }) => Promise<string>;
  readonly pageSize: number;
  readonly freshSeconds: number;
  readonly backfillGames?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly exerciseOccurrences: readonly {
      readonly exerciseExternalId: string;
      readonly startsAt: string;
    }[];
    readonly now: Date;
  }) => Promise<unknown>;
  readonly readLocalGames?: (input: {
    readonly tenantId: string;
    readonly userId: string;
  }) => Promise<
    readonly {
      readonly id: string;
      readonly revision: number;
      readonly displayState: string;
      readonly title: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly station: { readonly name: string };
      readonly deepLink: string;
    }[]
  >;
  readonly now?: () => Date;
}

function revision(page: VivaBookingHistoryPage): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        page: page.page,
        size: page.size,
        totalElements: page.totalElements,
        records: page.records,
      }),
    )
    .digest('hex');
}

function providerPage(
  state: ActivityHistorySyncState,
  reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE',
) {
  if (reason !== 'NEXT_PAGE') return 0;
  const parsed = Number(state.nextProviderCursor);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('ACTIVITY_HISTORY_CURSOR_INVALID');
  return parsed;
}

function oldestCoveredAt(
  state: ActivityHistorySyncState,
  page: VivaBookingHistoryPage,
): string | undefined {
  const candidates = [state.oldestSyncedAt, ...page.records.map((record) => record.startsAt)]
    .filter((value): value is string => typeof value === 'string')
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return candidates[0];
}

function syncInput(input: {
  readonly state: ActivityHistorySyncState;
  readonly page: VivaBookingHistoryPage;
  readonly reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
  readonly now: Date;
  readonly freshSeconds: number;
  readonly sourceRevision: string;
}): PersistActivityHistorySyncInput {
  const oldestSyncedAt = oldestCoveredAt(input.state, input.page);
  const common: {
    readonly lastSuccessAt: string;
    readonly staleAt: string;
    readonly oldestSyncedAt?: string;
    readonly sourceRevision: string;
  } = {
    lastSuccessAt: input.now.toISOString(),
    staleAt: new Date(input.now.getTime() + input.freshSeconds * 1_000).toISOString(),
    ...(oldestSyncedAt ? { oldestSyncedAt } : {}),
    sourceRevision: input.sourceRevision,
  };
  if (input.reason === 'STALE' && input.state.coverageStatus === 'COMPLETE') {
    return { ...common, coverageStatus: 'COMPLETE' };
  }
  if (
    input.reason === 'STALE' &&
    input.state.coverageStatus === 'PARTIAL' &&
    input.state.nextProviderCursor
  ) {
    return {
      ...common,
      coverageStatus: 'PARTIAL',
      nextProviderCursor: input.state.nextProviderCursor,
    };
  }
  if (input.page.isLastPage || input.page.nextPage === null) {
    return { ...common, coverageStatus: 'COMPLETE' };
  }
  return {
    ...common,
    coverageStatus: 'PARTIAL',
    nextProviderCursor: String(input.page.nextPage),
  };
}

function safeErrorCode(error: unknown): string {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  const candidate = typeof rawCode === 'string' ? rawCode : '';
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(candidate) ? candidate : 'ACTIVITY_HISTORY_REFRESH_FAILED';
}

function exerciseAssociationId(exerciseRef: string | undefined): string | undefined {
  if (!exerciseRef) return undefined;
  try {
    return localVivaExerciseAssociationId(exerciseRef);
  } catch {
    return undefined;
  }
}

export class ActivityHistoryRefreshCoordinator implements ActivityHistoryRefreshService {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  public constructor(private readonly options: ActivityHistoryRefreshCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public refresh(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
  }): Promise<void> {
    const key = `${input.tenantId}:${input.userId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const operation = this.run(input).finally(() => {
      if (this.inflight.get(key) === operation) this.inflight.delete(key);
    });
    this.inflight.set(key, operation);
    return operation;
  }

  private async run(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly reason: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
  }): Promise<void> {
    try {
      const state = await this.options.repository.getSyncState({
        tenantId: input.tenantId,
        userId: input.userId,
      });
      const accessToken = await this.options.getAccessToken(input);
      const page = await this.options.source.readPage({
        accessToken,
        correlationId: input.correlationId,
        page: providerPage(state, input.reason),
        size: this.options.pageSize,
      });
      const fetchedAt = this.now();
      const sourceRevision = revision(page);
      const items: PersistActivityHistoryItemInput[] = [];
      const supersededItemIds = new Set<string>();
      const exerciseOccurrences = page.records.flatMap((record) =>
        record.kind === 'GAME' && record.sourceRef.exerciseRef
          ? [
              {
                exerciseExternalId: record.sourceRef.exerciseRef,
                startsAt: record.startsAt,
              },
            ]
          : [],
      );
      if (this.options.backfillGames && exerciseOccurrences.length > 0) {
        await this.options.backfillGames({
          tenantId: input.tenantId,
          userId: input.userId,
          correlationId: input.correlationId,
          exerciseOccurrences,
          now: fetchedAt,
        });
      }
      const localGames =
        input.reason !== 'NEXT_PAGE' && this.options.readLocalGames
          ? await this.options.readLocalGames({
              tenantId: input.tenantId,
              userId: input.userId,
            })
          : [];
      const localGameIds = new Set(localGames.map((game) => game.id));
      const recordAssociationIds = new Map<string, string>();
      if (localGames.length > 0) {
        for (const record of page.records) {
          if (record.kind !== 'GAME') continue;
          const associationId = exerciseAssociationId(record.sourceRef.exerciseRef);
          if (associationId) recordAssociationIds.set(record.sourceRef.bookingRef, associationId);
        }
      }
      const associatedGames = new Map(
        (
          await this.options.repository.resolveVivaExerciseGameAssociations({
            tenantId: input.tenantId,
            associationIds: [...recordAssociationIds.values()],
          })
        ).map((association) => [association.associationId, association.gameId]),
      );
      for (const record of page.records) {
        const associatedGameId = associatedGames.get(
          recordAssociationIds.get(record.sourceRef.bookingRef) ?? '',
        );
        if (
          record.kind === 'GAME' &&
          associatedGameId !== undefined &&
          localGameIds.has(associatedGameId)
        ) {
          const mapping = await this.options.repository.resolveSourceMapping({
            tenantId: input.tenantId,
            externalSystem: 'VIVA',
            entityType: 'booking_history',
            externalId: record.sourceRef.bookingRef,
            externalVersion: sourceRevision,
            syncedAt: fetchedAt.toISOString(),
          });
          supersededItemIds.add(mapping.internalId);
          continue;
        }
        const mapping = await this.options.repository.resolveSourceMapping({
          tenantId: input.tenantId,
          externalSystem: 'VIVA',
          entityType: 'booking_history',
          externalId: record.sourceRef.bookingRef,
          externalVersion: sourceRevision,
          syncedAt: fetchedAt.toISOString(),
        });
        const subtitle = [record.venue.room, record.venue.address].filter(Boolean).join(' · ');
        items.push({
          id: mapping.internalId,
          kind: record.kind,
          status: record.status,
          occurredAt: record.startsAt,
          startsAt: record.startsAt,
          ...(record.endsAt ? { endsAt: record.endsAt } : {}),
          title: record.title,
          venueName: record.venue.name,
          integrationMappingId: mapping.mappingId,
          details: subtitle ? { subtitle } : {},
          sourceRevision,
          syncedAt: fetchedAt.toISOString(),
        });
      }
      if (input.reason !== 'NEXT_PAGE') {
        for (const game of localGames) {
          items.push({
            id: game.id,
            kind: 'GAME',
            status: game.displayState === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED',
            occurredAt: game.startsAt,
            startsAt: game.startsAt,
            endsAt: game.endsAt,
            title: game.title,
            venueName: game.station.name,
            route: game.deepLink,
            gameId: game.id,
            details: { game },
            sourceRevision: `game:${game.revision}`,
            syncedAt: fetchedAt.toISOString(),
          });
        }
      }
      await this.options.repository.persistPage({
        tenantId: input.tenantId,
        userId: input.userId,
        items,
        ...(supersededItemIds.size > 0 ? { supersededItemIds: [...supersededItemIds] } : {}),
        sync: syncInput({
          state,
          page,
          reason: input.reason,
          now: fetchedAt,
          freshSeconds: this.options.freshSeconds,
          sourceRevision,
        }),
      });
    } catch (error) {
      await this.options.repository
        .recordSyncFailure({
          tenantId: input.tenantId,
          userId: input.userId,
          errorCode: safeErrorCode(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
