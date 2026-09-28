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

  it('shows the game roster as an avatar stack, never an open join slot', () => {
    const { container } = render(
      <ChatAvatar
        isGame
        title="Игра"
        participants={[
          {
            userId: '11111111-1111-4111-8111-111111111111',
            displayName: 'Анна',
            role: 'ORGANIZER',
            avatarUrl: photoUrl,
            level: 'C+',
            levelValue: 3.44,
          },
          {
            userId: '22222222-2222-4222-8222-222222222222',
            displayName: 'Борис Кузнецов',
            role: 'PLAYER',
          },
        ]}
      />,
    );

    const stack = container.querySelector('.chat-game-stack');
    expect(stack).not.toBeNull();
    expect(stack?.querySelectorAll('.participant-avatar-stack__item')).toHaveLength(2);
    expect(stack?.querySelector('img')).toHaveAttribute('src', photoUrl);
    expect(stack?.querySelector('.participant-avatar-stack__open-slot')).toBeNull();
    expect(screen.getByText('БК')).toBeInTheDocument();
  });

  it('doubles the roster stack only where the row asks for it', () => {
    const participants = [
      {
        userId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Анна',
        role: 'ORGANIZER' as const,
      },
      {
        userId: '22222222-2222-4222-8222-222222222222',
        displayName: 'Борис',
        role: 'PLAYER' as const,
      },
    ];
    const compact = render(<ChatAvatar isGame title="Игра" participants={participants} />);
    expect(compact.container.querySelector('.chat-game-stack')).not.toBeNull();
    expect(compact.container.querySelector('.chat-game-stack-wide')).toBeNull();
    compact.unmount();

    // The chat list asks for the doubled circles; the thread header keeps the compact stack.
    const wide = render(<ChatAvatar isGame title="Игра" participants={participants} wideStack />);
    expect(wide.container.querySelector('.chat-game-stack-wide')).not.toBeNull();
    expect(wide.container.querySelectorAll('.participant-avatar-stack__item')).toHaveLength(2);
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
