import './GameCreateWizard.css';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { GameCreateStep } from './use-game-create-wizard.js';

export function GameCreateWizardHeader({
  title,
  total = 3,
  step,
  label,
  href,
  busy,
  back,
}: {
  title: string;
  total?: 2 | 3;
  step: GameCreateStep;
  label: string;
  href: string;
  busy: boolean;
  back: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  return (
    <header className="game-create-wizard__header">
      {step === 0 ? (
        <a className="game-create-wizard__back" href={href} aria-label="Назад">
          <span aria-hidden="true">←</span>
        </a>
      ) : (
        <button
          className="game-create-wizard__back"
          type="button"
          disabled={busy}
          aria-label="Назад"
          onClick={back}
        >
          <span aria-hidden="true">←</span>
        </button>
      )}
      <div>
        <p>
          {title} · {step + 1} из {total}
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {label}
        </h1>
      </div>
    </header>
  );
}

export function GameCreateWizardSection({
  hidden,
  children,
}: {
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <div className="game-create-wizard__section" hidden={hidden}>
      {children}
    </div>
  );
}

export function GameCreateWizardNext({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="game-create-wizard__actions">
      <button type="button" className="game-detail-primary" disabled={disabled} onClick={onClick}>
        Продолжить
      </button>
    </div>
  );
}

const DAY_LABEL = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const MONTH_LABEL = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
const FULL_DATE_LABEL = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full' });

function localDay(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function GameCreateDateStrip({
  start,
  onSelect,
}: {
  start: string;
  onSelect: (start: string) => void;
}) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Array.from({ length: 10 }, (_, offset) => {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    return date;
  });
  return (
    <div className="game-create-wizard__dates" role="group" aria-label="Дата игры">
      {days.map((date) => {
        const value = localDay(date);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={start.slice(0, 10) === value}
            aria-label={FULL_DATE_LABEL.format(date)}
            onClick={() => onSelect(value + 'T' + (start.slice(11, 16) || '18:00'))}
          >
            <span>{DAY_LABEL.format(date)}</span>
            <strong>{date.getDate()}</strong>
            <span>{MONTH_LABEL.format(date)}</span>
          </button>
        );
      })}
    </div>
  );
}
