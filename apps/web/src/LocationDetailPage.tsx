import { useState } from 'react';

import type { LocationDetail } from './auth-gateway.js';
import { LocationNavigation } from './LocationsPage.js';

const amenitySymbols: Readonly<Record<string, string>> = {
  PARKING: 'P',
  CAFE: '☕',
  CHANGING_ROOM: '▣',
  SHOWER: '♨',
  SAUNA: '◆',
  RENTAL: '◇',
  SHOP: '▤',
  ACCESSIBILITY: '♿',
  KIDS: '☆',
  LOUNGE: '▱',
  OTHER: '•',
};

function readableDistance(distanceMeters: number | null): string {
  if (distanceMeters === null) return '';
  if (distanceMeters < 1_000) return `${distanceMeters} м`;
  return `${(distanceMeters / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`;
}

export function LocationDetailPage({
  location,
}: {
  readonly location: LocationDetail;
}): React.JSX.Element {
  const [activeImage, setActiveImage] = useState(0);
  const [favorite, setFavorite] = useState(false);
  const images = location.gallery.length > 0 ? location.gallery : [null];

  return (
    <main className="location-detail-shell">
      <section className="location-detail-gallery" aria-label="Фотографии локации">
        <div className="location-detail-gallery-actions">
          <a href="/locations" aria-label="Вернуться к локациям">
            ‹
          </a>
          <button type="button" aria-label="Поделиться локацией">
            •••
          </button>
        </div>
        <div className="location-detail-slides">
          {images.map((image, index) => (
            <button
              type="button"
              className={index === activeImage ? 'is-active' : ''}
              aria-label={`Показать фотографию ${index + 1}`}
              key={image?.url ?? 'empty'}
              onClick={() => setActiveImage(index)}
              style={image ? { backgroundImage: `url(${image.url})` } : undefined}
            />
          ))}
        </div>
        <div className="location-detail-dots" aria-hidden="true">
          {images.map((image, index) => (
            <i className={index === activeImage ? 'is-active' : ''} key={image?.url ?? 'empty'} />
          ))}
        </div>
      </section>

      <section className="location-detail-card">
        <header className="location-detail-title">
          <div>
            <h1>{location.title}</h1>
            <p className={location.openNow ? 'is-open' : ''}>
              <i /> {location.workingHoursSummary}
            </p>
          </div>
          <button
            className={favorite ? 'is-favorite' : ''}
            type="button"
            aria-label={favorite ? 'Удалить из избранного' : 'Добавить в избранное'}
            onClick={() => setFavorite((current) => !current)}
          >
            {favorite ? '♥' : '♡'}
          </button>
        </header>

        <section className="location-detail-amenities" aria-label="Преимущества">
          {location.amenities.map((amenity) => (
            <div key={amenity.key}>
              <span>{amenitySymbols[amenity.icon] ?? '•'}</span>
              <p>
                <strong>{amenity.title}</strong>
                {amenity.description ? <small>{amenity.description}</small> : null}
              </p>
            </div>
          ))}
        </section>

        <section className="location-detail-contact">
          <div className="location-detail-map" aria-label="Расположение локации">
            {location.coordinates ? (
              <span
                className="location-map-pin"
                title={`${location.coordinates.latitude}, ${location.coordinates.longitude}`}
              >
                ●
              </span>
            ) : null}
            {location.navigationUrl ? (
              <a href={location.navigationUrl} target="_blank" rel="noreferrer">
                ⌁ Построить маршрут
              </a>
            ) : (
              <span className="location-route-unavailable">Координаты не указаны</span>
            )}
          </div>
          <dl>
            {location.metro ? (
              <div>
                <dt>Станция метро</dt>
                <dd>
                  {location.metro.name}
                  {location.metro.distanceMeters === null
                    ? ''
                    : `, ${readableDistance(location.metro.distanceMeters)}`}
                </dd>
              </div>
            ) : null}
            {location.address ? (
              <div>
                <dt>Адрес</dt>
                <dd>{location.address}</dd>
              </div>
            ) : null}
            {location.phoneE164 ? (
              <div>
                <dt>Телефон</dt>
                <dd>
                  <a href={`tel:${location.phoneE164}`}>{location.phoneE164}</a>
                </dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section className="location-detail-schedule">
          <h2>График работы</h2>
          <div>
            {location.workingHours.map((day) => (
              <span key={day.weekday}>
                <strong>{day.weekday}</strong>
                <small>
                  {day.closed
                    ? 'Закрыто'
                    : day.intervals
                        .map((interval) => `${interval.opensAt}–${interval.closesAt}`)
                        .join(', ')}
                </small>
              </span>
            ))}
          </div>
        </section>
      </section>
      <LocationNavigation />
    </main>
  );
}
