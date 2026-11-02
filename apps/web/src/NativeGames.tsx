import { useEffect, useState } from 'react';
import type { PublicGameCardPage } from '@phub/api-sdk';
import type { AuthGateway } from './auth-gateway.js';
import { GameCard } from './GameCard.js';
export function NativeGames({ gateway }: { gateway: AuthGateway }) {
  const [page, setPage] = useState<PublicGameCardPage | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void gateway
      .listPublicGames({ availability: 'INCLUDE_FULL', limit: 20 })
      .then(
        (v) => {
          if (active) setPage(v);
        },
        () => {
          if (active) setError(true);
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [gateway, refresh]);
  async function next() {
    if (busy || !page?.nextCursor) return;
    const principal = gateway.quarterCreatePrincipal?.();
    setBusy(true);
    setError(false);
    try {
      const value = await gateway.listPublicGames({
        availability: 'INCLUDE_FULL',
        limit: 20,
        cursor: page.nextCursor,
      });
      if (principal && gateway.quarterCreatePrincipal?.() === principal)
        setPage({
          ...value,
          items: [
            ...page.items,
            ...value.items.filter((v) => !page.items.some((old) => old.id === v.id)),
          ],
        });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main aria-busy={busy}>
      <h1>Игры</h1>
      <a href="/games/new?quarterCreate=1">Создать игру по подписке</a>
      {page?.items.map((game) => (
        <GameCard key={game.id} game={game} readOnly />
      ))}
      {page?.items.length === 0 && <p>Открытых игр пока нет.</p>}
      {error && <p role="alert">Не удалось загрузить игры.</p>}
      {page?.nextCursor && (
        <button type="button" disabled={busy} onClick={() => void next()}>
          Показать ещё игры
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(false);
          setPage(null);
          setRefresh((v) => v + 1);
        }}
      >
        Обновить игры
      </button>
    </main>
  );
}
