export interface SummerSubscriptionPlanStatus {
  readonly counterKey: string;
  readonly inventoryId: string;
  readonly unlimited: boolean;
  readonly saleType: string;
  readonly planKey: string | null;
  readonly campaignKey: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly stagedRelease?: boolean;
  readonly releaseStartDate?: string | null;
  readonly releasePhase?: string | null;
  readonly dailyDropActive?: boolean;
  readonly launchLimit?: number;
  readonly launchPaidCount?: number;
  readonly launchReservedCount?: number;
  readonly launchRemainingCount?: number;
  readonly launchCompletedAt?: string | null;
  readonly dailyLimit?: number;
  readonly dailyDropDate?: string | null;
  readonly dailyDropStartsAt?: string | null;
  readonly totalLimit: number;
  readonly paidCount: number;
  readonly reservedCount: number;
  readonly takenCount: number;
  readonly remainingCount: number;
  readonly canPurchase: boolean;
  readonly bindingReady: boolean;
  readonly bindingError: string | null;
  readonly priceMinor: number;
  readonly price: number;
  readonly updatedAt: string;
}

export interface SummerSubscriptionStatusResponse {
  readonly ok: boolean;
  readonly counterKey: string;
  readonly inventoryId: string;
  readonly unlimited: boolean;
  readonly planKey: string | null;
  readonly planType: string | null;
  readonly campaignKey: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly totalLimit: number;
  readonly paidCount: number;
  readonly reservedCount: number;
  readonly takenCount: number;
  readonly remainingCount: number;
  readonly canPurchase: boolean;
  readonly priceMinor: number;
  readonly price: number;
  readonly updatedAt: string;
  readonly plans: readonly SummerSubscriptionPlanStatus[];
}

export interface SummerSubscriptionPurchaseRequest {
  readonly clientPhone: string;
  readonly clientId: string;
  readonly counterKey: string;
  readonly planType: string | null;
  readonly plan: string | null;
  readonly tariff: string | null;
  readonly campaignKey: string | null;
  readonly productId: string;
  readonly paymentRef: string;
  readonly successUrl: string;
  readonly failUrl: string;
  readonly baseRedirectUrl: string;
  readonly trainerQrCode: string | null;
  readonly referralToken: string | null;
  readonly referralVisitId: string | null;
}

export interface SummerSubscriptionPurchaseResponse {
  readonly ok: boolean;
  readonly paymentUrl?: string;
  readonly paymentRef?: string;
  readonly status?: string;
  readonly productName?: string;
  readonly toPayMinor?: number;
}

export interface SummerSubscriptionAnalyticsUser {
  readonly phone: string;
  readonly clientId: string;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
}
