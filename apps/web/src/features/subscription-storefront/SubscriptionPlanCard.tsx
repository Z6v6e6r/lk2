import {
  GameController,
  Lightning,
  PersonSimpleRun,
  Trophy,
  UsersThree,
} from '@phosphor-icons/react';

import type {
  SubscriptionBenefitIcon,
  SubscriptionBillingOption,
  SubscriptionPlanView,
} from './model.js';

function rubles(priceMinor: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(priceMinor / 100);
}

function BenefitIcon({ name }: { readonly name: SubscriptionBenefitIcon }): React.JSX.Element {
  const props = { 'aria-hidden': true, size: 15, weight: 'fill' as const };
  switch (name) {
    case 'game':
      return <GameController {...props} />;
    case 'training':
      return <PersonSimpleRun {...props} />;
    case 'group':
      return <UsersThree {...props} />;
    case 'tournament':
      return <Trophy {...props} />;
  }
}

function BillingOptions(props: {
  readonly options: readonly SubscriptionBillingOption[];
  readonly selectedId: string;
  readonly onChange: (optionId: string) => void;
}): React.JSX.Element | null {
  if (props.options.length < 2) return null;
  return (
    <div className="subscription-card__billing-options" aria-label="Период оплаты">
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={props.selectedId === option.id}
          onClick={() => props.onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SubscriptionPlanCard(props: {
  readonly plan: SubscriptionPlanView;
  readonly selectedBillingOptionId: string;
  readonly onBillingOptionChange: (optionId: string) => void;
  readonly onChoose: () => void;
}): React.JSX.Element {
  const selectedOption =
    props.plan.billingOptions.find((option) => option.id === props.selectedBillingOptionId) ??
    props.plan.billingOptions[0];
  if (!selectedOption) throw new Error(`Subscription plan ${props.plan.id} has no billing options`);

  return (
    <article
      className={`subscription-card${props.plan.featured ? ' subscription-card--featured' : ''}`}
      data-plan-id={props.plan.id}
    >
      {props.plan.progress ? (
        <div
          className="subscription-card__progress"
          aria-label={`${props.plan.progress.label}: ${props.plan.progress.current} из ${props.plan.progress.total}`}
        >
          <Lightning aria-hidden size={12} weight="fill" />
          <span>{props.plan.progress.label}</span>
          <b>
            {props.plan.progress.current} / {props.plan.progress.total}
          </b>
        </div>
      ) : null}

      <div
        className={`subscription-card__tag subscription-card__tag--${props.plan.tagTone ?? 'violet'}`}
      >
        <Lightning aria-hidden size={12} weight="fill" />
        <span>{props.plan.label}</span>
      </div>

      <div className="subscription-card__price-row">
        <p className="subscription-card__price">
          <strong>{rubles(selectedOption.priceMinor)} ₽</strong>
          <span>{selectedOption.priceSuffix ?? '/ мес.'}</span>
        </p>
        <BillingOptions
          options={props.plan.billingOptions}
          selectedId={selectedOption.id}
          onChange={props.onBillingOptionChange}
        />
      </div>

      <button className="subscription-card__cta" type="button" onClick={props.onChoose}>
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
    </article>
  );
}
