import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, UIEvent } from 'react';

import type {
  ActivityHistoryPage,
  ActivityHistoryQuery,
  BookingRecommendationPage,
  CommunityMembershipPage,
  HomeBase,
  HomeBookingRecommendationFilters,
  HomeDashboard,
  UserProfile,
  UserUpcomingBookings,
} from './auth-gateway.js';
import { ActivityHistoryModal } from './ActivityHistory.js';
import { EventCalendarIcon, EventLocationIcon } from './ActivityCardIcons.js';
import { BookingRecommendations } from './BookingRecommendations.js';
import { GameTypeBadge } from './GameTypeBadge.js';
import locationSeligerUrl from './assets/home/location-seliger.png';
import promotionHeroFallbackUrl from './assets/home/promotion-hero-fallback.png';
import bookingRecommendationsLoaderUrl from './assets/loaders/booking-recommendations.gif';
import { locationCourtLabel } from './location-court-label.js';
import promoUrl from './assets/home/promo.png';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';

interface HomeDashboardPageProps {
  readonly dashboard: HomeBase;
  readonly viewerFallback: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly viewer: HomeSectionEnvelope<UserProfile> | null;
  readonly upcoming: HomeSectionEnvelope<UserUpcomingBookings> | null;
  readonly tenantName: string;
  readonly layoutVariant?: 'default' | 'v2' | 'v3';
  readonly recommendationDisplay?: 'CARDS' | 'ROWS';
  readonly notificationUnreadCount: number;
  readonly loadCommunityPage?: (
    cursor?: string,
    limit?: number,
  ) => Promise<CommunityMembershipPage>;
  readonly communityPageSize?: number;
  readonly loadBookingRecommendations?: (
    input?: HomeBookingRecommendationFilters,
  ) => Promise<BookingRecommendationPage>;
  readonly loadActivityHistory?: (input?: ActivityHistoryQuery) => Promise<ActivityHistoryPage>;
  readonly recordPromotionEngagement?: (
    promotionId: string,
    kind: 'IMPRESSION' | 'CLICK',
  ) => Promise<unknown>;
  readonly logoutBusy: boolean;
  readonly error?: string | null;
  readonly onRetryViewer: () => void;
  readonly onActivateUpcoming?: () => void;
  readonly onRetryUpcoming: () => void;
  readonly onLogout: () => void;
}

export type HomeSectionEnvelope<T> =
  | { readonly state: 'READY'; readonly value: T }
  | { readonly state: 'STALE'; readonly value: T }
  | { readonly state: 'UNAVAILABLE'; readonly message: string };

type AvailableHomeCommunities = Extract<
  HomeBase['communities'],
  { readonly status: 'READY' | 'STALE' }
>;
type HomeCommunity = AvailableHomeCommunities['value'][number];

type HomeActionIconName = 'games' | 'tournaments' | 'trainings';

function recommendationItemKey(item: BookingRecommendationPage['items'][number]): string {
  return item.kind === 'GAME' ? `GAME:${item.game.id}` : `${item.kind}:${item.activity.id}`;
}

function appendRecommendationPage(
  current: BookingRecommendationPage,
  next: BookingRecommendationPage,
): BookingRecommendationPage {
  const existing = new Set(current.items.map(recommendationItemKey));
  return {
    ...next,
    items: [
      ...current.items,
      ...next.items.filter((item) => !existing.has(recommendationItemKey(item))),
    ],
  };
}

const HOME_RECOMMENDATION_EXPANSION_THRESHOLD = 6;

const implementedMvpRoutes = new Set([
  '/',
  '/profile',
  '/bookings',
  '/notifications',
  '/games',
  '/communities',
  '/locations',
  '/promotions',
  '/gift-certificates',
  '/offers',
]);

function isImplementedMvpRoute(route: string): boolean {
  const pathname = route.split(/[?#]/, 1)[0] ?? '';
  if (implementedMvpRoutes.has(pathname)) return true;
  return /^\/(?:profile|locations|games)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    pathname,
  );
}

function HomeActionIcon({ name }: { readonly name: HomeActionIconName }): React.JSX.Element {
  switch (name) {
    case 'games':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M7.7817 1.64905C7.30563 2.40443 7.04537 3.28087 7.04537 4.18225C7.04553 6.81 9.17839 8.94274 11.8061 8.94299C12.7075 8.94299 13.5781 8.68862 14.3335 8.21252C14.3271 8.50453 14.2949 8.80333 14.2504 9.10803C13.8061 11.717 11.6919 13.818 9.07662 14.2496C4.72851 14.9667 1.02157 11.2599 1.73873 6.91174C2.17037 4.29649 4.27145 2.18236 6.88033 1.73792C7.18493 1.68715 7.48979 1.65541 7.7817 1.64905ZM8.9985 1.61096C10.3566 1.80178 11.6174 2.42752 12.5903 3.39417C13.5629 4.36073 14.1964 5.61664 14.396 6.97327L14.2329 7.09241C13.5914 7.58956 12.7834 7.88536 11.9087 7.88538C9.80755 7.88538 8.10014 6.17787 8.10006 4.07678C8.10006 3.14373 8.43998 2.27112 8.9985 1.61096Z"
            fill="#FAFAFA"
          />
        </svg>
      );
    case 'tournaments':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M7.5 12.1667H6C5.26667 12.1667 4.66667 12.7667 4.66667 13.5V13.6667H4C3.72667 13.6667 3.5 13.8933 3.5 14.1667C3.5 14.44 3.72667 14.6667 4 14.6667H12C12.2733 14.6667 12.5 14.44 12.5 14.1667C12.5 13.8933 12.2733 13.6667 12 13.6667H11.3333V13.5C11.3333 12.7667 10.7333 12.1667 10 12.1667H8.5V10.64C8.33333 10.66 8.16667 10.6667 8 10.6667C7.83333 10.6667 7.66667 10.66 7.5 10.64V12.1667Z"
            fill="#FAFAFA"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M13.4529 7.01325C13.1462 7.31992 12.7595 7.59325 12.3195 7.75992C11.6262 9.46659 9.95953 10.6666 7.99953 10.6666C6.03953 10.6666 4.37286 9.46659 3.67953 7.75992C3.23953 7.59325 2.85286 7.31992 2.5462 7.01325C1.9262 6.32659 1.51953 5.50659 1.51953 4.54659C1.51953 3.58659 2.27286 2.83325 3.23286 2.83325H3.6062C4.03953 1.94659 4.9462 1.33325 5.99953 1.33325H9.99953C11.0529 1.33325 11.9595 1.94659 12.3929 2.83325H12.7662C13.7262 2.83325 14.4795 3.58659 14.4795 4.54659C14.4795 5.50659 14.0729 6.32659 13.4529 7.01325ZM6.85404 4.83325H9.18738C9.46071 4.83325 9.68738 4.60659 9.68738 4.33325C9.68738 4.05992 9.46071 3.83325 9.18738 3.83325H6.85404C6.58071 3.83325 6.35404 4.05992 6.35404 4.33325C6.35404 4.60659 6.58071 4.83325 6.85404 4.83325Z"
            fill="#FAFAFA"
          />
        </svg>
      );
    case 'trainings':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M5.99967 1.33337C4.25301 1.33337 2.83301 2.75337 2.83301 4.50004C2.83301 6.21337 4.17301 7.60004 5.91967 7.66004C5.97301 7.65337 6.02634 7.65337 6.06634 7.66004C6.07967 7.66004 6.08634 7.66004 6.09967 7.66004C6.10634 7.66004 6.10634 7.66004 6.11301 7.66004C7.81967 7.60004 9.15967 6.21337 9.16634 4.50004C9.16634 2.75337 7.74634 1.33337 5.99967 1.33337Z"
            fill="#FAFAFA"
          />
          <path
            d="M9.38664 9.4333C7.52664 8.1933 4.49331 8.1933 2.61997 9.4333C1.77331 9.99996 1.30664 10.7666 1.30664 11.5866C1.30664 12.4066 1.77331 13.1666 2.61331 13.7266C3.54664 14.3533 4.77331 14.6666 5.99997 14.6666C7.22664 14.6666 8.45331 14.3533 9.38664 13.7266C10.2266 13.16 10.6933 12.4 10.6933 11.5733C10.6866 10.7533 10.2266 9.9933 9.38664 9.4333Z"
            fill="#FAFAFA"
          />
          <path
            d="M13.3272 4.89344C13.4339 6.18677 12.5139 7.32011 11.2406 7.47344C11.2339 7.47344 11.2339 7.47344 11.2272 7.47344H11.2072C11.1672 7.47344 11.1272 7.47344 11.0939 7.48677C10.4472 7.52011 9.85389 7.31344 9.40723 6.93344C10.0939 6.32011 10.4872 5.40011 10.4072 4.40011C10.3606 3.86011 10.1739 3.36677 9.89389 2.94677C10.1472 2.82011 10.4406 2.74011 10.7406 2.71344C12.0472 2.60011 13.2139 3.57344 13.3272 4.89344Z"
            fill="#FAFAFA"
          />
          <path
            d="M14.6605 11.0599C14.6071 11.7066 14.1938 12.2666 13.5005 12.6466C12.8338 13.0133 11.9938 13.1866 11.1605 13.1666C11.6405 12.7333 11.9205 12.1933 11.9738 11.6199C12.0405 10.7933 11.6471 9.99994 10.8605 9.36661C10.4138 9.01327 9.89382 8.73327 9.32715 8.52661C10.8005 8.09994 12.6538 8.38661 13.7938 9.30661C14.4071 9.79994 14.7205 10.4199 14.6605 11.0599Z"
            fill="#FAFAFA"
          />
        </svg>
      );
  }
}

function HomePreferencesEditIcon(): React.JSX.Element {
  return (
    <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.89 2.11a1.52 1.52 0 0 1 2.15 0l.85.85a1.52 1.52 0 0 1 0 2.15l-7.8 7.8-3.43.43.43-3.43 7.8-7.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m9.75 3.25 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function WalletIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M10.7249 6.81995V7.31995C10.7249 7.45495 10.6199 7.56495 10.4799 7.56995H9.74994C9.48494 7.56995 9.24494 7.37495 9.22494 7.11495C9.20994 6.95995 9.26994 6.81495 9.36994 6.71495C9.45994 6.61995 9.58494 6.56995 9.71994 6.56995H10.4749C10.6199 6.57495 10.7249 6.68495 10.7249 6.81995Z"
        fill="#FAFAFA"
      />
      <path
        d="M8.99461 6.34495C8.74461 6.58995 8.62461 6.95495 8.72461 7.33495C8.85461 7.79995 9.30961 8.09495 9.78961 8.09495H10.2246C10.4996 8.09495 10.7246 8.31995 10.7246 8.59495V8.68995C10.7246 9.72495 9.87961 10.5699 8.84461 10.5699H3.10461C2.06961 10.5699 1.22461 9.72495 1.22461 8.68995V5.32495C1.22461 4.70995 1.51961 4.16495 1.97461 3.82495C2.28961 3.58495 2.67961 3.44495 3.10461 3.44495H8.84461C9.87961 3.44495 10.7246 4.28995 10.7246 5.32495V5.54495C10.7246 5.81995 10.4996 6.04495 10.2246 6.04495H9.71461C9.43461 6.04495 9.17961 6.15495 8.99461 6.34495Z"
        fill="#FAFAFA"
      />
      <path
        d="M8.09954 2.41C8.23454 2.545 8.11954 2.755 7.92954 2.755L4.08954 2.75C3.86954 2.75 3.75454 2.48 3.91454 2.325L4.72454 1.51C5.40954 0.83 6.51954 0.83 7.20454 1.51L8.07954 2.395C8.08454 2.4 8.09454 2.405 8.09954 2.41Z"
        fill="#FAFAFA"
      />
    </svg>
  );
}

type BottomNavIconName = 'home' | 'games' | 'create' | 'chat' | 'profile';

export function ChatIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M9.99935 19.0079C9.42435 19.0079 8.88268 18.7163 8.49935 18.2079L7.24935 16.5413C7.22435 16.5079 7.12435 16.4663 7.08268 16.4579H6.66602C3.19102 16.4579 1.04102 15.5163 1.04102 10.8329V6.66626C1.04102 2.98293 2.98268 1.04126 6.66602 1.04126H13.3327C17.016 1.04126 18.9577 2.98293 18.9577 6.66626V10.8329C18.9577 14.5163 17.016 16.4579 13.3327 16.4579H12.916C12.8493 16.4579 12.791 16.4913 12.7493 16.5413L11.4993 18.2079C11.116 18.7163 10.5743 19.0079 9.99935 19.0079ZM6.66602 2.29126C3.68268 2.29126 2.29102 3.68293 2.29102 6.66626V10.8329C2.29102 14.5996 3.58268 15.2079 6.66602 15.2079H7.08268C7.50768 15.2079 7.99101 15.4496 8.24935 15.7913L9.49935 17.4579C9.79101 17.8413 10.2077 17.8413 10.4993 17.4579L11.7493 15.7913C12.0243 15.4246 12.4577 15.2079 12.916 15.2079H13.3327C16.316 15.2079 17.7077 13.8163 17.7077 10.8329V6.66626C17.7077 3.68293 16.316 2.29126 13.3327 2.29126H6.66602Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BottomNavIcon({ name }: { readonly name: BottomNavIconName }): React.JSX.Element {
  switch (name) {
    case 'home':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M7.09572 1.78614C8.46171 0.72792 10.6414 0.673629 12.0617 1.66846L17.2737 5.31449C18.2687 6.01117 19.0559 7.51343 19.0559 8.73469V14.868C19.0559 17.175 17.1825 19.0483 14.8755 19.0483H5.12268C2.81597 19.0481 0.943515 17.1662 0.943359 14.8595V8.61701C0.943359 7.4773 1.65783 6.02985 2.56229 5.32403L7.09572 1.78614ZM9.99961 10.8148C9.54992 10.8148 9.18537 11.1794 9.18537 11.629V15.4288C9.18542 15.8785 9.54995 16.243 9.99961 16.243C10.4493 16.243 10.8138 15.8785 10.8138 15.4288V11.629C10.8138 11.1794 10.4493 10.8148 9.99961 10.8148Z"
            fill="currentColor"
          />
        </svg>
      );
    case 'games':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M9.97508 1.0417C9.46675 1.0417 8.94175 1.08337 8.40842 1.17504C4.74175 1.80004 1.75008 4.80004 1.14175 8.48337C0.658417 11.4084 1.56675 14.2667 3.64175 16.3417C5.71675 18.4167 8.57508 19.3167 11.4917 18.8417C15.1667 18.2334 18.1751 15.25 18.8001 11.5834C18.9334 10.775 18.9667 9.98337 18.9001 9.23337V9.22503C18.8834 9.03337 18.8501 8.85003 18.8001 8.6667C18.7417 8.45837 18.5834 8.30004 18.3834 8.23337C18.1834 8.1667 17.9584 8.2167 17.7917 8.35004C17.0084 9.00837 16.0084 9.37504 14.9751 9.37504C12.5584 9.37504 10.6001 7.40837 10.6001 5.00004C10.6001 3.9667 10.9668 2.9667 11.6251 2.18337C11.7667 2.0167 11.8084 1.80004 11.7417 1.5917C11.6751 1.38337 11.5167 1.23337 11.3084 1.17504C11.1251 1.12504 10.9417 1.0917 10.7501 1.07504C10.5001 1.05004 10.2418 1.0417 9.97508 1.0417ZM9.97508 17.7084C7.93342 17.7084 6.00008 16.9167 4.53342 15.45C2.75008 13.6667 1.96675 11.2 2.38342 8.68337C2.90842 5.52503 5.46675 2.9417 8.62508 2.40837C9.12508 2.32504 9.60008 2.27504 10.0584 2.2917C9.60842 3.1167 9.36675 4.05004 9.36675 5.00004C9.36675 8.10004 11.8917 10.625 14.9917 10.625C15.9417 10.625 16.8751 10.3834 17.7001 9.93337C17.7084 10.3917 17.6667 10.8667 17.5834 11.3667C17.0501 14.5167 14.4667 17.0834 11.3084 17.6C10.8501 17.675 10.4084 17.7084 9.97508 17.7084Z"
            fill="currentColor"
          />
          <path
            d="M11.1496 1.15833C10.9663 1.15833 10.7913 1.23333 10.6746 1.38333C9.82461 2.39167 9.34961 3.675 9.34961 5C9.34961 8.1 11.8746 10.625 14.9746 10.625C16.2996 10.625 17.5829 10.1583 18.5913 9.3C18.7829 9.14167 18.8579 8.88333 18.7913 8.65C18.6413 8.13333 18.2583 6.38333 17.875 6C15.7987 3.92371 15.375 3 12.6746 1.98333C12.2913 1.6 11.8329 1.33333 11.3246 1.18333C11.2663 1.16667 11.2079 1.15833 11.1496 1.15833ZM14.9746 9.375C12.5579 9.375 10.5996 7.40833 10.5996 5C10.5996 4.11667 10.8663 3.25833 11.3579 2.54167C11.3579 2.54167 11.7417 1.86667 11.875 2C14.875 2.5 15.7987 3.92371 17.875 6C18.0083 6.13333 17.7917 8.34167 17.875 8.5C17.1583 8.99167 15.8579 9.375 14.9746 9.375Z"
            fill="currentColor"
          />
          <circle cx="9.875" cy="10" r="8.375" stroke="currentColor" strokeWidth="1.25" />
        </svg>
      );
    case 'create':
      return (
        <svg width="88" height="72" viewBox="0 0 88 72" fill="none" aria-hidden="true">
          <g filter="url(#filter0_d_743_2030)">
            <rect x="16" y="16" width="56" height="40" rx="16" fill="#8766EB" />
            <g className="fh-create-cross">
              <path
                d="M41.75 36.75H38C37.5858 36.75 37.25 36.4142 37.25 36C37.25 35.5858 37.5858 35.25 38 35.25H41.75V36.75Z"
                fill="#FAFAFA"
              />
              <path
                d="M50 35.25C50.4142 35.25 50.75 35.5858 50.75 36C50.75 36.4142 50.4142 36.75 50 36.75H43.25V35.25H50Z"
                fill="#FAFAFA"
              />
              <path
                d="M44.75 42C44.75 42.4142 44.4142 42.75 44 42.75C43.5858 42.75 43.25 42.4142 43.25 42V35.25H44.75V42Z"
                fill="#FAFAFA"
              />
              <path
                d="M44 29.25C44.4142 29.25 44.75 29.5858 44.75 30V33.75H43.25V30C43.25 29.5858 43.5858 29.25 44 29.25Z"
                fill="#FAFAFA"
              />
            </g>
          </g>
          <defs>
            <filter
              id="filter0_d_743_2030"
              x="0"
              y="0"
              width="88"
              height="72"
              filterUnits="userSpaceOnUse"
              colorInterpolationFilters="sRGB"
            >
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feColorMatrix
                in="SourceAlpha"
                type="matrix"
                values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                result="hardAlpha"
              />
              <feOffset />
              <feGaussianBlur stdDeviation="8" />
              <feColorMatrix
                type="matrix"
                values="0 0 0 0 0.658824 0 0 0 0 0.556863 0 0 0 0 0.964706 0 0 0 0.16 0"
              />
              <feBlend
                mode="normal"
                in2="BackgroundImageFix"
                result="effect1_dropShadow_743_2030"
              />
              <feBlend
                mode="normal"
                in="SourceGraphic"
                in2="effect1_dropShadow_743_2030"
                result="shape"
              />
            </filter>
          </defs>
        </svg>
      );
    case 'chat':
      return <ChatIcon />;
    case 'profile':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M10.1441 9.5C10.0541 9.49098 9.94595 9.49098 9.84685 9.5C7.7027 9.42785 6 7.66911 6 5.50451C6 3.29481 7.78378 1.5 10 1.5C12.2072 1.5 14 3.29481 14 5.50451C13.991 7.66911 12.2883 9.42785 10.1441 9.5Z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10.0078 11.625C11.7873 11.625 13.529 12.0325 14.8145 12.8086H14.8154C15.9357 13.4823 16.375 14.2932 16.375 14.9932C16.3749 15.6936 15.9345 16.5061 14.8135 17.1846C13.5226 17.9653 11.7789 18.375 10 18.375C8.22112 18.375 6.47741 17.9653 5.18652 17.1846L5.18457 17.1836C4.06461 16.5099 3.625 15.6998 3.625 15C3.625 14.2996 4.06466 13.486 5.18555 12.8076C6.48212 12.0311 8.22931 11.625 10.0078 11.625Z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

export type MainNavigationSection = 'home' | 'games' | 'chats' | 'notifications' | 'profile';

interface MainBottomNavigationProps {
  readonly active?: MainNavigationSection;
  readonly gamesDestination?: 'bookings' | 'games';
  readonly communicationsDestination?: 'chats' | 'notifications';
}

export function MainBottomNavigation({
  active,
  gamesDestination = 'bookings',
  communicationsDestination = 'notifications',
}: MainBottomNavigationProps): React.JSX.Element {
  const gamesHref = gamesDestination === 'games' ? '/games' : '/bookings';
  const gamesLabel = gamesDestination === 'games' ? 'Игры' : 'Записи';
  const communicationsHref = communicationsDestination === 'chats' ? '/chats' : '/notifications';
  const communicationsLabel = communicationsDestination === 'chats' ? 'Чаты' : 'Уведомления';

  return (
    <nav className="fh-bottom-nav" aria-label="Основная навигация">
      <a href="/" aria-current={active === 'home' ? 'page' : undefined} aria-label="Главная">
        <BottomNavIcon name="home" />
      </a>
      <a
        href={gamesHref}
        aria-current={active === 'games' ? 'page' : undefined}
        aria-label={gamesLabel}
      >
        <BottomNavIcon name="games" />
      </a>
      <a className="fh-create" href="/games/new?new=1" aria-label="Создать игру">
        <span className="fh-create-button">
          <BottomNavIcon name="create" />
        </span>
      </a>
      <a
        href={communicationsHref}
        aria-current={active === communicationsDestination ? 'page' : undefined}
        aria-label={communicationsLabel}
      >
        <BottomNavIcon name="chat" />
      </a>
      <a
        href="/profile"
        aria-current={active === 'profile' ? 'page' : undefined}
        aria-label="Профиль"
      >
        <BottomNavIcon name="profile" />
      </a>
    </nav>
  );
}

function NotificationBellIcon(): React.JSX.Element {
  const rawId = useId().replace(/:/g, '');
  const topGradientId = `notification-top-${rawId}`;
  const bottomGradientId = `notification-bottom-${rawId}`;
  const glowId = `notification-glow-${rawId}`;

  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={topGradientId}
          x1="5.3"
          y1="22.6"
          x2="23.7"
          y2="5.8"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.18" stopColor="white" stopOpacity="0.55" />
          <stop offset="0.48" stopColor="white" stopOpacity="1" />
          <stop offset="0.82" stopColor="white" stopOpacity="0.72" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={bottomGradientId}
          x1="30.2"
          y1="12.3"
          x2="11.3"
          y2="29.7"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.18" stopColor="white" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="white" stopOpacity="1" />
          <stop offset="0.86" stopColor="white" stopOpacity="0.62" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="0.65" />
        </filter>
      </defs>
      <g fill="none" strokeLinecap="round" opacity="0.62" filter={`url(#${glowId})`}>
        <path
          d="M5.314 22.617 A13.5 13.5 0 0 1 23.705 5.765"
          stroke={`url(#${topGradientId})`}
          strokeWidth="1.8"
        />
        <path
          d="M30.235 12.295 A13.5 13.5 0 0 1 11.25 29.691"
          stroke={`url(#${bottomGradientId})`}
          strokeWidth="1.8"
        />
      </g>
      <g fill="none" strokeLinecap="round">
        <path
          d="M5.314 22.617 A13.5 13.5 0 0 1 23.705 5.765"
          stroke={`url(#${topGradientId})`}
          strokeWidth="0.9"
        />
        <path
          d="M30.235 12.295 A13.5 13.5 0 0 1 11.25 29.691"
          stroke={`url(#${bottomGradientId})`}
          strokeWidth="0.9"
        />
      </g>
      <path
        d="M22.8936 19.66L22.227 18.5534C22.087 18.3067 21.9603 17.84 21.9603 17.5667V15.88C21.9603 14.3134 21.0403 12.96 19.7136 12.3267C19.367 11.7134 18.727 11.3334 17.9936 11.3334C17.267 11.3334 16.6136 11.7267 16.267 12.3467C14.967 12.9934 14.067 14.3334 14.067 15.88V17.5667C14.067 17.84 13.9403 18.3067 13.8003 18.5467L13.127 19.66C12.8603 20.1067 12.8003 20.6 12.967 21.0534C13.127 21.5 13.507 21.8467 14.0003 22.0134C15.2936 22.4534 16.6536 22.6667 18.0136 22.6667C19.3736 22.6667 20.7336 22.4534 22.027 22.02C22.4936 21.8667 22.8536 21.5134 23.027 21.0534C23.2003 20.5934 23.1536 20.0867 22.8936 19.66Z"
        fill="white"
      />
      <path
        d="M19.8868 23.34C19.6068 24.1134 18.8668 24.6667 18.0001 24.6667C17.4735 24.6667 16.9535 24.4534 16.5868 24.0734C16.3735 23.8734 16.2135 23.6067 16.1201 23.3334C16.2068 23.3467 16.2935 23.3534 16.3868 23.3667C16.5401 23.3867 16.7001 23.4067 16.8601 23.42C17.2401 23.4534 17.6268 23.4734 18.0135 23.4734C18.3935 23.4734 18.7735 23.4534 19.1468 23.42C19.2868 23.4067 19.4268 23.4 19.5601 23.38C19.6668 23.3667 19.7735 23.3534 19.8868 23.34Z"
        fill="white"
      />
    </svg>
  );
}

export function NotificationBellLink({
  unreadCount,
  className,
}: {
  readonly unreadCount: number;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <a
      className={['fh-bell', unreadCount > 0 ? 'is-unread' : null, className?.trim() || null]
        .filter(Boolean)
        .join(' ')}
      href="/notifications"
      aria-label={
        unreadCount > 0
          ? `Уведомления, непрочитанных: ${unreadCount}`
          : 'Уведомления, непрочитанных нет'
      }
    >
      <NotificationBellIcon />
      {unreadCount > 0 ? <span className="fh-bell-dot" aria-hidden="true" /> : null}
    </a>
  );
}

function HeroBackgroundX(): React.JSX.Element {
  return <span className="fh-hero-x" aria-hidden="true" />;
}

function Chevron(): React.JSX.Element {
  return <span className="fh-chevron" aria-hidden="true" />;
}

function levelAvatarProgress(level: UserProfile['level']): number {
  if (level.assessmentRequired) return 0;
  const fractionalProgress = level.value - Math.floor(level.value);
  return Math.round(fractionalProgress * 100);
}

function communityInitials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase('ru-RU'))
    .join('');
}

function communityAccent(id: string): string {
  const palette = ['#B9A1FF', '#C9F66F', '#8EDDC4', '#F2C974', '#9FC7FF'] as const;
  const hash = [...id].reduce((value, character) => value + character.charCodeAt(0), 0);
  return palette[hash % palette.length] ?? palette[0];
}

function CommunityLogo({ community }: { readonly community: HomeCommunity }): React.JSX.Element {
  const accent = communityAccent(community.id);
  return (
    <span className="fh-community-logo" style={{ borderColor: accent }}>
      {community.logoUrl ? (
        <img src={community.logoUrl} alt="" />
      ) : (
        <i style={{ backgroundColor: accent }}>
          <span>{communityInitials(community.title)}</span>
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7.5 10.5h17M6.5 15.5h19M7.5 20.5h17" />
            <circle cx="10" cy="8" r="1" />
            <circle cx="16" cy="8" r="1" />
            <circle cx="22" cy="8" r="1" />
          </svg>
        </i>
      )}
      {community.isVerified ? <b aria-hidden="true">✓</b> : null}
    </span>
  );
}

function CommunitySearchIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function mergeCommunities(
  current: readonly HomeCommunity[],
  next: readonly HomeCommunity[],
): HomeCommunity[] {
  const byId = new Map(current.map((community) => [community.id, community]));
  next.forEach((community) => byId.set(community.id, community));
  return [...byId.values()];
}

function HomeCommunityCarousel({
  initialItems,
  snapshotAvailable,
  loadPage,
  pageSize,
}: {
  readonly initialItems: readonly HomeCommunity[];
  readonly snapshotAvailable: boolean;
  readonly loadPage:
    ((cursor?: string, limit?: number) => Promise<CommunityMembershipPage>) | undefined;
  readonly pageSize: number;
}): React.JSX.Element {
  const [directoryItems, setDirectoryItems] = useState<readonly HomeCommunity[] | null>(null);
  const [directoryStatus, setDirectoryStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    loadPage ? 'loading' : 'idle',
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const loadingMore = useRef(false);
  const active = useRef(true);
  const drag = useRef({ active: false, moved: false, startX: 0, startScrollLeft: 0 });
  const suppressNextClick = useRef(false);
  const items = directoryItems ?? initialItems;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!loadPage) return;
    let requestActive = true;
    loadingMore.current = false;
    void loadPage(undefined, pageSize).then(
      (page) => {
        if (!requestActive) return;
        setDirectoryItems(page.items);
        setNextCursor(page.nextCursor);
        setDirectoryStatus('ready');
      },
      () => {
        if (requestActive) setDirectoryStatus('failed');
      },
    );
    return () => {
      requestActive = false;
    };
  }, [loadPage, pageSize]);

  function loadMore(): void {
    const cursor = nextCursor;
    if (!loadPage || !cursor || loadingMore.current) return;
    loadingMore.current = true;
    void loadPage(cursor, pageSize).then(
      (page) => {
        if (!active.current) return;
        setDirectoryItems((current) => mergeCommunities(current ?? initialItems, page.items));
        setNextCursor(page.nextCursor);
        loadingMore.current = false;
      },
      () => {
        loadingMore.current = false;
      },
    );
  }

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const track = event.currentTarget;
    const remainingScroll = track.scrollWidth - track.scrollLeft - track.clientWidth;
    if (remainingScroll <= 116) loadMore();
  }

  function finishMouseDrag(): void {
    if (!drag.current.active) return;
    suppressNextClick.current = drag.current.moved;
    if (drag.current.moved) {
      window.setTimeout(() => {
        suppressNextClick.current = false;
      }, 0);
    }
    drag.current.active = false;
    setDragging(false);
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    drag.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startScrollLeft: event.currentTarget.scrollLeft,
    };
    setDragging(true);
  }

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!drag.current.active || event.buttons !== 1) return;
    const distance = event.clientX - drag.current.startX;
    if (!drag.current.moved && Math.abs(distance) < 5) return;
    drag.current.moved = true;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.current.startScrollLeft - distance;
  }

  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!suppressNextClick.current) return;
    suppressNextClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  if (!snapshotAvailable && directoryItems === null) {
    return directoryStatus === 'loading' ? (
      <p className="fh-section-unavailable" role="status">
        Загружаем сообщества…
      </p>
    ) : (
      <p className="fh-section-unavailable" role="alert">
        Сообщества временно недоступны.
      </p>
    );
  }

  return (
    <div
      className={`fh-community-track${dragging ? ' is-dragging' : ''}`}
      role="region"
      aria-label="Мои сообщества"
      tabIndex={0}
      onScroll={handleScroll}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={finishMouseDrag}
      onMouseLeave={finishMouseDrag}
      onClickCapture={handleClickCapture}
      onDragStart={(event) => event.preventDefault()}
    >
      <a className="fh-community-search" href="/communities" aria-label="Найти сообщество">
        <span aria-hidden="true">
          <CommunitySearchIcon />
        </span>
      </a>
      {items.map((community) => (
        <div
          className="fh-community-card"
          key={community.id}
          role="group"
          aria-label={`${community.title}${
            community.unreadChatCount > 0
              ? `, непрочитанных сообщений: ${community.unreadChatCount}`
              : ''
          }`}
        >
          <CommunityLogo community={community} />
        </div>
      ))}
    </div>
  );
}

function HomePromotionCarousel({
  promotion,
  promotions,
  variant = 'standard',
}: Pick<HomeDashboard, 'promotion' | 'promotions'> & {
  readonly variant?: 'standard' | 'hero';
}): React.JSX.Element | null {
  const items = promotions.items.length > 0 ? promotions.items : promotion ? [promotion] : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const isHeroPromotion = variant === 'hero';

  useEffect(() => {
    if (!promotions.rotationEnabled || items.length < 2 || paused) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reducedMotion) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      setActiveIndex((current) => (current + 1) % items.length);
    }, promotions.intervalSeconds * 1_000);
    return () => window.clearInterval(interval);
  }, [items.length, paused, promotions.intervalSeconds, promotions.rotationEnabled]);

  const boundedActiveIndex = activeIndex < items.length ? activeIndex : 0;
  const activeItem = items[boundedActiveIndex] ?? items[0];
  if (!activeItem) return null;
  const desktopImageUrl = activeItem.imageUrl ?? activeItem.mobileImageUrl ?? promoUrl;

  return (
    <section
      className={isHeroPromotion ? 'fh-hero-promotion' : 'fh-promotions'}
      aria-label={isHeroPromotion ? 'Промо в шапке' : 'Акции'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <a
        className={isHeroPromotion ? 'fh-hero-promo' : 'fh-promo'}
        href={activeItem.route}
        aria-label={isHeroPromotion ? `Акция: ${activeItem.title}` : activeItem.title}
        key={activeItem.id}
      >
        {isHeroPromotion ? (
          <span className="fh-hero-promo-tag" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M5.7.8 2.9 5h2L4.3 9.2 7.1 5h-2L5.7.8Z"
                fill="currentColor"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth=".35"
              />
            </svg>
            Акция
          </span>
        ) : null}
        <picture>
          {!isHeroPromotion && activeItem.mobileImageUrl ? (
            <source media="(max-width: 767px)" srcSet={activeItem.mobileImageUrl} />
          ) : null}
          <img
            src={desktopImageUrl}
            alt=""
            width={isHeroPromotion ? '670' : '750'}
            height={isHeroPromotion ? '240' : '480'}
            loading="lazy"
            decoding="async"
          />
        </picture>
      </a>
      {items.length > 1 ? (
        <div
          className={isHeroPromotion ? 'fh-hero-promotion-dots' : 'fh-promotion-dots'}
          role="group"
          aria-label={isHeroPromotion ? 'Выбор промо в шапке' : 'Выбор акции'}
        >
          {items.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={index === boundedActiveIndex ? 'is-active' : ''}
              aria-label={`Показать акцию «${item.title}»`}
              aria-current={index === boundedActiveIndex ? 'true' : undefined}
              onClick={() => setActiveIndex(index)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function HomeHeroPromotionFallback(): React.JSX.Element {
  return (
    <section className="fh-hero-promotion fh-hero-promotion-fallback" aria-label="Промо в шапке">
      <img
        src={promotionHeroFallbackUrl}
        alt="Лето. Падел."
        width="670"
        height="240"
        decoding="async"
      />
    </section>
  );
}

function HomeStandardPromotionSection({
  promotions,
}: {
  readonly promotions: HomeBase['promotions'];
}): React.JSX.Element {
  if (promotions.status === 'UNAVAILABLE') {
    return (
      <section className="fh-promotions fh-section-unavailable" role="alert">
        Акции временно недоступны.
      </section>
    );
  }

  return (
    <>
      {promotions.status === 'STALE' ? (
        <p className="fh-section-stale" role="status">
          Показаны последние доступные акции.
        </p>
      ) : null}
      <HomePromotionCarousel
        promotion={promotions.value.standard.items[0] ?? null}
        promotions={promotions.value.standard}
      />
    </>
  );
}

function HomeLocationsSection({
  locations,
  titleId,
}: {
  readonly locations: HomeBase['locations'];
  readonly titleId: string;
}): React.JSX.Element {
  return (
    <section className="fh-locations" aria-labelledby={titleId}>
      <div className="fh-section-head">
        <h2 id={titleId}>
          Локации <span>{locations.length}</span>
        </h2>
        <a href="/locations">Все</a>
      </div>
      <div className="fh-location-track">
        {locations.map((location, index) => {
          const imageUrl = location.imageUrl ?? (index === 0 ? locationSeligerUrl : null);
          return (
            <a
              className="fh-location-card"
              href={location.route}
              key={location.id}
              aria-label={`${location.title}, ${location.courtCount} ${locationCourtLabel(location.courtCount)}`}
              style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}
            >
              <span>
                <strong>{location.title}</strong>
                <small>
                  {location.courtCount} {locationCourtLabel(location.courtCount)}
                </small>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function HomeAdditionalLinks({
  links,
}: {
  readonly links: HomeBase['additionalLinks'];
}): React.JSX.Element | null {
  const visibleLinks = links.filter((link) => isImplementedMvpRoute(link.route));
  if (visibleLinks.length === 0) return null;

  return (
    <nav className="fh-additional" aria-label="Дополнительные разделы">
      {visibleLinks.map((link) => (
        <a href={link.route} key={link.id}>
          <span>{link.title}</span>
          <Chevron />
        </a>
      ))}
    </nav>
  );
}

export type HomeUpcomingItem = UserUpcomingBookings['items'][number];

const upcomingKindLabel: Readonly<Record<HomeUpcomingItem['kind'], string>> = {
  game: 'Игра',
  training: 'Тренировка',
  tournament: 'Турнир',
};

const upcomingStatusLabel: Readonly<Record<HomeUpcomingItem['status'], string>> = {
  confirmed: 'Подтверждено',
  waitlist: 'Лист ожидания',
  payment_required: 'Нужна оплата',
};

const upcomingTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

const upcomingDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
});

const upcomingWeekdayFormatter = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
});

const calendarDayFormatter = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
});

const calendarDayLabelFormatter = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function bookingCalendarDays(now: Date, dayOffset: number): readonly Date[] {
  const firstDay = new Date(now);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() + dayOffset);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(firstDay);
    day.setDate(firstDay.getDate() + index);
    return day;
  });
}

function participantLabel(
  participant: NonNullable<HomeUpcomingItem['participants']>[number],
): string {
  const fullName = [participant.firstName, participant.lastName].filter(Boolean).join(' ');
  const nickname = participant.nickname
    ? participant.nickname.startsWith('@')
      ? participant.nickname
      : `@${participant.nickname}`
    : null;
  return [fullName || participant.displayName, nickname].filter(Boolean).join(' · ');
}

function EventParticipants({
  item,
}: {
  readonly item: HomeUpcomingItem;
}): React.JSX.Element | null {
  return (
    <ParticipantAvatarStack
      ariaLabel="Участники записи"
      capacity={4}
      participants={(item.participants ?? []).map((participant, index) => {
        const label = participantLabel(participant);
        return {
          key: participant.profileId ?? `${label}-${index}`,
          displayName: label,
          avatarUrl: participant.avatarUrl ?? null,
          level: participant.level ?? null,
          levelValue: participant.levelValue ?? null,
        };
      })}
    />
  );
}

export function UpcomingBookingCard({
  item,
  showAction = true,
}: {
  readonly item: HomeUpcomingItem;
  readonly showAction?: boolean;
}): React.JSX.Element {
  const startsAt = new Date(item.startsAt);
  const hasParticipants = (item.participants?.length ?? 0) + (item.openSlots ?? 0) > 0;
  const detailsHref = isImplementedMvpRoute(item.route) ? item.route : '/bookings';
  const gameType = item.game?.type;
  const stationTitle = item.game?.station?.title ?? item.venue.split(' · ')[0];
  const endsAt = item.endsAt ? new Date(item.endsAt) : null;
  const weekdayLabel = upcomingWeekdayFormatter.format(startsAt);
  const weekday = weekdayLabel.endsWith('.') ? weekdayLabel : `${weekdayLabel}.`;
  const timeLabel = endsAt
    ? `с ${upcomingTimeFormatter.format(startsAt)} до ${upcomingTimeFormatter.format(endsAt)}`
    : `с ${upcomingTimeFormatter.format(startsAt)}`;
  const locationLabel = item.game?.courtName
    ? `${stationTitle} · ${item.game.courtName}`
    : stationTitle;
  return (
    <article
      className={hasParticipants ? 'fh-event has-participants' : 'fh-event'}
      aria-label={item.title}
    >
      {gameType ? (
        <GameTypeBadge type={gameType} />
      ) : (
        <span className={`fh-event__tag is-${item.status.replace('_', '-')}`}>
          <span className="fh-event__tag-label">
            {upcomingKindLabel[item.kind]} · {upcomingStatusLabel[item.status]}
          </span>
        </span>
      )}
      <h3 className="activity-card-title">{item.title}</h3>
      <span className="fh-event__metadata">
        <span className="activity-card-metadata-row">
          <EventCalendarIcon />
          <time dateTime={item.startsAt}>
            {upcomingDateFormatter.format(startsAt)}, {weekday}, {timeLabel}
          </time>
        </span>
        <span className="activity-card-metadata-row">
          <EventLocationIcon />
          {item.game?.station ? (
            <a href={item.game.station.route}>{locationLabel}</a>
          ) : (
            <span>{locationLabel}</span>
          )}
        </span>
      </span>
      <span className="fh-event__divider" aria-hidden="true" />
      <span className="fh-event__footer">
        <EventParticipants item={item} />
        {showAction ? (
          <a className="fh-event__action" href={detailsHref}>
            Открыть
          </a>
        ) : null}
      </span>
    </article>
  );
}

function HomeViewerHeader({
  fallback,
  notificationUnreadCount,
  onRetry,
  viewer,
}: {
  readonly fallback: HomeDashboardPageProps['viewerFallback'];
  readonly notificationUnreadCount: number;
  readonly onRetry: () => void;
  readonly viewer: HomeSectionEnvelope<UserProfile> | null;
}): React.JSX.Element {
  const profile = viewer && viewer.state !== 'UNAVAILABLE' ? viewer.value : null;
  const displayName = profile?.displayName ?? fallback.displayName;
  const userId = profile?.userId ?? fallback.id;
  const balance = profile
    ? new Intl.NumberFormat('ru-RU').format(profile.balanceMinor / 100)
    : null;

  return (
    <header className="fh-profile-row">
      <a className="fh-profile" href="/profile">
        <PlayerLevelAvatar
          alt={displayName}
          fallbackSeed={userId}
          level={
            profile ? (profile.level.assessmentRequired ? '?' : profile.level.label) : 'не загружен'
          }
          progress={profile ? levelAvatarProgress(profile.level) : 0}
          showLevelRing={Boolean(profile)}
          src={profile?.avatarUrl ?? null}
        />
        <span className="fh-profile-copy">
          <h1>{displayName}</h1>
          {profile ? (
            <small>
              <WalletIcon />
              {balance} ₽
            </small>
          ) : (
            <small role={viewer?.state === 'UNAVAILABLE' ? 'alert' : 'status'}>
              {viewer?.state === 'UNAVAILABLE'
                ? 'Профиль временно недоступен'
                : 'Загружаем профиль…'}
            </small>
          )}
          {viewer?.state === 'STALE' ? <small>Профиль может быть неактуален</small> : null}
        </span>
      </a>
      {viewer?.state === 'UNAVAILABLE' ? (
        <button
          className="fh-profile-retry"
          type="button"
          aria-label="Повторить загрузку профиля"
          onClick={onRetry}
        >
          <span aria-hidden="true">↻</span>
        </button>
      ) : null}
      <NotificationBellLink unreadCount={notificationUnreadCount} />
    </header>
  );
}

export function HomeDashboardPage({
  dashboard,
  viewerFallback,
  viewer,
  upcoming,
  tenantName,
  layoutVariant = 'default',
  recommendationDisplay = 'CARDS',
  notificationUnreadCount,
  loadCommunityPage,
  communityPageSize = 10,
  loadBookingRecommendations = () =>
    Promise.resolve({
      version: '0'.repeat(64),
      generatedAt: new Date(0).toISOString(),
      staleAt: new Date(0).toISOString(),
      personalization: 'BASIC',
      items: [],
      nextCursor: null,
    }),
  loadActivityHistory = () => Promise.reject(new Error('ACTIVITY_HISTORY_NOT_CONNECTED')),
  recordPromotionEngagement,
  logoutBusy,
  error,
  onRetryViewer,
  onActivateUpcoming = () => undefined,
  onRetryUpcoming,
  onLogout,
}: HomeDashboardPageProps): React.JSX.Element {
  const actionRoute = (id: HomeBase['quickActions'][number]['id'], fallback: string): string =>
    dashboard.quickActions.find((action) => action.id === id)?.route ?? fallback;
  const actions = [
    { id: 'games', label: 'Играть', icon: 'games', route: actionRoute('play', '/games') },
    {
      id: 'trainings',
      label: 'Тренироваться',
      icon: 'trainings',
      route: actionRoute('group_training', '/trainings'),
    },
  ] as const;
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [selectedBookingKind, setSelectedBookingKind] = useState<'all' | HomeUpcomingItem['kind']>(
    'all',
  );
  const [calendarDayOffset, setCalendarDayOffset] = useState(0);
  const calendarSwipeStartX = useRef<number | null>(null);
  const [bookingTab, setBookingTab] = useState<'MY' | 'FOR_ME'>('FOR_ME');
  const [bookingRecommendations, setBookingRecommendations] =
    useState<BookingRecommendationPage | null>(null);
  const [bookingRecommendationsLoading, setBookingRecommendationsLoading] = useState(true);
  const [bookingRecommendationsLoadingMore, setBookingRecommendationsLoadingMore] = useState(false);
  const [bookingRecommendationsError, setBookingRecommendationsError] = useState<string | null>(
    null,
  );
  const initialBookingRecommendationsLoader = useRef(loadBookingRecommendations);
  const initialBookingRecommendationLimit = useRef(layoutVariant === 'v3' ? 14 : 6);
  const bookingRecommendationsRequestStarted = useRef(true);
  const bookingRecommendationsLoadMoreStarted = useRef(false);
  const bookingRecommendationsExpansionStarted = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const calendarDays = bookingCalendarDays(new Date(), calendarDayOffset);
  const upcomingItems =
    upcoming && upcoming.state !== 'UNAVAILABLE' ? upcoming.value.items : ([] as const);
  const datesWithBookings = new Set(
    upcomingItems.map((item) => localDateKey(new Date(item.startsAt))),
  );
  const visibleUpcoming = upcomingItems.filter(
    (item) =>
      (!selectedDateKey || localDateKey(new Date(item.startsAt)) === selectedDateKey) &&
      (selectedBookingKind === 'all' || item.kind === selectedBookingKind),
  );
  const showBookingsScrollPeek = bookingTab === 'MY' && visibleUpcoming.length > 2;
  const showRecommendationsScrollPeek = bookingTab === 'FOR_ME';
  const usesCompactHero = layoutVariant !== 'default';
  const usesV3RecommendationCards = layoutVariant === 'v3' && recommendationDisplay === 'CARDS';
  const shellClassName = [
    'figma-home-shell',
    layoutVariant === 'v3' ? (usesV3RecommendationCards ? 'is-home-v3' : 'is-home-v3-rows') : null,
    layoutVariant === 'v3' && bookingTab === 'MY' ? 'has-v3-my-extras' : null,
    showBookingsScrollPeek
      ? 'has-bookings-scroll-peek'
      : showRecommendationsScrollPeek
        ? 'has-recommendations-scroll-peek'
        : null,
  ]
    .filter(Boolean)
    .join(' ');
  const communities =
    dashboard.communities.status === 'UNAVAILABLE' ? null : dashboard.communities.value;
  const promotionSlots =
    dashboard.promotions.status === 'UNAVAILABLE' ? null : dashboard.promotions.value;
  const heroCommunities = dashboard.capabilities.canViewCommunities ? (
    <section className="fh-hero-communities" aria-label="Сообщества">
      {communities || loadCommunityPage ? (
        <HomeCommunityCarousel
          initialItems={communities ?? []}
          snapshotAvailable={communities !== null}
          loadPage={loadCommunityPage}
          pageSize={communityPageSize}
        />
      ) : (
        <p className="fh-section-unavailable" role="alert">
          Сообщества временно недоступны.
        </p>
      )}
    </section>
  ) : null;
  const heroPromotion =
    promotionSlots && promotionSlots.hero.items.length > 0 ? (
      <HomePromotionCarousel promotion={null} promotions={promotionSlots.hero} variant="hero" />
    ) : (
      <HomeHeroPromotionFallback />
    );

  const requestBookingRecommendations = useCallback((): void => {
    setBookingRecommendationsError(null);
    if (bookingRecommendations || bookingRecommendationsRequestStarted.current) return;
    bookingRecommendationsRequestStarted.current = true;
    setBookingRecommendationsLoading(true);
    void loadBookingRecommendations({ limit: layoutVariant === 'v3' ? 14 : 6 }).then(
      (page) => {
        setBookingRecommendations(page);
        setBookingRecommendationsLoading(false);
      },
      () => {
        bookingRecommendationsRequestStarted.current = false;
        setBookingRecommendationsError('Не удалось загрузить рекомендации.');
        setBookingRecommendationsLoading(false);
      },
    );
  }, [bookingRecommendations, layoutVariant, loadBookingRecommendations]);

  const loadMoreBookingRecommendations = useCallback((): void => {
    const cursor = bookingRecommendations?.nextCursor;
    if (!cursor || bookingRecommendationsLoadMoreStarted.current) return;
    bookingRecommendationsLoadMoreStarted.current = true;
    setBookingRecommendationsLoadingMore(true);
    setBookingRecommendationsError(null);
    void loadBookingRecommendations({ limit: 12, cursor }).then(
      (page) => {
        setBookingRecommendations((current) =>
          current ? appendRecommendationPage(current, page) : page,
        );
        bookingRecommendationsLoadMoreStarted.current = false;
        setBookingRecommendationsLoadingMore(false);
      },
      () => {
        bookingRecommendationsLoadMoreStarted.current = false;
        setBookingRecommendationsLoadingMore(false);
        setBookingRecommendationsError('Не удалось загрузить следующие рекомендации.');
      },
    );
  }, [bookingRecommendations?.nextCursor, loadBookingRecommendations]);

  useEffect(() => {
    let active = true;
    void initialBookingRecommendationsLoader
      .current({ limit: initialBookingRecommendationLimit.current })
      .then(
        (page) => {
          if (!active) return;
          setBookingRecommendations(page);
          setBookingRecommendationsLoading(false);
        },
        () => {
          if (!active) return;
          bookingRecommendationsRequestStarted.current = false;
          setBookingRecommendationsError('Не удалось загрузить рекомендации.');
          setBookingRecommendationsLoading(false);
        },
      );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !bookingRecommendations ||
      bookingRecommendationsLoading ||
      bookingRecommendationsExpansionStarted.current
    ) {
      return;
    }
    bookingRecommendationsExpansionStarted.current = true;
    let active = true;
    void loadBookingRecommendations({
      limit: initialBookingRecommendationLimit.current,
      phase:
        bookingRecommendations.items.length < HOME_RECOMMENDATION_EXPANSION_THRESHOLD
          ? 'EXPANDED'
          : 'TOURNAMENTS',
    }).then(
      (page) => {
        if (active) setBookingRecommendations(page);
      },
      () => {
        // The initial three-day recommendation slice remains usable.
      },
    );
    return () => {
      active = false;
    };
  }, [bookingRecommendations, bookingRecommendationsLoading, loadBookingRecommendations]);

  function showBookingRecommendations(): void {
    setBookingTab('FOR_ME');
    requestBookingRecommendations();
  }

  return (
    <div className={shellClassName}>
      <main className="figma-home" aria-label="Главная">
        <section
          className={`fh-hero${usesCompactHero ? ' fh-hero--v2' : ''}${
            layoutVariant === 'v3' ? ' fh-hero--v3' : ''
          }`}
        >
          <HeroBackgroundX />
          <HomeViewerHeader
            fallback={viewerFallback}
            notificationUnreadCount={notificationUnreadCount}
            onRetry={onRetryViewer}
            viewer={viewer}
          />

          {layoutVariant === 'v3' ? (
            <>
              {heroCommunities}
              {heroPromotion}
            </>
          ) : (
            <>
              {usesCompactHero ? heroPromotion : heroCommunities}
              {usesCompactHero ? heroCommunities : heroPromotion}
            </>
          )}

          <nav className="fh-actions" aria-label="Разделы клуба">
            {actions.map((action) => (
              <a href={action.route} key={action.id}>
                <span className="fh-action-icon">
                  <HomeActionIcon name={action.icon} />
                </span>
                <span>{action.label}</span>
              </a>
            ))}
          </nav>

          <div className="fh-tabs" role="tablist" aria-label="Раздел записей">
            <button
              type="button"
              role="tab"
              aria-selected={bookingTab === 'FOR_ME'}
              onClick={showBookingRecommendations}
            >
              Для меня
            </button>
            <a
              className="fh-preferences-edit"
              href="/profile#booking-preferences-title"
              aria-label="Настроить предпочтения"
              title="Настроить предпочтения"
            >
              <HomePreferencesEditIcon />
            </a>
            <button
              type="button"
              role="tab"
              aria-selected={bookingTab === 'MY'}
              onClick={() => {
                setBookingTab('MY');
                setBookingRecommendationsError(null);
                onActivateUpcoming();
              }}
            >
              <span className="fh-tab-label">
                Мои записи
                {upcomingItems.length > 0 ? (
                  <i className="fh-booking-presence-dot" aria-hidden="true" />
                ) : null}
              </span>
            </button>
          </div>
        </section>

        <section className="fh-main-box">
          <section
            className="fh-bookings"
            aria-label={bookingTab === 'MY' ? 'Мои записи' : 'Для меня'}
          >
            {bookingTab === 'MY' ? (
              upcoming === null ? (
                <div className="fh-section-state" role="status">
                  <span className="loader" aria-hidden="true" />
                  <strong>Загружаем мои записи…</strong>
                </div>
              ) : upcoming.state === 'UNAVAILABLE' ? (
                <div className="fh-section-state is-unavailable" role="alert">
                  <strong>Мои записи временно недоступны</strong>
                  <p>{upcoming.message}</p>
                  <button type="button" onClick={onRetryUpcoming}>
                    Повторить
                  </button>
                </div>
              ) : (
                <>
                  {upcoming.state === 'STALE' ? (
                    <p className="fh-section-stale" role="status">
                      Показаны последние доступные записи. Данные могут быть неактуальны.
                    </p>
                  ) : null}
                  <div className="fh-filters" aria-label="Фильтр записей по дате">
                    <div
                      className="fh-calendar"
                      onPointerDown={(event) => {
                        calendarSwipeStartX.current = event.clientX;
                      }}
                      onPointerUp={(event) => {
                        const startX = calendarSwipeStartX.current;
                        calendarSwipeStartX.current = null;
                        if (startX === null || Math.abs(event.clientX - startX) < 40) return;
                        setCalendarDayOffset((currentOffset) =>
                          event.clientX < startX
                            ? Math.min(14, currentOffset + 1)
                            : Math.max(0, currentOffset - 1),
                        );
                      }}
                      onPointerCancel={() => {
                        calendarSwipeStartX.current = null;
                      }}
                    >
                      <button
                        className={
                          selectedDateKey === null
                            ? 'fh-calendar-reset is-selected'
                            : 'fh-calendar-reset'
                        }
                        type="button"
                        aria-label="Все даты"
                        aria-pressed={selectedDateKey === null}
                        onClick={() => setSelectedDateKey(null)}
                      >
                        <span>Все даты</span>
                      </button>
                      {calendarDays.map((day) => {
                        const dateKey = localDateKey(day);
                        const selected = selectedDateKey === dateKey;
                        return (
                          <button
                            className={selected ? 'is-selected' : ''}
                            type="button"
                            key={dateKey}
                            aria-label={calendarDayLabelFormatter.format(day)}
                            aria-pressed={selected}
                            onClick={() => setSelectedDateKey(selected ? null : dateKey)}
                          >
                            <strong>{day.getDate()}</strong>
                            <small>{calendarDayFormatter.format(day).replace('.', '')}</small>
                            {datesWithBookings.has(dateKey) ? (
                              <i className="fh-booking-presence-dot" aria-hidden="true" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                    <div className="fh-filter-pills" aria-label="Фильтр записей по типу">
                      {(
                        [
                          ['all', 'Все'],
                          ['game', 'Игры'],
                          ['training', 'Тренировки'],
                          ['tournament', 'Турниры'],
                        ] as const
                      ).map(([kind, label]) => (
                        <button
                          className={selectedBookingKind === kind ? 'is-selected' : ''}
                          type="button"
                          key={kind}
                          aria-pressed={selectedBookingKind === kind}
                          onClick={() => setSelectedBookingKind(kind)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="fh-divider" />
                  {visibleUpcoming.length > 0 ? (
                    <div className="fh-bookings-list">
                      {visibleUpcoming.map((item) => (
                        <div className="fh-booking-entry" key={item.id}>
                          <UpcomingBookingCard item={item} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="fh-bookings-empty" role="status">
                      <strong>
                        {selectedDateKey || selectedBookingKind !== 'all'
                          ? 'По выбранным фильтрам записей нет'
                          : 'Ближайших записей нет'}
                      </strong>
                      <p>
                        {selectedDateKey || selectedBookingKind !== 'all'
                          ? 'Выберите другой день, тип записи или снимите фильтр даты повторным нажатием.'
                          : 'Когда появятся ближайшие записи, они отобразятся здесь.'}
                      </p>
                    </div>
                  )}
                  <div className="fh-bookings-footer">
                    <div className="fh-divider" />
                    <div className="fh-bookings-footer-action">
                      <button type="button" onClick={() => setHistoryOpen(true)}>
                        История посещений
                      </button>
                    </div>
                  </div>
                </>
              )
            ) : (
              <div className="fh-for-me">
                {bookingRecommendationsLoading && !bookingRecommendations ? (
                  <div
                    className={`fh-for-me-loader${layoutVariant === 'v3' ? ' fh-for-me-loader--pulse' : ''}`}
                    role="status"
                    aria-label="Подбираем игры"
                  >
                    {layoutVariant === 'v3' ? (
                      <span className="fh-loader-pulse" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <img src={bookingRecommendationsLoaderUrl} alt="" />
                    )}
                  </div>
                ) : null}
                {bookingRecommendationsError ? (
                  <p role="alert">{bookingRecommendationsError}</p>
                ) : null}
                {bookingRecommendations ? (
                  <BookingRecommendations
                    page={bookingRecommendations}
                    compact
                    compactActionVariant={usesV3RecommendationCards ? 'mini-create' : 'default'}
                    compactMetadataVariant={usesV3RecommendationCards ? 'station-time' : 'default'}
                    compactRosterVariant={usesV3RecommendationCards ? 'host-slots' : 'default'}
                    compactVisualVariant={usesV3RecommendationCards ? 'photo-grid' : 'default'}
                    showCompactReasonBadges={!usesV3RecommendationCards}
                    hasMore={Boolean(bookingRecommendations.nextCursor)}
                    loadingMore={bookingRecommendationsLoadingMore}
                    onLoadMore={loadMoreBookingRecommendations}
                    recommendationStripAdvertising={promotionSlots?.recommendationStrip ?? null}
                    recommendationCardAdvertising={promotionSlots?.recommendationCard ?? null}
                    advertisingLayout={usesV3RecommendationCards ? 'compact' : 'vertical'}
                    {...(recordPromotionEngagement
                      ? { onAdvertisingEngagement: recordPromotionEngagement }
                      : {})}
                  />
                ) : null}
                <div className="fh-bookings-footer">
                  <div className="fh-divider" />
                  <div
                    className={`fh-bookings-footer-action${
                      usesV3RecommendationCards ? '' : ' is-split'
                    }`}
                  >
                    {usesV3RecommendationCards ? null : (
                      <a href="/bookings?view=for-me">Все рекомендации</a>
                    )}
                    <a href="/profile#booking-preferences-title">Настроить</a>
                  </div>
                </div>
              </div>
            )}
          </section>

          {layoutVariant === 'v3' && bookingTab === 'MY' ? (
            <section className="fh-v3-my-extras" aria-label="Сервисы клуба">
              <HomeStandardPromotionSection promotions={dashboard.promotions} />
              <HomeLocationsSection
                locations={dashboard.locations}
                titleId="fh-v3-locations-title"
              />
              <HomeAdditionalLinks links={dashboard.additionalLinks} />
            </section>
          ) : null}

          {layoutVariant === 'v3' ? null : (
            <>
              <HomeStandardPromotionSection promotions={dashboard.promotions} />

              <section className="fh-lower">
                <HomeLocationsSection
                  locations={dashboard.locations}
                  titleId="fh-locations-title"
                />
                <HomeAdditionalLinks links={dashboard.additionalLinks} />
              </section>
            </>
          )}
        </section>

        <MainBottomNavigation active="home" />

        <button
          className="fh-logout-accessible"
          type="button"
          disabled={logoutBusy}
          onClick={onLogout}
        >
          Выйти
        </button>
        <span className="fh-tenant-accessible">{tenantName}</span>
        {error ? (
          <p className="fh-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
      <ActivityHistoryModal
        open={historyOpen}
        loadHistory={loadActivityHistory}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}
