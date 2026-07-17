// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { LocationDetail, LocationList } from './auth-gateway.js';
import { LocationDetailPage } from './LocationDetailPage.js';
import { LocationsPage } from './LocationsPage.js';

const locationId = '11111111-1111-4111-8111-111111111111';

afterEach(cleanup);

describe('published location screens', () => {
  it('links every directory card by PadlHub UUID', () => {
    const locations: LocationList = {
      items: [
        {
          id: locationId,
          title: 'Нагатинская',
          city: 'Москва',
          courtCount: 6,
          coverImageUrl: 'https://cdn.padlhub.test/location.webp',
          route: `/locations/${locationId}`,
        },
      ],
    };

    render(<LocationsPage locations={locations} />);

    expect(screen.getByRole('heading', { name: 'Локации' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Нагатинская/ })).toHaveAttribute(
      'href',
      `/locations/${locationId}`,
    );
  });

  it('renders computed status, contact data and a local favorite interaction', () => {
    const location: LocationDetail = {
      id: locationId,
      slug: 'nagatinskaya',
      title: 'Хаб Нагатинская',
      shortTitle: 'Нагатинская',
      city: 'Москва',
      courtCount: 6,
      address: '1-й Нагатинский проезд, 2',
      coordinates: { latitude: 55.6801, longitude: 37.6319 },
      timezone: 'Europe/Moscow',
      metro: { name: 'Нагатинская', distanceMeters: 400 },
      phoneE164: '+79990000000',
      gallery: [
        {
          url: 'https://cdn.padlhub.test/location.webp',
          alt: 'Корты',
          isCover: true,
          sortOrder: 0,
        },
      ],
      amenities: [
        {
          key: 'parking',
          icon: 'PARKING',
          title: 'Бесплатная парковка',
          description: null,
          sortOrder: 0,
        },
      ],
      workingHours: [
        {
          weekday: 'MON',
          closed: false,
          intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
        },
      ],
      openNow: true,
      workingHoursSummary: 'Сегодня, 07:00—23:00',
      navigationUrl: 'https://yandex.ru/maps/?rtext=~55.6801,37.6319&rtt=auto',
      route: `/locations/${locationId}`,
    };

    render(<LocationDetailPage location={location} />);

    expect(screen.getByRole('heading', { name: 'Хаб Нагатинская' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '⌁ Построить маршрут' })).toHaveAttribute(
      'href',
      location.navigationUrl,
    );
    const favorite = screen.getByRole('button', { name: 'Добавить в избранное' });
    fireEvent.click(favorite);
    expect(screen.getByRole('button', { name: 'Удалить из избранного' })).toBeInTheDocument();
  });
});
