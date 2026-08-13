import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
      '/realtime': {
        target: process.env.PHUB_DEV_REALTIME_PROXY_TARGET ?? 'ws://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
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
});
