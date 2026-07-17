import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import webPush from 'web-push';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const directory = resolve(
  argument('directory') ?? '/Users/zver/.config/padlhub/secrets/web-push-local',
);
const subject = argument('subject') ?? 'mailto:ops@padlhub.local';
const appId = argument('app-id') ?? 'padlhub-web';
const environment = argument('environment') ?? 'SANDBOX';
if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
  throw new Error('--subject must use mailto: or https:');
}
if (appId.length < 1 || appId.length > 300) throw new Error('--app-id must have 1-300 characters');
if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
  throw new Error('--environment must be SANDBOX or PRODUCTION');
}

const privateKeyPath = resolve(directory, 'web-push-vapid-private-key');
const endpointKeyringPath = resolve(directory, 'notification-endpoint-keyring.json');
const metadataPath = resolve(directory, 'metadata.json');
const overridePath = resolve(directory, 'compose.web-push.yaml');
for (const path of [privateKeyPath, endpointKeyringPath, metadataPath, overridePath]) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing Web Push material: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const vapidKeys = webPush.generateVAPIDKeys();
const endpointKeyring = JSON.stringify({
  v1: randomBytes(32).toString('base64'),
});
await writeFile(privateKeyPath, `${vapidKeys.privateKey}\n`, { mode: 0o600 });
await writeFile(endpointKeyringPath, `${endpointKeyring}\n`, { mode: 0o600 });
await writeFile(
  metadataPath,
  `${JSON.stringify(
    {
      subject,
      appId,
      environment,
      publicKey: vapidKeys.publicKey,
      activeEndpointKeyId: 'v1',
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
await writeFile(
  overridePath,
  `services:
  api:
    environment:
      WEB_PUSH_ENABLED: "true"
      WEB_PUSH_ENVIRONMENT: ${JSON.stringify(environment)}
      WEB_PUSH_APP_ID: ${JSON.stringify(appId)}
      WEB_PUSH_VAPID_SUBJECT: ${JSON.stringify(subject)}
      WEB_PUSH_VAPID_PUBLIC_KEY: ${JSON.stringify(vapidKeys.publicKey)}
      WEB_PUSH_VAPID_PRIVATE_KEY_FILE: /run/secrets/web_push_vapid_private_key
      NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS_FILE: /run/secrets/notification_endpoint_keyring
      NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: v1
    secrets:
      - web_push_vapid_private_key
      - notification_endpoint_keyring
  worker:
    environment:
      WEB_PUSH_ENABLED: "true"
      WEB_PUSH_ENVIRONMENT: ${JSON.stringify(environment)}
      WEB_PUSH_APP_ID: ${JSON.stringify(appId)}
      WEB_PUSH_VAPID_SUBJECT: ${JSON.stringify(subject)}
      WEB_PUSH_VAPID_PUBLIC_KEY: ${JSON.stringify(vapidKeys.publicKey)}
      WEB_PUSH_VAPID_PRIVATE_KEY_FILE: /run/secrets/web_push_vapid_private_key
      NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS_FILE: /run/secrets/notification_endpoint_keyring
      NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: v1
    secrets:
      - web_push_vapid_private_key
      - notification_endpoint_keyring
secrets:
  web_push_vapid_private_key:
    file: ${JSON.stringify(privateKeyPath)}
  notification_endpoint_keyring:
    file: ${JSON.stringify(endpointKeyringPath)}
`,
  { mode: 0o600 },
);

process.stdout.write(
  `${JSON.stringify(
    {
      directory,
      overridePath,
      metadataPath,
      subject,
      appId,
      environment,
      publicKey: vapidKeys.publicKey,
      privateMaterialPrinted: false,
    },
    null,
    2,
  )}\n`,
);
