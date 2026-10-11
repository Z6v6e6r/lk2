import type { AppConfig } from '@phub/config';
import { createNotificationEndpointCipher } from '@phub/notifications';

/** Both transports store endpoint addresses through the same server-owned keyring. */
export function createRuntimeNotificationEndpointCipher(
  config: Pick<
    AppConfig,
    | 'WEB_PUSH_ENABLED'
    | 'FCM_ENABLED'
    | 'NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS'
    | 'NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID'
  >,
) {
  return (config.WEB_PUSH_ENABLED || config.FCM_ENABLED) &&
    config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS
    ? createNotificationEndpointCipher({
        serializedKeys: config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS,
        activeKeyId: config.NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID,
      })
    : undefined;
}
