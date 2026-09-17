import { describe, expect, it } from 'vitest';

import {
  ADMIN_ONLY_PERMISSIONS,
  FULL_CLIENT_PERMISSIONS,
  isAdminOnlyPermission,
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
    expect(resolveClientPermissions({ stored: ['profile.read'], fullClientAccess: false })).toEqual([
      'profile.read',
    ]);
    expect(
      resolveClientPermissions({ stored: ['profile.read'], fullClientAccess: true }),
    ).toEqual(expect.arrayContaining([...FULL_CLIENT_PERMISSIONS]));
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
