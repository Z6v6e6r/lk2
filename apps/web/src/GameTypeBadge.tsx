export type GameTypeBadgeType = 'friendly' | 'rating';

export function EventGameTypeIcon({
  type,
}: {
  readonly type: GameTypeBadgeType;
}): React.JSX.Element {
  if (type === 'rating') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path
          d="M6.191 1.578 6.895 2.997c.096.198.352.387.568.424l1.276.213c.816.137 1.008.734.42 1.323l-.992 1c-.168.169-.26.496-.208.73l.284 1.238c.224.98-.292 1.359-1.152.847l-1.196-.714a.687.687 0 0 0-.792 0l-1.196.714c-.856.512-1.376.129-1.152-.847l.284-1.238c.052-.234-.04-.56-.208-.73l-.992-1c-.584-.589-.396-1.186.42-1.323l1.276-.213c.212-.037.468-.226.564-.424l.704-1.419c.384-.77 1.008-.77 1.388 0Z"
          fill="#9BBD05"
        />
      </svg>
    );
  }

  return (
    <svg width="8" height="10" viewBox="0 0 8 10" fill="none" aria-hidden="true">
      <path
        d="M6.829 2.173a4.001 4.001 0 0 0-5.657 0C-.417 3.766-.389 6.362 1.251 7.923c1.518 1.436 3.977 1.436 5.494 0 1.645-1.56 1.673-4.157.084-5.75ZM5.739 6.85a2.529 2.529 0 0 1-3.481 0 .3.3 0 0 1-.012-.424.3.3 0 0 1 .423-.012 1.934 1.934 0 0 0 2.659 0 .3.3 0 0 1 .423.012.3.3 0 0 1-.012.424Z"
        fill="#4DB369"
      />
    </svg>
  );
}

export function GameTypeBadge({ type }: { readonly type: GameTypeBadgeType }): React.JSX.Element {
  return (
    <span className={`fh-event__tag is-${type}`}>
      <EventGameTypeIcon type={type} />
      <span className="fh-event__tag-label">
        {type === 'rating' ? 'Игра на рейтинг' : 'Френдли игра'}
      </span>
    </span>
  );
}
