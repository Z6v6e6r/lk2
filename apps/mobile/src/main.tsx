import { Capacitor } from '@capacitor/core';
import { PrimaryButton } from '@phub/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function MobileApp(): React.JSX.Element {
  return (
    <main>
      <span>{Capacitor.getPlatform()} preview</span>
      <h1>PadlHub</h1>
      <p>Один React-клиент, нативные оболочки Capacitor и собственный API-контур.</p>
      <PrimaryButton>Продолжить</PrimaryButton>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Mobile mount element was not found');
createRoot(root).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
