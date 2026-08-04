import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type { AuthenticatedSession, AuthChallenge, CommunityPost } from '@phub/api-sdk';
import type {
  GiftCertificateAdminCatalogState,
  GiftCertificateCatalogInput,
  GiftCertificateCatalogView,
  GiftCertificateMediaAsset,
} from '@phub/gift-certificates';
import type { LocationAdminView, LocationMediaAsset, LocationProfileInput } from '@phub/locations';

export type {
  GiftCertificateAdminCatalogState,
  GiftCertificateCatalogInput,
  GiftCertificateCatalogView,
} from '@phub/gift-certificates';
export type { LocationAdminView, LocationProfileInput } from '@phub/locations';
export type AdminLocationCommandResult = LocationAdminView & { readonly replayed: boolean };
export type AdminLocationMediaCommandResult = LocationMediaAsset & { readonly replayed: boolean };
export type AdminGiftCertificateCatalogCommandResult = GiftCertificateCatalogView & {
  readonly replayed: boolean;
};
export type AdminGiftCertificateMediaCommandResult = GiftCertificateMediaAsset & {
  readonly replayed: boolean;
};

export type AdminNotificationChannel = 'IN_APP' | 'WEB_PUSH' | 'IOS_PUSH' | 'ANDROID_PUSH';

export interface AdminNotificationChannelCapability {
  readonly channel: AdminNotificationChannel;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly tenantEnabled?: boolean;
}

export interface AdminNotificationCapabilities {
  readonly channels: readonly AdminNotificationChannelCapability[];
}

export interface AdminNotificationRecipient {
  readonly userId: string;
  readonly displayName: string;
  readonly phoneMasked: string;
  readonly availableChannels: readonly AdminNotificationChannel[];
}

export interface AdminNotificationRecipientResolution {
  readonly matched: readonly AdminNotificationRecipient[];
  readonly unresolvedPhones: readonly string[];
}

export interface AdminNotificationCampaignAccepted {
  readonly outcome: 'accepted';
  readonly campaignId: string;
  readonly matchedCount: number;
  readonly unresolvedCount: number;
  readonly inAppCreatedCount: number;
  readonly pushQueuedCount: number;
  readonly suppressedCount: number;
  readonly replayed: boolean;
}

export interface AdminCommunityJoinRequest {
  readonly requestId: string;
  readonly communityId: string;
  readonly requesterUserId: string;
  readonly kind: 'JOIN' | 'REJOIN';
  readonly status: 'PENDING';
  readonly membershipStatus: 'NONE' | 'PENDING' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
  readonly membershipRevision: number;
  readonly requestRevision: number;
  readonly requestedAt: string;
}

export interface AdminCommunityJoinRequestPage {
  readonly items: readonly AdminCommunityJoinRequest[];
  readonly nextCursor?: string;
}

export interface AdminCommunityJoinRequestDecisionResult {
  readonly outcome: 'APPROVED' | 'REJECTED';
  readonly requestId: string;
  readonly communityId: string;
  readonly requesterUserId: string;
  readonly requestStatus: 'APPROVED' | 'REJECTED';
  readonly requestRevision: number;
  readonly membershipStatus: 'NONE' | 'ACTIVE' | 'LEFT' | 'REMOVED' | 'BANNED';
  readonly membershipRevision: number;
  readonly reasonCode: string | null;
  readonly decidedAt: string;
  readonly replayed: boolean;
}

export interface AdminCommunityDirectInviteQuotaGrant {
  readonly id: string;
  readonly communityId: string;
  readonly status: 'ACTIVE';
  readonly revision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
  readonly consumedAt: null;
  readonly replayed: boolean;
}

export interface AdminCommunityPendingPost {
  readonly post: CommunityPost & { readonly status: 'PENDING_MODERATION' };
}

export interface AdminCommunityPendingPostPage {
  readonly items: readonly AdminCommunityPendingPost[];
  readonly nextCursor?: string;
}

export interface AdminCommunityMediaReadGrant {
  readonly url: string;
  readonly expiresAt: string;
}

export interface NotificationAdminClient {
  restoreSession(): Promise<AuthenticatedSession | null>;
  requestCode(phone: string): Promise<AuthChallenge>;
  verifyCode(challengeId: string, code: string): Promise<AuthenticatedSession>;
  logout(): Promise<void>;
  getCapabilities(): Promise<AdminNotificationCapabilities>;
  resolveRecipients(phones: readonly string[]): Promise<AdminNotificationRecipientResolution>;
  createCampaign(input: {
    readonly phones: readonly string[];
    readonly title: string;
    readonly body: string;
    readonly deepLink?: string;
    readonly channels: readonly AdminNotificationChannel[];
  }): Promise<AdminNotificationCampaignAccepted>;
  listPendingCommunityJoinRequests(input?: {
    readonly communityId?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<AdminCommunityJoinRequestPage>;
  approveCommunityJoinRequest(
    requestId: string,
    input: {
      readonly expectedMembershipRevision: number;
      readonly expectedRequestRevision: number;
    },
  ): Promise<AdminCommunityJoinRequestDecisionResult>;
  rejectCommunityJoinRequest(
    requestId: string,
    input: {
      readonly expectedMembershipRevision: number;
      readonly expectedRequestRevision: number;
      readonly reasonCode: string;
    },
  ): Promise<AdminCommunityJoinRequestDecisionResult>;
  createCommunityDirectInviteQuotaGrant(
    communityId: string,
    input: {
      readonly reasonCode: string;
      readonly ticketId: string;
    },
  ): Promise<AdminCommunityDirectInviteQuotaGrant>;
  listPendingCommunityContent(input?: {
    readonly communityId?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<AdminCommunityPendingPostPage>;
  getCommunityModerationMediaUrl(
    communityId: string,
    mediaId: string,
    variant: 'THUMBNAIL' | 'FEED',
  ): Promise<AdminCommunityMediaReadGrant>;
  approveCommunityPost(
    communityId: string,
    postId: string,
    expectedRevision: number,
  ): Promise<CommunityPost>;
  rejectCommunityPost(
    communityId: string,
    postId: string,
    input: { readonly expectedRevision: number; readonly reasonCode: string },
  ): Promise<CommunityPost>;
  hideCommunityPost(
    communityId: string,
    postId: string,
    input: { readonly expectedRevision: number; readonly reasonCode: string },
  ): Promise<CommunityPost>;
  restoreCommunityPost(
    communityId: string,
    postId: string,
    input: { readonly expectedRevision: number; readonly reasonCode: string },
  ): Promise<CommunityPost>;
  listLocations(): Promise<{ readonly items: readonly LocationAdminView[] }>;
  getLocation(locationId: string): Promise<LocationAdminView>;
  createLocation(profile: LocationProfileInput): Promise<AdminLocationCommandResult>;
  updateLocation(
    locationId: string,
    expectedVersion: number,
    profile: LocationProfileInput,
  ): Promise<AdminLocationCommandResult>;
  uploadLocationMedia(file: File): Promise<AdminLocationMediaCommandResult>;
  resolveMediaUrl(url: string): string;
  getGiftCertificateCatalogState(): Promise<GiftCertificateAdminCatalogState>;
  saveGiftCertificateCatalogDraft(
    expectedRevision: number | null,
    catalog: GiftCertificateCatalogInput,
  ): Promise<AdminGiftCertificateCatalogCommandResult>;
  publishGiftCertificateCatalogDraft(
    catalogId: string,
    expectedRevision: number,
  ): Promise<AdminGiftCertificateCatalogCommandResult>;
  uploadGiftCertificateMedia(file: File): Promise<AdminGiftCertificateMediaCommandResult>;
}

interface NotificationAdminClientOptions {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly fetchImplementation?: typeof fetch;
}

let requestSequence = 0;

function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  requestSequence += 1;
  return `cup-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}

export function createNotificationAdminClient(
  options: NotificationAdminClientOptions,
): NotificationAdminClient {
  const fetchImplementation =
    options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
  const userClient = new PadlHubApiClient({
    baseUrl: options.baseUrl,
    tenantKey: options.tenantKey,
    platform: 'cup-admin',
    appVersion: options.appVersion,
    ...(options.appBuild ? { appBuild: options.appBuild } : {}),
    fetchImplementation,
  });
  const adminRoot = `${options.baseUrl.replace(/\/$/, '')}/admin/api/v1/${encodeURIComponent(
    options.tenantKey,
  )}`;

  async function toError(response: Response, correlationId: string): Promise<ApiClientError> {
    const body = (await response.json().catch(() => undefined)) as
      { code?: string; message?: string; correlationId?: string } | undefined;
    return new ApiClientError(
      body?.message ?? 'Запрос не выполнен.',
      response.status,
      body?.code ?? 'UNEXPECTED_API_ERROR',
      body?.correlationId ?? response.headers.get('X-Correlation-ID') ?? correlationId,
    );
  }

  async function adminRequest<T>(
    path: string,
    init: RequestInit = {},
    idempotencyKey?: string,
    allowRefresh = true,
  ): Promise<T> {
    const correlationId = operationId();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Correlation-ID', correlationId);
    headers.set('X-App-Platform', 'cup-admin');
    headers.set('X-App-Version', options.appVersion);
    if (options.appBuild) headers.set('X-App-Build', options.appBuild);
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const accessToken = userClient.getAccessToken();
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

    const response = await fetchImplementation(`${adminRoot}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
    if (response.status === 401 && allowRefresh) {
      await userClient.refreshSession();
      return adminRequest<T>(path, init, idempotencyKey, false);
    }
    if (!response.ok) throw await toError(response, correlationId);
    return (await response.json()) as T;
  }

  return {
    async restoreSession() {
      try {
        return await userClient.refreshSession();
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) return null;
        throw error;
      }
    },
    requestCode(phone) {
      return userClient.createAuthChallenge({ method: 'phone_otp', phone });
    },
    verifyCode(challengeId, code) {
      return userClient.verifyAuthChallenge(challengeId, { code });
    },
    logout() {
      return userClient.revokeSession();
    },
    getCapabilities() {
      return adminRequest<AdminNotificationCapabilities>('/notifications/capabilities');
    },
    resolveRecipients(phones) {
      return adminRequest<AdminNotificationRecipientResolution>(
        '/notifications/recipients/resolve',
        { method: 'POST', body: JSON.stringify({ phones }) },
      );
    },
    createCampaign(input) {
      return adminRequest<AdminNotificationCampaignAccepted>(
        '/notifications/campaigns',
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    listPendingCommunityJoinRequests(input = {}) {
      const query = new URLSearchParams();
      if (input.communityId) query.set('communityId', input.communityId);
      if (input.cursor) query.set('cursor', input.cursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return adminRequest<AdminCommunityJoinRequestPage>(
        `/community-join-requests/pending${suffix}`,
      );
    },
    approveCommunityJoinRequest(requestId, input) {
      return adminRequest<AdminCommunityJoinRequestDecisionResult>(
        `/community-join-requests/${encodeURIComponent(requestId)}/approve`,
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    rejectCommunityJoinRequest(requestId, input) {
      return adminRequest<AdminCommunityJoinRequestDecisionResult>(
        `/community-join-requests/${encodeURIComponent(requestId)}/reject`,
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    createCommunityDirectInviteQuotaGrant(communityId, input) {
      return adminRequest<AdminCommunityDirectInviteQuotaGrant>(
        `/communities/${encodeURIComponent(communityId)}/direct-invite-quota-grants`,
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    listPendingCommunityContent(input = {}) {
      const query = new URLSearchParams();
      if (input.communityId) query.set('communityId', input.communityId);
      if (input.cursor) query.set('cursor', input.cursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return adminRequest<AdminCommunityPendingPostPage>(`/community-content/pending${suffix}`);
    },
    getCommunityModerationMediaUrl(communityId, mediaId, variant) {
      return adminRequest<AdminCommunityMediaReadGrant>(
        `/communities/${encodeURIComponent(communityId)}/content/media/${encodeURIComponent(mediaId)}/variants/${variant}/url`,
      );
    },
    approveCommunityPost(communityId, postId, expectedRevision) {
      return adminRequest<CommunityPost>(
        `/communities/${encodeURIComponent(communityId)}/content/posts/${encodeURIComponent(postId)}/approve`,
        { method: 'POST', body: JSON.stringify({ expectedRevision }) },
        operationId(),
      );
    },
    rejectCommunityPost(communityId, postId, input) {
      return adminRequest<CommunityPost>(
        `/communities/${encodeURIComponent(communityId)}/content/posts/${encodeURIComponent(postId)}/reject`,
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    hideCommunityPost(communityId, postId, input) {
      return adminRequest<CommunityPost>(
        `/communities/${encodeURIComponent(communityId)}/content/posts/${encodeURIComponent(postId)}/hide`,
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    restoreCommunityPost(communityId, postId, input) {
      return adminRequest<CommunityPost>(
        `/communities/${encodeURIComponent(communityId)}/content/posts/${encodeURIComponent(postId)}/restore`,
        { method: 'POST', body: JSON.stringify(input) },
        operationId(),
      );
    },
    listLocations() {
      return adminRequest<{ readonly items: readonly LocationAdminView[] }>('/locations');
    },
    getLocation(locationId) {
      return adminRequest<LocationAdminView>(`/locations/${encodeURIComponent(locationId)}`);
    },
    createLocation(profile) {
      return adminRequest<AdminLocationCommandResult>(
        '/locations',
        { method: 'POST', body: JSON.stringify(profile) },
        operationId(),
      );
    },
    updateLocation(locationId, expectedVersion, profile) {
      return adminRequest<AdminLocationCommandResult>(
        `/locations/${encodeURIComponent(locationId)}`,
        { method: 'PATCH', body: JSON.stringify({ expectedVersion, profile }) },
        operationId(),
      );
    },
    uploadLocationMedia(file) {
      return adminRequest<AdminLocationMediaCommandResult>(
        '/location-media',
        {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        },
        operationId(),
      );
    },
    resolveMediaUrl(url) {
      const baseUrl = options.baseUrl.replace(/\/$/, '');
      return baseUrl ? new URL(url, `${baseUrl}/`).toString() : url;
    },
    getGiftCertificateCatalogState() {
      return adminRequest<GiftCertificateAdminCatalogState>('/gift-certificate-catalog');
    },
    saveGiftCertificateCatalogDraft(expectedRevision, catalog) {
      return adminRequest<AdminGiftCertificateCatalogCommandResult>(
        '/gift-certificate-catalog/draft',
        { method: 'PUT', body: JSON.stringify({ expectedRevision, catalog }) },
        operationId(),
      );
    },
    publishGiftCertificateCatalogDraft(catalogId, expectedRevision) {
      return adminRequest<AdminGiftCertificateCatalogCommandResult>(
        '/gift-certificate-catalog/draft/publish',
        { method: 'POST', body: JSON.stringify({ catalogId, expectedRevision }) },
        operationId(),
      );
    },
    uploadGiftCertificateMedia(file) {
      return adminRequest<AdminGiftCertificateMediaCommandResult>(
        '/gift-certificate-media',
        {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        },
        operationId(),
      );
    },
  };
}
