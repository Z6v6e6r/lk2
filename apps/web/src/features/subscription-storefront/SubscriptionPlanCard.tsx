import type { CSSProperties } from 'react';

import type { SubscriptionBenefitIcon, SubscriptionBillingOption, SubscriptionPlanView } from './model.js';
import { subscriptionBenefitIconUrls } from './assets/benefit-icons.js';
import lightningUrl from './assets/icons/lightning.svg';

type TagCssProperties = CSSProperties & { '--subscription-tag-tone'?: string };

function rubles(priceMinor: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(priceMinor / 100);
}

function progressLabel(progress: NonNullable<SubscriptionBillingOption['progress']>): string {
  return `Осталось: ${progress.current} / ${progress.total}`;
}

function BenefitIcon({ name }: { readonly name: SubscriptionBenefitIcon }): React.JSX.Element {
  return (
    <img
      className="subscription-card__benefit-icon"
      src={subscriptionBenefitIconUrls[name]}
      alt=""
      aria-hidden
    />
  );
}

function BillingOptions(props: {
  readonly options: readonly SubscriptionBillingOption[];
  readonly selectedId: string;
  readonly onChange: (optionId: string) => void;
}): React.JSX.Element | null {
  if (props.options.length < 2) return null;

  const selectedIndex = Math.max(
    0,
    props.options.findIndex((option) => option.id === props.selectedId),
  );

  function selectAt(index: number, target: HTMLElement): void {
    const option = props.options[index];
    if (!option) return;
    props.onChange(option.id);
    const radios = target
      .closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[index]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const last = props.options.length - 1;
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = selectedIndex >= last ? 0 : selectedIndex + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = selectedIndex <= 0 ? last : selectedIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectAt(nextIndex, event.currentTarget);
  }

  return (
    <div
      className="subscription-card__billing-options"
      role="radiogroup"
      aria-label="Период оплаты"
      onKeyDown={onKeyDown}
    >
      {props.options.map((option) => {
        const checked = props.selectedId === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => props.onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function PlanProgress(props: {
  readonly progress?: SubscriptionBillingOption['progress'];
  readonly className: string;
}): React.JSX.Element {
  const label = props.progress ? progressLabel(props.progress) : '';
  return (
    <div
      className={props.className}
      aria-label={props.progress ? `${props.progress.label}: ${label}` : undefined}
    >
      {props.progress ? (
        <img className="subscription-card__lightning" src={lightningUrl} alt="" aria-hidden />
      ) : null}
      <span>{label}</span>
    </div>
  );
}

function PlanTagBadge({ label }: { readonly label: string }): React.JSX.Element {
  const tone = 'var(--subscription-tag-tone, var(--subscription-accent))';
  return (
    <div className="subscription-card__badge">
      <svg viewBox="0 0 32 22" fill="none" aria-hidden="true">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M130.376 0C131.462 7.32369e-05 132.504 0.432008 133.272 1.2002L136.898 4.82617C138.21 6.13725 138.477 8.16576 137.55 9.77148L131.671 19.9521C130.939 21.2196 129.587 22.001 128.123 22.001H7.72361C6.63714 22.001 5.5944 21.569 4.82615 20.8008L1.20018 17.1748C-0.110889 15.8637 -0.378254 13.8352 0.548809 12.2295L3.20506 7.62891H9.5576L7.09471 12.2822C6.88698 12.6428 7.14823 13.0936 7.56443 13.0938H9.79295C10.124 13.0937 10.4299 12.9174 10.5957 12.6309L13.2597 7.62891H20.2109C20.5761 7.62891 20.908 7.41419 21.0576 7.08105L21.707 5.63281C21.8674 5.27501 21.6059 4.87134 21.2138 4.87109H14.8525L17.5049 0H130.376Z"
          fill={tone}
        />
        <path
          d="M12.3525 2.79004C12.3526 3.12691 12.4952 3.39912 12.7803 3.60645L13.5967 4.20898C13.6743 4.26083 13.7129 4.33875 13.7129 4.44238V4.67578C13.7128 4.80531 13.6481 4.87012 13.5185 4.87012H4.79783L6.42772 2.04785C7.15955 0.780629 8.51218 0 9.97557 0H13.8652L12.3525 2.79004Z"
          fill={tone}
        />
      </svg>
      <span className="subscription-card__badge-text">{label}</span>
      <svg viewBox="110 0 29 22" fill="none" aria-hidden="true">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M130.376 0C131.462 7.32369e-05 132.504 0.432008 133.272 1.2002L136.898 4.82617C138.21 6.13725 138.477 8.16576 137.55 9.77148L131.671 19.9521C130.939 21.2196 129.587 22.001 128.123 22.001H7.72361C6.63714 22.001 5.5944 21.569 4.82615 20.8008L1.20018 17.1748C-0.110889 15.8637 -0.378254 13.8352 0.548809 12.2295L3.20506 7.62891H9.5576L7.09471 12.2822C6.88698 12.6428 7.14823 13.0936 7.56443 13.0938H9.79295C10.124 13.0937 10.4299 12.9174 10.5957 12.6309L13.2597 7.62891H20.2109C20.5761 7.62891 20.908 7.41419 21.0576 7.08105L21.707 5.63281C21.8674 5.27501 21.6059 4.87134 21.2138 4.87109H14.8525L17.5049 0H130.376Z"
          fill={tone}
        />
      </svg>
    </div>
  );
}

function PlanCardBody(props: {
  readonly plan: SubscriptionPlanView;
  readonly selectedOption: SubscriptionBillingOption;
  readonly onBillingOptionChange: (optionId: string) => void;
  readonly onChoose: () => void;
}): React.JSX.Element {
  return (
    <div className="subscription-card__panel">
      <div className="subscription-card__header">
        <div
          className={`subscription-card__tag${
            props.plan.artUrl
              ? ' subscription-card__tag--art'
              : ' subscription-card__tag--label'
          }`}
          style={
            props.plan.tagTone
              ? { '--subscription-tag-tone': props.plan.tagTone } as TagCssProperties
              : undefined
          }
          aria-label={props.plan.label}
        >
          {props.plan.artUrl ? (
            <img className="subscription-card__art" src={props.plan.artUrl} alt="" aria-hidden />
          ) : (
            <PlanTagBadge label={props.plan.label} />
          )}
        </div>

        <div className="subscription-card__price-row">
          <p className="subscription-card__price">
            <strong>{rubles(props.selectedOption.priceMinor)} ₽</strong>
            <span>{props.selectedOption.priceSuffix ?? '/ мес.'}</span>
          </p>
          <BillingOptions
            options={props.plan.billingOptions}
            selectedId={props.selectedOption.id}
            onChange={props.onBillingOptionChange}
          />
        </div>
      </div>

      <div className="subscription-card__body">
        <button
          className="subscription-card__cta"
          type="button"
          disabled={props.plan.ctaDisabled === true}
          onClick={props.onChoose}
        >
          {props.plan.ctaLabel ?? 'Оформить подписку'}
        </button>

        <div className="subscription-card__benefits">
          {props.plan.benefitGroups.map((group) => (
            <section key={group.id} className="subscription-card__benefit-group">
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    {item.icon ? <BenefitIcon name={item.icon} /> : null}
                    {item.badge ? <b>{item.badge}</b> : null}
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SubscriptionPlanCard(props: {
  readonly plan: SubscriptionPlanView;
  readonly selectedBillingOptionId: string;
  readonly onBillingOptionChange: (optionId: string) => void;
  readonly onChoose: () => void;
  readonly bare?: boolean;
}): React.JSX.Element {
  const selectedOption =
    props.plan.billingOptions.find((option) => option.id === props.selectedBillingOptionId) ??
    props.plan.billingOptions[0];
  if (!selectedOption) throw new Error(`Subscription plan ${props.plan.id} has no billing options`);

  const progress = selectedOption.progress;

  if (props.bare) {
    return (
      <PlanCardBody
        plan={props.plan}
        selectedOption={selectedOption}
        onBillingOptionChange={props.onBillingOptionChange}
        onChoose={props.onChoose}
      />
    );
  }

  return (
    <article
      className={`subscription-card${progress ? '' : ' subscription-card--no-progress'}`}
      data-plan-id={props.plan.id}
    >
      <PlanProgress progress={progress} className="subscription-card__progress" />
      <PlanCardBody
        plan={props.plan}
        selectedOption={selectedOption}
        onBillingOptionChange={props.onBillingOptionChange}
        onChoose={props.onChoose}
      />
    </article>
  );
}
