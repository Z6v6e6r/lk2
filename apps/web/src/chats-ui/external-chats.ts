/**
 * PadlHub keeps a presence in Telegram and MAX. Those destinations are not PadlHub conversations and
 * are never created by the messaging API, so they live here as a small fixed list of outbound links
 * and render as ordinary chat rows in the list. Nothing about them is tenant data: the addresses are
 * published brand channels and are the same for every organization.
 */
export type ExternalChatBrand = 'TELEGRAM' | 'MAX';

export interface ExternalChatDestination {
  readonly key: string;
  readonly brand: ExternalChatBrand;
  readonly title: string;
  readonly preview: string;
  readonly href: string;
}

export const EXTERNAL_CHAT_DESTINATIONS: readonly ExternalChatDestination[] = [
  {
    key: 'telegram-channel',
    brand: 'TELEGRAM',
    title: 'ПадлХАБ в Telegram',
    preview: 'Канал @padel_academyF',
    href: 'https://t.me/padel_academyF',
  },
  {
    key: 'max-channel',
    brand: 'MAX',
    title: 'ПадлХАБ в MAX',
    preview: 'Новости и анонсы сообщества',
    href: 'https://max.ru/id7722810381_biz',
  },
  {
    key: 'max-bot',
    brand: 'MAX',
    title: 'Бот ПадлХАБ в MAX',
    preview: 'Запись, расписание и ответы на вопросы',
    href: 'https://max.ru/id7722810381_bot',
  },
];

/**
 * Search behaves like the conversation search next to it: the same query filters both lists with one
 * case-insensitive match over the visible title and preview.
 */
export function externalChatRows(query: string): readonly ExternalChatDestination[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  if (!normalizedQuery) return EXTERNAL_CHAT_DESTINATIONS;
  return EXTERNAL_CHAT_DESTINATIONS.filter((destination) =>
    [destination.title, destination.preview].some((value) =>
      value.toLocaleLowerCase('ru-RU').includes(normalizedQuery),
    ),
  );
}
