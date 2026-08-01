import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { BookingActivityCard } from './BookingRecommendations.js';
import { MainBottomNavigation } from './HomeDashboardPage.js';
import type { BookingRecommendationActivity } from './booking-activity-kind.js';
import type { AuthGateway, TrainingSchedulePage } from './auth-gateway.js';

type TrainingLevelRangeFilter = 'ALL' | 'D_C_PLUS' | 'C_C_PLUS' | 'C_B_PLUS' | 'B_A';
type TrainingStartAfterFilter = 'ALL' | '18:00';

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
const trainingLevelOrder = new Map(
  (['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const).map((level, index) => [level, index]),
);

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function activityDateKey(activity: BookingRecommendationActivity): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: activity.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(activity.startsAt));
}

function activityStartsAfter(
  activity: BookingRecommendationActivity,
  startsAfter: TrainingStartAfterFilter,
): boolean {
  if (startsAfter === 'ALL') return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: activity.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(activity.startsAt));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute >= 18 * 60;
}

function activityMatchesLevel(
  activity: BookingRecommendationActivity,
  levelRange: TrainingLevelRangeFilter,
): boolean {
  const selectedRange = levelRangeFilters[levelRange];
  if (!selectedRange) return true;
  const activityRange = activity.levelRange;
  if (!activityRange?.from || !activityRange.to) return false;
  const selectedFrom = trainingLevelOrder.get(selectedRange.from);
  const selectedTo = trainingLevelOrder.get(selectedRange.to);
  const activityFrom = trainingLevelOrder.get(activityRange.from);
  const activityTo = trainingLevelOrder.get(activityRange.to);
  if (
    selectedFrom === undefined ||
    selectedTo === undefined ||
    activityFrom === undefined ||
    activityTo === undefined
  ) {
    return false;
  }
  return activityTo >= selectedFrom && activityFrom <= selectedTo;
}

function categoryKey(activity: BookingRecommendationActivity): string {
  return activity.category?.id ?? `title:${activity.title.toLocaleLowerCase('ru-RU')}`;
}

function categoryName(activity: BookingRecommendationActivity): string {
  return activity.category?.name ?? activity.title;
}

function mergeActivities(
  current: readonly BookingRecommendationActivity[],
  page: TrainingSchedulePage,
): readonly BookingRecommendationActivity[] {
  const activities = page.items.filter((activity) => activity.kind === 'TRAINING');
  return [
    ...new Map([...current, ...activities].map((activity) => [activity.id, activity])).values(),
  ].sort(
    (left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
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
  const [activities, setActivities] = useState<readonly BookingRecommendationActivity[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<readonly string[]>([]);
  const [selectedStationIds, setSelectedStationIds] = useState<readonly string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [levelRange, setLevelRange] = useState<TrainingLevelRangeFilter>('ALL');
  const [startsAfter, setStartsAfter] = useState<TrainingStartAfterFilter>('ALL');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    let active = true;
    void gateway.listTrainingSchedule().then(
      (page) => {
        if (!active) return;
        setActivities((current) => mergeActivities(current, page));
        setError(null);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setActivities([]);
        setError('Групповые тренировки временно недоступны. Попробуйте обновить страницу.');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  const categories = useMemo(
    () =>
      [
        ...new Map(
          activities.map((activity) => [
            categoryKey(activity),
            { id: categoryKey(activity), name: categoryName(activity) },
          ]),
        ).values(),
      ].sort((left, right) => left.name.localeCompare(right.name, 'ru-RU')),
    [activities],
  );
  const stations = useMemo(
    () =>
      [
        ...new Map(
          activities.map((activity) => [
            activity.station.id,
            { id: activity.station.id, name: activity.station.name },
          ]),
        ).values(),
      ].sort((left, right) => left.name.localeCompare(right.name, 'ru-RU')),
    [activities],
  );
  const selectedCategories = useMemo(
    () => categories.filter((category) => selectedCategoryIds.includes(category.id)),
    [categories, selectedCategoryIds],
  );
  const selectedStations = useMemo(
    () => stations.filter((station) => selectedStationIds.includes(station.id)),
    [selectedStationIds, stations],
  );
  const visibleActivities = useMemo(
    () =>
      activities.filter(
        (activity) =>
          (selectedDate === null || activityDateKey(activity) === selectedDate) &&
          (selectedCategoryIds.length === 0 ||
            selectedCategoryIds.includes(categoryKey(activity))) &&
          (selectedStationIds.length === 0 || selectedStationIds.includes(activity.station.id)) &&
          activityStartsAfter(activity, startsAfter) &&
          activityMatchesLevel(activity, levelRange),
      ),
    [activities, levelRange, selectedCategoryIds, selectedDate, selectedStationIds, startsAfter],
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
    setSelectedCategoryIds((current) =>
      current.includes(categoryId)
        ? current.filter((item) => item !== categoryId)
        : [...current, categoryId],
    );
  }

  function toggleStation(stationId: string): void {
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
        {!loading ? <span>{visibleActivities.length}</span> : null}
      </div>

      {error ? (
        <p className="games-message is-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="games-list trainings-list" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="games-loading" role="status">
            Загружаем групповые тренировки…
          </div>
        ) : null}
        {!loading && visibleActivities.length === 0 ? (
          <div className="games-empty">
            <span aria-hidden="true">◌</span>
            <h2>Подходящих тренировок пока нет</h2>
            <p>Смените дату, тип, станцию или уровень.</p>
          </div>
        ) : null}
        {visibleActivities.map((activity) => (
          <BookingActivityCard activity={activity} key={activity.id} />
        ))}
      </section>

      <MainBottomNavigation active="games" gamesDestination="games" />
    </main>
  );
}
