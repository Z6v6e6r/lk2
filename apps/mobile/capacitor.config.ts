import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.padlhub.app',
  appName: 'PadlHub',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  // Capacitor's debug bridge logs response bodies, including the short-lived access JWT.
  ios: { contentInset: 'automatic', loggingBehavior: 'none' },
  android: { loggingBehavior: 'none', webContentsDebuggingEnabled: false },
  plugins: {
    PadlHubAndroidSession: {
      apiBaseUrl: process.env.VITE_PHUB_API_BASE_URL ?? '',
      tenantKey: process.env.VITE_PHUB_TENANT_KEY ?? '',
    },
    PadlHubSession: {
      apiBaseUrl: process.env.VITE_PHUB_API_BASE_URL ?? '',
      tenantKey: process.env.VITE_PHUB_TENANT_KEY ?? '',
    },
  },
};

export default config;
