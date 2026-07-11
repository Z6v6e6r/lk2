export const TEST_TENANT = {
  id: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  key: 'test-padel',
} as const;

export const TEST_USER = {
  id: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  tenantIds: [TEST_TENANT.id],
  roles: ['client'],
  permissions: ['profile.read'],
} as const;
