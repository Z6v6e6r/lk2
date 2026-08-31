export type SubscriptionBenefitIcon = 'game' | 'training' | 'group' | 'tournament';

export interface SubscriptionBillingOption {
  readonly id: string;
  readonly label: string;
  readonly priceMinor: number;
  readonly priceSuffix?: string;
}

export interface SubscriptionBenefit {
  readonly id: string;
  readonly label: string;
  readonly icon?: SubscriptionBenefitIcon;
  readonly badge?: string;
}

export interface SubscriptionBenefitGroup {
  readonly id: string;
  readonly title: string;
  readonly items: readonly SubscriptionBenefit[];
}

export interface SubscriptionPlanView {
  readonly id: string;
  readonly label: string;
  readonly tagTone?: 'mint' | 'violet' | 'lime' | 'blue';
  readonly featured?: boolean;
  readonly progress?: {
    readonly current: number;
    readonly total: number;
    readonly label: string;
  };
  readonly billingOptions: readonly SubscriptionBillingOption[];
  readonly initialBillingOptionId?: string;
  readonly ctaLabel?: string;
  readonly benefitGroups: readonly SubscriptionBenefitGroup[];
}

export interface SubscriptionOfferSectionView {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly plans: readonly SubscriptionPlanView[];
}

export interface SubscriptionStorefrontTheme {
  readonly accent?: string;
  readonly accentStrong?: string;
  readonly pageBackground?: string;
  readonly surface?: string;
  readonly text?: string;
}

export interface SubscriptionStorefrontView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly markUrl?: string;
  readonly markAlt?: string;
  readonly sections: readonly SubscriptionOfferSectionView[];
  readonly theme?: SubscriptionStorefrontTheme;
}

export interface SubscriptionPlanSelection {
  readonly planId: string;
  readonly billingOptionId: string;
}
