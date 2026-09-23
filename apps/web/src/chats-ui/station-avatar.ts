import nagatinskayaPremiumUrl from '../assets/stations/nagatinskaya-premium.webp';
import nagatinskayaUrl from '../assets/stations/nagatinskaya.webp';
import piterUrl from '../assets/stations/piter.webp';
import seligerskayaUrl from '../assets/stations/seligerskaya.webp';
import siriusUrl from '../assets/stations/sirius.webp';
import skolkovoUrl from '../assets/stations/skolkovo.webp';
import terehovoUrl from '../assets/stations/terehovo.webp';
import yasenevoUrl from '../assets/stations/yasenevo.webp';

/**
 * Station titles are tenant-owned editorial copy, not an identifier, so this is a presentation map
 * over the published names: a renamed or newly published station keeps the generic station marker
 * instead of borrowing another station's artwork. The legacy LK1 cabinet keyed the same artwork by
 * the same titles.
 */
const STATION_LOGO_URLS: Readonly<Record<string, string>> = {
  нагатинская: nagatinskayaUrl,
  'нагатинская премиум': nagatinskayaPremiumUrl,
  // The published beta title is «Питер»; the asset is drawn for Санкт-Петербург.
  питер: piterUrl,
  'санкт-петербург': piterUrl,
  'санкт-петербург-2': piterUrl,
  селигерская: seligerskayaUrl,
  // The same court is published as «Сириус» in the station list and as «Сочи» in the CUP station
  // table, so both titles resolve to its artwork.
  сириус: siriusUrl,
  'сириус сочи': siriusUrl,
  сколково: skolkovoUrl,
  сочи: siriusUrl,
  терехово: terehovoUrl,
  ясенево: yasenevoUrl,
};

/**
 * Compares titles the way the station list search does: case-, ё- and whitespace-insensitive, so
 * «Нагатинская  Премиум» with a typographic space still finds its artwork.
 */
export function stationLogoKey(title: string): string {
  return title.trim().toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
}

/** The artwork for a published station title, or null when this station has no logo yet. */
export function stationLogoUrl(title: string): string | null {
  return STATION_LOGO_URLS[stationLogoKey(title)] ?? null;
}
