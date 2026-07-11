import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function CupAdminApp(): React.JSX.Element {
  return (
    <main>
      <span>PadlHub ЦУП</span>
      <h1>Операционный контур</h1>
      <p>ЦУП использует Admin API и те же доменные модули, что пользовательские клиенты.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('CUP mount element was not found');
createRoot(root).render(
  <StrictMode>
    <CupAdminApp />
  </StrictMode>,
);
