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
