import avatarBackground01Url from './assets/avatar-backgrounds/padel_avatar_bg_01.png';
import avatarBackground02Url from './assets/avatar-backgrounds/padel_avatar_bg_02.png';
import avatarBackground03Url from './assets/avatar-backgrounds/padel_avatar_bg_03.png';
import avatarBackground04Url from './assets/avatar-backgrounds/padel_avatar_bg_04.png';
import avatarBackground05Url from './assets/avatar-backgrounds/padel_avatar_bg_05.png';
import avatarBackground06Url from './assets/avatar-backgrounds/padel_avatar_bg_06.png';
import avatarBackground07Url from './assets/avatar-backgrounds/padel_avatar_bg_07.png';
import avatarBackground08Url from './assets/avatar-backgrounds/padel_avatar_bg_08.png';
import avatarBackground09Url from './assets/avatar-backgrounds/padel_avatar_bg_09.png';
import avatarBackground10Url from './assets/avatar-backgrounds/padel_avatar_bg_10.png';
import avatarBackground11Url from './assets/avatar-backgrounds/padel_avatar_bg_11.png';
import avatarBackground12Url from './assets/avatar-backgrounds/padel_avatar_bg_12.png';
import avatarBackground13Url from './assets/avatar-backgrounds/padel_avatar_bg_13.png';
import avatarBackground14Url from './assets/avatar-backgrounds/padel_avatar_bg_14.png';
import avatarBackground15Url from './assets/avatar-backgrounds/padel_avatar_bg_15.png';
import avatarBackground16Url from './assets/avatar-backgrounds/padel_avatar_bg_16.png';
import avatarBackground17Url from './assets/avatar-backgrounds/padel_avatar_bg_17.png';
import avatarBackground18Url from './assets/avatar-backgrounds/padel_avatar_bg_18.png';
import avatarBackground19Url from './assets/avatar-backgrounds/padel_avatar_bg_19.png';
import avatarBackground20Url from './assets/avatar-backgrounds/padel_avatar_bg_20.png';

export const AVATAR_BACKGROUND_URLS = [
  avatarBackground01Url,
  avatarBackground02Url,
  avatarBackground03Url,
  avatarBackground04Url,
  avatarBackground05Url,
  avatarBackground06Url,
  avatarBackground07Url,
  avatarBackground08Url,
  avatarBackground09Url,
  avatarBackground10Url,
  avatarBackground11Url,
  avatarBackground12Url,
  avatarBackground13Url,
  avatarBackground14Url,
  avatarBackground15Url,
  avatarBackground16Url,
  avatarBackground17Url,
  avatarBackground18Url,
  avatarBackground19Url,
  avatarBackground20Url,
] as const;

export function avatarBackgroundIndex(seed: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16_777_619);
  }

  return (hash >>> 0) % AVATAR_BACKGROUND_URLS.length;
}

export function avatarBackgroundUrl(seed: string): string {
  return AVATAR_BACKGROUND_URLS[avatarBackgroundIndex(seed)] ?? AVATAR_BACKGROUND_URLS[0];
}

export function playerInitials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('ru-RU') ?? '')
    .join('');
}
