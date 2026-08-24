import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { MobileApp } from './MobileApp.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Mobile mount element was not found');

createRoot(root).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
