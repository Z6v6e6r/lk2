import { createServer as createHttpServer, request } from 'node:http';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { expect, it, vi } from 'vitest';

it('enforces real-account policy before the actual Vite proxy and isolates cookie hosts', async () => {
  const reached: string[] = [];
  const upstream = createHttpServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    res.end('sentinel');
  });
  await new Promise<void>((done, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', done);
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing sentinel port');
  vi.stubEnv('PHUB_LOCAL_REAL_ACCOUNT', '1');
  vi.stubEnv('VITE_LK2_REAL_ACCOUNT', '1');
  vi.stubEnv('PHUB_DEV_API_PROXY_TARGET', `http://127.0.0.1:${address.port}`);
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    vite = await createServer({
      configFile: resolve(import.meta.dirname, 'vite.config.ts'),
      root: import.meta.dirname,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await vite.listen();
    const local = vite.httpServer?.address();
    if (!local || typeof local === 'string') throw new Error('Missing Vite port');
    const send = (method: string, path: string, host = 'localhost:5174') =>
      new Promise<number | undefined>((done, reject) => {
        const req = request(
          { hostname: '127.0.0.1', port: local.port, method, path, headers: { host } },
          (res) => {
            res.resume();
            res.once('end', () => done(res.statusCode));
          },
        );
        req.once('error', reject);
        req.end();
      });
    const root = '/user/api/v1/local-padel';
    const id = '11111111-1111-4111-8111-111111111111';
    for (const path of [
      `${root}/games`,
      `${root}/profile/privacy`,
      `${root}/gift-certificates/sales`,
      `${root}/auth/challenges/../session/refresh`,
      `${root}/auth//session/refresh`,
      `${root}/auth/%73ession/refresh`,
      `${root}/auth%252fsession/refresh`,
      `${root}/auth\\session/refresh`,
      `${root}/auth/session/refresh/`,
      `${root}/games?path=/auth/session/refresh`,
      '/user/api/v1/other/auth/challenges',
      '//user/api/v1/local-padel/auth/challenges',
      '/%75ser/api/v1/local-padel/auth/challenges',
    ])
      expect(await send('POST', path)).toBe(403);
    expect(await send('GET', `${root}/auth/viva/callback`)).toBe(403);
    expect(await send('GET', '/internal/health')).toBe(403);
    expect(await send('GET', '/realtime')).toBe(403);
    expect(await send('POST', `${root}/auth/challenges`, '127.0.0.1:5174')).toBe(421);
    expect(reached).toEqual([]);
    for (const [method, path] of [
      ['POST', `${root}/auth/challenges`],
      ['POST', `${root}/auth/challenges/${id}/verify`],
      ['POST', `${root}/booking-screen-read-jobs/${id}/results/${id}`],
      ['GET', `${root}/profile?query=%20`],
      ['GET', `/public/api/v1/media/profile-photos/${id}/${id}`],
    ])
      expect(await send(method!, path!)).toBe(200);
    expect(reached).toHaveLength(5);
    await new Promise<void>((done, reject) => {
      const socket = connect(local.port, '127.0.0.1', () => {
        socket.write(
          'GET /user/api/v1/local-padel/profile HTTP/1.1\r\nHost: localhost:5174\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        );
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error('API upgrade was not closed'));
      });
      socket.once('close', () => done());
      socket.once('error', reject);
    });
    expect(reached).toHaveLength(5);
  } finally {
    await vite?.close();
    await new Promise<void>((done, reject) =>
      upstream.close((error) => (error ? reject(error) : done())),
    );
    vi.unstubAllEnvs();
  }
}, 20_000);
