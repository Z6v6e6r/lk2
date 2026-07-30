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

function OpenPlaceIcon(): React.JSX.Element {
  return (
    <svg width="38" height="40" viewBox="0 0 38 40" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="32" height="32" rx="16" fill="#F1F1F1" />
      <path
        d="M17.6667 19.4201H15.4444C15.199 19.4201 15 19.2212 15 18.9757C15 18.7302 15.199 18.5312 15.4444 18.5312H17.6667V19.4201Z"
        fill="#888889"
      />
      <path
        d="M22.5556 18.5312C22.801 18.5312 23 18.7302 23 18.9757C23 19.2212 22.801 19.4201 22.5556 19.4201H18.5556V18.5312H22.5556Z"
        fill="#888889"
      />
      <path
        d="M19.4455 22.5321C19.4455 22.7776 19.2465 22.9766 19.0011 22.9766C18.7556 22.9766 18.5566 22.7776 18.5566 22.5321V18.5321H19.4455V22.5321Z"
        fill="#888889"
      />
      <path
        d="M19.0011 14.9766C19.2465 14.9766 19.4455 15.1755 19.4455 15.421V17.6432H18.5566V15.421C18.5566 15.1755 18.7556 14.9766 19.0011 14.9766Z"
        fill="#888889"
      />
      <path
        d="M38 19C38 29.4934 29.4934 38 19 38C8.50659 38 0 29.4934 0 19C0 8.50659 8.50659 0 19 0C29.4934 0 38 8.50659 38 19ZM1.52 19C1.52 28.6539 9.34606 36.48 19 36.48C28.6539 36.48 36.48 28.6539 36.48 19C36.48 9.34606 28.6539 1.52 19 1.52C9.34606 1.52 1.52 9.34606 1.52 19Z"
        fill="#F1F1F1"
      />
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
  const visibleOpen = Math.min(3, open);
  const hiddenOpen = Math.max(0, open - visibleOpen);
  const isFull = open === 0;

  return (
    <div className="summary-participants">
      <div className="summary-participants__labels">
        <span>
          {isFull
            ? `Записано ${safeOccupied} из ${safeTotal}`
            : `Доступно ${open} ${placesLabel(open)} из ${safeTotal}`}
        </span>
        {isFull ? <span>Мест нет</span> : null}
      </div>
      {!isFull ? (
        <div className="summary-participants__row">
          <span className="summary-participants__avatars" aria-label={`Доступно мест: ${open}`}>
            {Array.from({ length: visibleOpen }, (_, index) => (
              <span
                className="summary-participants__avatar is-open"
                aria-label={`Свободное место ${index + 1}`}
                key={`open-${index}`}
              >
                <OpenPlaceIcon />
              </span>
            ))}
            {hiddenOpen > 0 ? (
              <span
                className="summary-participants__avatar is-aggregate"
                aria-label={`Ещё мест: ${hiddenOpen}`}
              >
                +{hiddenOpen}
              </span>
            ) : null}
          </span>
          {action ? <span className="summary-participants__action">{action}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
