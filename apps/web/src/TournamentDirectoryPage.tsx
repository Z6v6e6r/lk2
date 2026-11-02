import { useEffect, useMemo, useState } from 'react';
import type { PublicTournamentSummary } from '@phub/api-sdk';
import type { AuthGateway } from './auth-gateway.js';
import { TournamentSummaryCard } from './TournamentSummaryCard.js';
import { tournamentDetailRange } from './tournament-detail-range.js';
/** Concrete dated tournament discovery; does not open the mixed Event Catalog. */
export function TournamentDirectoryPage({
  gateway,
}: {
  gateway: Pick<AuthGateway, 'listPublicTournamentSummaries'>;
}) {
  const range = useMemo(() => tournamentDetailRange(), []),
    [items, setItems] = useState<readonly PublicTournamentSummary[] | null>(null),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    const list = gateway.listPublicTournamentSummaries;
    if (!list) {
      return () => {
        current = false;
      };
    }
    void list({ ...range, limit: 50, availability: 'INCLUDE_FULL' }).then(
      (page) => {
        if (current) {
          setItems(page.items);
          setError(false);
        }
      },
      () => {
        if (current) {
          setItems(null);
          setError(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [gateway, range, attempt]);
  return (
    <main className="games-page">
      <header>
        <a href="/">На главную</a>
        <h1>Турниры</h1>
        <p>Ближайшие 15 дней. Возможность записи проверяется в карточке.</p>
      </header>
      {error || !gateway.listPublicTournamentSummaries ? (
        <p role="alert">
          Не удалось загрузить турниры.{' '}
          <button type="button" onClick={() => setAttempt((x) => x + 1)}>
            Повторить
          </button>
        </p>
      ) : items === null ? (
        <p role="status">Загружаем турниры…</p>
      ) : items.length === 0 ? (
        <p>В выбранные дни турниров пока нет.</p>
      ) : (
        items.map((item) => (
          <TournamentSummaryCard
            key={item.id}
            tournament={{ ...item, route: `/tournaments?event=${encodeURIComponent(item.id)}` }}
          />
        ))
      )}
    </main>
  );
}
