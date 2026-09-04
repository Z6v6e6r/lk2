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

    fireEvent.click(screen.getByRole('radio', { name: 'год' }));
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

  it('renders billing-option progress when the selected period provides it', () => {
    const { container } = render(
      <SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={vi.fn()} />,
    );

    expect(screen.queryByLabelText('Осталось мест: Осталось: 45 / 200')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'год' }));
    expect(screen.getByLabelText('Осталось мест: Осталось: 45 / 200')).toBeVisible();
    expect(container.querySelector('.subscription-card__progress')).toBeVisible();
  });

  it('renders every plan inside a gradient card with progress above the panel', () => {
    const { container } = render(
      <SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={vi.fn()} />,
    );

    const card = container.querySelector('.subscription-card[data-plan-id="ra"]');
    expect(card).toBeVisible();
    expect(card).toHaveAttribute('data-plan-id', 'ra');
    expect(card?.querySelector('.subscription-card__progress')).toBeVisible();
    expect(card?.querySelector('.subscription-card__panel')).toBeVisible();
    expect(screen.getByLabelText('Осталось мест: Осталось: 12 / 100')).toBeVisible();
  });

  it('renders mock benefit copy from the storefront card trio', () => {
    render(<SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'мес.' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'X2' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'год' })).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Период оплаты' })).toBeVisible();
    expect(screen.getByText('«Время на друзей»')).toBeVisible();
    expect(screen.getByText('Турниры Падлхаб')).toBeVisible();
    expect(
      screen.getAllByText(
        'Скидка на форматы: игра + тренер, групповые тренировки, «Время на друзей», турниры Падлхаб',
      ),
    ).toHaveLength(3);
  });

  it('moves billing selection with arrow keys inside the radiogroup', () => {
    render(<SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={vi.fn()} />);

    const monthly = screen.getByRole('radio', { name: 'мес.' });
    monthly.focus();
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Период оплаты' }), {
      key: 'ArrowRight',
    });
    expect(screen.getByRole('radio', { name: 'X2' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('19 600 ₽')).toBeVisible();
  });

  it('marks cards without seats-left progress as transparent', () => {
    const { container } = render(
      <SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={vi.fn()} />,
    );

    const friendshipCard = container.querySelector('.subscription-card[data-plan-id="friendship"]');
    const academyCard = container.querySelector('.subscription-card[data-plan-id="academy"]');
    const raCard = container.querySelector('.subscription-card[data-plan-id="ra"]');

    expect(friendshipCard).toHaveClass('subscription-card--no-progress');
    expect(academyCard).toHaveClass('subscription-card--no-progress');
    expect(raCard).not.toHaveClass('subscription-card--no-progress');
  });

  it('renders bare panels instead of wrapped cards when no plan in the rail carries progress', () => {
    const { container } = render(
      <SubscriptionStorefront view={multiSectionSubscriptionStorefront} onChoose={vi.fn()} />,
    );

    const seasonalRail = container.querySelectorAll('.subscription-offer-section')[1]
      ?.querySelector('.subscription-plan-rail');
    expect(seasonalRail).toBeDefined();
    const items = seasonalRail?.querySelectorAll(':scope > [role="listitem"]') ?? [];
    expect(items).toHaveLength(2);
    items.forEach((item) => {
      expect(item.querySelector('.subscription-card')).toBeNull();
      expect(item.querySelector('.subscription-card__panel')).not.toBeNull();
      expect(item.querySelector('.subscription-card__progress')).toBeNull();
    });

    const mainRail = container.querySelectorAll('.subscription-offer-section')[0]
      ?.querySelector('.subscription-plan-rail');
    expect(mainRail?.querySelector('.subscription-card')).not.toBeNull();
  });

  it('renders an art-only tag for plans with artUrl and a color badge tag otherwise', () => {
    const { container } = render(
      <SubscriptionStorefront view={multiSectionSubscriptionStorefront} onChoose={vi.fn()} />,
    );

    const friendshipCard = container.querySelector('.subscription-card[data-plan-id="friendship"]');
    const summerTag = container.querySelector('.subscription-card__tag--label');

    expect(friendshipCard?.querySelector('.subscription-card__tag--art')).not.toBeNull();
    expect(summerTag).not.toBeNull();
    expect(summerTag?.querySelector('.subscription-card__badge-text')?.textContent).toContain(
      'Лето',
    );
  });

  it('uses a non-transactional callback instead of owning a payment gateway', () => {
    const onChoose = vi.fn();
    render(<SubscriptionStorefront view={defaultSubscriptionStorefront} onChoose={onChoose} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Оформить подписку' })[1]!);
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith({ planId: 'ra', billingOptionId: 'monthly' });
  });

  it('disables the CTA when the plan marks ctaDisabled', () => {
    const onChoose = vi.fn();
    const soldOut = {
      ...defaultSubscriptionStorefront,
      sections: [
        {
          ...defaultSubscriptionStorefront.sections[0]!,
          plans: defaultSubscriptionStorefront.sections[0]!.plans.map((plan) =>
            plan.id === 'ra'
              ? { ...plan, ctaLabel: 'Мест нет', ctaDisabled: true }
              : plan,
          ),
        },
      ],
    };
    render(<SubscriptionStorefront view={soldOut} onChoose={onChoose} />);

    const cta = screen.getByRole('button', { name: 'Мест нет' });
    expect(cta).toBeDisabled();
    fireEvent.click(cta);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
