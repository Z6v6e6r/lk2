import { ChatIcon } from '../HomeDashboardPage.js';
import { TrainingPeopleIcon } from '../TrainingPeopleIcon.js';

export type ChatCategoryIconName =
  | 'ALL'
  | 'DIRECT'
  | 'GAME'
  | 'TOURNAMENT'
  | 'STATION'
  | 'COMMUNITY'
  | 'NOTIFICATIONS'
  | 'UNREAD'
  | 'SEND'
  | 'REFRESH';

export function ChatCategoryIcon({
  name,
}: {
  readonly name: ChatCategoryIconName;
}): React.JSX.Element {
  if (name === 'ALL') return <ChatIcon />;
  if (name === 'COMMUNITY') return <TrainingPeopleIcon />;
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
      {name === 'DIRECT' ? (
        <>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
        </>
      ) : null}
      {name === 'GAME' ? (
        <>
          <rect x="4" y="3" width="16" height="18" rx="3" />
          <path d="M4 12h16M8 3v18M16 3v18" />
        </>
      ) : null}
      {name === 'TOURNAMENT' ? (
        <>
          <path d="M8 3h8v6a4 4 0 0 1-8 0V3ZM8 5H4v2a4 4 0 0 0 4 4M16 5h4v2a4 4 0 0 1-4 4M12 13v7M8 21h8" />
        </>
      ) : null}
      {name === 'STATION' ? (
        <>
          <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" />
          <circle cx="12" cy="10" r="2.5" />
        </>
      ) : null}
      {name === 'NOTIFICATIONS' ? (
        <>
          <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 8H4c0-1 2-2 2-8ZM10 21h4" />
        </>
      ) : null}
      {name === 'UNREAD' ? (
        <>
          <path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
          <circle cx="15" cy="7" r="3" />
          <circle cx="9" cy="17" r="3" />
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
