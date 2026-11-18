// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Component, lazy, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { DeferredScreen } from './App.js';

afterEach(cleanup);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('DeferredScreen', () => {
  it('shows its fallback while the screen chunk loads and then the screen', async () => {
    const chunk = deferred<{ default: () => ReactNode }>();
    const Screen = lazy(() => chunk.promise);

    render(
      <DeferredScreen fallback={<p role="status">Открываем экран…</p>}>
        <Screen />
      </DeferredScreen>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Открываем экран…');
    chunk.resolve({ default: () => <p>Экран загружен</p> });
    expect(await screen.findByText('Экран загружен')).toBeVisible();
  });

  it('keeps the opened screen state when the parent re-renders', async () => {
    // A CREATE/JOIN/purchase screen must not lose a pending attempt because an unrelated state
    // update happened in App while its lazy chunk was already resolved.
    function Counter(): ReactNode {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          шагов: {count}
        </button>
      );
    }
    const chunk = deferred<{ default: () => ReactNode }>();
    const LazyCounter = lazy(() => chunk.promise);
    const user = userEvent.setup();

    function Parent({ tick }: { tick: number }): ReactNode {
      return (
        <div data-tick={tick}>
          <DeferredScreen>
            <LazyCounter />
          </DeferredScreen>
        </div>
      );
    }

    const view = render(<Parent tick={0} />);
    chunk.resolve({ default: () => <Counter /> });
    const button = await screen.findByRole('button', { name: /шагов: 0/ });
    await user.click(button);
    expect(screen.getByRole('button', { name: /шагов: 1/ })).toBeVisible();

    view.rerender(<Parent tick={1} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /шагов: 1/ })).toBeVisible());
    expect(screen.getByRole('button', { name: /шагов: 1/ })).not.toHaveTextContent('шагов: 0');
  });

  it('surfaces a failed chunk load to an error boundary instead of hiding it', async () => {
    let rejectChunk: (error: Error) => void = () => undefined;
    const chunk = new Promise<{ default: () => ReactNode }>((_resolve, reject) => {
      rejectChunk = reject;
    });
    const Broken = lazy(() => chunk);
    class Boundary extends Component<{ children: ReactNode }, { message: string }> {
      override state = { message: '' };
      static getDerivedStateFromError(error: Error): { message: string } {
        return { message: error.message };
      }
      override render(): ReactNode {
        if (this.state.message) return <p role="alert">{this.state.message}</p>;
        return this.props.children;
      }
    }

    render(
      <Boundary>
        <DeferredScreen fallback={<p role="status">Открываем экран…</p>}>
          <Broken />
        </DeferredScreen>
      </Boundary>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Открываем экран…');

    // React delivers the rejected lazy import to the boundary above the deferred screen.
    void rejectChunk(new Error('CHUNK_LOAD_FAILED'));

    expect(await screen.findByRole('alert')).toHaveTextContent('CHUNK_LOAD_FAILED');
  });
});
