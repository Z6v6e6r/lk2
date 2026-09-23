import { describe, expect, it } from 'vitest';

import { stationLogoKey, stationLogoUrl } from './station-avatar.js';

describe('station logo lookup', () => {
  it('finds artwork for every station title shipped with a logo', () => {
    const titles = [
      ['Нагатинская', 'nagatinskaya.webp'],
      ['Нагатинская Премиум', 'nagatinskaya-premium.webp'],
      ['Питер', 'piter.webp'],
      ['Селигерская', 'seligerskaya.webp'],
      ['Сколково', 'skolkovo.webp'],
      ['Терехово', 'terehovo.webp'],
      ['Ясенево', 'yasenevo.webp'],
    ] as const;

    for (const [title, file] of titles) {
      expect(stationLogoUrl(title), `${title} must resolve to its own artwork`).toContain(file);
    }
  });

  it('compares titles case-, ё- and whitespace-insensitively', () => {
    expect(stationLogoKey('  ЯСЕНЕВО ')).toBe('ясенево');
    // A typographic non-breaking space reaches the client from the editorial station list.
    expect(stationLogoKey('Нагатинская\u00a0Премиум')).toBe('нагатинская премиум');
    expect(stationLogoUrl('Тёрехово')).toBe(stationLogoUrl('Терехово'));
  });

  it('maps every Санкт-Петербург spelling onto the same artwork', () => {
    expect(stationLogoUrl('Санкт-Петербург')).toBe(stationLogoUrl('Питер'));
    expect(stationLogoUrl('Санкт-Петербург-2')).toBe(stationLogoUrl('Питер'));
  });

  it('returns null for a station without artwork instead of borrowing another logo', () => {
    expect(stationLogoUrl('Сочи')).toBeNull();
    expect(stationLogoUrl('Тестовая станция')).toBeNull();
    expect(stationLogoUrl('')).toBeNull();
  });
});
