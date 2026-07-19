import type { BookingRecommendationPage } from './auth-gateway.js';
import { GameCard } from './GameCard.js';

const reasonLabels: Readonly<
  Record<BookingRecommendationPage['items'][number]['reasons'][number], string>
> = {
  LEVEL_MATCH: 'Подходит по уровню',
  FAVORITE_STATION: 'Любимая станция',
  PLAYED_STATION: 'Вы часто играете здесь',
  PREFERRED_TIME: 'В удобное время',
  USUAL_TIME: 'В привычное время',
  AVAILABLE_SOON: 'Ближайшая доступная игра',
};

export function BookingRecommendations({
  page,
  compact = false,
}: {
  readonly page: BookingRecommendationPage;
  readonly compact?: boolean;
}): React.JSX.Element {
  if (page.items.length === 0) {
    return (
      <div className="booking-recommendations-empty" role="status">
        <strong>Пока нет подходящих игр</strong>
        <p>Настройте любимые станции и удобное время или загляните позже.</p>
        <a href="/profile#booking-preferences-title">Настроить предпочтения</a>
      </div>
    );
  }

  return (
    <div className={compact ? 'booking-recommendations is-compact' : 'booking-recommendations'}>
      {page.items.map((item) => (
        <section className="booking-recommendation" key={item.game.id}>
          <div className="booking-recommendation__reasons" aria-label="Почему игра подходит">
            {item.reasons.map((reason) => (
              <span key={reason}>{reasonLabels[reason]}</span>
            ))}
          </div>
          <GameCard game={item.game} compact={compact} />
        </section>
      ))}
    </div>
  );
}
