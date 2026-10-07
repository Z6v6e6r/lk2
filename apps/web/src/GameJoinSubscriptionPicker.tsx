import { useEffect, useId, useState } from 'react';
import type { AuthGateway, HomeDashboard } from './auth-gateway.js';
import './GameJoinSubscriptionPicker.css';

type Subscription = Pick<HomeDashboard['subscriptions'][number], 'id' | 'title'>;
type State = {
  gateway: Pick<AuthGateway, 'getHomeDashboard'>;
  status: 'loading' | 'error' | 'ready';
  items: readonly Subscription[];
};
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Titles are display only; the server decides ownership, applicability and price. */
export function GameJoinSubscriptionPicker(props: {
  readonly gateway: Pick<AuthGateway, 'getHomeDashboard'>;
  readonly value?: string;
  readonly onChange: (canonicalSubscriptionId: string | undefined) => void;
}): React.JSX.Element {
  const id = useId();
  const { gateway } = props;
  const [state, setState] = useState<State>({ gateway, status: 'loading', items: [] });
  const [retry, setRetry] = useState(0);
  const current = state.gateway === gateway ? state : { status: 'loading', items: [] };
  useEffect(() => {
    let disposed = false;
    void gateway
      .getHomeDashboard()
      .then((dashboard) => {
        if (disposed) return;
        const subscriptions = new Map<string, Subscription>();
        for (const item of dashboard.subscriptions) {
          if (canonicalUuid.test(item.id) && !subscriptions.has(item.id)) {
            subscriptions.set(item.id, { id: item.id, title: item.title });
          }
        }
        const items = [...subscriptions.values()];
        setState({ gateway, status: 'ready', items });
      })
      .catch(() => {
        if (!disposed) setState({ gateway, status: 'error', items: [] });
      });
    return () => {
      disposed = true;
    };
  }, [gateway, retry]);

  return (
    <section
      className="game-detail-card game-join-subscription-picker"
      aria-labelledby={`${id}-title`}
      aria-busy={current.status === 'loading'}
    >
      <h2 id={`${id}-title`}>Подписка для проверки</h2>
      {current.status === 'loading' ? <p role="status">Загружаем ваши подписки…</p> : null}
      {current.status === 'error' ? <p role="alert">Не удалось загрузить ваши подписки.</p> : null}
      {current.status === 'error' || retry > 0 ? (
        <button
          type="button"
          aria-disabled={current.status === 'loading'}
          onClick={() => {
            if (current.status === 'loading') return;
            props.onChange(undefined);
            setState({ gateway, status: 'loading', items: [] });
            setRetry((value) => value + 1);
          }}
        >
          {current.status === 'ready' ? 'Обновить список подписок' : 'Повторить загрузку подписок'}
        </button>
      ) : null}
      {current.status === 'ready' && current.items.length === 0 ? (
        <p>Нет подписок для проверки.</p>
      ) : null}
      {current.status === 'ready' && current.items.length > 0 ? (
        <label htmlFor={id}>
          Выберите подписку
          <select
            id={id}
            value={props.value ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              props.onChange(current.items.some((item) => item.id === value) ? value : undefined);
            }}
          >
            <option value="">Выберите подписку</option>
            {current.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}
