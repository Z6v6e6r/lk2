import { expect, it, vi } from 'vitest';
import { createMobileReadState } from './mobile-read-cache.js';

it('rejects a pending success after denial even before the first snapshot has reached the UI', async () => {
  const observe = vi.fn();
  const remount = vi.fn();
  const state = createMobileReadState(observe, remount);
  let resolve!: (data: object) => void;
  const old = state.read(
    '/locations',
    () =>
      new Promise<object>((done) => {
        resolve = done;
      }),
  );
  state.observe({ path: '/locations', state: 'stale', savedAt: 1 });
  state.observe({ path: '/locations', state: 'unavailable', invalidate: true });
  resolve({ items: ['old'] });
  await expect(old).rejects.toThrow('NATIVE_READ_SUPERSEDED');
  expect(observe).not.toHaveBeenCalled();
  expect(remount).not.toHaveBeenCalled();
  state.observe({ path: '/locations', state: 'unavailable', invalidate: true });
  expect(remount).not.toHaveBeenCalled();
  state.observe({ path: '/locations', state: 'live' });
  await expect(state.read('/locations', () => Promise.resolve({ items: [] }))).resolves.toEqual({
    items: [],
  });
  expect(observe).toHaveBeenCalledWith({ path: '/locations', state: 'live' });
});

it('does not delete the next generation observation when an obsolete read fails late', async () => {
  const observe = vi.fn();
  const state = createMobileReadState(observe, vi.fn());
  let reject!: (error: Error) => void;
  const old = state.read(
    '/locations',
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  state.observe({ path: '/locations', state: 'unavailable', invalidate: true });
  state.observe({ path: '/locations', state: 'stale', savedAt: 2 });
  reject(new Error('Old parse failed'));
  await expect(old).rejects.toThrow('Old parse failed');
  await state.read('/locations', () => Promise.resolve({}));
  expect(observe).toHaveBeenCalledWith({ path: '/locations', state: 'stale', savedAt: 2 });
});
