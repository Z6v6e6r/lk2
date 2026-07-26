import styles from './GiftCardNominalStep.module.css';

export interface GiftCardNominalOption {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: 'RUB';
}

export interface GiftCardNominalStepProps {
  readonly denominations: readonly GiftCardNominalOption[];
  readonly value: string | null;
  readonly onChange: (denominationId: string) => void;
}

function formatRubles(amountMinor: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function accessibleRubles(amountMinor: number): string {
  return formatRubles(amountMinor).replaceAll('\u00a0', ' ');
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="m3.25 8.1 2.7 2.7 6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GiftCardNominalStep(props: GiftCardNominalStepProps): React.JSX.Element {
  return (
    <section className={styles.root} aria-label="Шаг 03. Номинал">
      <div className={`gift-sale-step-pill ${styles.stepPill}`}>
        <span>03</span>
        <span aria-hidden="true">|</span>
        <span>Номинал</span>
      </div>

      <div className={styles.amountGrid}>
        {props.denominations.map((denomination) => {
          const selected = denomination.id === props.value;
          return (
            <button
              type="button"
              className={styles.amountButton}
              data-selected={selected}
              aria-pressed={selected}
              aria-label={accessibleRubles(denomination.amountMinor)}
              key={denomination.id}
              onClick={() => props.onChange(denomination.id)}
            >
              <span>{formatRubles(denomination.amountMinor)}</span>
              {selected ? (
                <span className={styles.checkBadge}>
                  <CheckIcon />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
