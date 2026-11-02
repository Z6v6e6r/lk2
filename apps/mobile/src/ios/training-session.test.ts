import { afterEach, expect, it, vi } from 'vitest';
import { createIOSFetch, type IOSSessionPlugin } from './session.js';
import { trainingRequest } from './training-routes.js';
import {
  config,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './testing/cabinet-fixtures.js';
const id = '11111111-1111-4111-8111-111111111111',
  sub = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333';
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/trainings`;
const input = { dateHint: '2035-04-02', subscriptionId: sub };
const headers = { authorization: 'Bearer synthetic-access', 'idempotency-key': key };
const query = {
  surface: 'TRAININGS' as const,
  localDates: ['2035-04-02', '2035-04-03'],
  kinds: ['GROUP_TRAINING' as const, 'SPLIT' as const],
  availability: 'INCLUDE_FULL' as const,
  limit: 20,
};
const receipt = {
  trainingId: id,
  subscriptionId: sub,
  dateHint: input.dateHint,
  operation: { id: key, status: 'UNKNOWN' },
  registration: { status: 'UNKNOWN', asOf: null },
  retryAfterSeconds: 15,
};
afterEach(() => vi.restoreAllMocks());
it('one native session keeps catalogue, original registration and GET-only recovery distinct', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>(
    async (v) =>
      await Promise.resolve(
        v.operation === 'training'
          ? nativeResult(v.resource === 'catalog' ? { items: [] } : receipt)
          : fixtureReply(v),
      ),
  );
  const session = syntheticSession(request);
  await session.restore();
  await session.trainingCatalogue(query);
  await session.continueTrainingCatalogue(id, 20);
  expect(await session.registerTraining(id, input, key)).toEqual(receipt);
  await session.getTrainingRegistration(id, key);
  const native = request.mock.calls.filter(([v]) => v.operation === 'training').map(([v]) => v);
  expect(native.map((v) => v.resource)).toEqual(['catalog', 'catalog', 'register', 'status']);
  expect(native[0]!.query).toEqual({
    localDates: '2035-04-02,2035-04-03',
    kinds: 'GROUP_TRAINING,SPLIT',
    availability: 'INCLUDE_FULL',
    limit: '20',
  });
  expect(native[2]).toMatchObject({
    resourceId: id,
    body: JSON.stringify(input),
    headers: { 'idempotency-key': key },
  });
  expect(native[3]).toMatchObject({ resourceId: id, headers: { 'idempotency-key': key } });
  expect(native[3]).not.toHaveProperty('body');
});
it.each([401, 503, 'network'] as const)(
  'registration does not replay or refresh after %s',
  async (status) => {
    const request = vi.fn<IOSSessionPlugin['request']>((v) => {
      if (v.operation !== 'training') return Promise.resolve(fixtureReply(v));
      if (status === 'network')
        return Promise.reject(
          Object.assign(new Error('synthetic network failure'), {
            code: 'NATIVE_NETWORK_UNAVAILABLE',
          }),
        );
      return Promise.resolve(
        nativeResult({ error: { code: 'SYNTHETIC_FAILURE', message: 'unavailable' } }, status),
      );
    });
    const session = syntheticSession(request);
    await session.restore();
    await expect(session.registerTraining(id, input, key)).rejects.toThrow();
    expect(request.mock.calls.filter(([v]) => v.operation === 'training')).toHaveLength(1);
    expect(request.mock.calls.filter(([v]) => v.operation === 'refresh')).toHaveLength(1);
  },
);
it('logout closes original command before ACK and rejects a duplicate in-flight command', async () => {
  let finish!: (v: Awaited<ReturnType<IOSSessionPlugin['request']>>) => void;
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    v.operation === 'training'
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve(fixtureReply(v)),
  );
  const session = syntheticSession(request);
  await session.restore();
  const pending = session.registerTraining(id, input, key);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await expect(session.registerTraining(id, input, key)).rejects.toThrow();
  session.closeQuarterCreate();
  finish(nativeResult(receipt));
  await rejected;
  await expect(session.getTrainingRegistration(id, key)).rejects.toThrow();
  expect(request.mock.calls.filter(([v]) => v.operation === 'training')).toHaveLength(1);
});
it('bridge cannot bypass original request custody', async () => {
  const request = vi.fn<IOSSessionPlugin['request']>();
  await expect(
    createIOSFetch(config, { request, configuration: () => Promise.resolve(config) })(
      `${root}/${id}/registrations`,
      { method: 'POST', headers, body: JSON.stringify(input) },
    ),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it('strict routes keep encoded catalogue values and reject duplicate query/body or foreign authority', () => {
  const catalogue = `${root}/catalog?localDates=2035-04-02%2C2035-04-03&kinds=GROUP_TRAINING%2CSPLIT&availability=INCLUDE_FULL&levelFrom=C%2B`;
  expect(
    trainingRequest(catalogue, { headers: { authorization: headers.authorization } }, config)?.query
      .levelFrom,
  ).toBe('C+');
  for (const url of [
    catalogue + '&localDates=2035-04-04',
    catalogue.replace('2035-04-02', '2035-02-30'),
    catalogue + '&cursor=' + id,
    catalogue.replace('/local-padel/', '/foreign/'),
    catalogue.replace(config.apiBaseUrl, 'https://untrusted.test'),
    `${root}/${id}/registrations?x=1`,
    `${root}/../trainings/${id}/registrations`,
  ]) {
    expect(() =>
      trainingRequest(
        url,
        {
          method: url.includes('catalog') ? 'GET' : 'POST',
          headers: url.includes('catalog') ? { authorization: headers.authorization } : headers,
          ...(url.includes('catalog') ? {} : { body: JSON.stringify(input) }),
        },
        config,
      ),
    ).toThrow();
  }
  for (const body of [
    JSON.stringify({ ...input, tenantId: id }),
    '{}',
    'null',
    `{"dateHint":"2035-04-02","subscriptionId":"${sub}","subscriptionId":"${sub}"}`,
    JSON.stringify({ ...input, dateHint: '2035-02-30' }),
  ])
    expect(() =>
      trainingRequest(`${root}/${id}/registrations`, { method: 'POST', headers, body }, config),
    ).toThrow();
  for (const h of [
    { authorization: headers.authorization },
    { ...headers, cookie: 'forbidden' },
    { ...headers, authorization: '' },
  ])
    expect(() =>
      trainingRequest(`${root}/${id}/registration-operation`, { headers: h }, config),
    ).toThrow();
});
