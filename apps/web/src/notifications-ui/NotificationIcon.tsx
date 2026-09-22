import styles from './NotificationsUi.module.css';

export type NotificationIconName =
  | 'back'
  | 'bell'
  | 'calendar'
  | 'chat'
  | 'chevron'
  | 'clock'
  | 'friends'
  | 'game'
  | 'gear'
  | 'info'
  | 'megaphone'
  | 'moon';

/**
 * One stroke-icon set for the notification contour. It deliberately mirrors the existing shell
 * icons (24px box, 1.8 stroke, round caps) so the settings screen does not import a second visual
 * language.
 */
export function NotificationIcon({
  name,
}: {
  readonly name: NotificationIconName;
}): React.JSX.Element {
  const paths: Record<NotificationIconName, React.ReactNode> = {
    back: <path d="m14 5-7 7 7 7" />,
    bell: (
      <path d="M6 9a6 6 0 0 1 12 0c0 5 1.9 6.4 2 7H4c.1-.6 2-2 2-7Zm3.4 11a2.7 2.7 0 0 0 5.2 0" />
    ),
    calendar: (
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-11ZM4 9.5h16M8 3v3m8-3v3" />
    ),
    chat: <path d="M20 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-4.2A8 8 0 1 1 20 12Z" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    friends: (
      <path d="M9 11.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm-5 6.2c.4-2.5 2.1-3.8 5-3.8s4.6 1.3 5 3.8M15 8h5m-2.5-2.5V11" />
    ),
    game: (
      <path d="M6.2 8.2 4.5 7a2 2 0 0 0-2.8 1.1L1 12.8a2 2 0 0 0 3.6 1.6l1.1-1.6h4.6l1.1 1.6a2 2 0 0 0 3.6-1.6l-.7-4.7A2 2 0 0 0 11.5 7L9.8 8.2H6.2ZM5.5 9.5v3m-1.5-1.5h3m7-1.3v.1m-2 1.2v.1" />
    ),
    gear: (
      <path d="m12 3 1 1.9 2.1.5 1.8-1 1.7 1.7-1 1.8.5 2.1 1.9 1v2l-1.9 1-.5 2.1 1 1.8-1.7 1.7-1.8-1-2.1.5-1 1.9h-2l-1-1.9-2.1-.5-1.8 1-1.7-1.7 1-1.8-.5-2.1-1.9-1v-2l1.9-1 .5-2.1-1-1.8L5 4.4l1.8 1L8.9 5l1-2h2Zm0 5.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5m0-8v.1" />
      </>
    ),
    megaphone: <path d="M4 10.5v3h3l5 3.2V7.3L7 10.5H4Zm12.5-.8a4.2 4.2 0 0 1 0 6.6M5.5 14v4.2" />,
    moon: <path d="M19 15.5A7.8 7.8 0 0 1 8.5 5 7.8 7.8 0 1 0 19 15.5Z" />,
  };

  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {paths[name]}
      </g>
    </svg>
  );
}
