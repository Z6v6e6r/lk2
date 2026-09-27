import { Capacitor } from '@capacitor/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp.js';
import { resolveMobileRuntimeConfig } from './runtime-config.js';
import '../../web/src/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Mobile mount element was not found');
const native = Capacitor.isNativePlatform();
let content: React.JSX.Element;
try {
  const config = resolveMobileRuntimeConfig({
    native,
    origin: window.location.origin,
    ...(import.meta.env.VITE_PHUB_API_BASE_URL
      ? { apiBaseUrl: import.meta.env.VITE_PHUB_API_BASE_URL }
      : {}),
    ...(import.meta.env.VITE_PHUB_TENANT_KEY
      ? { tenantKey: import.meta.env.VITE_PHUB_TENANT_KEY }
      : {}),
    ...(import.meta.env.VITE_APP_VERSION ? { appVersion: import.meta.env.VITE_APP_VERSION } : {}),
  });
  content = <MobileApp config={config} native={native} />;
} catch {
  content = (
    <main className="mobile-status">
      <h1>ПадлХАБ</h1>
      <p role="alert">
        Эта сборка ещё не подключена к сервису. Для входа потребуется настроенная версия приложения.
      </p>
    </main>
  );
}
createRoot(root).render(<StrictMode>{content}</StrictMode>);
