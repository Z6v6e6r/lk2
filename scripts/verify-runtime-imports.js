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

const { createContactReader } = await import('@phub/database/contacts');
if (typeof createContactReader !== 'function') {
  throw new Error('Contact reader runtime export is missing');
}
const contactReader = createContactReader({});
if (Object.keys(contactReader).join(',') !== 'listForUser') {
  throw new Error('Contact runtime capability must expose only listForUser');
}

const { createSupportTicketRepository, SupportTicketPermissionError } =
  await import('@phub/database/support-tickets');
if (
  typeof createSupportTicketRepository !== 'function' ||
  typeof SupportTicketPermissionError !== 'function'
) {
  throw new Error('Support ticket runtime exports are missing');
}
const supportTickets = createSupportTicketRepository({});
if (
  Object.keys(supportTickets).sort().join(',') !==
  'closeResolvedBatch,create,get,list,message,purgeClosedBatch,update'
) {
  throw new Error('Support ticket runtime repository surface is invalid');
}

const { createManagedSelfLeaveRepository, ManagedSelfLeaveError } =
  await import('@phub/database/managed-self-leave');
if (
  typeof createManagedSelfLeaveRepository !== 'function' ||
  typeof ManagedSelfLeaveError !== 'function'
) {
  throw new Error('Managed SELF leave runtime exports are missing');
}
const managedSelfLeave = createManagedSelfLeaveRepository({});
if (
  Object.keys(managedSelfLeave).sort().join(',') !==
  'begin,claim,finalize,isNoPayment,read,readByKey,readCommand,reconcileUndispatched'
) {
  throw new Error('Managed SELF leave runtime repository surface is invalid');
}
if (new ManagedSelfLeaveError('GAME_NOT_LEAVABLE').code !== 'GAME_NOT_LEAVABLE') {
  throw new Error('Managed SELF leave runtime error contract is invalid');
}
