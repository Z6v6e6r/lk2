// @vitest-environment jsdom

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferRead, runWhenIdle } from './deferred-idle.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('runWhenIdle', () => {
  it('defers the task to the idle window and cancels it on request', () => {
    const cancel = vi.fn();
    const idle = vi.fn(() => 7);
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', cancel);
    const task = vi.fn();

    const cancelTask = runWhenIdle(task, 1_500);

    expect(idle).toHaveBeenCalledWith(task, { timeout: 1_500 });
    expect(task).not.toHaveBeenCalled();
    cancelTask();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('still runs the task when the platform has no requestIdleCallback', async () => {
    vi.useFakeTimers();
    const task = vi.fn();

    runWhenIdle(task);

    expect(task).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('starts the read only after the idle window and forwards its value', async () => {
    const idleTasks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (task: () => void) => {
      idleTasks.push(task);
      return idleTasks.length;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const start = vi.fn().mockResolvedValue('profile');

    const pending = deferRead(start);
    expect(start).not.toHaveBeenCalled();

    act(() => {
      for (const task of idleTasks.splice(0)) task();
    });

    await expect(pending).resolves.toBe('profile');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('forwards a failed deferred read to the caller', async () => {
    const idleTasks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (task: () => void) => {
      idleTasks.push(task);
      return idleTasks.length;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    const pending = deferRead(() => Promise.reject(new Error('PROFILE_UNAVAILABLE')));
    act(() => {
      for (const task of idleTasks.splice(0)) task();
    });

    await expect(pending).rejects.toThrow('PROFILE_UNAVAILABLE');
  });

  it('never starts a deferred read whose screen went away', () => {
    const idleTasks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (task: () => void) => {
      idleTasks.push(task);
      return idleTasks.length;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const start = vi.fn().mockResolvedValue('profile');

    void deferRead(start, { shouldStart: () => false });
    act(() => {
      for (const task of idleTasks.splice(0)) task();
    });

    expect(start).not.toHaveBeenCalled();
  });

  it('starts a deferred read while its screen is still mounted', async () => {
    const idleTasks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (task: () => void) => {
      idleTasks.push(task);
      return idleTasks.length;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const start = vi.fn().mockResolvedValue('communities');
    let mounted = true;

    const pending = deferRead(start, { shouldStart: () => mounted });
    act(() => {
      for (const task of idleTasks.splice(0)) task();
    });

    await expect(pending).resolves.toBe('communities');
    mounted = false;
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not run a cancelled fallback task', async () => {
    vi.useFakeTimers();
    const task = vi.fn();

    runWhenIdle(task)();
    await vi.runAllTimersAsync();

    expect(task).not.toHaveBeenCalled();
  });
});
