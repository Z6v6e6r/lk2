import { useId } from 'react';

export function CreateGameButtonIcon({
  fill = '#8766EB',
}: {
  readonly fill?: string;
} = {}): React.JSX.Element {
  const filterId = `create-game-shadow-${useId().replace(/:/g, '')}`;

  return (
    <svg width="88" height="72" viewBox="0 0 88 72" fill="none" aria-hidden="true">
      <g filter={`url(#${filterId})`}>
        <rect x="16" y="16" width="56" height="40" rx="16" fill={fill} />
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
          id={filterId}
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
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_743_2030" />
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
}
