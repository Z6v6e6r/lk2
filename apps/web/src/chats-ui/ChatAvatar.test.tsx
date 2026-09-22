// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatAvatar } from './ChatAvatar.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const deliveryId = 'f3d1c0e4-1111-4111-8111-111111111111';
const photoUrl = `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`;

afterEach(cleanup);

describe('ChatAvatar', () => {
  it('renders the stored profile photo for a direct participant', () => {
    const { container } = render(<ChatAvatar isGame={false} title="Борис" photoUrl={photoUrl} />);

    const photo = container.querySelector('img');
    expect(photo).toHaveAttribute('src', photoUrl);
    expect(photo).toHaveAttribute('alt', '');
    expect(screen.queryByText('Б')).not.toBeInTheDocument();
  });

  it('renders initials when the participant has no stored photo', () => {
    const { container } = render(<ChatAvatar isGame={false} title="Борис Кузнецов" />);

    expect(container.querySelector('img')).toHaveAttribute('data-player-level-photo', 'fallback');
    expect(screen.getByText('БК')).toBeInTheDocument();
  });

  it('keeps the game category icon and ignores a participant photo', () => {
    const { container } = render(<ChatAvatar isGame title="Игра" photoUrl={photoUrl} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to initials when the delivery URL fails to load', () => {
    const { container } = render(<ChatAvatar isGame={false} title="Борис" photoUrl={photoUrl} />);

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).toHaveAttribute('data-player-level-photo', 'fallback');
    expect(screen.getByText('Б')).toBeInTheDocument();
  });

  it('renders the level badge and fractional progress for an assessed participant', () => {
    const { container } = render(
      <ChatAvatar isGame={false} title="Борис" photoUrl={photoUrl} level="C+" levelValue={3.44} />,
    );

    expect(container.querySelector('[data-player-level-badge]')).toHaveTextContent('C+');
    expect(container.querySelector('[data-player-level-avatar]')).toHaveAttribute(
      'data-progress',
      '44',
    );
  });

  it('uses the shared participant avatar variant so the level accent reaches the ring', () => {
    const { container } = render(
      <ChatAvatar isGame={false} title="Борис" photoUrl={photoUrl} level="C+" levelValue={3.44} />,
    );

    const avatar = container.querySelector<HTMLElement>('[data-player-level-avatar]');
    // The accent and the participant frame are applied only for variant="participant".
    expect(avatar?.style.getPropertyValue('--player-level-avatar-accent')).toBe('#f0925f');
  });
});
