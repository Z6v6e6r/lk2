import { HeaderCategoryIcon } from './HeaderCategoryIcon.js';

export type ChatCategoryIconName =
  | 'ALL'
  | 'DIRECT'
  | 'GAME'
  | 'TOURNAMENT'
  | 'STATION'
  | 'COMMUNITY'
  | 'NOTIFICATIONS'
  | 'BELL_OFF'
  | 'UNREAD'
  | 'SETTINGS'
  | 'SEND'
  | 'REFRESH';

export function ChatCategoryIcon({
  name,
}: {
  readonly name: ChatCategoryIconName;
}): React.JSX.Element {
  switch (name) {
    case 'ALL':
    case 'DIRECT':
    case 'GAME':
    case 'TOURNAMENT':
    case 'STATION':
    case 'COMMUNITY':
    case 'NOTIFICATIONS':
      return <HeaderCategoryIcon name={name} />;
    default:
      break;
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'BELL_OFF' ? (
        <>
          <path d="M6 9a6 6 0 0 1 9.3-5.1M18 11c0 6 2 7 2 8H6M10 21h4M4 4l16 16" />
        </>
      ) : null}
      {name === 'UNREAD' ? (
        <>
          <path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
          <circle cx="15" cy="7" r="3" />
          <circle cx="9" cy="17" r="3" />
        </>
      ) : null}
      {name === 'SETTINGS' ? (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.8 1.8 0 0 0 .04 2.5l.05.05-1.4 1.4-.05-.05a1.8 1.8 0 0 0-2.5-.04 1.8 1.8 0 0 0-.54 1.3v.07h-2v-.07a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.95.4l-.05.05-1.4-1.4.05-.05a1.8 1.8 0 0 0 .04-2.5 1.8 1.8 0 0 0-1.3-.54h-.07v-2h.07a1.8 1.8 0 0 0 1.66-1.1 1.8 1.8 0 0 0-.4-1.95l-.05-.05 1.4-1.4.05.05a1.8 1.8 0 0 0 2.5.04 1.8 1.8 0 0 0 .54-1.3V4h2v.07a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.95-.4l.05-.05 1.4 1.4-.05.05a1.8 1.8 0 0 0-.04 2.5 1.8 1.8 0 0 0 1.3.54h.07v2h-.07A1.8 1.8 0 0 0 19.4 15Z" />
        </>
      ) : null}
      {name === 'SEND' ? <path d="m12 19 0-14m-6 6 6-6 6 6" /> : null}
      {name === 'REFRESH' ? (
        <>
          <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
        </>
      ) : null}
    </svg>
  );
}
