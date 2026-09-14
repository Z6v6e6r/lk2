import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { createBrowserAuthGateway } from './auth-gateway.js';
import { buildCommunityRealtimeUrl } from './community-realtime-url.js';
import './styles.css';

const mount = document.getElementById('phub-app');
if (!mount) throw new Error('PadlHub mount element #phub-app was not found');

const bootstrap = window.__PHUB_BOOTSTRAP__;
const tenantKey = bootstrap?.tenantKey ?? 'local-padel';
const apiBaseUrl = (bootstrap?.apiBaseUrl ?? window.location.origin).replace(/\/$/, '');
const realAccountPreview = import.meta.env.DEV && import.meta.env.VITE_LK2_REAL_ACCOUNT === '1';
let realtimeUrl: string | undefined;
try {
  // Realtime shares the already trusted PadlHub API origin. Invalid deployment configuration
  // degrades to canonical HTTP reads instead of preventing the LK from starting.
  realtimeUrl = buildCommunityRealtimeUrl(apiBaseUrl, tenantKey);
} catch {
  realtimeUrl = undefined;
}
const gateway = createBrowserAuthGateway({
  baseUrl: apiBaseUrl,
  tenantKey,
  appVersion: bootstrap?.release ?? 'development',
});

createRoot(mount).render(
  <StrictMode>
    {realAccountPreview ? (
      <p className="real-account-read-only-notice" role="status">
        Реальный аккаунт Viva · только чтение. Бронирования, оплаты и изменения недоступны.
      </p>
    ) : null}
    <Suspense
      fallback={
        <main className="app-shell app-shell-loading" aria-labelledby="chunk-loading-title">
          <section className="loading-card" aria-busy="true">
            <span className="loader" aria-hidden="true" />
            <h1 id="chunk-loading-title">Открываем личный кабинет</h1>
            <p role="status">Загружаем нужный раздел…</p>
          </section>
        </main>
      }
    >
      <App
        gateway={gateway}
        tenantKey={tenantKey}
        realtimeBaseUrl={apiBaseUrl}
        {...(realtimeUrl ? { realtimeUrl } : {})}
      />
    </Suspense>
  </StrictMode>,
);
