import { Capacitor } from '@capacitor/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp.js';
import { androidSessionPlugin } from './native-api-fetch.js';
import { resolveMobileRuntimeConfig } from './runtime-config.js';
import '../../web/src/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Mobile mount element was not found');
const view = createRoot(root);
view.render(
  <main className="mobile-status" role="status">
    Открываем личный кабинет…
  </main>,
);
const native = Capacitor.isNativePlatform();
let content: React.JSX.Element;
async function start(): Promise<void> {
  try {
    // Native configuration is authoritative; web assets cannot choose another tenant or host.
    const bundled = native ? await androidSessionPlugin.configuration() : undefined;
    const config = resolveMobileRuntimeConfig({
      native,
      origin: window.location.origin,
      ...(bundled ?? {}),
      ...(!native && import.meta.env.VITE_PHUB_API_BASE_URL
        ? { apiBaseUrl: import.meta.env.VITE_PHUB_API_BASE_URL }
        : {}),
      ...(!native && import.meta.env.VITE_PHUB_TENANT_KEY
        ? { tenantKey: import.meta.env.VITE_PHUB_TENANT_KEY }
        : {}),
      ...(!native && import.meta.env.VITE_APP_VERSION
        ? { appVersion: import.meta.env.VITE_APP_VERSION }
        : {}),
    });
    content = <MobileApp config={config} native={native} />;
  } catch {
    content = (
      <main className="mobile-status">
        <h1>ПадлХАБ</h1>
        <p role="alert">
          Эта сборка ещё не подключена к сервису. Для входа потребуется настроенная версия
          приложения.
        </p>
      </main>
    );
  }
  view.render(<StrictMode>{content}</StrictMode>);
}
void start();
