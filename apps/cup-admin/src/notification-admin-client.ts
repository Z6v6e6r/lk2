import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type { AuthenticatedSession, AuthChallenge } from '@phub/api-sdk';
import type { LocationAdminView, LocationProfileInput } from '@phub/locations';

export type { LocationAdminView, LocationProfileInput } from '@phub/locations';
export type AdminLocationCommandResult = LocationAdminView & { readonly replayed: boolean };

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
  listLocations(): Promise<{ readonly items: readonly LocationAdminView[] }>;
  getLocation(locationId: string): Promise<LocationAdminView>;
  createLocation(profile: LocationProfileInput): Promise<AdminLocationCommandResult>;
  updateLocation(
    locationId: string,
    expectedVersion: number,
    profile: LocationProfileInput,
  ): Promise<AdminLocationCommandResult>;
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
    if (init.body) headers.set('Content-Type', 'application/json');
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
  };
}
