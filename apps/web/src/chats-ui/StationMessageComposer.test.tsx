// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  StationMessageComposer,
  type StationMessageComposerProps,
} from './StationMessageComposer.js';
import type { StationMessageReceipt } from '../auth-gateway.js';
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const id = '11111111-1111-4111-8111-111111111111';
const unknown = (requestId: string): StationMessageReceipt => ({
  contractVersion: 1,
  contract: 'station-message',
  requestId,
  outcome: 'UNKNOWN',
  code: 'MESSAGE_RECEIPT_UNPROVEN',
});
const confirmed = (requestId: string, body: string): StationMessageReceipt => ({
  contractVersion: 1,
  contract: 'station-message',
  requestId,
  outcome: 'CONFIRMED',
  message: {
    id: '22222222-2222-8222-8222-222222222222',
    body,
    sentAt: '2026-11-01T00:00:00.000Z',
    author: { displayName: 'Player' },
    isViewer: true,
  },
});
function props(): StationMessageComposerProps {
  return {
    scope: 'tenant/user',
    communityId: id,
    eligible: true,
    send: vi.fn<StationMessageComposerProps['send']>((_community, request) =>
      Promise.resolve(unknown(request.requestId)),
    ),
    status: vi.fn<StationMessageComposerProps['status']>((_community, key) =>
      Promise.resolve(unknown(key)),
    ),
    onConfirmed: vi.fn(),
    onAccessDenied: vi.fn(),
  };
}
async function send(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
}
describe('actual station message composer handlers', () => {
  it('keeps original keys after unknown, edit, return to old text; reload performs GET only', async () => {
    const p = props();
    const view = render(<StationMessageComposer {...p} />);
    await send('original');
    await send('edited');
    await send('original');
    const calls = vi.mocked(p.send).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2]?.[1].requestId).toBe(calls[0]?.[1].requestId);
    expect(calls[1]?.[1].requestId).not.toBe(calls[0]?.[1].requestId);
    expect(Object.values(sessionStorage).join()).not.toContain('original');
    expect(Object.values(sessionStorage).join()).not.toContain('edited');
    view.unmount();
    render(<StationMessageComposer {...p} />);
    await waitFor(() => expect(p.status).toHaveBeenCalledTimes(2));
    expect(p.send).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(vi.mocked(p.status).mock.calls.map((c) => c[1])).toEqual([
      calls[0]![1].requestId,
      calls[1]![1].requestId,
    ]);
  });
  it('late confirmation does not clear a newer draft and only clears its original receipt', async () => {
    const p = props();
    let resolve!: (value: StationMessageReceipt) => void;
    vi.mocked(p.send).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<StationMessageComposer {...p} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(p.send).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'newer draft' } });
    await act(() => {
      resolve(confirmed(vi.mocked(p.send).mock.calls[0]![1].requestId, 'first'));
      return Promise.resolve();
    });
    // Confirmation also awaits WebCrypto validation of the original body hash.
    // Flushing a microtask does not wait for that native asynchronous operation.
    await waitFor(() => expect(p.onConfirmed).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('newer draft');
    expect(screen.queryByText(/Ожидают подтверждения:/)).not.toBeInTheDocument();
  });
  it.each([403, 404, 503])(
    'status %i retains original custody and never retries POST',
    async (status) => {
      const p = props();
      const view = render(<StationMessageComposer {...p} />);
      await send('unknown');
      view.unmount();
      vi.mocked(p.status).mockRejectedValue({ status });
      render(<StationMessageComposer {...p} />);
      await waitFor(() => expect(p.status).toHaveBeenCalledOnce());
      expect(p.send).toHaveBeenCalledOnce();
      expect(screen.getByText(/Ожидают подтверждения: 1/)).toBeVisible();
      if (status !== 503) expect(p.onAccessDenied).toHaveBeenCalledOnce();
    },
  );
  it('does not use another account/community custody or accept malformed receipt', async () => {
    const p = props();
    vi.mocked(p.send).mockResolvedValue({ outcome: 'CONFIRMED' } as StationMessageReceipt);
    const view = render(<StationMessageComposer {...p} />);
    await send('hello');
    expect(p.onConfirmed).not.toHaveBeenCalled();
    view.unmount();
    render(<StationMessageComposer {...p} scope="tenant/other" />);
    await act(() => Promise.resolve());
    expect(p.status).not.toHaveBeenCalled();
  });
});

it('unmount/logout drops late confirmed ACK and retains original metadata for later GET restore', async () => {
  const p = props();
  let finish!: (value: StationMessageReceipt) => void;
  vi.mocked(p.send).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<StationMessageComposer {...p} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'original' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  await waitFor(() => expect(p.send).toHaveBeenCalledOnce());
  const key = vi.mocked(p.send).mock.calls[0]![1].requestId;
  view.unmount();
  await act(() => {
    finish(confirmed(key, 'original'));
    return Promise.resolve();
  });
  expect(p.onConfirmed).not.toHaveBeenCalled();
  render(<StationMessageComposer {...p} />);
  await waitFor(() => expect(p.status).toHaveBeenCalledWith(id, key));
  expect(p.send).toHaveBeenCalledOnce();
});

it('GET receipt with correct UUID but wrong original body cannot erase metadata or display confirmation', async () => {
  const p = props();
  const view = render(<StationMessageComposer {...p} />);
  await send('original');
  view.unmount();
  vi.mocked(p.status).mockImplementation((_community, key) =>
    Promise.resolve(confirmed(key, 'other body')),
  );
  render(<StationMessageComposer {...p} />);
  await waitFor(() => expect(p.status).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Проверить статус' })).toBeEnabled(),
  );
  expect(p.onConfirmed).not.toHaveBeenCalled();
  expect(screen.getByText(/Ожидают подтверждения: 1/)).toBeInTheDocument();
});
