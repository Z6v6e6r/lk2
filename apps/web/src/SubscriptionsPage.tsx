import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';

import type { HomeDashboard } from './auth-gateway.js';
import friendshipBadge from './assets/subscriptions/friendship-badge.png';
import raBadge from './assets/subscriptions/ra-badge.png';
import academyBadge from './assets/subscriptions/academy-badge.png';
import energyBadge from './assets/subscriptions/energy-badge.png';
import kidsBadge from './assets/subscriptions/kids-padel-badge.png';
import './SubscriptionsPage.css';

type Subscription = HomeDashboard['subscriptions'][number];
type Snapshot = Pick<HomeDashboard, 'subscriptions'> & {
  readonly generatedAt: string;
  readonly staleAt: string;
};
interface SubscriptionsPageProps {
  readonly loadDashboard: () => Promise<Pick<HomeDashboard, 'subscriptions' | 'snapshot'>>;
  readonly subscriptionId?: string;
  readonly onNavigate?: (href: string, method: 'push' | 'back' | 'replace') => void;
}
const statusLabels: Record<Subscription['status'], string> = {
  active: 'Активен',
  scheduled: 'Ожидает начала',
  paused: 'Приостановлен',
  exhausted: 'Исчерпан',
  expired: 'Истёк',
};
// Exact titles choose decoration only; they never determine type, units or entitlements.
const badges = new Map([
  ['дружба', { src: friendshipBadge, box: [124, 164, 1924, 385] }],
  ['ра', { src: raBadge, box: [532, 189, 1106, 344] }],
  ['академия', { src: academyBadge, box: [124, 195, 1924, 325] }],
  ['энергия', { src: energyBadge, box: [118, 191, 1937, 322] }],
  ['дети падел', { src: kidsBadge, box: [167, 222, 1838, 297] }],
]);
function PlanTitle({ item }: { readonly item: Subscription }): React.JSX.Element {
  const artwork = badges.get(item.title.trim().toLocaleLowerCase('ru-RU'));
  if (!artwork) return <span>{item.title}</span>;
  const [x = 0, y = 0, width = 1, height = 1] = artwork.box;
  return (
    <span className="subscriptions-badge" style={{ aspectRatio: width / height }}>
      <img
        src={artwork.src}
        alt={item.title}
        style={{
          width: `${(2172 / width) * 100}%`,
          left: `${(-x / width) * 100}%`,
          top: `${(-y / height) * 100}%`,
        }}
      />
    </span>
  );
}
function remaining(item: Subscription): string {
  if (item.remainingUnits === 0 && item.status !== 'exhausted') return 'Не подтверждён';
  return String(item.remainingUnits);
}
function dateLabel(value: string, includeTime = false): string {
  return new Date(value).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    ...(includeTime ? { timeStyle: 'short' as const } : {}),
  });
}
function PlanFacts({ item }: { readonly item: Subscription }): React.JSX.Element {
  return (
    <dl className="subscriptions-facts">
      <div>
        <dt>Остаток</dt>
        <dd>{remaining(item)}</dd>
      </div>
      <div>
        <dt>Действует до</dt>
        <dd>
          {item.validUntil ? (
            <time dateTime={item.validUntil}>{dateLabel(item.validUntil)}</time>
          ) : (
            'Срок не указан'
          )}
        </dd>
      </div>
    </dl>
  );
}
export function SubscriptionsPage({
  loadDashboard,
  subscriptionId,
  onNavigate,
}: SubscriptionsPageProps): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    loader: typeof loadDashboard;
    snapshot: Snapshot | null;
    loading: boolean;
    error: boolean;
  }>({ loader: loadDashboard, snapshot: null, loading: true, error: false });
  const request = useRef(0);
  const locked = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const lastOpened = useRef<string | null>(null);
  const listScroll = useRef(0);
  const visible =
    state.loader === loadDashboard ? state : { snapshot: null, loading: true, error: false };
  const selected = subscriptionId
    ? visible.snapshot?.subscriptions.find(
        (item) => item.id.toLowerCase() === subscriptionId.toLowerCase(),
      )
    : undefined;

  useEffect(() => {
    let active = true;
    const current = ++request.current;
    locked.current = true;
    void Promise.resolve()
      .then(loadDashboard)
      .then(
        (dashboard) => {
          if (!active || request.current !== current) return;
          setState({
            loader: loadDashboard,
            snapshot: {
              subscriptions: dashboard.subscriptions,
              generatedAt: dashboard.snapshot.generatedAt,
              staleAt: dashboard.snapshot.staleAt,
            },
            loading: false,
            error: false,
          });
          locked.current = false;
        },
        () => {
          if (!active || request.current !== current) return;
          setState((previous) => ({
            loader: loadDashboard,
            snapshot: previous.loader === loadDashboard ? previous.snapshot : null,
            loading: false,
            error: true,
          }));
          locked.current = false;
        },
      );
    return () => {
      active = false;
    };
  }, [loadDashboard, revision]);

  useEffect(() => {
    const previousLink =
      !subscriptionId && lastOpened.current ? links.current.get(lastOpened.current) : undefined;
    if (previousLink) {
      previousLink.focus({ preventScroll: true });
      window.scrollTo({ top: listScroll.current });
    } else {
      heading.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  }, [subscriptionId]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string, id?: string): void {
    if (
      !onNavigate ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (id) {
      lastOpened.current = id;
      listScroll.current = window.scrollY;
    }
    onNavigate(href, id ? 'push' : lastOpened.current === subscriptionId ? 'back' : 'replace');
  }
  function refresh(): void {
    if (locked.current) return;
    locked.current = true;
    setState((previous) => ({ ...previous, loading: true, error: false }));
    setRevision((value) => value + 1);
  }
  return (
    <main className="subscriptions-page" aria-labelledby="subscriptions-title">
      <header className="subscriptions-header">
        <a
          className="subscriptions-back"
          href={subscriptionId ? '/subscriptions' : '/profile'}
          aria-label={subscriptionId ? 'Назад к абонементам' : 'Вернуться в профиль'}
          onClick={subscriptionId ? (event) => navigate(event, '/subscriptions') : undefined}
        >
          ‹
        </a>
        <h1 id="subscriptions-title" ref={heading} tabIndex={-1}>
          {subscriptionId ? (selected?.title ?? 'Абонемент') : 'Мои абонементы'}
        </h1>
        <button
          className="subscriptions-refresh"
          type="button"
          onClick={refresh}
          disabled={visible.loading}
          aria-label="Обновить подборку абонементов"
        >
          {visible.loading ? 'Обновляем…' : 'Обновить'}
        </button>
      </header>
      <aside className="subscriptions-coverage" role="note">
        <strong>Текущая подборка</strong>
        <p>
          Здесь показано до 6 абонементов с Главной. Это неполный список: другие ваши абонементы
          могут не отображаться.
        </p>
      </aside>
      <section
        className="subscriptions-content"
        aria-busy={visible.loading}
        aria-label={subscriptionId ? 'Детали абонемента' : 'Подборка абонементов'}
      >
        {visible.loading ? (
          <p className="subscriptions-message" role="status">
            {visible.snapshot ? 'Обновляем подборку…' : 'Загружаем абонементы…'}
          </p>
        ) : null}
        {visible.error ? (
          <p className="subscriptions-message subscriptions-error" role="alert">
            Не удалось загрузить абонементы. Попробуйте обновить подборку.
            {visible.snapshot ? ' Ниже показана предыдущая подборка.' : ''}
          </p>
        ) : null}
        {visible.snapshot ? (
          <>
            <p className="subscriptions-snapshot">
              Подборка сформирована{' '}
              <time dateTime={visible.snapshot.generatedAt}>
                {dateLabel(visible.snapshot.generatedAt, true)}
              </time>
              . Срок актуальности —{' '}
              <time dateTime={visible.snapshot.staleAt}>
                {dateLabel(visible.snapshot.staleAt, true)}
              </time>
              .
            </p>
            {subscriptionId ? (
              selected ? (
                <article className="subscriptions-details">
                  <div
                    className="subscriptions-card"
                    data-plan={selected.title.trim().toLocaleLowerCase('ru-RU')}
                  >
                    <div className="subscriptions-card-heading">
                      <PlanTitle item={selected} />
                      <span className="subscriptions-status">{statusLabels[selected.status]}</span>
                    </div>
                    <PlanFacts item={selected} />
                  </div>
                  <section className="subscriptions-description" aria-label="Условия абонемента">
                    <h2>Информация об абонементе</h2>
                    <dl>
                      <div>
                        <dt>Тип</dt>
                        <dd>Не указан</dd>
                      </div>
                      <div>
                        <dt>Единица остатка</dt>
                        <dd>Не указана</dd>
                      </div>
                    </dl>
                    {selected.remainingUnits === 0 && selected.status !== 'exhausted' ? (
                      <p>Точный остаток не подтверждён. Это не означает, что абонемент исчерпан.</p>
                    ) : null}
                  </section>
                </article>
              ) : !visible.loading && !visible.error ? (
                <p className="subscriptions-message">
                  Этого абонемента нет в текущей подборке. Вернитесь к списку или обновите подборку.
                </p>
              ) : null
            ) : visible.snapshot.subscriptions.length ? (
              <ul className="subscriptions-list">
                {visible.snapshot.subscriptions.map((item) => {
                  const href = `/subscriptions/${item.id}`;
                  return (
                    <li key={item.id}>
                      <a
                        className="subscriptions-card"
                        data-plan={item.title.trim().toLocaleLowerCase('ru-RU')}
                        href={href}
                        aria-label={`Открыть абонемент ${item.title}`}
                        ref={(element) => {
                          if (element) links.current.set(item.id, element);
                          else links.current.delete(item.id);
                        }}
                        onClick={(event) => navigate(event, href, item.id)}
                      >
                        <div className="subscriptions-card-heading">
                          <h2>
                            <PlanTitle item={item} />
                          </h2>
                          <span className="subscriptions-status">{statusLabels[item.status]}</span>
                        </div>
                        <PlanFacts item={item} />
                        <span className="subscriptions-card-foot">
                          Единица остатка не указана <span aria-hidden="true">›</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : !visible.loading && !visible.error ? (
              <p className="subscriptions-message">В текущей подборке нет абонементов.</p>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
