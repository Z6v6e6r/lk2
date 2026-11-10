/**
 * Lock-screen copy for data-only Android push. The native service renders these strings without
 * the WebView, an authenticated session or any API call, so only content that is already safe on a
 * locked device may travel here: the template headline plus one short type line. The rendered body
 * stays in the inbox because booking and scenario bodies interpolate the player, court or address.
 */
const MAX_TITLE_LENGTH = 120;
const MAX_TYPE_TEXT_LENGTH = 80;

export const LOCK_SCREEN_TYPE_TEXT: Readonly<Record<string, string>> = {
  BOOKING: 'Не пропусти занятие',
  GAME: 'Не пропусти игру',
  MESSAGING: 'Новое сообщение в чате',
  FRIENDSHIP: 'Новая заявка в друзья',
  ADMIN_MESSAGE: 'Оповещение ПадлХАБ',
};

export const LOCK_SCREEN_FALLBACK_BODY = 'У вас новое уведомление';

function clean(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return collapsed.length >= 1 && collapsed.length <= maxLength ? collapsed : undefined;
}

/**
 * Returns the template headline only when the template cannot interpolate event data. A title that
 * references payload fields would put dynamic text on the lock screen, so it is dropped and the
 * native fallback title is used instead.
 */
export function lockScreenTitle(input: {
  readonly titleTemplate: string | null | undefined;
  readonly renderedTitle: string | null | undefined;
}): string | undefined {
  if (typeof input.titleTemplate !== 'string' || input.titleTemplate.includes('{{'))
    return undefined;
  return clean(input.renderedTitle, MAX_TITLE_LENGTH);
}

export function lockScreenTypeText(category: string | null | undefined): string {
  if (typeof category !== 'string') return LOCK_SCREEN_FALLBACK_BODY;
  const text = LOCK_SCREEN_TYPE_TEXT[category];
  return text !== undefined && text.length <= MAX_TYPE_TEXT_LENGTH
    ? text
    : LOCK_SCREEN_FALLBACK_BODY;
}
