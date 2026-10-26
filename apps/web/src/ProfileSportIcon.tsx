import type { ReactNode } from 'react';

export type ProfileSportIconName =
  'padel' | 'squash' | 'tennis' | 'boxing' | 'basketball' | 'running';

// Vector geometry from the user-supplied lk2-sport-icons v1.0.0 package.
const sportIconPaths: Readonly<Record<ProfileSportIconName, ReactNode>> = {
  padel: (
    <>
      <g transform="rotate(35 12 12)">
        <path d="M12 2.3c3.1 0 5.2 2.7 5.2 6.1s-2.2 6.1-5.2 6.1-5.2-2.7-5.2-6.1S8.9 2.3 12 2.3Z" />
        <path d="m10.5 14.2.35 1.9h2.3l.35-1.9" />
        <rect x="10.85" y="16.1" width="2.3" height="5.15" rx=".45" />
        <circle cx="10.2" cy="5.5" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="12" cy="5.5" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="13.8" cy="5.5" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="9.5" cy="7.65" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="11.15" cy="7.65" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="12.85" cy="7.65" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="7.65" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="10.2" cy="9.8" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="12" cy="9.8" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="13.8" cy="9.8" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="11.1" cy="11.7" r="0.43" fill="currentColor" stroke="none" />
        <circle cx="12.9" cy="11.7" r="0.43" fill="currentColor" stroke="none" />
      </g>
    </>
  ),
  squash: (
    <>
      <g transform="rotate(35 12 12)">
        <path d="M12 2.1c2.8 0 4.5 2.2 4.5 5.2 0 3.3-2.1 5.8-4.5 8.1-2.4-2.3-4.5-4.8-4.5-8.1 0-3 1.7-5.2 4.5-5.2Z" />
        <path d="M11.3 14.8v6.3h1.4v-6.3" />
        <path
          d="M10 2.8v10.5M12 2.1v13M14 2.8v10.5M7.9 5.1h8.2M7.6 8.1h8.8M8.7 11.1h6.6"
          strokeWidth=".85"
        />
      </g>
      <circle cx="19.1" cy="19.1" r="1.5" />
    </>
  ),
  tennis: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.9 3.55c-.8 4.65 1.6 7.85 4.1 9.15s3.1 4.3 2.1 7.75" />
    </>
  ),
  boxing: (
    <>
      <path d="M6.1 18C4.8 15.8 4 12.5 4 8.8c0-4.1 2.7-5.9 7-5.9s7.1 1.9 7.1 5.3c2.3 1.1 2.5 3.6 1.3 5.9l-3 3.9Z" />
      <path d="M18.1 8.2c0 2.1-1.2 4.5-2.6 5.6" />
      <rect x="6.1" y="18" width="10.3" height="3" rx=".65" />
    </>
  ),
  basketball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18M3 12h18M5.6 5.65c4.5 3.25 4.5 9.45 0 12.7M18.4 5.65c-4.5 3.25-4.5 9.45 0 12.7" />
    </>
  ),
  running: (
    <>
      <circle cx="16" cy="4.4" r="1.9" />
      <path d="m6.1 11.7 2.2-2.7 3.6-1.1 2.8 2.8h4M11.9 7.9l-2.5 5.5 4.9 3.1-2 4.5M9.4 13.4l-2.5 4.3L3 19.2" />
    </>
  ),
};

export function ProfileSportIcon({
  sport,
}: {
  readonly sport: ProfileSportIconName;
}): React.JSX.Element {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {sportIconPaths[sport]}
    </svg>
  );
}
