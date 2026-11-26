import { useRef, useState } from 'react';

import {
  cupSupportHandoffDestination,
  readCupSupportHandoffDraft,
} from './cup-support-staging-handoff.js';

export function CupSupportHandoffPage({
  draft,
  issue,
}: {
  readonly draft: string;
  readonly issue: (draft: string) => Promise<{ readonly proof: string }>;
}): React.JSX.Element {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function continueToSupport(): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(false);
    try {
      const { proof } = await issue(draft);
      if (readCupSupportHandoffDraft(window.location) !== draft) return;
      const destination = cupSupportHandoffDestination(proof);
      window.history.replaceState(window.history.state, '', '/');
      window.location.replace(destination);
    } catch {
      setError(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="app-shell app-shell-loading" aria-labelledby="cup-support-handoff-title">
      <section className="loading-card">
        <h1 id="cup-support-handoff-title">Подтвердите вход для обращения</h1>
        <p>Продолжите в поддержку CUP, чтобы отправить подготовленное обращение.</p>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void continueToSupport()}
        >
          {busy ? 'Подтверждаем вход…' : 'Продолжить в поддержку'}
        </button>
        {error ? <p role="alert">Не удалось подтвердить вход. Попробуйте ещё раз.</p> : null}
      </section>
    </main>
  );
}
