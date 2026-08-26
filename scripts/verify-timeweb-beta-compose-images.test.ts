import { describe, expect, it } from 'vitest';

import { verifyComposeImages } from './verify-timeweb-beta-compose-images.js';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const releaseEnvironment = [
  'REGISTRY=ghcr.io/z6v6e6r',
  `WEB_IMAGE_DIGEST=${digest('1')}`,
  `API_IMAGE_DIGEST=${digest('2')}`,
  `WORKER_IMAGE_DIGEST=${digest('3')}`,
  `REALTIME_IMAGE_DIGEST=${digest('4')}`,
  `MIGRATOR_IMAGE_DIGEST=${digest('5')}`,
].join('\n');
const actual = [
  `ghcr.io/z6v6e6r/phub-web@${digest('1')}`,
  `ghcr.io/z6v6e6r/phub-api@${digest('2')}`,
  `ghcr.io/z6v6e6r/phub-worker@${digest('3')}`,
  `ghcr.io/z6v6e6r/phub-realtime@${digest('4')}`,
  `ghcr.io/z6v6e6r/phub-migrator@${digest('5')}`,
].join('\n');

describe('Timeweb beta effective Compose image gate', () => {
  it('accepts exactly the five canonical manifest images', () => {
    expect(() => verifyComposeImages(releaseEnvironment, actual)).not.toThrow();
  });

  it('rejects an ambient override even when the component name is valid', () => {
    const hostile = actual.replace(digest('2'), digest('a'));
    expect(() => verifyComposeImages(releaseEnvironment, hostile)).toThrow('image_set');
  });
});
