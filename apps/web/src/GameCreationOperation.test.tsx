// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameCommandResult } from './auth-gateway.js';
import { GameCreationOperation } from './GameCreationOperation.js';
import { isCreateGameOperation } from './create-game-attempt.js';

afterEach(cleanup);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const result = {
  commandId: id,
  operation: {
    id,
    type: 'CREATE_GAME',
    status: 'SUCCEEDED',
    gameId: id,
    aggregateRevision: 1,
    createdAt: '2027-01-01T12:00:00Z',
    updatedAt: '2027-01-01T12:00:00Z',
    nextAction: { type: 'NONE' },
    error: null,
  },
  game: null,
  replayed: false,
} as const satisfies GameCommandResult;

describe('beta creation operation rendering and response boundary', () => {
  it.each(['ACCEPTED', 'PROCESSING', 'FAILED', 'UNKNOWN'] as const)(
    'renders %s without booking success',
    (status) => {
      render(<GameCreationOperation status={status} />);
      expect(screen.getByRole('status')).toHaveTextContent(/бронь корта не подтверждена/i);
    },
  );

  it('accepts only the matching create operation with explicit terminal success', () => {
    expect(isCreateGameOperation(result, id)).toBe(true);
    const changes = [
      { type: 'JOIN_GAME' },
      { id: [id] },
      { gameId: [id] },
      { gameId: { toString: () => id } },
      { status: 'UNRECOGNIZED' },
      { gameId: null },
      { aggregateRevision: null },
      { aggregateRevision: 0 },
      { error: { code: 'GAME_NOT_FOUND', message: 'bad' } },
      {
        nextAction: {
          type: 'OPEN_PAYMENT',
          url: 'https://example.test',
          expiresAt: '2027-01-01T12:05:00Z',
        },
      },
    ];
    for (const change of changes) {
      expect(
        isCreateGameOperation({
          ...result,
          operation: { ...result.operation, ...change },
        } as GameCommandResult),
      ).toBe(false);
    }
    const sharedArrayId = [id];
    expect(
      isCreateGameOperation({
        ...result,
        commandId: sharedArrayId,
        operation: { ...result.operation, id: sharedArrayId },
      } as unknown as GameCommandResult),
    ).toBe(false);
    expect(isCreateGameOperation(result, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
    expect(
      isCreateGameOperation({ ...result, commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ).toBe(false);
  });
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (n: string) => `sha256:${n.repeat(64)}`;
const time = '2027-01-01T12:00:00Z';
const binding = {
  tenantId: uuid(1),
  actorUserId: uuid(2),
  operationId: uuid(3),
  gameId: uuid(4),
  quoteId: uuid(5),
  quoteRevision: 1,
  slotId: uuid(6),
  slotVersion: 'slot-v1',
  subscriptionInstanceId: uuid(7),
  visits: 1,
  amountMinor: 12345,
  currency: 'RUB' as const,
  keySha256: digest('a'),
  intentSha256: digest('b'),
  requestSha256: digest('c'),
  bindingSha256: digest('d'),
  mappingBindingSha256: digest('e'),
  mappings: {
    actor: { tenantId: uuid(1), id: uuid(8), revision: 'actor-v1', internalId: uuid(2) },
    subscription: {
      tenantId: uuid(1),
      id: uuid(9),
      revision: 'subscription-v1',
      internalId: uuid(7),
    },
    slot: { tenantId: uuid(1), id: uuid(10), revision: 'slot-map-v1', internalId: uuid(6) },
  },
};
const receipt = { receiptRef: uuid(11), bindingSha256: digest('d'), asOf: time };
const original = { operationId: uuid(3), binding };
function partial() {
  return {
    operationId: uuid(3),
    revision: 2,
    status: 'PROCESSING',
    gameId: uuid(4),
    booking: { status: 'UNKNOWN' },
    benefit: { status: 'UNKNOWN' },
    settlement: { status: 'UNKNOWN' },
    binding,
    attempt: { id: uuid(14), state: 'UNKNOWN' },
    asOf: time,
    errorCode: null,
  };
}

describe('pinned PR388 nonfinal state rendering', () => {
  it('renders confirmed booking separately while missing benefit/settlement stay unknown', () => {
    const value = {
      ...partial(),
      booking: {
        status: 'CONFIRMED',
        bookingId: uuid(12),
        gameId: uuid(4),
        quoteId: uuid(5),
        slotId: uuid(6),
        confirmedAt: time,
        receipt,
      },
    };
    render(<GameCreationOperation booked={{ value, original }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('БронированиеПодтверждено');
    expect(status).toHaveTextContent('Применение льготыНеизвестно');
    expect(status).toHaveTextContent('РасчётНеизвестно');
    expect(status).toHaveTextContent('PROCESSING');
    expect(status).not.toHaveTextContent(/создана|успешно|бронь корта не подтверждена/i);
  });
  it('does not promote applied benefit or confirmed settlement into booking success', () => {
    render(
      <GameCreationOperation
        booked={{
          value: {
            ...partial(),
            benefit: { status: 'APPLIED', count: 1, subscriptionOperationId: uuid(13), receipt },
            settlement: {
              status: 'CONFIRMED',
              amountMinor: 12345,
              debtMinor: 0,
              currency: 'RUB',
              receipt,
            },
          },
          original,
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('БронированиеНеизвестно');
    expect(screen.getByRole('status')).toHaveTextContent('Применение льготыПрименена');
    expect(screen.getByRole('status')).toHaveTextContent('РасчётПодтверждён');
    expect(screen.getByRole('status')).toHaveTextContent('PROCESSING');
  });
  it.each(['success', 'tenant', 'quote', 'revision'] as const)(
    'refuses untrusted %s without showing confirmed legs',
    (change) => {
      const value = change === 'success' ? { ...partial(), status: 'SUCCEEDED' } : partial();
      const expected =
        change === 'tenant'
          ? { ...original, binding: { ...binding, tenantId: uuid(20) } }
          : change === 'quote'
            ? { ...original, binding: { ...binding, quoteId: uuid(20) } }
            : change === 'revision'
              ? { ...original, binding: { ...binding, quoteRevision: 2 } }
              : original;
      render(<GameCreationOperation booked={{ value, original: expected }} />);
      expect(screen.getByRole('status')).toHaveTextContent('Ответ операции не подтверждён');
      expect(screen.getByRole('status')).toHaveTextContent('UNKNOWN');
      expect(screen.getByRole('status')).not.toHaveTextContent('SUCCEEDED');
      expect(screen.getByRole('status')).not.toHaveTextContent(uuid(4));
    },
  );
});
