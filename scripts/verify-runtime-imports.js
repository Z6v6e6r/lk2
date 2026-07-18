const [{ IdentityProviderError }, { VivaIdentityProvider }] = await Promise.all([
  import('@phub/auth'),
  import('@phub/viva-adapter'),
  import('@phub/auth/viva-delegation'),
]);

const provider = new VivaIdentityProvider({
  mode: 'sandbox',
  baseUrl: 'https://identity.example.test',
  realm: 'clients',
  clientId: 'runtime-import-check',
  channel: 'web',
  profileApiBaseUrl: 'https://profile.example.test',
  oauthScopes: 'openid',
  timeoutMs: 1_000,
  devPhoneE164: '+79990000001',
  devOtpCode: '0000',
  fetchImplementation: async () => new Response('', { status: 401 }),
});

let providerError;
try {
  await provider.verifyPhoneCode({
    phoneE164: '+79990000001',
    code: '0000',
    providerTenantKey: 'local-padel',
    correlationId: 'runtime-import-check',
  });
} catch (error) {
  providerError = error;
}

if (!(providerError instanceof IdentityProviderError)) {
  throw new Error('Viva adapter must reuse the runtime @phub/auth error class');
}
if (providerError.code !== 'AUTH_CODE_INVALID') {
  throw new Error(`Unexpected Viva adapter runtime error: ${providerError.code}`);
}
