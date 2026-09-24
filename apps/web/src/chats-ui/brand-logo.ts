import maxLogoUrl from '../assets/brands/max.svg';
import telegramLogoUrl from '../assets/brands/telegram.svg';
import { type ExternalChatBrand } from './external-chats.js';

/**
 * The official mark of the messenger that owns the destination, taken from the brand's own published
 * logo instead of a hand-drawn lookalike: the row is a door into that app, and its owner has to be
 * recognisable at a glance. Both entries are the provider's primary logo on its brand background, so
 * the row needs no extra badge.
 */
const BRAND_LOGO_URLS: Readonly<Record<ExternalChatBrand, string>> = {
  TELEGRAM: telegramLogoUrl,
  MAX: maxLogoUrl,
};

export function brandLogoUrl(brand: ExternalChatBrand): string {
  return BRAND_LOGO_URLS[brand];
}
