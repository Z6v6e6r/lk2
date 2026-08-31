// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubscriptionStorefront } from './SubscriptionStorefront.js';
import {
  defaultSubscriptionStorefront,
  multiSectionSubscriptionStorefront,
} from './preview/catalogs.js';

afterEach(cleanup);

describe('SubscriptionStorefront', () => {
  it('renders a data-driven storefront and reports the selected billing option', () => {
    const onChoose = vi.fn();
    render(<SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={onChoose} />);

    expect(screen.getByRole('heading', { name: 'Играй в падел выгодно' })).toBeVisible();
    const rail = screen.getByRole('list', { name: 'Варианты абонементов' });
    expect(rail.querySelectorAll(':scope > [role="listitem"]')).toHaveLength(3);
    expect(screen.getByText('9 800 ₽')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'годовая' }));
    expect(screen.getByText('98 000 ₽')).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: 'Оформить подписку' })[0]!);

    expect(onChoose).toHaveBeenCalledWith({ planId: 'friendship', billingOptionId: 'annual' });
  });

  it('renders multiple independent offer sections for vertical page composition', () => {
    render(<SubscriptionStorefront view={multiSectionSubscriptionStorefront} onChoose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Основные абонементы' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Сезонные предложения' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Основные абонементы' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Сезонные предложения' })).toBeVisible();
  });

  it('uses a non-transactional callback instead of owning a payment gateway', () => {
    const onChoose = vi.fn();
    render(<SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={onChoose} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Оформить подписку' })[1]!);
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith({ planId: 'ra', billingOptionId: 'monthly' });
  });
});
