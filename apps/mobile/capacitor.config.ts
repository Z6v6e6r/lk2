import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.padlhub.app',
  appName: 'PadlHub',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  // Capacitor's debug bridge logs response bodies, including the short-lived access JWT.
  // The native viewport owns safe areas; WKWebView must not add a second scroll inset.
  ios: { contentInset: 'never', loggingBehavior: 'none' },
  android: { loggingBehavior: 'none', webContentsDebuggingEnabled: false },
  plugins: {
    // MainActivity contains the whole WebView, including fixed headers, inside native insets.
    SystemBars: { insetsHandling: 'disable', style: 'LIGHT' },
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
