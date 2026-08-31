import { SubscriptionPlanCard } from './SubscriptionPlanCard.js';
import type { SubscriptionOfferSectionView, SubscriptionPlanSelection } from './model.js';

export function SubscriptionOfferSection(props: {
  readonly section: SubscriptionOfferSectionView;
  readonly selectedBillingOptions: Readonly<Record<string, string>>;
  readonly onBillingOptionChange: (planId: string, optionId: string) => void;
  readonly onChoose: (selection: SubscriptionPlanSelection) => void;
}): React.JSX.Element {
  return (
    <section className="subscription-offer-section" aria-labelledby={`${props.section.id}-title`}>
      {props.section.title ? (
        <header className="subscription-offer-section__header">
          <h2 id={`${props.section.id}-title`}>{props.section.title}</h2>
          {props.section.description ? <p>{props.section.description}</p> : null}
        </header>
      ) : (
        <h2 id={`${props.section.id}-title`} className="subscription-visually-hidden">
          Варианты абонементов
        </h2>
      )}

      <div
        className="subscription-plan-rail"
        role="list"
        aria-label={props.section.title ?? 'Варианты абонементов'}
        tabIndex={0}
      >
        {props.section.plans.map((plan) => {
          const selectedBillingOptionId =
            props.selectedBillingOptions[plan.id] ??
            plan.initialBillingOptionId ??
            plan.billingOptions[0]?.id;
          if (!selectedBillingOptionId) {
            throw new Error(`Subscription plan ${plan.id} has no selected billing option`);
          }
          return (
            <div key={plan.id} className="subscription-plan-rail__item" role="listitem">
              <SubscriptionPlanCard
                plan={plan}
                selectedBillingOptionId={selectedBillingOptionId}
                onBillingOptionChange={(optionId) => props.onBillingOptionChange(plan.id, optionId)}
                onChoose={() =>
                  props.onChoose({ planId: plan.id, billingOptionId: selectedBillingOptionId })
                }
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
