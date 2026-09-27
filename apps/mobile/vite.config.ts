import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  publicDir: '../web/public',
  build: { sourcemap: false },
  ...(process.env.PHUB_DEV_API_PROXY_TARGET
    ? {
        server: {
          proxy: {
            '/public/api': {
              target: process.env.PHUB_DEV_API_PROXY_TARGET,
              changeOrigin: true,
            },
            '/user': {
              target: process.env.PHUB_DEV_API_PROXY_TARGET,
              changeOrigin: true,
            },
          },
        },
      }
    : {}),
});
