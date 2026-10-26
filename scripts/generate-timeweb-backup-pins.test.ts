import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  API_WORKER_CI_DOWNLOAD_PATCH,
  API_WORKER_CI_READER_PATCH,
  API_WORKER_CONTROLLER_PROMOTION_PATCH,
  API_WORKER_ANDROID_CHAT_TEST_PATCH,
  API_WORKER_REHEARSAL_READINESS_PATCH,
  API_WORKER_NATIVE_BOOKINGS_PATCH,
} from './timeweb-api-worker-contract.js';
import {
  BEGIN_MARKER,
  DEFAULT_HELPER,
  END_MARKER,
  renderPinBlock,
  replacePinBlock,
} from './generate-timeweb-backup-pins.js';

const groups = [
  API_WORKER_CI_DOWNLOAD_PATCH,
  API_WORKER_CI_READER_PATCH,
  API_WORKER_CONTROLLER_PROMOTION_PATCH,
  API_WORKER_ANDROID_CHAT_TEST_PATCH,
  API_WORKER_REHEARSAL_READINESS_PATCH,
  API_WORKER_NATIVE_BOOKINGS_PATCH,
];

describe('generated Python delivery pins', () => {
  it('keeps the helper block identical to the JavaScript contract', () => {
    const source = readFileSync(DEFAULT_HELPER, 'utf8');
    const begin = source.indexOf(BEGIN_MARKER);
    const end = source.indexOf(END_MARKER);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const checkedIn = source.slice(begin, source.indexOf('\n', end) + 1);
    expect(checkedIn).toBe(renderPinBlock());
  });

  it('renders every frozen path exactly once with its checked-in OIDs', () => {
    const block = renderPinBlock();
    const paths = groups.flatMap((group) => group.map((pin) => pin.path));
    expect(paths).toHaveLength(32);
    expect(new Set(paths).size).toBe(32);
    for (const path of paths) expect(block).toContain(`'${path}':`);
    for (const group of groups)
      for (const pin of group) expect(block).toContain(`'newOid': '${pin.newOid}'`);
  });

  it('refuses a helper that lost the generated markers', () => {
    expect(() => replacePinBlock('no markers here', renderPinBlock())).toThrow('markers');
  });
});
