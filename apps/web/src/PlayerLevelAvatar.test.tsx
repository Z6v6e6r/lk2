// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';
import { AVATAR_BACKGROUND_URLS, avatarBackgroundIndex } from './avatar-backgrounds.js';

afterEach(cleanup);

describe('PlayerLevelAvatar', () => {
  it('renders the Figma base proportions, mask, and four six-degree-separated segments', () => {
    render(<PlayerLevelAvatar alt="Игрок" level="D+" progress={75} />);

    const avatar = screen.getByRole('img', {
      name: 'Игрок, уровень D+, прогресс 75%',
    });
    const segments = avatar.querySelectorAll('[data-player-level-segment]');

    expect(avatar).toHaveAttribute('data-size', '48');
    expect(avatar).toHaveAttribute('data-progress', '75');
    expect(avatar).toHaveStyle({ '--player-level-avatar-scale': '1' });
    expect(segments).toHaveLength(4);
    expect(segments[0]?.querySelector('path')?.getAttribute('d')).toContain('A 24 24');
    expect(segments[0]?.querySelector('path')?.getAttribute('d')).toContain('A 22 22');
    expect(segments[0]?.querySelector('path')?.getAttribute('d')).toContain('M 22.744 47.967');
    expect(segments[0]).toHaveAttribute('data-segment-progress', '1');
    expect(segments[1]).toHaveAttribute('data-segment-progress', '1');
    expect(segments[2]).toHaveAttribute('data-segment-progress', '1');
    expect(segments[3]).toHaveAttribute('data-segment-progress', '0');
    expect(avatar.querySelector('[data-player-level-badge]')).toHaveTextContent('D+');
    expect(avatar.querySelector('g[mask]')).toHaveAttribute(
      'mask',
      expect.stringMatching(/^url\(#player-level-avatar-ring-/),
    );
    const badgeClearance = avatar.querySelector('mask rect[fill="#000"]');
    expect(badgeClearance).toHaveAttribute('x', '12');
    expect(badgeClearance).toHaveAttribute('y', '37');
    expect(badgeClearance).toHaveAttribute('width', '24');
    expect(badgeClearance).toHaveAttribute('height', '16');
  });

  it.each(['D', 'D+', 'C+'])('renders the %s level without changing the layout', (level) => {
    render(<PlayerLevelAvatar alt={`Игрок ${level}`} level={level} />);

    const avatar = screen.getByRole('img', {
      name: `Игрок ${level}, уровень ${level}, прогресс 0%`,
    });
    expect(avatar.querySelector('[data-player-level-badge]')).toHaveTextContent(level);
    expect(avatar.querySelectorAll('[data-player-level-segment]')).toHaveLength(4);
  });

  it('fills the current segment proportionally while keeping every background segment visible', () => {
    render(<PlayerLevelAvatar alt="Игрок 62" level="C" progress={62} />);

    const avatar = screen.getByRole('img', {
      name: 'Игрок 62, уровень C, прогресс 62%',
    });
    const segments = avatar.querySelectorAll('[data-player-level-segment]');

    expect(segments[0]).toHaveAttribute('data-segment-progress', '1');
    expect(segments[1]).toHaveAttribute('data-segment-progress', '1');
    expect(segments[2]).toHaveAttribute('data-segment-progress', '0.48');
    expect(segments[3]).toHaveAttribute('data-segment-progress', '0');
    expect(segments[0]?.querySelectorAll('path')).toHaveLength(2);
    expect(segments[1]?.querySelectorAll('path')).toHaveLength(2);
    expect(segments[2]?.querySelectorAll('path')).toHaveLength(2);
    expect(segments[3]?.querySelectorAll('path')).toHaveLength(1);
  });

  it('clamps invalid progress values to the supported range', () => {
    const { rerender } = render(
      <PlayerLevelAvatar alt="Верхняя граница" level="C" progress={150} />,
    );

    expect(
      screen.getByRole('img', { name: 'Верхняя граница, уровень C, прогресс 100%' }),
    ).toHaveAttribute('data-progress', '100');

    rerender(<PlayerLevelAvatar alt="Нижняя граница" level="C" progress={-10} />);
    expect(
      screen.getByRole('img', { name: 'Нижняя граница, уровень C, прогресс 0%' }),
    ).toHaveAttribute('data-progress', '0');

    rerender(<PlayerLevelAvatar alt="Некорректное значение" level="C" progress={Number.NaN} />);
    expect(
      screen.getByRole('img', { name: 'Некорректное значение, уровень C, прогресс 0%' }),
    ).toHaveAttribute('data-progress', '0');
  });

  it('scales all base proportions through one coefficient', () => {
    render(<PlayerLevelAvatar alt="Игрок 64" level="B+" size={64} />);

    const avatar = screen.getByRole('img', {
      name: 'Игрок 64, уровень B+, прогресс 0%',
    });
    expect(avatar).toHaveAttribute('data-size', '64');
    expect(avatar).toHaveStyle({ '--player-level-avatar-scale': `${64 / 48}` });
  });

  it('uses the project fallback for an absent or failed source', () => {
    const fallbackSeed = 'player-42';
    const { rerender } = render(
      <PlayerLevelAvatar alt="Без фото" fallbackSeed={fallbackSeed} src={null} />,
    );

    const fallbackAvatar = screen.getByRole('img', {
      name: 'Без фото, уровень , прогресс 0%',
    });
    const fallbackPhoto = fallbackAvatar.querySelector('[data-player-level-photo]');
    expect(fallbackPhoto).toHaveAttribute('data-player-level-photo', 'fallback');
    expect(fallbackPhoto).toHaveAttribute(
      'data-avatar-background',
      String(avatarBackgroundIndex(fallbackSeed) + 1),
    );
    expect(fallbackPhoto?.getAttribute('src')).toMatch(/padel_avatar_bg_\d{2}\.png$/);
    expect(fallbackAvatar.querySelector('[data-avatar-initials]')).toHaveTextContent('БФ');

    rerender(<PlayerLevelAvatar alt="Ошибка фото" src="/broken-avatar.png" />);
    const failedPhoto = screen
      .getByRole('img', { name: 'Ошибка фото, уровень , прогресс 0%' })
      .querySelector('[data-player-level-photo]');
    expect(failedPhoto).toHaveAttribute('data-player-level-photo', 'source');

    fireEvent.error(failedPhoto!);

    expect(
      screen
        .getByRole('img', { name: 'Ошибка фото, уровень , прогресс 0%' })
        .querySelector('[data-player-level-photo]'),
    ).toHaveAttribute('data-player-level-photo', 'fallback');
  });

  it('uses the participant placeholder when a participant has no photo', () => {
    render(
      <PlayerLevelAvatar
        alt="Иван Петров"
        level="D+"
        progress={87}
        src={null}
        variant="participant"
      />,
    );

    const avatar = screen.getByRole('img', {
      name: 'Иван Петров, уровень D+, прогресс 87%',
    });
    const photo = avatar.querySelector('[data-player-level-photo]');
    expect(photo).toHaveAttribute('data-player-level-photo', 'fallback');
    expect(photo?.getAttribute('src')).toMatch(/padel_avatar_bg_\d{2}\.png$/);
    expect(avatar.querySelector('[data-avatar-initials]')).toHaveTextContent('ИП');
  });

  it('selects a stable fallback from all twenty supplied backgrounds', () => {
    expect(AVATAR_BACKGROUND_URLS).toHaveLength(20);
    expect(new Set(AVATAR_BACKGROUND_URLS).size).toBe(20);
    expect(avatarBackgroundIndex('player-42')).toBe(avatarBackgroundIndex('player-42'));
    expect(
      new Set(Array.from({ length: 200 }, (_, index) => avatarBackgroundIndex(`player-${index}`)))
        .size,
    ).toBe(20);
  });

  it('keeps an empty level and a custom class layout-safe', () => {
    render(<PlayerLevelAvatar alt="Без уровня" className="profile-slot" level="" />);

    const avatar = screen.getByRole('img', {
      name: 'Без уровня, уровень , прогресс 0%',
    });
    expect(avatar).toHaveClass('profile-slot');
    expect(avatar.querySelector('[data-player-level-badge]')).not.toBeInTheDocument();
  });
});
