import { useState } from 'react';

import { EventCalendarIcon, EventLocationIcon } from './ActivityCardIcons.js';
import type { HomeUpcomingItem } from './HomeDashboardPage.js';
import { ParticipantAvatarStack } from './ParticipantAvatarStack.js';
import { GameTypeBadge } from './GameTypeBadge.js';
import type { GameDetailTab } from './GameDetailView.js';

/** A booking snapshot owns presentation only; commands require a canonical game. */
export function UpcomingGameDetailView({
  item,
}: {
  readonly item: HomeUpcomingItem;
}): React.JSX.Element {
  const [tab, setTab] = useState<GameDetailTab>('GAME');
  const participants = item.participants ?? [];
  const rosterAvailable =
    item.roster?.state !== 'UNAVAILABLE' &&
    (item.participants !== undefined || item.openSlots !== undefined);
  const capacity =
    item.roster?.capacity ??
    (item.participants !== undefined && item.openSlots !== undefined
      ? participants.length + item.openSlots
      : undefined);
  const format = (value: string, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat('ru-RU', options).format(new Date(value));
  const date = format(item.startsAt, { day: 'numeric', month: 'long', weekday: 'short' });
  const timeOptions = { hour: '2-digit', minute: '2-digit' } as const;
  const time = `с ${format(item.startsAt, timeOptions)}${item.endsAt ? ` до ${format(item.endsAt, timeOptions)}` : ''}`;
  const station = item.game?.station?.title ?? item.venue;
  const location = item.game?.courtName ? `${station} · ${item.game.courtName}` : station;
  const status =
    item.status === 'waitlist'
      ? 'Вы в листе ожидания'
      : item.status === 'payment_required'
        ? 'Требуется оплата'
        : 'Запись подтверждена';

  return (
    <section className="game-detail" aria-label="Карточка игры">
      <section className="game-match-summary" aria-label="Основная информация об игре">
        {item.game?.type ? (
          <GameTypeBadge type={item.game.type} />
        ) : (
          <span className="fh-event__tag game-match-summary__tag">
            <span className="fh-event__tag-label">Игра</span>
          </span>
        )}
        <h2 className="activity-card-title">{item.title}</h2>
        <div className="game-match-summary__metadata">
          <span className="activity-card-metadata-row">
            <EventCalendarIcon />
            <time dateTime={item.startsAt}>
              {date}, {time}
            </time>
          </span>
          <span className="activity-card-metadata-row">
            <EventLocationIcon />
            <span>{location}</span>
          </span>
        </div>
        <span className="game-match-summary__divider" aria-hidden="true" />
      </section>
      <div className="game-detail-tab-section">
        <div className="game-detail-tabs" role="tablist" aria-label="Разделы матча">
          {(['GAME', 'RESULT'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className={tab === value ? 'is-active' : undefined}
              aria-selected={tab === value}
              aria-controls={`upcoming-game-panel-${value.toLowerCase()}`}
              onClick={() => setTab(value)}
            >
              {value === 'GAME' ? 'Игра' : 'Результат'}
            </button>
          ))}
        </div>
        {tab === 'GAME' ? (
          <div
            className="game-detail-panel"
            role="tabpanel"
            aria-label="Игра"
            id="upcoming-game-panel-game"
          >
            <section
              className="game-detail-card game-detail-players"
              aria-labelledby="upcoming-game-players-title"
            >
              <h2 className="sr-only" id="upcoming-game-players-title">
                Участники игры
              </h2>
              {rosterAvailable ? (
                <>
                  {capacity !== undefined && item.participants !== undefined ? (
                    <div className="game-detail-players__summary">
                      <div
                        className="game-detail-players__scale"
                        role="progressbar"
                        aria-label="Заполненность игры"
                        aria-valuemin={0}
                        aria-valuemax={capacity}
                        aria-valuenow={participants.length}
                        aria-valuetext={`${participants.length} из ${capacity} мест занято`}
                      >
                        {Array.from({ length: capacity }, (_, index) => (
                          <span
                            key={index}
                            className={index < participants.length ? 'is-filled' : undefined}
                            aria-hidden="true"
                          />
                        ))}
                      </div>
                      <div className="game-detail-players__labels">
                        <span className="game-detail-players__count">
                          {participants.length}/{capacity}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {item.roster?.state === 'STALE' ? (
                    <p className="game-detail-state">Состав требует обновления</p>
                  ) : null}
                  <div className="game-detail-players__list">
                    {participants.map((participant, index) => {
                      const content = (
                        <>
                          <ParticipantAvatarStack
                            capacity={1}
                            ariaLabel={participant.displayName}
                            participants={[
                              {
                                key: participant.profileId ?? String(index),
                                displayName: participant.displayName,
                                avatarUrl: participant.avatarUrl ?? null,
                                level: participant.level ?? null,
                                levelValue: participant.levelValue ?? null,
                              },
                            ]}
                          />
                          <span className="game-detail-player__name">
                            <strong>{participant.displayName}</strong>
                          </span>
                        </>
                      );
                      return (
                        <div
                          className="game-detail-player"
                          key={participant.profileId ?? String(index)}
                        >
                          {participant.profileId ? (
                            <a
                              className="game-detail-player__profile"
                              href={`/profile/${encodeURIComponent(participant.profileId)}`}
                            >
                              {content}
                            </a>
                          ) : (
                            content
                          )}
                        </div>
                      );
                    })}
                    {Array.from({ length: item.openSlots ?? 0 }, (_, index) => (
                      <div className="game-detail-player is-open" key={`open-${index}`}>
                        <ParticipantAvatarStack
                          ariaLabel="Свободное место"
                          capacity={1}
                          participants={[]}
                        />
                        <span className="game-detail-player__name">
                          <strong>Свободное место</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="game-detail-state" role="status">
                  Состав временно недоступен
                </p>
              )}
            </section>
            <section
              className="game-detail-card game-detail-format"
              aria-labelledby="upcoming-game-lineup-title"
            >
              <header>
                <h2 id="upcoming-game-lineup-title">Стартовый состав</h2>
              </header>
              <p className="game-detail-state">Стартовый состав пока недоступен</p>
            </section>
            <div className="game-detail-actions">
              <p className="game-detail-state">{status}</p>
            </div>
          </div>
        ) : (
          <div
            className="game-detail-panel"
            role="tabpanel"
            aria-label="Результат"
            id="upcoming-game-panel-result"
          >
            <section className="game-detail-card game-detail-result" aria-label="Результат матча">
              <div className="game-detail-result__empty">
                <strong>Результат пока недоступен</strong>
              </div>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
