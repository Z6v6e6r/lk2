import type { StationSupportDialog, StationSupportStation } from '../auth-gateway.js';

export interface StationChatRow {
  readonly key: string;
  readonly title: string;
  readonly preview: string;
  readonly hasHistory: boolean;
  readonly updatedAt: string | null;
  readonly selected: boolean;
  readonly dialogId: string | null;
  readonly stationId: string | null;
}

function matchesQuery(title: string, preview: string, normalizedQuery: string): boolean {
  return [title, preview].some((value) =>
    value.toLocaleLowerCase('ru-RU').includes(normalizedQuery),
  );
}

/** Timestamps arrive as ISO strings from the provider and can be absent, so unreadable means oldest. */
function recency(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every published station is a chat destination from the start: the client picks a station and the
 * first message opens their own dialog with it. A station that already has a dialog shows that
 * dialog's last message and opens the existing history; a dialog the published list cannot map (an
 * unassigned or unpublished station) stays at the end so existing history is never hidden.
 */
export function stationChatRows(input: {
  readonly stations: readonly StationSupportStation[];
  readonly dialogs: readonly StationSupportDialog[];
  readonly query: string;
  readonly selectedDialogId: string | null;
  readonly selectedStationId: string | null;
}): readonly StationChatRow[] {
  const normalizedQuery = input.query.trim().toLocaleLowerCase('ru-RU');
  const dialogByStation = new Map<string, StationSupportDialog>();
  for (const dialog of input.dialogs) {
    if (dialog.stationId) dialogByStation.set(dialog.stationId, dialog);
  }
  const rows: StationChatRow[] = [];
  for (const station of input.stations) {
    const dialog = dialogByStation.get(station.id) ?? null;
    if (dialog) dialogByStation.delete(station.id);
    const preview = dialog?.lastMessage?.preview ?? 'Начните переписку';
    if (normalizedQuery && !matchesQuery(station.name, preview, normalizedQuery)) continue;
    rows.push({
      key: dialog?.id ?? `station:${station.id}`,
      title: station.name,
      preview,
      hasHistory: dialog?.lastMessage != null,
      updatedAt: dialog?.updatedAt ?? null,
      selected: dialog
        ? dialog.id === input.selectedDialogId
        : station.id === input.selectedStationId,
      dialogId: dialog?.id ?? null,
      stationId: station.id,
    });
  }
  const publishedStationIds = new Set(input.stations.map((station) => station.id));
  for (const dialog of input.dialogs) {
    if (dialog.stationId && publishedStationIds.has(dialog.stationId)) continue;
    const preview = dialog.lastMessage?.preview ?? 'Обращение к станции';
    if (normalizedQuery && !matchesQuery(dialog.stationName, preview, normalizedQuery)) continue;
    rows.push({
      key: dialog.id,
      title: dialog.stationName,
      preview,
      hasHistory: dialog.lastMessage != null,
      updatedAt: dialog.updatedAt,
      selected: dialog.id === input.selectedDialogId,
      dialogId: dialog.id,
      stationId: null,
    });
  }
  return rows;
}

export interface StationHistoryRow {
  readonly key: string;
  readonly dialogId: string;
  readonly title: string;
  readonly preview: string;
  readonly updatedAt: string | null;
}

/**
 * The station dialogs that already carry correspondence, newest first. The unfiltered "Все" tab
 * shows them next to the LK2 conversations, so an answer that is already waiting is never hidden
 * behind the station tab; a station without history stays a station-tab destination where the first
 * message can still be started.
 */
export function stationHistoryRows(input: {
  readonly dialogs: readonly StationSupportDialog[];
  readonly query: string;
}): readonly StationHistoryRow[] {
  const normalizedQuery = input.query.trim().toLocaleLowerCase('ru-RU');
  return input.dialogs
    .filter((dialog) => dialog.lastMessage != null)
    .filter(
      (dialog) =>
        !normalizedQuery ||
        matchesQuery(dialog.stationName, dialog.lastMessage?.preview ?? '', normalizedQuery),
    )
    .map((dialog) => ({
      key: dialog.id,
      dialogId: dialog.id,
      title: dialog.stationName,
      preview: dialog.lastMessage?.preview ?? '',
      updatedAt: dialog.updatedAt,
    }))
    .sort((left, right) => recency(right.updatedAt) - recency(left.updatedAt));
}
