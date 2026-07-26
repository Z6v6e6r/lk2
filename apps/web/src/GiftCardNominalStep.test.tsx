// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { GiftCardNominalStep, type GiftCardNominalOption } from './GiftCardNominalStep.js';

const denominations: readonly GiftCardNominalOption[] = [
  { id: 'denomination-6000', amountMinor: 600_000, currency: 'RUB' },
  { id: 'denomination-10000', amountMinor: 1_000_000, currency: 'RUB' },
  { id: 'denomination-15000', amountMinor: 1_500_000, currency: 'RUB' },
  { id: 'denomination-20000', amountMinor: 2_000_000, currency: 'RUB' },
  { id: 'denomination-30000', amountMinor: 3_000_000, currency: 'RUB' },
  { id: 'denomination-50000', amountMinor: 5_000_000, currency: 'RUB' },
  { id: 'denomination-75000', amountMinor: 7_500_000, currency: 'RUB' },
  { id: 'denomination-100000', amountMinor: 10_000_000, currency: 'RUB' },
];

afterEach(cleanup);

function ControlledNominalStep(props: {
  readonly onChange?: (value: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState<string | null>('denomination-6000');
  return (
    <GiftCardNominalStep
      denominations={denominations}
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        props.onChange?.(nextValue);
      }}
    />
  );
}

describe('GiftCardNominalStep', () => {
  it('renders step 03 as one flat catalog block without a separate title or accordions', () => {
    render(<ControlledNominalStep />);

    expect(screen.getByRole('region', { name: 'Шаг 03. Номинал' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(denominations.length);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByText('Популярные')).not.toBeInTheDocument();
    expect(screen.queryByText('Все номиналы')).not.toBeInTheDocument();
    expect(screen.queryByText('Другой номинал')).not.toBeInTheDocument();
  });

  it('keeps selection in the controlled checkout denomination id', () => {
    const onChange = vi.fn();
    render(<ControlledNominalStep onChange={onChange} />);

    const initial = screen.getByRole('button', { name: '6 000 ₽' });
    const next = screen.getByRole('button', { name: '100 000 ₽' });
    expect(initial).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(next);

    expect(onChange).toHaveBeenCalledWith('denomination-100000');
    expect(initial).toHaveAttribute('aria-pressed', 'false');
    expect(next).toHaveAttribute('aria-pressed', 'true');
  });
});
