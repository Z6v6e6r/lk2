import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { createBrowserAuthGateway } from './auth-gateway.js';
import './styles.css';

const mount = document.getElementById('phub-app');
if (!mount) throw new Error('PadlHub mount element #phub-app was not found');

const bootstrap = window.__PHUB_BOOTSTRAP__;
const tenantKey = bootstrap?.tenantKey ?? 'local-padel';
const apiBaseUrl = (bootstrap?.apiBaseUrl ?? window.location.origin).replace(/\/$/, '');
const gateway = createBrowserAuthGateway({
  baseUrl: apiBaseUrl,
  tenantKey,
  appVersion: bootstrap?.release ?? 'development',
});

createRoot(mount).render(
  <StrictMode>
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
      <App gateway={gateway} tenantKey={tenantKey} />
    </Suspense>
  </StrictMode>,
);
