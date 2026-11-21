import { useEffect, useId, useRef, useState } from 'react';

const MOBILE = '(max-width: 680px)';
export type GameCreateStep = 0 | 1 | 2;

function validStep(value: unknown): value is GameCreateStep {
  return value === 0 || value === 1 || value === 2;
}

function historyRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}

export function useGameCreateWizard() {
  const id = useId();
  const [active, setActive] = useState(() => window.matchMedia?.(MOBILE).matches ?? false);
  const [step, setStep] = useState<GameCreateStep>(0);
  const anchorStep = useRef<GameCreateStep>(0);
  const generation = useRef(0);

  useEffect(() => {
    const media = window.matchMedia?.(MOBILE);
    const resize = () => setActive(media?.matches ?? false);
    const restore = (event: PopStateEvent) => {
      const entry = historyRecord(historyRecord(event.state).lk2CreateWizard);
      setStep(
        entry.id === id && entry.generation === generation.current && validStep(entry.step)
          ? entry.step
          : anchorStep.current,
      );
    };
    media?.addEventListener('change', resize);
    window.addEventListener('popstate', restore);
    return () => {
      media?.removeEventListener('change', resize);
      window.removeEventListener('popstate', restore);
    };
  }, [id]);

  function advance(next: GameCreateStep) {
    if (next === step) return;
    window.history.pushState(
      {
        ...historyRecord(window.history.state),
        lk2CreateWizard: { id, generation: generation.current, step: next },
      },
      '',
    );
    setStep(next);
  }

  function back() {
    if (step === 0) return;
    const entry = historyRecord(historyRecord(window.history.state).lk2CreateWizard);
    if (entry.id === id && entry.generation === generation.current && step > anchorStep.current) {
      window.history.back();
      return;
    }
    const previous = step === 2 ? 1 : 0;
    anchorStep.current = previous;
    setStep(previous);
  }

  function reset() {
    generation.current += 1;
    anchorStep.current = 0;
    setStep(0);
  }

  return { active, step, advance, back, reset };
}
