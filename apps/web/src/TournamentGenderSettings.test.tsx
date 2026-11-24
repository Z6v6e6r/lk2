// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentGenderSettings } from './TournamentGenderSettings.js';

afterEach(cleanup);

it('loads the setting and saves an explicit choice against its current version', async () => {
  const load = vi.fn().mockResolvedValue({ gender: null, version: 0 });
  const save = vi.fn().mockResolvedValue({ gender: 'FEMALE', version: 1 });
  const user = userEvent.setup();
  render(<TournamentGenderSettings load={load} save={save} />);
  const field = await screen.findByLabelText('Пол');
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  await user.selectOptions(field, 'FEMALE');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(save).toHaveBeenCalledWith({ gender: 'FEMALE', expectedVersion: 0 });
  expect(await screen.findByText('Пол сохранён.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
});
