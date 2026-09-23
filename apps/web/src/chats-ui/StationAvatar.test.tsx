// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StationAvatar } from './StationAvatar.js';
import { stationLogoUrl } from './station-avatar.js';

afterEach(cleanup);

describe('StationAvatar', () => {
  it('renders the station artwork for a published station title', () => {
    const { container } = render(<StationAvatar title="Ясенево" />);

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', stationLogoUrl('Ясенево'));
    expect(image).toHaveAttribute('alt', '');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('keeps the frame and falls back to the station marker for a title without artwork', () => {
    const { container } = render(<StationAvatar title="Сочи" />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('stays decorative, because the station name is the row text next to it', () => {
    const { container } = render(<StationAvatar title="Нагатинская Премиум" />);

    const frame = container.querySelector('span');
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      stationLogoUrl('Нагатинская Премиум'),
    );
  });
});
