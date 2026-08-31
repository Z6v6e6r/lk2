import { ArrowLeft, DotsThree } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import { SubscriptionOfferSection } from './SubscriptionOfferSection.js';
import type {
  SubscriptionPlanSelection,
  SubscriptionStorefrontTheme,
  SubscriptionStorefrontView,
} from './model.js';
import './subscriptions.css';

type StorefrontCssProperties = CSSProperties & {
  '--subscription-accent'?: string;
  '--subscription-accent-strong'?: string;
  '--subscription-page-background'?: string;
  '--subscription-surface'?: string;
  '--subscription-text'?: string;
};

function themeStyle(theme: SubscriptionStorefrontTheme | undefined): StorefrontCssProperties {
  return {
    ...(theme?.accent ? { '--subscription-accent': theme.accent } : {}),
    ...(theme?.accentStrong ? { '--subscription-accent-strong': theme.accentStrong } : {}),
    ...(theme?.pageBackground ? { '--subscription-page-background': theme.pageBackground } : {}),
    ...(theme?.surface ? { '--subscription-surface': theme.surface } : {}),
    ...(theme?.text ? { '--subscription-text': theme.text } : {}),
  };
}

function initialBillingOptions(view: SubscriptionStorefrontView): Record<string, string> {
  return Object.fromEntries(
    view.sections.flatMap((section) =>
      section.plans.flatMap((plan) => {
        const optionId = plan.initialBillingOptionId ?? plan.billingOptions[0]?.id;
        return optionId ? [[plan.id, optionId]] : [];
      }),
    ),
  );
}

export function SubscriptionStorefront(props: {
  readonly view: SubscriptionStorefrontView;
  readonly onBack?: () => void;
  readonly onMore?: () => void;
  readonly onChoose: (selection: SubscriptionPlanSelection) => void;
}): React.JSX.Element {
  const defaults = useMemo(() => initialBillingOptions(props.view), [props.view]);
  const [selectedBillingOptions, setSelectedBillingOptions] =
    useState<Readonly<Record<string, string>>>(defaults);

  function selectBillingOption(planId: string, optionId: string): void {
    setSelectedBillingOptions((current) => ({ ...current, [planId]: optionId }));
  }

  return (
    <main
      className="subscription-storefront"
      style={themeStyle(props.view.theme)}
      data-storefront-id={props.view.id}
    >
      <nav className="subscription-storefront__navigation" aria-label="Навигация по витрине">
        {props.onBack ? (
          <button type="button" aria-label="Назад" onClick={props.onBack}>
            <ArrowLeft aria-hidden size={20} weight="bold" />
          </button>
        ) : (
          <a href="/" aria-label="Вернуться на главную">
            <ArrowLeft aria-hidden size={20} weight="bold" />
          </a>
        )}
        <button type="button" aria-label="Другие действия" onClick={props.onMore}>
          <DotsThree aria-hidden size={24} weight="bold" />
        </button>
      </nav>

      <header className="subscription-storefront__hero">
        {props.view.markUrl ? (
          <img
            className="subscription-storefront__mark"
            src={props.view.markUrl}
            alt={props.view.markAlt ?? ''}
          />
        ) : null}
        <h1>{props.view.title}</h1>
        <p>{props.view.description}</p>
      </header>

      <div className="subscription-storefront__sections">
        {props.view.sections.map((section) => (
          <SubscriptionOfferSection
            key={section.id}
            section={section}
            selectedBillingOptions={selectedBillingOptions}
            onBillingOptionChange={selectBillingOption}
            onChoose={props.onChoose}
          />
        ))}
      </div>
    </main>
  );
}
