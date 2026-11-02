import { it, expect } from 'vitest';
import { monthlyRequest, monthlyOfferId } from './native-monthly-purchase-request.js';
import { mpHash, mpOperationId } from '../../..//packages/domain/src/subscription-purchase.js';
import {
  monthlyIdentity,
  validateMonthlyQuote,
  validateMonthlyResult,
} from '../../web/src/monthly-purchase-attempt.js';
import { config, auth } from './ios/testing/cabinet-fixtures.js';
const key = 'monthly:11111111-1111-4111-8111-111111111111',
  root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/subscription-purchase-operations`,
  headers = {
    authorization: 'Bearer synthetic-access',
    'idempotency-key': key,
    'content-type': 'application/json',
  },
  consent = {
    offerId: monthlyOfferId,
    expectedRevision: 'sha256:' + 'a'.repeat(64),
    amountMinor: 100000,
    currency: 'RUB',
  };
it('native command mapper accepts only the six reviewed resources and original consent', () => {
  expect(
    monthlyRequest(
      root + '/capability',
      { headers: { authorization: headers.authorization } },
      config,
    ),
  ).toEqual({ resource: 'capability' });
  expect(monthlyRequest(root + '/by-key', { headers }, config)).toEqual({ resource: 'byKey' });
  expect(
    monthlyRequest(
      root + '/quote',
      { method: 'POST', headers, body: JSON.stringify({ offerId: monthlyOfferId }) },
      config,
    ),
  ).toEqual({ resource: 'quote' });
  expect(
    monthlyRequest(root, { method: 'POST', headers, body: JSON.stringify(consent) }, config),
  ).toEqual({ resource: 'purchase' });
  for (const [path, resource] of [
    ['reconcile', 'reconcile'],
    ['payment-launch', 'launch'],
  ])
    expect(
      monthlyRequest(
        root + '/' + auth.context.userId + '/' + path,
        { method: 'POST', headers, body: '{}' },
        config,
      ),
    ).toEqual({ resource, resourceId: auth.context.userId });
});
it('native boundary rejects provider identities, duplicate consent, foreign URLs and alternate methods', () => {
  const init = { method: 'POST', headers, body: JSON.stringify(consent) };
  for (const suffix of ['?price=1', '/../games', '/unknown', '/quote#evil', '/quote\n'])
    expect(() => monthlyRequest(root + suffix, init, config)).toThrow();
  for (const body of [
    JSON.stringify({ ...consent, clientId: 'provider' }),
    JSON.stringify({ ...consent, amountMinor: 0 }),
    JSON.stringify({ ...consent, amountMinor: 1.5 }),
    JSON.stringify({ ...consent, expectedRevision: 'a'.repeat(64) }),
    JSON.stringify(consent).replace('}', ',"offerId":"' + monthlyOfferId + '"}'),
  ])
    expect(() => monthlyRequest(root, { ...init, body }, config)).toThrow();
  expect(() =>
    monthlyRequest(root, { ...init, headers: { ...headers, cookie: 'fixture' } }, config),
  ).toThrow();
  expect(() => monthlyRequest(root, { ...init, method: 'PUT' }, config)).toThrow();
});
it('browser receipt binds both actor and original key to the owner namespace', async () => {
  const c = {
      version: 1 as const,
      tenantId: auth.context.tenantId,
      userId: auth.context.userId,
      key,
      submitted: false,
      quote: null,
    },
    id = await monthlyIdentity(c);
  expect(id.keySha256).toBe(mpHash(key));
  expect(id.operationId).toBe(mpOperationId(c.tenantId, c.userId, mpHash(key)));
  const q = {
    contractVersion: 1,
    ...id,
    offerId: monthlyOfferId,
    title: 'Абонемент «Дружба»',
    revision: consent.expectedRevision,
    amountMinor: 100000,
    currency: 'RUB',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await expect(validateMonthlyQuote(q, c)).resolves.toEqual(q);
  await expect(validateMonthlyQuote({ ...q, keySha256: mpHash('other') }, c)).rejects.toThrow();
  const receipt = {
    contractVersion: 1,
    ...id,
    offerId: monthlyOfferId,
    status: 'PAID',
    amountMinor: 100000,
    currency: 'RUB',
    canOpenPayment: false,
    paymentExpiresAt: null,
  };
  await expect(validateMonthlyResult(receipt, c)).resolves.toEqual(receipt);
  for (const patch of [
    { operationId: auth.context.userId },
    { canOpenPayment: true },
    { providerSubscriptionId: 'provider' },
    { status: 'ACTIVE' },
  ])
    await expect(validateMonthlyResult({ ...receipt, ...patch }, c)).rejects.toThrow();
});
