import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isApiRequest, realAccountRequestAllowed } from './local-real-account-policy.js';

export default defineConfig(({ command }) => {
  const realAccount = command === 'serve' && process.env.PHUB_LOCAL_REAL_ACCOUNT === '1';
  if (command === 'serve' && realAccount !== (process.env.VITE_LK2_REAL_ACCOUNT === '1')) {
    throw new Error('Real-account UI and ingress modes must match');
  }
  return {
    plugins: [
      react(),
      ...(realAccount
        ? [
            {
              name: 'local-real-account-read-only',
              configureServer(server) {
                server.middlewares.use((request, response, next) => {
                  if (request.headers.host !== 'localhost:5174') {
                    response.statusCode = 421;
                    response.end('Open this real-account preview at http://localhost:5174');
                    return;
                  }
                  const url = request.url ?? '';
                  if (!isApiRequest(url) || realAccountRequestAllowed(request.method ?? '', url))
                    return next();
                  response.statusCode = 403;
                  response.setHeader('Content-Type', 'application/json');
                  response.setHeader('Cache-Control', 'no-store');
                  response.end(
                    JSON.stringify({
                      code: 'LOCAL_ACCOUNT_READ_ONLY',
                      message: 'В этом локальном режиме доступны только вход и чтение данных.',
                    }),
                  );
                });
                server.httpServer?.prependListener(
                  'upgrade',
                  (request: IncomingMessage, socket: Duplex) => {
                    if (
                      request.headers.host !== 'localhost:5174' ||
                      isApiRequest(request.url ?? '')
                    )
                      socket.destroy();
                  },
                );
              },
            } satisfies Plugin,
          ]
        : []),
    ],
    resolve: { tsconfigPaths: true },
    server: {
      proxy: {
        '/user/api': {
          target: process.env.PHUB_DEV_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
        '/public/api': {
          target: process.env.PHUB_DEV_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
        ...(!realAccount
          ? {
              '/realtime': {
                target: process.env.PHUB_DEV_REALTIME_PROXY_TARGET ?? 'ws://127.0.0.1:3001',
                changeOrigin: true,
                ws: true,
              },
            }
          : {}),
      },
    },
    build: {
      manifest: 'vite-manifest.json',
      sourcemap: true,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/app-[hash].js',
          chunkFileNames: 'assets/chunk-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
