import type { LegacyGameImportRepository } from '@phub/database';
import {
  localVivaExerciseAssociationId,
  localVivaProfileAssociationId,
  type LegacyGameSourceSnapshot,
} from '@phub/legacy-games-adapter';

export interface ActivityHistoryGameBackfillResult {
  readonly requested: number;
  readonly matched: number;
  readonly imported: number;
  readonly existing: number;
  readonly viewerBound: boolean;
}

export interface ActivityHistoryGameBackfillOptions {
  readonly tenantKey: string;
  readonly source: {
    readByVivaExerciseIds(input: {
      readonly exerciseExternalIds: readonly string[];
      readonly limit: number;
      readonly viewerPhoneE164?: string;
    }): Promise<readonly LegacyGameSourceSnapshot[]>;
  };
  readonly repository: LegacyGameImportRepository;
  readonly projectGameCard: (input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly gameId: string;
  }) => Promise<unknown>;
}

/**
 * Viva proves which historical exercises belong to the authenticated viewer. CUP supplies the
 * matching full game aggregate. Import and projection are idempotent, while all provider IDs stay
 * inside the two server adapters.
 */
export class ActivityHistoryGameBackfill {
  public constructor(private readonly options: ActivityHistoryGameBackfillOptions) {}

  public async run(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly exerciseExternalIds: readonly string[];
    readonly now: Date;
  }): Promise<ActivityHistoryGameBackfillResult> {
    const exerciseExternalIds = [...new Set(input.exerciseExternalIds.map((id) => id.trim()))]
      .filter(Boolean)
      .slice(0, 100);
    if (exerciseExternalIds.length === 0) {
      return { requested: 0, matched: 0, imported: 0, existing: 0, viewerBound: false };
    }
    const lifecycleRefreshed = await this.options.repository.refreshVivaExerciseGameLifecycles({
      tenantId: input.tenantId,
      vivaExerciseAssociationIds: exerciseExternalIds.map(localVivaExerciseAssociationId),
      correlationId: input.correlationId,
      now: input.now,
    });
    for (const game of lifecycleRefreshed) {
      await this.options.projectGameCard({
        tenantId: input.tenantId,
        eventId: game.projectionEventId,
        gameId: game.gameId,
      });
    }
    const viewerPhoneE164 = await this.options.repository.resolveViewerPhoneE164({
      tenantId: input.tenantId,
      userId: input.userId,
    });
    const snapshots = await this.options.source.readByVivaExerciseIds({
      exerciseExternalIds,
      limit: exerciseExternalIds.length,
      ...(viewerPhoneE164 ? { viewerPhoneE164 } : {}),
    });
    if (snapshots.length === 0) {
      return {
        requested: exerciseExternalIds.length,
        matched: 0,
        imported: 0,
        existing: 0,
        viewerBound: false,
      };
    }

    const vivaProfileExternalId = await this.options.repository.resolveVivaProfileExternalId({
      tenantId: input.tenantId,
      userId: input.userId,
    });
    const vivaProfileAssociationId = vivaProfileExternalId
      ? localVivaProfileAssociationId(vivaProfileExternalId)
      : undefined;
    const provenViewerAssociations = new Map<string, 'VIVA_PROFILE' | 'VIEWER_PHONE'>();
    for (const snapshot of snapshots) {
      if (
        snapshot.viewerParticipantExternalId &&
        snapshot.participants.some(
          (participant) => participant.externalId === snapshot.viewerParticipantExternalId,
        )
      ) {
        provenViewerAssociations.set(snapshot.viewerParticipantExternalId, 'VIEWER_PHONE');
      }
      if (
        vivaProfileAssociationId &&
        snapshot.participants.some(
          (participant) => participant.externalId === vivaProfileAssociationId,
        )
      ) {
        if (!provenViewerAssociations.has(vivaProfileAssociationId)) {
          provenViewerAssociations.set(vivaProfileAssociationId, 'VIVA_PROFILE');
        }
      }
    }
    const participantUserBindings = [...provenViewerAssociations].map(
      ([externalId, proofKind]) => ({
        externalId,
        userId: input.userId,
        proofKind,
      }),
    );
    const viewerBound = participantUserBindings.length > 0;
    const imported = await this.options.repository.importSnapshots({
      tenantKey: this.options.tenantKey,
      snapshots,
      correlationId: input.correlationId,
      ...(viewerBound ? { participantUserBindings } : {}),
      now: input.now,
    });
    if (imported.tenantId !== input.tenantId) {
      throw new Error('ACTIVITY_HISTORY_GAME_BACKFILL_TENANT_MISMATCH');
    }
    for (const game of [...imported.imported, ...imported.existing]) {
      await this.options.projectGameCard({
        tenantId: imported.tenantId,
        eventId: game.projectionEventId,
        gameId: game.gameId,
      });
    }
    return {
      requested: exerciseExternalIds.length,
      matched: snapshots.length,
      imported: imported.imported.length,
      existing: imported.existing.length,
      viewerBound,
    };
  }
}
