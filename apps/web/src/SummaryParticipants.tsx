interface SummaryParticipantsProps {
  readonly occupied: number;
  readonly total: number;
  readonly action?: React.ReactNode;
}

function placesLabel(value: number): string {
  const remainder100 = value % 100;
  const remainder10 = value % 10;
  if (remainder100 >= 11 && remainder100 <= 14) return 'мест';
  if (remainder10 === 1) return 'место';
  if (remainder10 >= 2 && remainder10 <= 4) return 'места';
  return 'мест';
}

function OccupiedPlaceIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="12" r="4.25" />
      <path d="M8.5 25c.8-4.2 3.3-6.3 7.5-6.3s6.7 2.1 7.5 6.3" />
    </svg>
  );
}

export function SummaryParticipants({
  occupied,
  total,
  action,
}: SummaryParticipantsProps): React.JSX.Element {
  const safeTotal = Math.max(0, total);
  const safeOccupied = Math.max(0, Math.min(occupied, safeTotal));
  const open = Math.max(0, safeTotal - safeOccupied);
  const visibleOccupied = Math.min(3, safeOccupied);
  const hiddenOccupied = Math.max(0, safeOccupied - visibleOccupied);

  return (
    <div className="summary-participants">
      <div className="summary-participants__labels">
        <span>
          Участники {safeOccupied}/{safeTotal}
        </span>
        <span>{open > 0 ? `Осталось ${open} ${placesLabel(open)}` : 'Мест нет'}</span>
      </div>
      <div className="summary-participants__row">
        <span className="summary-participants__avatars" aria-label={`Занято мест: ${safeOccupied}`}>
          {Array.from({ length: visibleOccupied }, (_, index) => (
            <span
              className="summary-participants__avatar"
              aria-label={`Занятое место ${index + 1}`}
              key={`occupied-${index}`}
            >
              <OccupiedPlaceIcon />
            </span>
          ))}
          {hiddenOccupied > 0 ? (
            <span
              className="summary-participants__avatar is-aggregate"
              aria-label={`Ещё участников: ${hiddenOccupied}`}
            >
              +{hiddenOccupied}
            </span>
          ) : null}
          {safeOccupied === 0 ? (
            <span
              className="summary-participants__avatar is-empty"
              aria-label="Участников пока нет"
            >
              <OccupiedPlaceIcon />
            </span>
          ) : null}
        </span>
        {action ? <span className="summary-participants__action">{action}</span> : null}
      </div>
    </div>
  );
}
