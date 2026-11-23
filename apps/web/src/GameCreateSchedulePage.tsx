import { useEffect, useMemo, useState } from 'react';
import type { AuthGateway } from './auth-gateway.js';
import {
  GameCreateScheduleWizard,
  type GameCreateScheduleCheckout,
  type GameCreateScheduleSource,
} from './GameCreateScheduleWizard.js';

export function GameCreateSchedulePage({
  gateway,
  checkout,
}: {
  readonly gateway: AuthGateway;
  readonly checkout?: GameCreateScheduleCheckout;
}) {
  const [locations, setLocations] = useState<
    Awaited<ReturnType<AuthGateway['listLocations']>>['items'] | null
  >(null);
  const [unavailable, setUnavailable] = useState(false);
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
        <a href="/games">К списку игр</a>
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
      {...(checkout ? { checkout } : {})}
    />
  );
}
