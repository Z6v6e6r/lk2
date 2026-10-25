import { describe, expect, it } from 'vitest';

import {
  capacityProvisioningTargetBytes,
  diskRestoreRequiredBytes,
  evaluateCapacityProvisioning,
} from './timeweb-restore-capacity.js';

describe('capacity provisioning', () => {
  it('keeps the legacy restore requirement and a growth-aware provisioning target', () => {
    const databaseBytes = 11_176_434_711;
    expect(diskRestoreRequiredBytes(databaseBytes)).toBe(databaseBytes * 2 + 5 * 1024 ** 3);
    expect(capacityProvisioningTargetBytes(databaseBytes)).toBeGreaterThanOrEqual(
      Math.ceil(databaseBytes * 3.5),
    );
  });

  it('reports the exact shortfall against a canonical required-bytes readback', () => {
    const result = evaluateCapacityProvisioning(11_176_434_711, 42_928_771_072, 47_453_667_687);
    expect(result.ready).toBe(false);
    expect(result.shortfallBytes).toBe(47_453_667_687 - 42_928_771_072);
    expect(result.detail).toContain('action=resize-or-cleanup');
    expect(result.provisioningTargetBytes).toBeGreaterThanOrEqual(47_453_667_687);
  });

  it('reports GO when the canonical required bytes fit', () => {
    const result = evaluateCapacityProvisioning(11_176_434_711, 60_000_000_000, 47_453_667_687);
    expect(result.ready).toBe(true);
    expect(result.shortfallBytes).toBe(0);
    expect(result.detail).toContain('action=ready');
  });

  it('still reports a provisioning gap after the immediate requirement is met', () => {
    // Small database: the immediate restore fits, but the legacy growth-aware target is larger.
    const result = evaluateCapacityProvisioning(1_000_000_000, 5_000_000_000, 4_000_000_000);
    expect(result.ready).toBe(true);
    expect(result.provisioningShortfallBytes).toBeGreaterThan(0);
    expect(result.detail).toContain('provisioning target');
  });
});
