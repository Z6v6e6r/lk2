import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { BookingActivityCard } from './BookingRecommendations.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';
import type {
  AuthGateway,
  EventCatalogItem,
  EventCatalogPage,
  EventCatalogQuery,
} from './auth-gateway.js';
import { usePaginatedEventSearch } from './usePaginatedEventSearch.js';

type TrainingLevelRangeFilter = 'ALL' | 'D_C_PLUS' | 'C_C_PLUS' | 'C_B_PLUS' | 'B_A';
type TrainingStartAfterFilter = 'ALL' | '18:00';
type TrainingCatalogItem = Extract<EventCatalogItem, { readonly activity: unknown }>;

const levelRangeFilters = {
  ALL: null,
  D_C_PLUS: { from: 'D', to: 'C+' },
  C_C_PLUS: { from: 'C', to: 'C+' },
  C_B_PLUS: { from: 'C', to: 'B+' },
  B_A: { from: 'B', to: 'A' },
} as const;

const levelRangeLabels: Readonly<Record<TrainingLevelRangeFilter, string>> = {
  ALL: 'Любой уровень',
  D_C_PLUS: 'D–C+',
  C_C_PLUS: 'C–C+',
  C_B_PLUS: 'C–B+',
  B_A: 'B–A',
};

const weekdayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dayFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit' });
type EventCatalogMetadata = Pick<
  EventCatalogPage,
  'state' | 'totalMatched' | 'facets' | 'sourceStatus'
>;

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isExpiredCatalogCursor(error: Error | null): boolean {
  return (
    error !== null &&
    'code' in error &&
    (error as Error & { readonly code?: string }).code === 'CATALOG_CURSOR_EXPIRED'
  );
}

function FilterCategoryIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="12" y="2.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="2.5" y="12" width="5.5" height="5.5" rx="1.2" />
      <rect x="12" y="12" width="5.5" height="5.5" rx="1.2" />
    </svg>
  );
}

function FilterStationIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M16.5 8.3c0 4.5-6.5 9.2-6.5 9.2S3.5 12.8 3.5 8.3a6.5 6.5 0 1 1 13 0Z" />
      <circle cx="10" cy="8" r="2.2" />
    </svg>
  );
}

function FilterSlidersIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M2.5 5h6M12.5 5h5M2.5 15h4M10.5 15h7M2.5 10h10M16.5 10h1" />
      <circle cx="10.5" cy="5" r="2" />
      <circle cx="8.5" cy="15" r="2" />
      <circle cx="14.5" cy="10" r="2" />
    </svg>
  );
}

function MultiSelectFilter({
  ariaLabel,
  icon,
  options,
  selectedValues,
  summary,
  onToggle,
}: {
  readonly ariaLabel: string;
  readonly icon: React.JSX.Element;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly selectedValues: readonly string[];
  readonly summary: string;
  readonly onToggle: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDocumentClick = (event: MouseEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="games-multiselect" ref={rootRef}>
      <button
        className="games-multiselect__trigger"
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span>{summary}</span>
        <span className="games-filter-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open ? (
        <div className="games-multiselect__menu" id={menuId} role="group" aria-label={ariaLabel}>
          {options.length > 0 ? (
            options.map((option) => (
              <label key={option.value}>
                <input
                  type="checkbox"
                  checked={selectedValues.includes(option.value)}
                  onChange={() => onToggle(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))
          ) : (
            <span className="trainings-filter-empty">Появятся после загрузки расписания</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export interface TrainingsPageProps {
  readonly gateway: AuthGateway;
  readonly individualTrainingRoute?: string;
}

export function TrainingsPage({
  gateway,
  individualTrainingRoute = '/coaches',
}: TrainingsPageProps): React.JSX.Element {
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<readonly string[]>([]);
  const [selectedStationIds, setSelectedStationIds] = useState<readonly string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [levelRange, setLevelRange] = useState<TrainingLevelRangeFilter>('ALL');
  const [startsAfter, setStartsAfter] = useState<TrainingStartAfterFilter>('ALL');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [categoryLabels, setCategoryLabels] = useState<Readonly<Record<string, string>>>({});
  const [stationLabels, setStationLabels] = useState<Readonly<Record<string, string>>>({});

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + index);
        return {
          key: dateKey(date),
          day: dayFormatter.format(date),
          weekday: weekdayFormatter.format(date).replace('.', ''),
        };
      }),
    [],
  );

  const catalogQuery = useMemo<EventCatalogQuery>(() => {
    const selectedRange = levelRangeFilters[levelRange];
    return {
      surface: 'TRAININGS',
      localDates: selectedDate ? [selectedDate] : days.map((day) => day.key),
      kinds: ['COACH_GAME', 'GROUP_TRAINING', 'SPLIT'],
      ...(selectedCategoryIds.length > 0 ? { categoryIds: [...selectedCategoryIds].sort() } : {}),
      ...(selectedStationIds.length > 0 ? { stationIds: [...selectedStationIds].sort() } : {}),
      availability: 'INCLUDE_FULL',
      ...(selectedRange ? { levelFrom: selectedRange.from, levelTo: selectedRange.to } : {}),
      ...(startsAfter === 'ALL' ? {} : { startsAfterLocal: startsAfter }),
      limit: 20,
    };
  }, [days, levelRange, selectedCategoryIds, selectedDate, selectedStationIds, startsAfter]);
  const queryKey = useMemo(() => JSON.stringify(catalogQuery), [catalogQuery]);
  const loadCatalogPage = useCallback(
    async (query: EventCatalogQuery, request: { readonly cursor?: string }) => {
      const page = request.cursor
        ? await gateway.continueEventCatalog(request.cursor, query.limit)
        : await gateway.listEventCatalog(query);
      return {
        items: page.items.filter((item): item is TrainingCatalogItem => 'activity' in item),
        nextCursor: page.nextCursor,
        metadata: {
          state: page.state,
          totalMatched: page.totalMatched,
          facets: page.facets,
          sourceStatus: page.sourceStatus,
        } satisfies EventCatalogMetadata,
      };
    },
    [gateway],
  );
  const {
    items,
    nextCursor,
    metadata,
    loading,
    loadingMore,
    error,
    errorPhase,
    loadMore,
    retry,
    restart,
  } = usePaginatedEventSearch<EventCatalogQuery, TrainingCatalogItem, EventCatalogMetadata>({
    queryKey,
    query: catalogQuery,
    loadPage: loadCatalogPage,
    itemKey: (item) => `${item.kind}:${item.activity.id}`,
  });
  const activities = useMemo(() => items.map((item) => item.activity), [items]);
  const cursorExpired = errorPhase === 'more' && isExpiredCatalogCursor(error);

  const categories = useMemo(
    () => metadata?.facets?.categories ?? [],
    [metadata?.facets?.categories],
  );
  const stations = useMemo(() => metadata?.facets?.stations ?? [], [metadata?.facets?.stations]);
  const selectedCategories = useMemo(
    () =>
      selectedCategoryIds.map((id) => {
        const option = categories.find((category) => category.id === id);
        return option ?? { id, name: categoryLabels[id] ?? 'Тип тренировки' };
      }),
    [categories, categoryLabels, selectedCategoryIds],
  );
  const selectedStations = useMemo(
    () =>
      selectedStationIds.map((id) => {
        const option = stations.find((station) => station.id === id);
        return option ?? { id, name: stationLabels[id] ?? 'Станция' };
      }),
    [selectedStationIds, stationLabels, stations],
  );
  const activeFilterCount =
    Number(selectedCategoryIds.length > 0) +
    Number(selectedStationIds.length > 0) +
    Number(levelRange !== 'ALL') +
    Number(startsAfter !== 'ALL');
  const categorySummary =
    selectedCategories.length === 0
      ? 'Все типы'
      : selectedCategories.length === 1
        ? (selectedCategories[0]?.name ?? 'Тип')
        : `Типы: ${selectedCategories.length}`;
  const stationSummary =
    selectedStations.length === 0
      ? 'Все станции'
      : selectedStations.length === 1
        ? (selectedStations[0]?.name ?? 'Станция')
        : `Станции: ${selectedStations.length}`;

  function toggleCategory(categoryId: string): void {
    const option = categories.find((category) => category.id === categoryId);
    if (option) setCategoryLabels((current) => ({ ...current, [categoryId]: option.name }));
    setSelectedCategoryIds((current) =>
      current.includes(categoryId)
        ? current.filter((item) => item !== categoryId)
        : [...current, categoryId],
    );
  }

  function toggleStation(stationId: string): void {
    const option = stations.find((station) => station.id === stationId);
    if (option) setStationLabels((current) => ({ ...current, [stationId]: option.name }));
    setSelectedStationIds((current) =>
      current.includes(stationId)
        ? current.filter((item) => item !== stationId)
        : [...current, stationId],
    );
  }

  function resetFilters(): void {
    setSelectedCategoryIds([]);
    setSelectedStationIds([]);
    setLevelRange('ALL');
    setStartsAfter('ALL');
  }

  return (
    <main className="games-page trainings-page">
      <header className="games-header">
        <a className="games-back" href="/" aria-label="На Главную">
          ←
        </a>
        <div>
          <span>ПаделХАБ</span>
          <h1>Тренировки</h1>
        </div>
        <span className="games-header__spacer" aria-hidden="true" />
      </header>

      <a
        className="games-create-hero trainings-individual-hero"
        href={individualTrainingRoute}
        aria-label="Индивидуальные тренировки"
      >
        <strong>Индивидуальные тренировки</strong>
        <span>Выберите тренера и удобное время</span>
      </a>

      <section className="games-filters" aria-label="Фильтры групповых тренировок">
        <div className="games-date-rail" aria-label="Выбор даты">
          <button
            className={selectedDate === null ? 'is-active' : undefined}
            type="button"
            aria-pressed={selectedDate === null}
            onClick={() => {
              setSelectedDate(null);
              setStartsAfter('ALL');
            }}
          >
            <strong>Все</strong>
            <span>даты</span>
          </button>
          {days.map((day) => (
            <button
              className={selectedDate === day.key ? 'is-active' : undefined}
              type="button"
              key={day.key}
              aria-pressed={selectedDate === day.key}
              onClick={() => setSelectedDate(day.key)}
            >
              <strong>{day.day}</strong>
              <span>{day.weekday}</span>
            </button>
          ))}
        </div>

        <div className="games-filter-panel">
          <div className="games-filter-primary trainings-filter-primary">
            <MultiSelectFilter
              ariaLabel="Типы тренировок"
              icon={<FilterCategoryIcon />}
              options={categories.map((category) => ({
                value: category.id,
                label: category.name,
              }))}
              selectedValues={selectedCategoryIds}
              summary={categorySummary}
              onToggle={toggleCategory}
            />
            <MultiSelectFilter
              ariaLabel="Станции"
              icon={<FilterStationIcon />}
              options={stations.map((station) => ({
                value: station.id,
                label: station.name,
              }))}
              selectedValues={selectedStationIds}
              summary={stationSummary}
              onToggle={toggleStation}
            />
          </div>

          <div className="games-filter-actions">
            <button
              className="games-filter-more"
              type="button"
              aria-expanded={filtersOpen}
              aria-controls="trainings-advanced-filters"
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <FilterSlidersIcon />
              Все фильтры · {activeFilterCount}
            </button>
            <button
              className="games-filter-reset"
              type="button"
              disabled={activeFilterCount === 0}
              onClick={resetFilters}
            >
              Сбросить всё
            </button>
          </div>

          {filtersOpen ? (
            <div className="games-filter-advanced" id="trainings-advanced-filters">
              <label className="games-filter-field">
                <span className="games-filter-label">Время начала</span>
                <span className="games-filter-select">
                  <select
                    aria-label="Время начала"
                    value={startsAfter}
                    onChange={(event) =>
                      setStartsAfter(event.target.value as TrainingStartAfterFilter)
                    }
                  >
                    <option value="ALL">Любое время</option>
                    <option value="18:00">После 18:00</option>
                  </select>
                  <span className="games-filter-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </span>
              </label>
              <label className="games-filter-field">
                <span className="games-filter-label">Уровень игроков</span>
                <span className="games-filter-select">
                  <select
                    aria-label="Уровень игроков"
                    value={levelRange}
                    onChange={(event) =>
                      setLevelRange(event.target.value as TrainingLevelRangeFilter)
                    }
                  >
                    {(Object.keys(levelRangeLabels) as TrainingLevelRangeFilter[]).map((value) => (
                      <option value={value} key={value}>
                        {levelRangeLabels[value]}
                      </option>
                    ))}
                  </select>
                  <span className="games-filter-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {activeFilterCount > 0 ? (
            <div className="games-filter-chips" aria-label="Выбранные фильтры">
              {selectedCategories.map((category) => (
                <button
                  type="button"
                  aria-label={`Убрать фильтр ${category.name}`}
                  key={category.id}
                  onClick={() => toggleCategory(category.id)}
                >
                  {category.name} <span>×</span>
                </button>
              ))}
              {selectedStations.map((station) => (
                <button
                  type="button"
                  aria-label={`Убрать фильтр ${station.name}`}
                  key={station.id}
                  onClick={() => toggleStation(station.id)}
                >
                  {station.name} <span>×</span>
                </button>
              ))}
              {startsAfter !== 'ALL' ? (
                <button
                  type="button"
                  aria-label="Убрать фильтр После 18:00"
                  onClick={() => setStartsAfter('ALL')}
                >
                  После 18:00 <span>×</span>
                </button>
              ) : null}
              {levelRange !== 'ALL' ? (
                <button
                  type="button"
                  aria-label={`Убрать фильтр Уровень ${levelRangeLabels[levelRange]}`}
                  onClick={() => setLevelRange('ALL')}
                >
                  Уровень {levelRangeLabels[levelRange]} <span>×</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <div className="trainings-list-heading">
        <h2>Групповые тренировки</h2>
        {!loading && metadata?.state === 'READY' ? <span>{metadata.totalMatched}</span> : null}
      </div>

      {error ? (
        <p className="games-message is-error" role="alert">
          Групповые тренировки временно недоступны.{' '}
          <button type="button" onClick={() => void (cursorExpired ? restart() : retry())}>
            {cursorExpired ? 'Обновить список' : 'Повторить'}
          </button>
        </p>
      ) : null}

      {metadata?.state === 'PARTIAL' ? (
        <p className="games-message is-error" role="status">
          Показаны не все тренировки: часть расписания временно недоступна. Попробуйте обновить
          список.{' '}
          <button type="button" onClick={() => void restart()}>
            Обновить список
          </button>
        </p>
      ) : null}

      <section className="games-list trainings-list" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="games-loading" role="status">
            Загружаем групповые тренировки…
          </div>
        ) : null}
        {!loading && !error && metadata?.state === 'READY' && activities.length === 0 ? (
          <div className="games-empty">
            <span aria-hidden="true">◌</span>
            <h2>Подходящих тренировок пока нет</h2>
            <p>Смените дату, тип, станцию или уровень.</p>
          </div>
        ) : null}
        {activities.map((activity) => (
          <BookingActivityCard activity={activity} key={activity.id} />
        ))}
        {nextCursor ? (
          <button
            className="games-load-more"
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore
              ? 'Загружаем…'
              : errorPhase === 'more'
                ? 'Повторить загрузку'
                : 'Показать ещё'}
          </button>
        ) : null}
      </section>

      <MainBottomNavigation active="games" gamesDestination="games" />
    </main>
  );
}
