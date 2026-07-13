import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  build: { sourcemap: true },
  ...(process.env.PHUB_DEV_API_PROXY_TARGET
    ? {
        server: {
          proxy: {
            '/user': {
              target: process.env.PHUB_DEV_API_PROXY_TARGET,
              changeOrigin: true,
            },
          },
        },
      }
    : {}),
});
