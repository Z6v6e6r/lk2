import { useEffect, useMemo, useState } from 'react';
import type { AuthGateway } from './auth-gateway.js';
import {
  GameCreateScheduleWizard,
  type GameCreateScheduleCheckout,
  type GameCreateScheduleSource,
} from './GameCreateScheduleWizard.js';

const freeGameHref = '/games/new?view=legacy&new=1';
const quarterHref = '/games/new?quarterCreate=1';

export function GameCreateSchedulePage({
  gateway,
  checkout,
  android = false,
}: {
  readonly gateway: AuthGateway;
  readonly checkout?: GameCreateScheduleCheckout;
  readonly android?: boolean;
}) {
  const [locations, setLocations] = useState<
    Awaited<ReturnType<AuthGateway['listLocations']>>['items'] | null
  >(null);
  const [unavailable, setUnavailable] = useState(false);
  const loadFriends = useMemo(
    () => async () =>
      (await gateway.listProfileFriends(24)).items.map((friend) => ({
        id: friend.userId,
        name: friend.displayName,
        avatarUrl: friend.avatarUrl,
      })),
    [gateway],
  );
  const source = useMemo<GameCreateScheduleSource | null>(() => {
    if (!gateway.listGameCreateSlots || !gateway.getGameCreateScheduleQuote) return null;
    return {
      listSlots: async (input) => (await gateway.listGameCreateSlots!(input)).slots,
      readQuote: async (input) => (await gateway.getGameCreateScheduleQuote!(input)).quote,
    };
  }, [gateway]);

  useEffect(() => {
    let active = true;
    void gateway.listLocations().then(
      (response) => {
        if (active) setLocations(response.items);
      },
      () => {
        if (active) setUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  if (!source || unavailable) {
    return (
      <main className="games-page games-page--create">
        <h1>Создать игру</h1>
        <p role="alert">Расписание ЛК1 недоступно.</p>
        {checkout ? <a href={freeGameHref}>Создать игру без бронирования</a> : null}
        {android ? <a href={quarterHref}>Создать игру по подписке</a> : null}
        <a href={android ? '/' : '/games'}>К списку игр</a>
      </main>
    );
  }
  if (!locations) {
    return (
      <main className="games-page games-page--create">
        <h1>Создать игру</h1>
        <p role="status">Загружаем станции…</p>
      </main>
    );
  }
  return (
    <GameCreateScheduleWizard
      stations={locations}
      source={source}
      {...(checkout ? { checkout, loadFriends, freeGameHref } : {})}
      {...(android ? { quarterHref, gamesHref: '/' } : {})}
    />
  );
}
