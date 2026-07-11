import { StrictMode } from 'react';
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
    <App gateway={gateway} tenantKey={tenantKey} />
  </StrictMode>,
);
