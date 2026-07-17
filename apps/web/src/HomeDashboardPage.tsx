import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, UIEvent } from 'react';

import type { CommunityMembershipPage, HomeDashboard } from './auth-gateway.js';
import locationSeligerUrl from './assets/home/location-seliger.png';
import player1Url from './assets/home/player-1.png';
import player2Url from './assets/home/player-2.png';
import player3Url from './assets/home/player-3.png';
import player4Url from './assets/home/player-4.png';
import promoUrl from './assets/home/promo.png';
import { PlayerLevelAvatar } from './PlayerLevelAvatar.js';

interface HomeDashboardPageProps {
  readonly dashboard: HomeDashboard;
  readonly tenantName: string;
  readonly notificationUnreadCount: number;
  readonly loadCommunityPage: (cursor?: string) => Promise<CommunityMembershipPage>;
  readonly logoutBusy: boolean;
  readonly error?: string | null;
  readonly onLogout: () => void;
}

type HomeCommunity = HomeDashboard['communities'][number];

type HomeActionIconName = 'games' | 'tournaments' | 'trainings';

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

function BottomNavIcon({ name }: { readonly name: BottomNavIconName }): React.JSX.Element {
  switch (name) {
    case 'home':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M7.09572 1.78614C8.46171 0.72792 10.6414 0.673629 12.0617 1.66846L17.2737 5.31449C18.2687 6.01117 19.0559 7.51343 19.0559 8.73469V14.868C19.0559 17.175 17.1825 19.0483 14.8755 19.0483H5.12268C2.81597 19.0481 0.943515 17.1662 0.943359 14.8595V8.61701C0.943359 7.4773 1.65783 6.02985 2.56229 5.32403L7.09572 1.78614ZM9.99961 10.8148C9.54992 10.8148 9.18537 11.1794 9.18537 11.629V15.4288C9.18542 15.8785 9.54995 16.243 9.99961 16.243C10.4493 16.243 10.8138 15.8785 10.8138 15.4288V11.629C10.8138 11.1794 10.4493 10.8148 9.99961 10.8148Z"
            fill="#353436"
          />
        </svg>
      );
    case 'games':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M9.97508 1.0417C9.46675 1.0417 8.94175 1.08337 8.40842 1.17504C4.74175 1.80004 1.75008 4.80004 1.14175 8.48337C0.658417 11.4084 1.56675 14.2667 3.64175 16.3417C5.71675 18.4167 8.57508 19.3167 11.4917 18.8417C15.1667 18.2334 18.1751 15.25 18.8001 11.5834C18.9334 10.775 18.9667 9.98337 18.9001 9.23337V9.22503C18.8834 9.03337 18.8501 8.85003 18.8001 8.6667C18.7417 8.45837 18.5834 8.30004 18.3834 8.23337C18.1834 8.1667 17.9584 8.2167 17.7917 8.35004C17.0084 9.00837 16.0084 9.37504 14.9751 9.37504C12.5584 9.37504 10.6001 7.40837 10.6001 5.00004C10.6001 3.9667 10.9668 2.9667 11.6251 2.18337C11.7667 2.0167 11.8084 1.80004 11.7417 1.5917C11.6751 1.38337 11.5167 1.23337 11.3084 1.17504C11.1251 1.12504 10.9417 1.0917 10.7501 1.07504C10.5001 1.05004 10.2418 1.0417 9.97508 1.0417ZM9.97508 17.7084C7.93342 17.7084 6.00008 16.9167 4.53342 15.45C2.75008 13.6667 1.96675 11.2 2.38342 8.68337C2.90842 5.52503 5.46675 2.9417 8.62508 2.40837C9.12508 2.32504 9.60008 2.27504 10.0584 2.2917C9.60842 3.1167 9.36675 4.05004 9.36675 5.00004C9.36675 8.10004 11.8917 10.625 14.9917 10.625C15.9417 10.625 16.8751 10.3834 17.7001 9.93337C17.7084 10.3917 17.6667 10.8667 17.5834 11.3667C17.0501 14.5167 14.4667 17.0834 11.3084 17.6C10.8501 17.675 10.4084 17.7084 9.97508 17.7084Z"
            fill="#353436"
          />
          <path
            d="M11.1496 1.15833C10.9663 1.15833 10.7913 1.23333 10.6746 1.38333C9.82461 2.39167 9.34961 3.675 9.34961 5C9.34961 8.1 11.8746 10.625 14.9746 10.625C16.2996 10.625 17.5829 10.1583 18.5913 9.3C18.7829 9.14167 18.8579 8.88333 18.7913 8.65C18.6413 8.13333 18.2583 6.38333 17.875 6C15.7987 3.92371 15.375 3 12.6746 1.98333C12.2913 1.6 11.8329 1.33333 11.3246 1.18333C11.2663 1.16667 11.2079 1.15833 11.1496 1.15833ZM14.9746 9.375C12.5579 9.375 10.5996 7.40833 10.5996 5C10.5996 4.11667 10.8663 3.25833 11.3579 2.54167C11.3579 2.54167 11.7417 1.86667 11.875 2C14.875 2.5 15.7987 3.92371 17.875 6C18.0083 6.13333 17.7917 8.34167 17.875 8.5C17.1583 8.99167 15.8579 9.375 14.9746 9.375Z"
            fill="#353436"
          />
          <circle cx="9.875" cy="10" r="8.375" stroke="#353436" strokeWidth="1.25" />
        </svg>
      );
    case 'create':
      return (
        <svg width="88" height="72" viewBox="0 0 88 72" fill="none" aria-hidden="true">
          <g filter="url(#fh-create-shadow)">
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
              id="fh-create-shadow"
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
              <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow" />
              <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
            </filter>
          </defs>
        </svg>
      );
    case 'chat':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M9.99935 19.0079C9.42435 19.0079 8.88268 18.7163 8.49935 18.2079L7.24935 16.5413C7.22435 16.5079 7.12435 16.4663 7.08268 16.4579H6.66602C3.19102 16.4579 1.04102 15.5163 1.04102 10.8329V6.66626C1.04102 2.98293 2.98268 1.04126 6.66602 1.04126H13.3327C17.016 1.04126 18.9577 2.98293 18.9577 6.66626V10.8329C18.9577 14.5163 17.016 16.4579 13.3327 16.4579H12.916C12.8493 16.4579 12.791 16.4913 12.7493 16.5413L11.4993 18.2079C11.116 18.7163 10.5743 19.0079 9.99935 19.0079ZM6.66602 2.29126C3.68268 2.29126 2.29102 3.68293 2.29102 6.66626V10.8329C2.29102 14.5996 3.58268 15.2079 6.66602 15.2079H7.08268C7.50768 15.2079 7.99101 15.4496 8.24935 15.7913L9.49935 17.4579C9.79101 17.8413 10.2077 17.8413 10.4993 17.4579L11.7493 15.7913C12.0243 15.4246 12.4577 15.2079 12.916 15.2079H13.3327C16.316 15.2079 17.7077 13.8163 17.7077 10.8329V6.66626C17.7077 3.68293 16.316 2.29126 13.3327 2.29126H6.66602Z"
            fill="#353436"
          />
        </svg>
      );
    case 'profile':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M10.1441 9.5C10.0541 9.49098 9.94595 9.49098 9.84685 9.5C7.7027 9.42785 6 7.66911 6 5.50451C6 3.29481 7.78378 1.5 10 1.5C12.2072 1.5 14 3.29481 14 5.50451C13.991 7.66911 12.2883 9.42785 10.1441 9.5Z"
            stroke="#353436"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10.0078 11.625C11.7873 11.625 13.529 12.0325 14.8145 12.8086H14.8154C15.9357 13.4823 16.375 14.2932 16.375 14.9932C16.3749 15.6936 15.9345 16.5061 14.8135 17.1846C13.5226 17.9653 11.7789 18.375 10 18.375C8.22112 18.375 6.47741 17.9653 5.18652 17.1846L5.18457 17.1836C4.06461 16.5099 3.625 15.6998 3.625 15C3.625 14.2996 4.06466 13.486 5.18555 12.8076C6.48212 12.0311 8.22931 11.625 10.0078 11.625Z"
            stroke="#353436"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

function NotificationBellIcon(): React.JSX.Element {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <path
        d="M0 18C0 8.05888 8.05888 0 18 0C27.9411 0 36 8.05888 36 18C36 27.9411 27.9411 36 18 36C8.05888 36 0 27.9411 0 18Z"
        fill="white"
        fillOpacity="0.01"
      />
      <g className="fh-bell-glyph">
        <path
          d="M22.8936 19.66L22.227 18.5534C22.087 18.3067 21.9603 17.84 21.9603 17.5667V15.88C21.9603 14.3134 21.0403 12.96 19.7136 12.3267C19.367 11.7134 18.727 11.3334 17.9936 11.3334C17.267 11.3334 16.6136 11.7267 16.267 12.3467C14.967 12.9934 14.067 14.3334 14.067 15.88V17.5667C14.067 17.84 13.9403 18.3067 13.8003 18.5467L13.127 19.66C12.8603 20.1067 12.8003 20.6 12.967 21.0534C13.127 21.5 13.507 21.8467 14.0003 22.0134C15.2936 22.4534 16.6536 22.6667 18.0136 22.6667C19.3736 22.6667 20.7336 22.4534 22.027 22.02C22.4936 21.8667 22.8536 21.5134 23.027 21.0534C23.2003 20.5934 23.1536 20.0867 22.8936 19.66Z"
          fill="white"
        />
        <path
          d="M19.8868 23.34C19.6068 24.1134 18.8668 24.6667 18.0001 24.6667C17.4735 24.6667 16.9535 24.4534 16.5868 24.0734C16.3735 23.8734 16.2135 23.6067 16.1201 23.3334C16.2068 23.3467 16.2935 23.3534 16.3868 23.3667C16.5401 23.3867 16.7001 23.4067 16.8601 23.42C17.2401 23.4534 17.6268 23.4734 18.0135 23.4734C18.3935 23.4734 18.7735 23.4534 19.1468 23.42C19.2868 23.4067 19.4268 23.4 19.5601 23.38C19.6668 23.3667 19.7735 23.3534 19.8868 23.34Z"
          fill="white"
        />
      </g>
    </svg>
  );
}

function Chevron(): React.JSX.Element {
  return <span className="fh-chevron" aria-hidden="true" />;
}

function levelAvatarProgress(level: HomeDashboard['profile']['level']): number {
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

function communityTitleLines(title: string): readonly [string] | readonly [string, string] {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= 1) return [words[0] ?? title];
  let splitAt = 1;
  let bestLongestLine = Number.POSITIVE_INFINITY;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const firstLength = words.slice(0, index).join(' ').length;
    const secondLength = words.slice(index).join(' ').length;
    const longestLine = Math.max(firstLength, secondLength);
    const difference = Math.abs(firstLength - secondLength);
    if (
      longestLine < bestLongestLine ||
      (longestLine === bestLongestLine && difference < bestDifference)
    ) {
      splitAt = index;
      bestLongestLine = longestLine;
      bestDifference = difference;
    }
  }
  return [words.slice(0, splitAt).join(' '), words.slice(splitAt).join(' ')];
}

function CommunityTitle({ title }: { readonly title: string }): React.JSX.Element {
  const lines = communityTitleLines(title);
  return (
    <span
      className={`fh-community-title ${lines.length === 1 ? 'is-single-word' : 'is-two-lines'}`}
      data-title-lines={lines.length}
    >
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>{line}</span>
      ))}
    </span>
  );
}

function CommunityLogo({
  community,
}: {
  readonly community: HomeDashboard['communities'][number];
}): React.JSX.Element {
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
  loadPage,
}: {
  readonly initialItems: readonly HomeCommunity[];
  readonly loadPage: (cursor?: string) => Promise<CommunityMembershipPage>;
}): React.JSX.Element {
  const [directoryItems, setDirectoryItems] = useState<readonly HomeCommunity[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const loadingMore = useRef(false);
  const active = useRef(true);
  const drag = useRef({ active: false, moved: false, startX: 0, startScrollLeft: 0 });
  const suppressNextClick = useRef(false);
  const items = mergeCommunities(directoryItems, initialItems);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    let requestActive = true;
    void loadPage().then(
      (page) => {
        if (!requestActive) return;
        setDirectoryItems(page.items);
        setNextCursor(page.nextCursor);
      },
      () => undefined,
    );
    return () => {
      requestActive = false;
    };
  }, [loadPage]);

  function loadMore(): void {
    const cursor = nextCursor;
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    void loadPage(cursor).then(
      (page) => {
        if (!active.current) return;
        setDirectoryItems((current) => mergeCommunities(current, page.items));
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
      {items.map((community) => (
        <a
          href={community.route}
          key={community.id}
          draggable={false}
          aria-label={`${community.title}${
            community.unreadChatCount > 0
              ? `, непрочитанных сообщений: ${community.unreadChatCount}`
              : ''
          }`}
        >
          <CommunityLogo community={community} />
          <CommunityTitle title={community.title} />
        </a>
      ))}
    </div>
  );
}

function HomePromotionCarousel({
  promotion,
  promotions,
}: Pick<HomeDashboard, 'promotion' | 'promotions'>): React.JSX.Element | null {
  const items = promotions.items.length > 0 ? promotions.items : promotion ? [promotion] : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

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
      className="fh-promotions"
      aria-label="Акции"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <a
        className="fh-promo"
        href={activeItem.route}
        aria-label={activeItem.title}
        key={activeItem.id}
      >
        <picture>
          {activeItem.mobileImageUrl ? (
            <source media="(max-width: 767px)" srcSet={activeItem.mobileImageUrl} />
          ) : null}
          <img
            src={desktopImageUrl}
            alt=""
            width="750"
            height="480"
            loading="lazy"
            decoding="async"
          />
        </picture>
      </a>
      {items.length > 1 ? (
        <div className="fh-promotion-dots" role="group" aria-label="Выбор акции">
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

const dates = [
  ['13', 'пн'],
  ['14', 'вт'],
  ['15', 'ср'],
  ['16', 'чт'],
  ['17', 'пт'],
  ['18', 'сб'],
  ['19', 'вс'],
] as const;

const playerImages = [player1Url, player2Url, player3Url, player4Url];

function EventCard({
  item,
  index,
}: {
  readonly item: HomeDashboard['upcoming'][number] | undefined;
  readonly index: number;
}): React.JSX.Element {
  const isRating = index === 1;
  return (
    <a className="fh-event" href={item?.route ?? '/games'}>
      <time>
        <strong>{isRating ? '14:00' : '12:00'}</strong>
        <span>{isRating ? 'до 15:00' : 'до 13:00'}</span>
      </time>
      <span className="fh-event__main">
        <span className="fh-event__header">
          <span className={`fh-event__tag ${isRating ? 'is-rating' : ''}`}>
            <span aria-hidden="true">{isRating ? '★' : '●'}</span>
            {isRating ? 'Рейтинговая игра' : 'Френдли игра'}
          </span>
          <Chevron />
          <strong>{item?.title ?? (isRating ? 'Название игры #2' : 'Название игры')}</strong>
          <small>Ясенево · Паустовского, 4А</small>
        </span>
        <span className="fh-players" aria-label="Участники игры">
          {playerImages.slice(0, isRating ? 3 : 4).map((src, playerIndex) => (
            <img src={src} alt="" aria-hidden="true" key={`${index}-${playerIndex}`} />
          ))}
          {isRating ? <span className="fh-player-add">+</span> : null}
        </span>
      </span>
    </a>
  );
}

export function HomeDashboardPage({
  dashboard,
  tenantName,
  notificationUnreadCount,
  loadCommunityPage,
  logoutBusy,
  error,
  onLogout,
}: HomeDashboardPageProps): React.JSX.Element {
  const actionRoute = (id: HomeDashboard['quickActions'][number]['id'], fallback: string): string =>
    dashboard.quickActions.find((action) => action.id === id)?.route ?? fallback;
  const actions = [
    { id: 'games', label: 'Игры', icon: 'games', route: actionRoute('play', '/games') },
    {
      id: 'tournaments',
      label: 'Турниры',
      icon: 'tournaments',
      route: actionRoute('tournament', '/tournaments'),
    },
    {
      id: 'trainings',
      label: 'Тренировки',
      icon: 'trainings',
      route: actionRoute('group_training', '/trainings'),
    },
  ] as const;
  const balance = new Intl.NumberFormat('ru-RU').format(dashboard.profile.balanceMinor / 100);

  return (
    <div className="figma-home-shell">
      <main className="figma-home" aria-label="Главная">
        <section className="fh-hero">
          <header className="fh-profile-row">
            <a className="fh-profile" href="/profile">
              <PlayerLevelAvatar
                alt={dashboard.profile.displayName}
                level={
                  dashboard.profile.level.assessmentRequired ? '?' : dashboard.profile.level.label
                }
                progress={levelAvatarProgress(dashboard.profile.level)}
                src={dashboard.profile.avatarUrl ?? null}
              />
              <span className="fh-profile-copy">
                <h1>{dashboard.profile.displayName}</h1>
                <small>
                  <WalletIcon />
                  {balance} ₽
                </small>
              </span>
            </a>
            <a
              className={notificationUnreadCount > 0 ? 'fh-bell is-unread' : 'fh-bell'}
              href="/notifications"
              aria-label={
                notificationUnreadCount > 0
                  ? `Уведомления, непрочитанных: ${notificationUnreadCount}`
                  : 'Уведомления, непрочитанных нет'
              }
            >
              <NotificationBellIcon />
              {notificationUnreadCount > 0 ? (
                <span className="fh-bell-dot" aria-hidden="true" />
              ) : null}
            </a>
          </header>

          {dashboard.capabilities.canViewCommunities ? (
            <section className="fh-hero-communities" aria-labelledby="fh-community-title">
              <header>
                <h2 id="fh-community-title">Сообщества</h2>
                <a href="/communities">Все</a>
              </header>
              <HomeCommunityCarousel
                initialItems={dashboard.communities}
                loadPage={loadCommunityPage}
              />
            </section>
          ) : null}

          <nav className="fh-actions" aria-label="Разделы клуба">
            {actions.map((action) => (
              <a href={action.route} key={action.id}>
                <span className="fh-action-icon">
                  <HomeActionIcon name={action.icon} />
                </span>
                <span>{action.label}</span>
                <Chevron />
              </a>
            ))}
          </nav>

          <div className="fh-tabs" role="tablist" aria-label="Раздел записей">
            <button type="button" role="tab" aria-selected="true">
              Мои записи
            </button>
            <button type="button" role="tab" aria-selected="false">
              Абонементы
            </button>
          </div>
        </section>

        <section className="fh-main-box">
          <section className="fh-bookings" aria-label="Мои записи">
            <div className="fh-filters">
              <div className="fh-calendar">
                {dates.map(([date, day], index) => (
                  <button className={index === 1 ? 'is-selected' : ''} type="button" key={date}>
                    <strong>{date}</strong>
                    <small>{day}</small>
                    {index === 6 ? <i /> : null}
                  </button>
                ))}
              </div>
              <div className="fh-filter-pills">
                <button className="is-selected" type="button">
                  Все
                </button>
                <button type="button">Игры</button>
                <button type="button">Тренировки</button>
                <button type="button">Турниры</button>
              </div>
            </div>
            <div className="fh-divider" />
            <EventCard item={dashboard.upcoming[0]} index={0} />
            <div className="fh-divider" />
            <EventCard item={dashboard.upcoming[1]} index={1} />
            <div className="fh-bookings-footer">
              <div className="fh-divider" />
              <a href="/bookings">Все записи</a>
            </div>
          </section>

          <HomePromotionCarousel
            promotion={dashboard.promotion}
            promotions={dashboard.promotions}
          />

          <section className="fh-lower">
            <section className="fh-locations" aria-labelledby="fh-locations-title">
              <div className="fh-section-head">
                <h2 id="fh-locations-title">
                  Локации <span>{dashboard.locations.length}</span>
                </h2>
                <a href="/locations">Все</a>
              </div>
              <div className="fh-location-track">
                {dashboard.locations.map((location, index) => {
                  const imageUrl = location.imageUrl ?? (index === 0 ? locationSeligerUrl : null);
                  return (
                    <a
                      className="fh-location-card"
                      href={location.route}
                      key={location.id}
                      aria-label={`${location.title}, ${location.courtCount} кортов`}
                      style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}
                    >
                      <span>
                        <strong>{location.title}</strong>
                        <small>{location.courtCount} кортов</small>
                      </span>
                    </a>
                  );
                })}
              </div>
            </section>

            <nav className="fh-additional" aria-label="Дополнительные разделы">
              {dashboard.additionalLinks.map((link) => (
                <a href={link.route} key={link.id}>
                  <span>{link.title}</span>
                  <Chevron />
                </a>
              ))}
            </nav>
          </section>
        </section>

        <nav className="fh-bottom-nav" aria-label="Основная навигация">
          <a href="/" aria-current="page" aria-label="Главная">
            <BottomNavIcon name="home" />
          </a>
          <a href="/games" aria-label="Игры">
            <BottomNavIcon name="games" />
          </a>
          <a className="fh-create" href="/games/new" aria-label="Создать игру">
            <BottomNavIcon name="create" />
          </a>
          <a href="/chats" aria-label="Чаты">
            <BottomNavIcon name="chat" />
          </a>
          <a href="/profile" aria-label="Профиль">
            <BottomNavIcon name="profile" />
          </a>
        </nav>

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
    </div>
  );
}
