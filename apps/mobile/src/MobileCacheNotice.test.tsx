// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MobileCacheNotice } from './MobileCacheNotice.js';
import { observeMobileCache } from './mobile-read-cache.js';

afterEach(cleanup);
const home = '/user/api/v1/local-padel/home/base';
const locations = '/user/api/v1/local-padel/locations';
const savedAt = Date.parse('2026-09-27T18:00:00.000Z');

it('announces retained sections and their actual fetch timestamp without claiming offline authorization', () => {
  const { rerender } = render(
    <MobileCacheNotice stale={{ [home]: savedAt, [locations]: savedAt }} />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Показана сохранённая копия');
  expect(screen.getByRole('status')).toHaveTextContent('Главная');
  expect(screen.getByRole('status')).toHaveTextContent('Локации');
  expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-09-27T18:00:00.000Z');
  const afterHome = observeMobileCache(
    { [home]: savedAt, [locations]: savedAt },
    { path: home, state: 'live' },
  );
  rerender(<MobileCacheNotice stale={afterHome} />);
  expect(screen.getByRole('status')).not.toHaveTextContent('Главная');
  expect(screen.getByRole('status')).toHaveTextContent('Локации');
  rerender(
    <MobileCacheNotice
      stale={observeMobileCache(afterHome, { path: locations, state: 'unavailable' })}
    />,
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('does not slide a stale timestamp and ignores invalid time observations', () => {
  const state = observeMobileCache({}, { path: home, state: 'stale', savedAt });
  expect(observeMobileCache(state, { path: home, state: 'stale', savedAt })).toEqual(state);
  expect(observeMobileCache(state, { path: locations, state: 'stale', savedAt: NaN })).toEqual(
    state,
  );
  expect(observeMobileCache(state, { path: home, state: 'fresh-cache', savedAt })).toEqual({});
});
