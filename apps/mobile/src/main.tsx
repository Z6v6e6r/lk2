import { Capacitor } from '@capacitor/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installStatusBarUnderlay } from './status-bar-underlay.js';

installStatusBarUnderlay();

// Load only the selected platform entry, including its styles and session policy.
if (Capacitor.getPlatform() === 'ios') {
  const root = document.getElementById('root');
  if (!root) throw new Error('Mobile mount element was not found');
  void import('./ios/IOSAuthApp.js').then(({ IOSAuthApp }) => {
    createRoot(root).render(
      <StrictMode>
        <IOSAuthApp />
      </StrictMode>,
    );
  });
} else {
  void import('./shared-app-entry.js');
}
