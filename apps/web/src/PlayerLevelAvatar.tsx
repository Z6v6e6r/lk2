import { useId, useState } from 'react';
import type { CSSProperties } from 'react';

import fallbackPhotoUrl from './assets/home/profile.png';
import styles from './PlayerLevelAvatar.module.css';

export interface PlayerLevelAvatarProps {
  readonly src?: string | null;
  readonly alt: string;
  readonly level?: string | null;

  /** Заполненность текущего уровня от 0 до 100. */
  readonly progress?: number;

  readonly size?: number;
  readonly className?: string;
  readonly variant?: 'profile' | 'participant';
  readonly accentColor?: string;
}

type PlayerLevelAvatarStyle = CSSProperties & {
  readonly '--player-level-avatar-scale': number;
  readonly '--player-level-avatar-accent'?: string;
};

const BASE_SIZE = 48;

const RING_CENTER = 24;
const RING_OUTER_RADIUS = 24;
const RING_INNER_RADIUS = 22;

/**
 * Длина каждого сегмента — 84°.
 * Между сегментами остаётся промежуток 6°.
 * Заполнение идёт по часовой стрелке: нижний левый, верхний левый,
 * верхний правый, нижний правый.
 */
const RING_SEGMENT_ANGLES = [
  { start: 93, end: 177 },
  { start: 183, end: 267 },
  { start: 273, end: 357 },
  { start: 3, end: 87 },
] as const;

const BADGE_CLEARANCE = {
  x: 12,
  y: 37,
  width: 24,
  height: 16,
  radius: 8,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function ringPoint(radius: number, angleDegrees: number): string {
  const angleRadians = (angleDegrees * Math.PI) / 180;

  const x = RING_CENTER + radius * Math.cos(angleRadians);
  const y = RING_CENTER + radius * Math.sin(angleRadians);

  return `${x.toFixed(3)} ${y.toFixed(3)}`;
}

function ringSegmentPath(startAngle: number, endAngle: number): string {
  const outerStart = ringPoint(RING_OUTER_RADIUS, startAngle);
  const outerEnd = ringPoint(RING_OUTER_RADIUS, endAngle);
  const innerEnd = ringPoint(RING_INNER_RADIUS, endAngle);
  const innerStart = ringPoint(RING_INNER_RADIUS, startAngle);

  return [
    `M ${outerStart}`,
    `A ${RING_OUTER_RADIUS} ${RING_OUTER_RADIUS} 0 0 1 ${outerEnd}`,
    `L ${innerEnd}`,
    `A ${RING_INNER_RADIUS} ${RING_INNER_RADIUS} 0 0 0 ${innerStart}`,
    'Z',
  ].join(' ');
}

function getSegmentProgress(totalProgress: number, segmentIndex: number): number {
  const normalizedProgress = clamp(totalProgress, 0, 100) / 100;

  return clamp(normalizedProgress * 4 - segmentIndex, 0, 1);
}

function partialRingSegmentPath(
  startAngle: number,
  endAngle: number,
  progress: number,
): string | null {
  const normalizedProgress = clamp(progress, 0, 1);

  if (normalizedProgress <= 0) {
    return null;
  }

  if (normalizedProgress >= 1) {
    return ringSegmentPath(startAngle, endAngle);
  }

  const currentEndAngle = startAngle + (endAngle - startAngle) * normalizedProgress;

  return ringSegmentPath(startAngle, currentEndAngle);
}

export function PlayerLevelAvatar({
  src,
  alt,
  level = '',
  progress = 0,
  size = BASE_SIZE,
  className,
  variant = 'profile',
  accentColor,
}: PlayerLevelAvatarProps): React.JSX.Element {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const ringMaskId = `player-level-avatar-ring-${useId().replaceAll(':', '')}`;

  const normalizedSize = Number.isFinite(size) && size > 0 ? size : BASE_SIZE;
  const normalizedProgress = Number.isFinite(progress) ? clamp(progress, 0, 100) : 0;

  const scale = normalizedSize / BASE_SIZE;
  const usesFallbackPhoto = !src || failedSource === src;
  const photoSource = usesFallbackPhoto ? fallbackPhotoUrl : src;

  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  const rootStyle: PlayerLevelAvatarStyle = {
    '--player-level-avatar-scale': scale,
    ...(variant === 'participant' && accentColor
      ? { '--player-level-avatar-accent': accentColor }
      : {}),
  };

  return (
    <span
      className={
        variant === 'participant' ? `${rootClassName} ${styles.participant}` : rootClassName
      }
      data-player-level-avatar=""
      data-progress={normalizedProgress}
      data-size={normalizedSize}
      role="img"
      aria-label={`${alt}, уровень ${level}, прогресс ${Math.round(normalizedProgress)}%`}
      style={rootStyle}
    >
      <svg
        className={styles.progressRing}
        viewBox="0 0 48 48"
        aria-hidden="true"
        focusable="false"
        shapeRendering="geometricPrecision"
        data-player-level-ring=""
      >
        <defs>
          <mask id={ringMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
            <rect width="48" height="48" fill="#fff" />
            <rect
              fill="#000"
              x={BADGE_CLEARANCE.x}
              y={BADGE_CLEARANCE.y}
              width={BADGE_CLEARANCE.width}
              height={BADGE_CLEARANCE.height}
              rx={BADGE_CLEARANCE.radius}
            />
          </mask>
        </defs>

        <g mask={`url(#${ringMaskId})`}>
          {RING_SEGMENT_ANGLES.map(({ start, end }, index) => {
            const segmentProgress = getSegmentProgress(normalizedProgress, index);
            const backgroundPath = ringSegmentPath(start, end);
            const activePath = partialRingSegmentPath(start, end, segmentProgress);

            return (
              <g
                key={index}
                data-player-level-segment=""
                data-segment-index={index}
                data-segment-progress={segmentProgress}
              >
                <path className={styles.segment} d={backgroundPath} />
                {activePath ? <path className={styles.segmentActive} d={activePath} /> : null}
              </g>
            );
          })}
        </g>
      </svg>

      <span className={styles.photoFrame}>
        <img
          className={[styles.photo, usesFallbackPhoto ? styles.photoFallback : '']
            .filter(Boolean)
            .join(' ')}
          src={photoSource}
          alt=""
          aria-hidden="true"
          data-player-level-photo={usesFallbackPhoto ? 'fallback' : 'source'}
          onError={() => {
            if (src && failedSource !== src) {
              setFailedSource(src);
            }
          }}
        />
      </span>

      {level ? (
        <span className={styles.levelBadge} data-player-level-badge="">
          {level}
        </span>
      ) : null}
    </span>
  );
}
