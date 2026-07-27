import type { ProfileLevelHistory } from './auth-gateway.js';

const LEVELS = ['A', 'B+', 'B', 'C+', 'C', 'D+', 'D'] as const;
const CHART_WIDTH = 335;
const CHART_HEIGHT = 238;
const PLOT_LEFT = 38;
const PLOT_RIGHT = 318;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 188;

function BackIcon(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m15 18-6-6 6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function chartDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
  })
    .format(new Date(value))
    .replace('.', '');
}

function fullDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function levelY(level: string): number {
  const index = Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]));
  return PLOT_TOP + (index / (LEVELS.length - 1)) * (PLOT_BOTTOM - PLOT_TOP);
}

function pointX(index: number, count: number, times: readonly number[]): number {
  if (count <= 1) return (PLOT_LEFT + PLOT_RIGHT) / 2;
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? first;
  if (last <= first) return PLOT_LEFT + (index / (count - 1)) * (PLOT_RIGHT - PLOT_LEFT);
  return (
    PLOT_LEFT + (((times[index] ?? first) - first) / (last - first)) * (PLOT_RIGHT - PLOT_LEFT)
  );
}

function LevelHistoryChart({
  items,
}: {
  readonly items: ProfileLevelHistory['items'];
}): React.JSX.Element {
  const times = items.map((item) => Date.parse(item.changedAt));
  const points = items.map((item, index) => ({
    ...item,
    x: pointX(index, items.length, times),
    y: levelY(item.levelLabel),
  }));
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const labelIndexes =
    points.length <= 2
      ? points.map((_, index) => index)
      : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  return (
    <svg
      className="profile-level-history-chart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label="График изменения уровня: дата по горизонтали, уровень по вертикали"
    >
      <title>История изменения уровня</title>
      <desc>Дата расположена по оси X, уровень игрока — по оси Y.</desc>
      {LEVELS.map((level) => {
        const y = levelY(level);
        return (
          <g key={level}>
            <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} />
            <text x={PLOT_LEFT - 9} y={y + 3} textAnchor="end">
              {level}
            </text>
          </g>
        );
      })}
      <line
        className="profile-level-history-chart__axis"
        x1={PLOT_LEFT}
        x2={PLOT_RIGHT}
        y1={PLOT_BOTTOM}
        y2={PLOT_BOTTOM}
      />
      {points.length > 1 ? <path className="profile-level-history-chart__line" d={path} /> : null}
      {points.map((point) => (
        <g key={`${point.changedAt}-${point.levelLabel}`}>
          <circle className="profile-level-history-chart__halo" cx={point.x} cy={point.y} r="7" />
          <circle className="profile-level-history-chart__point" cx={point.x} cy={point.y} r="4" />
        </g>
      ))}
      {labelIndexes.map((index) => {
        const point = points[index];
        if (!point) return null;
        return (
          <text
            className="profile-level-history-chart__date"
            key={point.changedAt}
            x={point.x}
            y={PLOT_BOTTOM + 24}
            textAnchor={
              index === 0 && points.length > 1
                ? 'start'
                : index === points.length - 1 && points.length > 1
                  ? 'end'
                  : 'middle'
            }
          >
            {chartDate(point.changedAt)}
          </text>
        );
      })}
      <text
        className="profile-level-history-chart__axis-label"
        x={(PLOT_LEFT + PLOT_RIGHT) / 2}
        y={CHART_HEIGHT - 4}
        textAnchor="middle"
      >
        дата
      </text>
      <text
        className="profile-level-history-chart__axis-label"
        x="9"
        y={(PLOT_TOP + PLOT_BOTTOM) / 2}
        textAnchor="middle"
        transform={`rotate(-90 9 ${(PLOT_TOP + PLOT_BOTTOM) / 2})`}
      >
        уровень
      </text>
    </svg>
  );
}

export function ProfileLevelHistoryPage({
  history,
  error,
}: {
  readonly history: ProfileLevelHistory | null;
  readonly error?: string | null;
}): React.JSX.Element {
  const current = history?.items.at(-1);

  return (
    <div className="profile-level-history-shell">
      <main className="profile-level-history-page">
        <header className="profile-level-history-toolbar">
          <a href="/profile" aria-label="Назад в профиль">
            <BackIcon />
          </a>
          <span>Профиль игрока</span>
        </header>

        <section className="profile-level-history-hero">
          <p>динамика игрока</p>
          <h1>История уровня</h1>
          <small>Дата по оси X · уровень по оси Y</small>
          {current ? (
            <div>
              <span>текущий уровень</span>
              <strong>{current.levelLabel}</strong>
            </div>
          ) : null}
        </section>

        <div className="profile-level-history-content">
          <section
            className="profile-level-history-card"
            aria-labelledby="level-history-chart-title"
          >
            <header>
              <div>
                <h2 id="level-history-chart-title">Изменение уровня</h2>
                <p>Точки добавляются после подтверждённых изменений рейтинга</p>
              </div>
              {history ? <span>{history.items.length}</span> : null}
            </header>
            {error ? (
              <p className="profile-level-history-state" role="alert">
                {error}
              </p>
            ) : !history ? (
              <p className="profile-level-history-state" role="status">
                Загружаем историю…
              </p>
            ) : history.items.length === 0 ? (
              <p className="profile-level-history-state">
                История появится после первого зафиксированного изменения уровня.
              </p>
            ) : (
              <LevelHistoryChart items={history.items} />
            )}
          </section>

          {history && history.items.length > 0 ? (
            <section
              className="profile-level-history-events"
              aria-labelledby="level-history-events"
            >
              <h2 id="level-history-events">Изменения</h2>
              {[...history.items].reverse().map((item) => (
                <article key={`${item.changedAt}-${item.levelLabel}`}>
                  <span>{fullDate(item.changedAt)}</span>
                  <strong>{item.levelLabel}</strong>
                </article>
              ))}
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
