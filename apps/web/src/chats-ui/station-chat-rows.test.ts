import { describe, expect, it } from 'vitest';

import type { StationSupportDialog } from '../auth-gateway.js';
import { stationChatRows, stationHistoryRows } from './station-chat-rows.js';

const yasenevo = '9b993668-ff54-4cce-8dfd-cad84c4a06fa';
const nagatinskaya = '11111111-1111-4111-8111-111111111111';
const yasenevoDialog = '33333333-3333-4333-8333-333333333333';
const unmappedDialog = '44444444-4444-4444-8444-444444444444';

const stations = [
  { id: yasenevo, name: 'Ясенево' },
  { id: nagatinskaya, name: 'Нагатинская' },
];

function dialog(overrides: Partial<StationSupportDialog> = {}): StationSupportDialog {
  return {
    id: yasenevoDialog,
    stationId: yasenevo,
    stationName: 'Ясенево',
    status: 'OPEN',
    updatedAt: '2026-09-22T10:00:00.000Z',
    lastMessage: {
      preview: 'Когда свободен корт?',
      author: 'STATION',
      createdAt: '2026-09-22T10:00:00.000Z',
    },
    ...overrides,
  };
}

function rows(input: {
  readonly dialogs?: readonly StationSupportDialog[];
  readonly query?: string;
  readonly selectedDialogId?: string | null;
  readonly selectedStationId?: string | null;
}) {
  return stationChatRows({
    stations,
    dialogs: input.dialogs ?? [],
    query: input.query ?? '',
    selectedDialogId: input.selectedDialogId ?? null,
    selectedStationId: input.selectedStationId ?? null,
  });
}

describe('station chat rows', () => {
  it('offers every published station before any dialog exists', () => {
    const result = rows({});
    expect(result.map((row) => row.title)).toEqual(['Ясенево', 'Нагатинская']);
    for (const row of result) {
      expect(row.preview).toBe('Начните переписку');
      expect(row.hasHistory).toBe(false);
      expect(row.dialogId).toBeNull();
      expect(row.stationId).not.toBeNull();
      expect(row.selected).toBe(false);
    }
  });

  it('attaches an existing dialog to its station and marks the open thread', () => {
    const result = rows({ dialogs: [dialog()], selectedDialogId: yasenevoDialog });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      title: 'Ясенево',
      preview: 'Когда свободен корт?',
      hasHistory: true,
      dialogId: yasenevoDialog,
      selected: true,
    });
    expect(result[1]).toMatchObject({ title: 'Нагатинская', dialogId: null, selected: false });
  });

  it('marks a station without history as the selected destination', () => {
    const result = rows({ selectedStationId: nagatinskaya });
    expect(result.map((row) => row.selected)).toEqual([false, true]);
  });

  it('keeps a dialog that the published station list cannot map', () => {
    const result = rows({
      dialogs: [dialog({ id: unmappedDialog, stationId: null, stationName: 'Без станции' })],
    });
    expect(result.map((row) => row.title)).toEqual(['Ясенево', 'Нагатинская', 'Без станции']);
    expect(result[2]).toMatchObject({
      preview: 'Когда свободен корт?',
      hasHistory: true,
      dialogId: unmappedDialog,
      stationId: null,
    });
  });

  it('keeps a dialog for an unpublished station instead of hiding its history', () => {
    const result = rows({
      dialogs: [dialog({ id: unmappedDialog, stationId: 'archived-station', stationName: 'Сочи' })],
    });
    expect(result.map((row) => row.title)).toEqual(['Ясенево', 'Нагатинская', 'Сочи']);
    expect(result[2]?.dialogId).toBe(unmappedDialog);
  });

  it('filters stations and unmapped dialogs by name or preview', () => {
    const dialogs = [
      dialog(),
      dialog({
        id: unmappedDialog,
        stationId: null,
        stationName: 'Сочи',
        lastMessage: {
          preview: 'Обращение в Сочи',
          author: 'STATION',
          createdAt: '2026-09-22T11:00:00.000Z',
        },
      }),
    ];
    expect(rows({ dialogs, query: 'нагат' }).map((row) => row.title)).toEqual(['Нагатинская']);
    expect(rows({ dialogs, query: 'КОРТ' }).map((row) => row.title)).toEqual(['Ясенево']);
    expect(rows({ dialogs, query: 'сочи' }).map((row) => row.title)).toEqual(['Сочи']);
    expect(rows({ dialogs, query: '  ' }).map((row) => row.title)).toEqual([
      'Ясенево',
      'Нагатинская',
      'Сочи',
    ]);
    expect(rows({ dialogs, query: 'ничего' })).toEqual([]);
  });
});

describe('station history rows for the unfiltered tab', () => {
  it('keeps only the dialogs that already have correspondence', () => {
    const result = stationHistoryRows({
      dialogs: [dialog(), dialog({ id: unmappedDialog, stationId: null, lastMessage: null })],
      query: '',
    });

    expect(result.map((row) => row.dialogId)).toEqual([yasenevoDialog]);
    expect(result[0]).toMatchObject({
      title: 'Ясенево',
      preview: 'Когда свободен корт?',
      updatedAt: '2026-09-22T10:00:00.000Z',
    });
  });

  it('orders the newest answer first so the tab reads like the conversation list', () => {
    const result = stationHistoryRows({
      dialogs: [
        dialog({ id: yasenevoDialog, updatedAt: '2026-09-20T10:00:00.000Z' }),
        dialog({
          id: unmappedDialog,
          stationId: null,
          stationName: 'Сочи',
          updatedAt: '2026-09-23T10:00:00.000Z',
        }),
      ],
      query: '',
    });

    expect(result.map((row) => row.title)).toEqual(['Сочи', 'Ясенево']);
  });

  it('searches the same fields the station list searches', () => {
    const dialogs = [
      dialog(),
      dialog({
        id: unmappedDialog,
        stationId: null,
        stationName: 'Сочи',
        lastMessage: {
          preview: 'Нужен тренер',
          author: 'STATION',
          createdAt: '2026-09-22T11:00:00.000Z',
        },
      }),
    ];

    expect(stationHistoryRows({ dialogs, query: 'ЯСЕН' }).map((row) => row.title)).toEqual([
      'Ясенево',
    ]);
    expect(stationHistoryRows({ dialogs, query: 'корт' }).map((row) => row.title)).toEqual([
      'Ясенево',
    ]);
    expect(stationHistoryRows({ dialogs, query: 'тренер' }).map((row) => row.title)).toEqual([
      'Сочи',
    ]);
    expect(stationHistoryRows({ dialogs, query: 'ничего' })).toEqual([]);
  });

  it('sinks a dialog without a readable timestamp instead of hiding it', () => {
    const result = stationHistoryRows({
      dialogs: [
        dialog({ id: unmappedDialog, updatedAt: null }),
        dialog({ id: yasenevoDialog, updatedAt: '2026-09-22T10:00:00.000Z' }),
      ],
      query: '',
    });

    expect(result.map((row) => row.dialogId)).toEqual([yasenevoDialog, unmappedDialog]);
  });
});
