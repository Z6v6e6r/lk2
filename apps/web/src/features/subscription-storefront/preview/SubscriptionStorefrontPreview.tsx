import { useMemo, useState } from 'react';

import { SubscriptionStorefront } from '../SubscriptionStorefront.js';
import type { SubscriptionPlanSelection, SubscriptionStorefrontView } from '../model.js';
import {
  abLetoSubscriptionStorefront,
  defaultSubscriptionStorefront,
  multiSectionSubscriptionStorefront,
} from './catalogs.js';
import { SubscriptionStorefrontTestPreview } from './SubscriptionStorefrontTestPreview.js';

function previewView(): SubscriptionStorefrontView {
  const scenario = new URL(window.location.href).searchParams.get('scenario');
  if (scenario === 'ab-leto') return abLetoSubscriptionStorefront;
  if (scenario === 'multi') return multiSectionSubscriptionStorefront;
  return defaultSubscriptionStorefront;
}

export function SubscriptionStorefrontPreview(): React.JSX.Element {
  const scenario = useMemo(
    () => new URL(window.location.href).searchParams.get('scenario'),
    [],
  );
  const [selection, setSelection] = useState<SubscriptionPlanSelection | null>(null);
  const view = useMemo(() => previewView(), []);

  if (scenario === 'test') {
    return <SubscriptionStorefrontTestPreview />;
  }

  return (
    <>
      <SubscriptionStorefront
        view={view}
        onBack={() => window.history.back()}
        onMore={() => undefined}
        onChoose={setSelection}
      />
      {selection ? (
        <output className="subscription-preview-selection" aria-live="polite">
          Выбран тариф {selection.planId} · {selection.billingOptionId}. Это preview без покупки.
        </output>
      ) : null}
    </>
  );
}
