// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { GameJoinFlowPanel } from './GameJoinFlowPanel.js';
afterEach(cleanup);
it('explains zero due as subscription use and requires an explicit keyboard confirmation', async () => {
  const confirm = vi.fn();
  render(
    <GameJoinFlowPanel
      busy={false}
      flow={{
        kind: 'NEEDS_CONSENT',
        consent: { amountMinor: 0, currency: 'RUB' },
        subscriptionInstanceId: '00000000-0000-4000-8000-000000000001',
        revision: 1,
        expiresAt: '2099-10-21T08:00:00.000Z',
        message: '',
      }}
      onConfirmConsent={confirm}
    />,
  );
  expect(
    screen.getByText(
      'Доплата по проверенным условиям не требуется. Это использование подписки, а не бесплатная игра.',
    ),
  ).toBeVisible();
  expect(confirm).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByRole('button', { name: /^Подтвердить/ })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ amountMinor: 0, currency: 'RUB' });
});
