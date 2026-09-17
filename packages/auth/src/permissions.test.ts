import { describe, expect, it } from 'vitest';

import {
  ADMIN_ONLY_PERMISSIONS,
  FULL_CLIENT_PERMISSIONS,
  isAdminOnlyPermission,
  mergeFullClientAccess,
  resolveClientPermissions,
} from './index.js';

describe('client permission catalog', () => {
  it('never lists an admin-only permission in the beta client catalog', () => {
    const adminOnly = new Set<string>(ADMIN_ONLY_PERMISSIONS);
    expect(FULL_CLIENT_PERMISSIONS.filter((permission) => adminOnly.has(permission))).toEqual([]);
  });

  it('keeps the catalog free of duplicates', () => {
    expect(new Set(FULL_CLIENT_PERMISSIONS).size).toBe(FULL_CLIENT_PERMISSIONS.length);
  });

  it('adds the catalog only when the beta switch is on', () => {
    expect(resolveClientPermissions({ stored: ['profile.read'], fullClientAccess: false })).toEqual(
      ['profile.read'],
    );
    expect(resolveClientPermissions({ stored: ['profile.read'], fullClientAccess: true })).toEqual(
      expect.arrayContaining([...FULL_CLIENT_PERMISSIONS]),
    );
  });

  it('strips admin-only permissions from a client token in both modes', () => {
    for (const fullClientAccess of [false, true]) {
      const permissions = resolveClientPermissions({
        stored: ['profile.read', 'notifications.manage', 'locations.publish'],
        fullClientAccess,
      });
      expect(permissions).toContain('profile.read');
      expect(permissions).not.toContain('notifications.manage');
      expect(permissions).not.toContain('locations.publish');
    }
  });

  it('recognizes admin-only permissions for the admin audience check', () => {
    expect(isAdminOnlyPermission('notifications.manage')).toBe(true);
    expect(isAdminOnlyPermission('chat.direct.create')).toBe(false);
  });
});

describe('bulk beta client-access merge', () => {
  it('adds the catalog and the client role to an empty profile', () => {
    const merged = mergeFullClientAccess({});
    expect(merged.roles).toEqual(['client']);
    expect(merged.permissions).toEqual([...FULL_CLIENT_PERMISSIONS].sort());
  });

  it('never demotes an operator or drops admin-only permissions', () => {
    const merged = mergeFullClientAccess({
      roles: ['admin', 'client'],
      permissions: ['notifications.manage', 'locations.publish', 'profile.read'],
    });

    expect(merged.roles).toEqual(['admin', 'client']);
    expect(merged.permissions).toContain('notifications.manage');
    expect(merged.permissions).toContain('locations.publish');
    expect(merged.permissions).toEqual(expect.arrayContaining([...FULL_CLIENT_PERMISSIONS]));
  });

  it('is idempotent and deterministic for an already granted profile', () => {
    const once = mergeFullClientAccess({ roles: ['client'], permissions: ['games.play'] });
    const twice = mergeFullClientAccess(once);
    expect(twice).toEqual(once);
  });
});
