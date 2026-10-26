import { describe, expect, it } from 'vitest';

import {
  POST101_DISK_SCHEMA,
  POST101_NAMESPACE_SCHEMA,
  PRE99_DISK_SCHEMA,
  PRE99_NAMESPACE_SCHEMA,
  evaluateCapacity,
  selectRestorePlan,
} from './timeweb-restore-capacity.js';

const GIB = 1024 ** 3;

describe('restore capacity selection', () => {
  it('keeps the namespace (tmpfs) schema for a database that fits the host', () => {
    const plan = selectRestorePlan('post101', 1 * GIB, 8 * GIB, 45 * GIB);
    expect(plan.storageMode).toBe('namespace');
    expect(plan.schema).toBe(POST101_NAMESPACE_SCHEMA);
    expect(selectRestorePlan('pre99', 1 * GIB, 8 * GIB, 45 * GIB).schema).toBe(
      PRE99_NAMESPACE_SCHEMA,
    );
  });

  it('switches to the disk schema when the 9.5 GiB database cannot fit tmpfs on a 12 GB host', () => {
    const plan = selectRestorePlan('post101', Math.round(9.5 * GIB), 8.9 * GIB, 45 * GIB);
    expect(plan.storageMode).toBe('disk');
    expect(plan.schema).toBe(POST101_DISK_SCHEMA);
    expect(selectRestorePlan('pre99', Math.round(9.5 * GIB), 8.9 * GIB, 45 * GIB).schema).toBe(
      PRE99_DISK_SCHEMA,
    );
  });

  it('fails before any mutation when neither mode fits', () => {
    expect(() => selectRestorePlan('post101', Math.round(9.5 * GIB), 8.9 * GIB, 20 * GIB)).toThrow(
      'NO_RESTORE_CAPACITY',
    );
    expect(evaluateCapacity(9.5 * GIB, 8.9 * GIB, 20 * GIB).model).toBe('none');
  });

  it('uses the same safety rule for the production profile', () => {
    const beta = selectRestorePlan('post101', Math.round(9.5 * GIB), 8.9 * GIB, 45 * GIB, 'beta');
    const production = selectRestorePlan(
      'post101',
      Math.round(9.5 * GIB),
      8.9 * GIB,
      45 * GIB,
      'production',
    );
    expect(production.schema).toBe(beta.schema);
    expect(production.storageMode).toBe('disk');
  });
});
