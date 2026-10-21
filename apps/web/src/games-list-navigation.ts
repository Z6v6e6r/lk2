/** Navigation preferences only: never persist cards, participants, prices or opaque API cursors. */
export interface GamesListNavigation {
  readonly tab: 'DISCOVER' | 'UPCOMING';
  readonly selectedKinds: readonly ('GAME' | 'COACH_GAME' | 'TOURNAMENT')[];
  readonly selectedStationIds: readonly string[];
  readonly selectedDate: string | null;
  readonly levelRange: 'ALL' | 'D_C_PLUS' | 'C_C_PLUS' | 'C_B_PLUS' | 'B_A';
  readonly ownLevelFilter: 'D' | 'D+' | 'C' | 'C+' | 'B' | 'B+' | 'A' | null;
  readonly startsAfter: 'ALL' | '18:00';
  readonly includeFull: boolean;
  readonly filtersOpen: boolean;
  readonly pages: number;
  readonly scrollY: number;
}

export function readGamesListNavigation(key: string): GamesListNavigation | null {
  try {
    const saved = JSON.parse(
      window.sessionStorage.getItem(key) ?? 'null',
    ) as GamesListNavigation | null;
    if (
      !saved ||
      !['DISCOVER', 'UPCOMING'].includes(saved.tab) ||
      !Array.isArray(saved.selectedKinds) ||
      !saved.selectedKinds.every(
        (kind: unknown) =>
          typeof kind === 'string' && ['GAME', 'COACH_GAME', 'TOURNAMENT'].includes(kind),
      ) ||
      !Array.isArray(saved.selectedStationIds) ||
      !saved.selectedStationIds.every(
        (id: unknown) =>
          typeof id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
      ) ||
      !(saved.selectedDate === null || /^\d{4}-\d{2}-\d{2}$/.test(saved.selectedDate)) ||
      !['ALL', 'D_C_PLUS', 'C_C_PLUS', 'C_B_PLUS', 'B_A'].includes(saved.levelRange) ||
      !(
        saved.ownLevelFilter === null ||
        ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'].includes(saved.ownLevelFilter)
      ) ||
      !['ALL', '18:00'].includes(saved.startsAfter) ||
      typeof saved.includeFull !== 'boolean' ||
      typeof saved.filtersOpen !== 'boolean' ||
      !Number.isSafeInteger(saved.pages) ||
      saved.pages < 1 ||
      !Number.isFinite(saved.scrollY) ||
      saved.scrollY < 0
    )
      return null;
    return saved;
  } catch {
    return null;
  }
}

export function saveGamesListNavigation(key: string, state: GamesListNavigation): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Navigation still works when browser storage is unavailable.
  }
}
