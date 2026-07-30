import { useRef, useState } from 'react';

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

function FavoriteIcon({ selected }: { readonly selected: boolean }): React.JSX.Element {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect
        width="36"
        height="36"
        rx="18"
        fill={selected ? '#F0705F' : '#FAFAFA'}
        fillOpacity={selected ? '0.08' : undefined}
      />
      {selected ? (
        <path
          d="M20.9607 12.0667C19.754 12.0667 18.674 12.6533 18.0007 13.5533C17.3273 12.6533 16.2473 12.0667 15.0407 12.0667C12.994 12.0667 11.334 13.7333 11.334 15.7933C11.334 16.5867 11.4607 17.32 11.6807 18C12.734 21.3333 15.9807 23.3266 17.5873 23.8733C17.814 23.9533 18.1873 23.9533 18.414 23.8733C20.0207 23.3266 23.2673 21.3333 24.3207 18C24.5407 17.32 24.6673 16.5867 24.6673 15.7933C24.6673 13.7333 23.0073 12.0667 20.9607 12.0667Z"
          fill="#F0705F"
        />
      ) : (
        <path
          d="M18.414 23.8733C18.1873 23.9533 17.814 23.9533 17.5873 23.8733C15.654 23.2133 11.334 20.46 11.334 15.7933C11.334 13.7333 12.994 12.0667 15.0407 12.0667C16.254 12.0667 17.3273 12.6533 18.0007 13.56C18.674 12.6533 19.754 12.0667 20.9607 12.0667C23.0073 12.0667 24.6673 13.7333 24.6673 15.7933C24.6673 20.46 20.3473 23.2133 18.414 23.8733Z"
          stroke="#353436"
          strokeWidth="1.26"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function RouteIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 1.5 6.22 6.22 1.5 8.06V1.5Z" fill="currentColor" />
      <path d="m14.5 14.5-4.72-4.72 4.72-1.84v6.56Z" fill="currentColor" />
      <path
        d="M6.08 4.72a4.65 4.65 0 0 1 5.2 5.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M9.92 11.28a4.65 4.65 0 0 1-5.2-5.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GalleryBackIcon(): React.JSX.Element {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect width="36" height="36" rx="18" fill="white" fillOpacity="0.12" />
      <path
        d="M20.6971 22.2044C21.101 22.611 21.1009 23.2844 20.6971 23.6911C20.4881 23.9014 20.2228 24 19.9581 24C19.6936 23.9999 19.429 23.9013 19.2202 23.6911L16.5178 20.9708L17.9947 19.4841L20.6971 22.2044ZM19.2202 12.305C19.6242 11.8983 20.2931 11.8983 20.6971 12.305C21.1007 12.7116 21.1007 13.384 20.6971 13.7906L15.0409 19.4841L14.303 18.7414C13.899 18.3347 13.899 17.6614 14.303 17.2547L19.2202 12.305Z"
        fill="white"
      />
    </svg>
  );
}

function GalleryMoreIcon(): React.JSX.Element {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <path
        d="M0 18C0 8.05888 8.05888 0 18 0C27.9411 0 36 8.05888 36 18C36 27.9411 27.9411 36 18 36C8.05888 36 0 27.9411 0 18Z"
        fill="white"
        fillOpacity="0.12"
      />
      <path
        d="M10 17.6375C10 18.5374 10.7375 19.275 11.6375 19.275C12.5375 19.275 13.275 18.5374 13.275 17.6375C13.275 16.7376 12.5375 16 11.6375 16C10.7375 16 10 16.7376 10 17.6375Z"
        fill="white"
      />
      <path
        d="M16.0947 17.6399C16.0947 18.5398 16.8322 19.2774 17.7322 19.2774C18.6322 19.2774 19.3697 18.5398 19.3697 17.6399C19.3697 16.74 18.6322 16.0024 17.7322 16.0024C16.8322 16.0024 16.0947 16.74 16.0947 17.6399Z"
        fill="white"
      />
      <path
        d="M22.2053 17.6375C22.2053 18.5374 22.9428 19.275 23.8428 19.275C24.7428 19.275 25.4803 18.5374 25.4803 17.6375C25.4803 16.7376 24.7428 16 23.8428 16C22.9428 16 22.2053 16.7376 22.2053 17.6375Z"
        fill="white"
      />
    </svg>
  );
}

export function LocationDetailPage({
  location,
}: {
  readonly location: LocationDetail;
}): React.JSX.Element {
  const [activeImage, setActiveImage] = useState(0);
  const [favorite, setFavorite] = useState(false);
  const gallerySwipeStartX = useRef<number | null>(null);
  const galleryHasPointerGesture = useRef(false);
  const galleryWasSwiped = useRef(false);
  const images = location.gallery.length > 0 ? location.gallery : [null];

  const changeActiveImage = (direction: -1 | 1): void => {
    setActiveImage((current) => (current + direction + images.length) % images.length);
  };

  const startGallerySwipe = (clientX: number): void => {
    gallerySwipeStartX.current = clientX;
    galleryWasSwiped.current = false;
  };

  const finishGallerySwipe = (clientX: number): void => {
    const startX = gallerySwipeStartX.current;
    gallerySwipeStartX.current = null;
    if (startX === null || Math.abs(clientX - startX) < 40) return;
    galleryWasSwiped.current = true;
    changeActiveImage(clientX < startX ? 1 : -1);
  };

  return (
    <main className="location-detail-shell">
      <section className="location-detail-gallery" aria-label="Фотографии локации">
        <div className="location-detail-gallery-actions">
          <a href="/locations" aria-label="Вернуться к локациям">
            <GalleryBackIcon />
          </a>
          <button type="button" aria-label="Поделиться локацией">
            <GalleryMoreIcon />
          </button>
        </div>
        <div
          className="location-detail-slides"
          onPointerDown={(event) => {
            galleryHasPointerGesture.current = true;
            startGallerySwipe(event.clientX);
          }}
          onPointerUp={(event) => {
            finishGallerySwipe(event.clientX);
            galleryHasPointerGesture.current = false;
          }}
          onPointerCancel={() => {
            galleryHasPointerGesture.current = false;
          }}
          onMouseDown={(event) => {
            if (!galleryHasPointerGesture.current) startGallerySwipe(event.clientX);
          }}
          onMouseUp={(event) => {
            if (!galleryHasPointerGesture.current) finishGallerySwipe(event.clientX);
          }}
        >
          {images.map((image, index) => (
            <button
              type="button"
              className={index === activeImage ? 'is-active' : ''}
              aria-label={`Показать фотографию ${index + 1}`}
              key={image?.url ?? 'empty'}
              onClick={() => {
                if (galleryWasSwiped.current) {
                  galleryWasSwiped.current = false;
                  return;
                }
                setActiveImage(index);
              }}
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
            <FavoriteIcon selected={favorite} />
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
                <RouteIcon />
                Построить маршрут
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
