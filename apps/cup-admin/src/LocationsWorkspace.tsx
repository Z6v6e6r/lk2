import {
  locationCompleteness,
  locationProfileInputSchema,
  slugifyLocationTitle,
  type LocationAdminView,
  type LocationAmenityIcon,
  type LocationProfileInput,
  type LocationPublicationStatus,
  type LocationWeekday,
} from '@phub/locations';
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import type { NotificationAdminClient } from './notification-admin-client.js';

type SettingsTab = 'general' | 'quick' | 'stations';
type LocationClient = Pick<
  NotificationAdminClient,
  'listLocations' | 'createLocation' | 'updateLocation'
>;

const weekdays: readonly { readonly id: LocationWeekday; readonly label: string }[] = [
  { id: 'MON', label: 'Пн' },
  { id: 'TUE', label: 'Вт' },
  { id: 'WED', label: 'Ср' },
  { id: 'THU', label: 'Чт' },
  { id: 'FRI', label: 'Пт' },
  { id: 'SAT', label: 'Сб' },
  { id: 'SUN', label: 'Вс' },
];

const amenityIcons: readonly { readonly id: LocationAmenityIcon; readonly label: string }[] = [
  { id: 'PARKING', label: 'Парковка' },
  { id: 'CAFE', label: 'Кофейня' },
  { id: 'CHANGING_ROOM', label: 'Раздевалки' },
  { id: 'SHOWER', label: 'Душевые' },
  { id: 'SAUNA', label: 'Сауна' },
  { id: 'RENTAL', label: 'Аренда инвентаря' },
  { id: 'SHOP', label: 'Магазин' },
  { id: 'ACCESSIBILITY', label: 'Доступная среда' },
  { id: 'KIDS', label: 'Детская зона' },
  { id: 'LOUNGE', label: 'Зона отдыха' },
  { id: 'OTHER', label: 'Другое' },
];

const statusCopy: Readonly<Record<LocationPublicationStatus, string>> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликована',
  ARCHIVED: 'Архив',
};

const completenessCopy: Readonly<Record<string, string>> = {
  cover: 'обложка',
  city: 'город',
  courts: 'число кортов',
  address: 'адрес',
  coordinates: 'координаты',
  phone: 'телефон',
  working_hours: 'график на 7 дней',
};

function defaultHours(): LocationProfileInput['workingHours'] {
  return weekdays.map(({ id }) => ({
    weekday: id,
    closed: false,
    intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
  }));
}

function emptyProfile(): LocationProfileInput {
  return {
    slug: '',
    title: '',
    shortTitle: null,
    city: null,
    courtCount: 0,
    address: null,
    latitude: null,
    longitude: null,
    timezone: 'Europe/Moscow',
    metroName: null,
    metroDistanceMeters: null,
    phoneE164: null,
    workingHours: defaultHours(),
    amenities: [],
    gallery: [],
    publicationStatus: 'DRAFT',
    showOnHome: true,
    sortOrder: 100,
  };
}

function editableProfile(location: LocationAdminView): LocationProfileInput {
  return {
    slug: location.slug,
    title: location.title,
    shortTitle: location.shortTitle,
    city: location.city,
    courtCount: location.courtCount,
    address: location.address,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
    metroName: location.metroName,
    metroDistanceMeters: location.metroDistanceMeters,
    phoneE164: location.phoneE164,
    workingHours: location.workingHours.map((entry) => ({
      ...entry,
      intervals: entry.intervals.map((interval) => ({ ...interval })),
    })),
    amenities: location.amenities.map((amenity) => ({ ...amenity })),
    gallery: location.gallery.map((image) => ({ ...image })),
    publicationStatus: location.publicationStatus,
    showOnHome: location.showOnHome,
    sortOrder: location.sortOrder,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось сохранить локацию.';
}

function numeric(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function LocationPreview({
  profile,
}: {
  readonly profile: LocationProfileInput;
}): React.JSX.Element {
  const cover = profile.gallery.find((image) => image.isCover)?.url;
  const firstHours = profile.workingHours.find((entry) => !entry.closed)?.intervals[0];
  return (
    <aside className="location-preview" aria-label="Предпросмотр карточки локации">
      <div
        className="location-preview-cover"
        style={cover ? { backgroundImage: `url(${cover})` } : undefined}
      >
        <span>{profile.gallery.length || 0} фото</span>
      </div>
      <div className="location-preview-body">
        <small>Предпросмотр</small>
        <h3>{profile.title || 'Название локации'}</h3>
        <p className="location-preview-hours">
          <i />
          {firstHours
            ? `Ежедневно, ${firstHours.opensAt}—${firstHours.closesAt}`
            : 'График не задан'}
        </p>
        <div className="location-preview-amenities">
          {profile.amenities.slice(0, 4).map((amenity) => (
            <span key={amenity.key}>◆ {amenity.title || 'Преимущество'}</span>
          ))}
          {profile.amenities.length === 0 ? <span>Добавьте преимущества станции</span> : null}
        </div>
        <div className="location-preview-map">⌖ Карта и маршрут</div>
        <dl>
          <div>
            <dt>Станция метро</dt>
            <dd>{profile.metroName ?? 'Не указана'}</dd>
          </div>
          <div>
            <dt>Адрес</dt>
            <dd>{profile.address ?? 'Не указан'}</dd>
          </div>
          <div>
            <dt>Телефон</dt>
            <dd>{profile.phoneE164 ?? 'Не указан'}</dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

function LocationListPanel(props: {
  readonly locations: readonly LocationAdminView[];
  readonly selectedId?: string;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onCreate: () => void;
  readonly onSelect: (location: LocationAdminView) => void;
}): React.JSX.Element {
  const normalizedQuery = props.query.trim().toLocaleLowerCase('ru-RU');
  const visible = props.locations.filter((location) =>
    `${location.title} ${location.shortTitle ?? ''} ${location.city ?? ''}`
      .toLocaleLowerCase('ru-RU')
      .includes(normalizedQuery),
  );
  return (
    <section className="panel location-list-panel">
      <div className="location-list-heading">
        <div>
          <p className="eyebrow">Публичный каталог</p>
          <h2>Станции</h2>
        </div>
        <button className="primary-button compact-button" type="button" onClick={props.onCreate}>
          + Добавить
        </button>
      </div>
      <label className="location-search">
        <span className="sr-only">Поиск станции</span>
        <input
          type="search"
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder="Название или город"
        />
      </label>
      <div className="location-list" role="list">
        {visible.map((location) => {
          const cover = location.gallery.find((image) => image.isCover)?.url;
          return (
            <button
              className={`location-row ${props.selectedId === location.id ? 'selected' : ''}`}
              type="button"
              role="listitem"
              key={location.id}
              onClick={() => props.onSelect(location)}
            >
              <span
                className="location-row-cover"
                style={cover ? { backgroundImage: `url(${cover})` } : undefined}
              />
              <span className="location-row-copy">
                <strong>{location.title}</strong>
                <small>
                  {location.city ?? 'Город не указан'} · {location.courtCount} кортов
                </small>
                <span>
                  <i className={`publication-dot is-${location.publicationStatus.toLowerCase()}`} />
                  {statusCopy[location.publicationStatus]} · {location.completeness.percent}%
                </span>
              </span>
              <b aria-hidden="true">›</b>
            </button>
          );
        })}
        {visible.length === 0 ? (
          <div className="empty-state location-empty">
            <span>⌖</span>
            <p>
              {props.locations.length === 0 ? 'Создайте первую станцию.' : 'Ничего не найдено.'}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LocationEditor(props: {
  readonly selected?: LocationAdminView;
  readonly profile: LocationProfileInput;
  readonly busy: boolean;
  readonly message?: string;
  readonly error?: string;
  readonly onChange: (profile: LocationProfileInput) => void;
  readonly onSave: (status: LocationPublicationStatus) => void;
}): React.JSX.Element {
  const profile = props.profile;
  const parsed = locationProfileInputSchema.safeParse(profile);
  const completeness = locationCompleteness(profile);
  const isNew = !props.selected;

  function change<K extends keyof LocationProfileInput>(
    key: K,
    value: LocationProfileInput[K],
  ): void {
    props.onChange({ ...profile, [key]: value });
  }

  function updateHours(
    weekday: LocationWeekday,
    update: (
      entry: LocationProfileInput['workingHours'][number],
    ) => LocationProfileInput['workingHours'][number],
  ): void {
    change(
      'workingHours',
      profile.workingHours.map((entry) => (entry.weekday === weekday ? update(entry) : entry)),
    );
  }

  function addImage(): void {
    change('gallery', [
      ...profile.gallery,
      {
        url: '',
        alt: '',
        isCover: profile.gallery.length === 0,
        sortOrder: profile.gallery.length,
      },
    ]);
  }

  function addAmenity(): void {
    change('amenities', [
      ...profile.amenities,
      {
        key: `amenity-${Date.now().toString(36)}`,
        icon: 'OTHER',
        title: '',
        description: null,
        sortOrder: profile.amenities.length,
      },
    ]);
  }

  return (
    <section className="location-editor-layout">
      <div className="panel location-editor">
        <header className="location-editor-header">
          <div>
            <p className="eyebrow">
              {isNew ? 'Новая станция' : `Версия ${props.selected.version}`}
            </p>
            <h2>{isNew ? 'Карточка локации' : props.selected.title}</h2>
            <p>Техническая активность станции и публикация карточки не связаны.</p>
          </div>
          <div
            className="completeness-ring"
            style={{ '--progress': `${completeness.percent}%` } as CSSProperties}
          >
            <strong>{completeness.percent}%</strong>
            <small>готово</small>
          </div>
        </header>

        <div className="editor-section">
          <div className="editor-section-title">
            <span>1</span>
            <div>
              <h3>Основное</h3>
              <p>Название в приложении и карточке на Главной.</p>
            </div>
          </div>
          <div className="location-form-grid two-columns">
            <label>
              Полное название
              <input
                value={profile.title}
                maxLength={120}
                onChange={(event) => {
                  const title = event.target.value;
                  props.onChange({
                    ...profile,
                    title,
                    slug: isNew && !profile.slug ? slugifyLocationTitle(title) : profile.slug,
                  });
                }}
                placeholder="Хаб Нагатинская"
              />
            </label>
            <label>
              Короткое название
              <input
                value={profile.shortTitle ?? ''}
                maxLength={80}
                onChange={(event) => change('shortTitle', nullable(event.target.value))}
                placeholder="Нагатинская"
              />
            </label>
            <label>
              Адрес карточки
              <span className="input-prefix">
                <i>/locations/</i>
                <input
                  value={profile.slug}
                  onChange={(event) => change('slug', event.target.value.toLowerCase())}
                  placeholder="nagatinskaya"
                />
              </span>
            </label>
            <label>
              Город
              <input
                value={profile.city ?? ''}
                onChange={(event) => change('city', nullable(event.target.value))}
                placeholder="Москва"
              />
            </label>
            <label>
              Количество кортов
              <input
                type="number"
                min="0"
                max="999"
                value={profile.courtCount}
                onChange={(event) => change('courtCount', Number(event.target.value) || 0)}
              />
            </label>
            <label>
              Часовой пояс
              <input
                value={profile.timezone}
                onChange={(event) => change('timezone', event.target.value)}
                placeholder="Europe/Moscow"
              />
            </label>
          </div>
        </div>

        <div className="editor-section">
          <div className="editor-section-title">
            <span>2</span>
            <div>
              <h3>Фотографии</h3>
              <p>До 12 HTTPS-изображений. Одно обязательно назначается обложкой.</p>
            </div>
            <button className="secondary-button" type="button" onClick={addImage}>
              + Фото
            </button>
          </div>
          <div className="location-repeat-list">
            {profile.gallery.map((image, index) => (
              <div className="gallery-editor-row" key={`${index}-${image.sortOrder}`}>
                <span
                  className="gallery-editor-preview"
                  style={image.url ? { backgroundImage: `url(${image.url})` } : undefined}
                />
                <label>
                  HTTPS-ссылка
                  <input
                    type="url"
                    value={image.url}
                    onChange={(event) =>
                      change(
                        'gallery',
                        profile.gallery.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, url: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                    placeholder="https://cdn.padlhub.ru/location.webp"
                  />
                </label>
                <label>
                  Описание
                  <input
                    value={image.alt}
                    onChange={(event) =>
                      change(
                        'gallery',
                        profile.gallery.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, alt: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                    placeholder="Корты и зона отдыха"
                  />
                </label>
                <button
                  className={`cover-toggle ${image.isCover ? 'active' : ''}`}
                  type="button"
                  onClick={() =>
                    change(
                      'gallery',
                      profile.gallery.map((candidate, candidateIndex) => ({
                        ...candidate,
                        isCover: candidateIndex === index,
                      })),
                    )
                  }
                >
                  {image.isCover ? 'Обложка' : 'Сделать обложкой'}
                </button>
                <button
                  className="icon-button danger-icon"
                  type="button"
                  aria-label="Удалить фотографию"
                  onClick={() => {
                    const next = profile.gallery
                      .filter((_, candidateIndex) => candidateIndex !== index)
                      .map((candidate, candidateIndex) => ({
                        ...candidate,
                        sortOrder: candidateIndex,
                      }));
                    if (image.isCover && next[0]) next[0] = { ...next[0], isCover: true };
                    change('gallery', next);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {profile.gallery.length === 0 ? (
              <p className="repeat-empty">Фотографии ещё не добавлены.</p>
            ) : null}
          </div>
        </div>

        <div className="editor-section">
          <div className="editor-section-title">
            <span>3</span>
            <div>
              <h3>График работы</h3>
              <p>Статус «Открыто сейчас» рассчитывается на сервере.</p>
            </div>
          </div>
          <div className="hours-grid">
            {weekdays.map(({ id, label }) => {
              const entry = profile.workingHours.find((candidate) => candidate.weekday === id);
              if (!entry) return null;
              const interval = entry.intervals[0] ?? { opensAt: '07:00', closesAt: '23:00' };
              return (
                <div className="hours-row" key={id}>
                  <strong>{label}</strong>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={!entry.closed}
                      onChange={(event) =>
                        updateHours(id, (current) => ({
                          ...current,
                          closed: !event.target.checked,
                          intervals: event.target.checked ? [interval] : [],
                        }))
                      }
                    />{' '}
                    Работает
                  </label>
                  <input
                    type="time"
                    disabled={entry.closed}
                    value={interval.opensAt}
                    aria-label={`${label}, открытие`}
                    onChange={(event) =>
                      updateHours(id, (current) => ({
                        ...current,
                        intervals: [{ ...interval, opensAt: event.target.value }],
                      }))
                    }
                  />
                  <span>—</span>
                  <input
                    type="time"
                    disabled={entry.closed}
                    value={interval.closesAt}
                    aria-label={`${label}, закрытие`}
                    onChange={(event) =>
                      updateHours(id, (current) => ({
                        ...current,
                        intervals: [{ ...interval, closesAt: event.target.value }],
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="editor-section">
          <div className="editor-section-title">
            <span>4</span>
            <div>
              <h3>Преимущества</h3>
              <p>Иконка и текст выводятся в заданном порядке.</p>
            </div>
            <button className="secondary-button" type="button" onClick={addAmenity}>
              + Добавить
            </button>
          </div>
          <div className="location-repeat-list">
            {profile.amenities.map((amenity, index) => (
              <div className="amenity-editor-row" key={amenity.key}>
                <select
                  value={amenity.icon}
                  aria-label={`Иконка преимущества ${index + 1}`}
                  onChange={(event) =>
                    change(
                      'amenities',
                      profile.amenities.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, icon: event.target.value as LocationAmenityIcon }
                          : candidate,
                      ),
                    )
                  }
                >
                  {amenityIcons.map((icon) => (
                    <option value={icon.id} key={icon.id}>
                      {icon.label}
                    </option>
                  ))}
                </select>
                <input
                  value={amenity.title}
                  aria-label={`Текст преимущества ${index + 1}`}
                  onChange={(event) =>
                    change(
                      'amenities',
                      profile.amenities.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, title: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                  placeholder="Бесплатная парковка на 40 мест"
                />
                <button
                  className="icon-button danger-icon"
                  type="button"
                  aria-label={`Удалить преимущество ${index + 1}`}
                  onClick={() =>
                    change(
                      'amenities',
                      profile.amenities
                        .filter((_, candidateIndex) => candidateIndex !== index)
                        .map((candidate, candidateIndex) => ({
                          ...candidate,
                          sortOrder: candidateIndex,
                        })),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            {profile.amenities.length === 0 ? (
              <p className="repeat-empty">Преимущества ещё не добавлены.</p>
            ) : null}
          </div>
        </div>

        <div className="editor-section">
          <div className="editor-section-title">
            <span>5</span>
            <div>
              <h3>Адрес и контакты</h3>
              <p>Карта и маршрут строятся по координатам.</p>
            </div>
          </div>
          <div className="location-form-grid two-columns">
            <label className="span-two">
              Полный адрес
              <input
                value={profile.address ?? ''}
                onChange={(event) => change('address', nullable(event.target.value))}
                placeholder="1-й Нагатинский пр-д, 2 стр. 40БН"
              />
            </label>
            <label>
              Широта
              <input
                inputMode="decimal"
                value={profile.latitude ?? ''}
                onChange={(event) => change('latitude', numeric(event.target.value))}
                placeholder="55.6801"
              />
            </label>
            <label>
              Долгота
              <input
                inputMode="decimal"
                value={profile.longitude ?? ''}
                onChange={(event) => change('longitude', numeric(event.target.value))}
                placeholder="37.6319"
              />
            </label>
            <label>
              Ближайшее метро
              <input
                value={profile.metroName ?? ''}
                onChange={(event) => change('metroName', nullable(event.target.value))}
                placeholder="Нагатинская"
              />
            </label>
            <label>
              Расстояние, м
              <input
                type="number"
                min="0"
                value={profile.metroDistanceMeters ?? ''}
                onChange={(event) => change('metroDistanceMeters', numeric(event.target.value))}
                placeholder="400"
              />
            </label>
            <label>
              Телефон в формате E.164
              <input
                type="tel"
                value={profile.phoneE164 ?? ''}
                onChange={(event) => change('phoneE164', nullable(event.target.value))}
                placeholder="+79990000000"
              />
            </label>
          </div>
        </div>

        <div className="editor-section publication-section">
          <div className="editor-section-title">
            <span>6</span>
            <div>
              <h3>Публикация</h3>
              <p>В слайдер попадают только опубликованные карточки.</p>
            </div>
          </div>
          <div className="publication-controls">
            <label className="inline-check">
              <input
                type="checkbox"
                checked={profile.showOnHome}
                onChange={(event) => change('showOnHome', event.target.checked)}
              />{' '}
              Показывать на Главной
            </label>
            <label>
              Порядок
              <input
                type="number"
                min="0"
                max="9999"
                value={profile.sortOrder}
                onChange={(event) => change('sortOrder', Number(event.target.value) || 0)}
              />
            </label>
          </div>
          {!completeness.readyToPublish ? (
            <div className="notice warning">
              Для публикации:{' '}
              {completeness.missingFields
                .map((field) => completenessCopy[field] ?? field)
                .join(', ')}
              .
            </div>
          ) : null}
          {!parsed.success ? (
            <div className="notice danger">Проверьте формат заполненных полей.</div>
          ) : null}
          {props.error ? <div className="notice danger">{props.error}</div> : null}
          {props.message ? <div className="notice success">{props.message}</div> : null}
          <div className="location-editor-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={props.busy || !parsed.success}
              onClick={() => props.onSave('DRAFT')}
            >
              {props.busy ? 'Сохраняем…' : 'Сохранить черновик'}
            </button>
            {!isNew ? (
              <button
                className="secondary-button archive-button"
                type="button"
                disabled={props.busy || !parsed.success}
                onClick={() => props.onSave('ARCHIVED')}
              >
                В архив
              </button>
            ) : null}
            <button
              className="primary-button"
              type="button"
              disabled={props.busy || !parsed.success || !completeness.readyToPublish}
              onClick={() => props.onSave('PUBLISHED')}
            >
              Опубликовать
            </button>
          </div>
        </div>
      </div>
      <LocationPreview profile={profile} />
    </section>
  );
}

export function LocationsWorkspace({
  client,
}: {
  readonly client: LocationClient;
}): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>('stations');
  const [locations, setLocations] = useState<readonly LocationAdminView[]>([]);
  const [selected, setSelected] = useState<LocationAdminView>();
  const [profile, setProfile] = useState<LocationProfileInput>(() => emptyProfile());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let current = true;
    void client.listLocations().then(
      (result) => {
        if (!current) return;
        setLocations(result.items);
        setError(undefined);
        setLoading(false);
      },
      (loadError: unknown) => {
        if (!current) return;
        setError(errorMessage(loadError));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [client]);

  async function reload(preferredId: string): Promise<void> {
    setLoading(true);
    const result = await client.listLocations();
    setLocations(result.items);
    const preferred = result.items.find((location) => location.id === preferredId);
    if (preferred) {
      setSelected(preferred);
      setProfile(editableProfile(preferred));
    }
    setLoading(false);
  }

  const publishedCount = useMemo(
    () => locations.filter((location) => location.publicationStatus === 'PUBLISHED').length,
    [locations],
  );

  async function save(status: LocationPublicationStatus): Promise<void> {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const next = { ...profile, publicationStatus: status };
    try {
      const result = selected
        ? await client.updateLocation(selected.id, selected.version, next)
        : await client.createLocation(next);
      setSelected(result);
      setProfile(editableProfile(result));
      setMessage(
        status === 'PUBLISHED'
          ? 'Карточка опубликована.'
          : status === 'ARCHIVED'
            ? 'Карточка перемещена в архив.'
            : 'Черновик сохранён.',
      );
      await reload(result.id);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace location-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Настройки</p>
          <h1>Управление пространством</h1>
          <p className="muted">Редактирование карточек станций и порядка на Главной.</p>
        </div>
        <span className="environment-badge">{publishedCount} опубликовано</span>
      </header>
      <nav className="settings-tabs" aria-label="Вкладки настроек">
        <button
          className={tab === 'general' ? 'active' : ''}
          type="button"
          onClick={() => setTab('general')}
        >
          Общие настройки
        </button>
        <button
          className={tab === 'quick' ? 'active' : ''}
          type="button"
          onClick={() => setTab('quick')}
        >
          Быстрые ответы
        </button>
        <button
          className={tab === 'stations' ? 'active' : ''}
          type="button"
          onClick={() => setTab('stations')}
        >
          Станции
        </button>
      </nav>
      {tab !== 'stations' ? (
        <section className="panel settings-placeholder">
          <span>{tab === 'general' ? '⚙' : '↩'}</span>
          <h2>{tab === 'general' ? 'Общие настройки' : 'Быстрые ответы'}</h2>
          <p>Существующий раздел остаётся независимым от публичных карточек станций.</p>
        </section>
      ) : (
        <div className="location-settings-grid">
          <LocationListPanel
            locations={locations}
            {...(selected ? { selectedId: selected.id } : {})}
            query={query}
            onQuery={setQuery}
            onCreate={() => {
              setSelected(undefined);
              setProfile(emptyProfile());
              setError(undefined);
              setMessage(undefined);
            }}
            onSelect={(location) => {
              setSelected(location);
              setProfile(editableProfile(location));
              setError(undefined);
              setMessage(undefined);
            }}
          />
          {loading ? (
            <section className="panel settings-placeholder location-loading">
              <span className="loader" />
              <p>Загружаем станции…</p>
            </section>
          ) : (
            <LocationEditor
              {...(selected ? { selected } : {})}
              profile={profile}
              busy={busy}
              {...(message ? { message } : {})}
              {...(error ? { error } : {})}
              onChange={setProfile}
              onSave={(status) => void save(status)}
            />
          )}
        </div>
      )}
    </main>
  );
}
