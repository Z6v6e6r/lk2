import { useEffect, useMemo, useRef, useState } from 'react';
import type { HomeRecommendationPromotionDeck } from '@phub/home-projection';

import './RecommendationAdvertisingCard.css';

type Promotion = HomeRecommendationPromotionDeck['items'][number];

export function RecommendationAdvertisingCard({
  item: initialItem,
  deck,
  kind,
  layout,
  photoGrid = false,
  onEngagement,
}: {
  readonly item: Promotion;
  readonly deck?: HomeRecommendationPromotionDeck | null | undefined;
  readonly kind: 'strip' | 'card';
  readonly layout: 'compact' | 'vertical';
  readonly photoGrid?: boolean;
  readonly onEngagement?: (promotionId: string, kind: 'IMPRESSION' | 'CLICK') => unknown;
}): React.JSX.Element {
  const items = useMemo(
    () => (deck?.items.length ? deck.items : [initialItem]),
    [deck, initialItem],
  );
  const [selectedId, setSelectedId] = useState(initialItem.id);
  const item = items.find((candidate) => candidate.id === selectedId) ?? items[0]!;
  const activeIndex = Math.max(
    0,
    items.findIndex((candidate) => candidate.id === item.id),
  );
  const rootRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const impression = useRef<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const rotating = deck?.rotationEnabled === true && items.length > 1;
  const intervalSeconds = deck?.intervalSeconds ?? 6;
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!preference) return;
    const update = (): void => setReducedMotion(preference.matches);
    preference.addEventListener?.('change', update);
    return () => preference.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    const handleVisibility = (): void => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    const element = rootRef.current;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) =>
              setVisible(
                entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5),
              ),
            { threshold: 0.5 },
          );
    if (element) observer?.observe(element);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
  useEffect(() => {
    if (!visible || !documentVisible) {
      impression.current = null;
      return;
    }
    if (impression.current === item.id || !onEngagement) return;
    impression.current = item.id;
    void Promise.resolve(onEngagement(item.id, 'IMPRESSION')).catch(() => undefined);
  }, [visible, documentVisible, item.id, onEngagement]);
  useEffect(() => {
    if (!rotating || paused || hovered || focused || reducedMotion || !visible || !documentVisible)
      return;
    const timer = window.setTimeout(() => {
      setSelectedId(items[(activeIndex + 1) % items.length]!.id);
    }, intervalSeconds * 1_000);
    return () => window.clearTimeout(timer);
  }, [
    rotating,
    paused,
    hovered,
    focused,
    reducedMotion,
    visible,
    documentVisible,
    intervalSeconds,
    items,
    activeIndex,
  ]);
  const cardImageUrl =
    layout === 'compact'
      ? (item.squareImageUrl ?? item.mobileImageUrl ?? item.imageUrl)
      : (item.horizontalImageUrl ?? item.imageUrl ?? item.mobileImageUrl);
  const imageUrl = kind === 'card' ? cardImageUrl : (item.imageUrl ?? item.mobileImageUrl);
  const figmaLayout = photoGrid && layout === 'compact';

  return (
    <article
      ref={rootRef}
      className={`booking-recommendation-ad is-${kind} is-${layout}`}
      data-recommendation-ad-kind={kind}
      data-photo-grid-ad={figmaLayout || undefined}
      aria-label={`Рекламный блок: ${kind === 'card' ? 'карточка' : 'баннер'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <a
        href={item.route}
        aria-label={`Реклама: ${item.title}`}
        onClick={() => {
          if (onEngagement)
            void Promise.resolve(onEngagement(item.id, 'CLICK')).catch(() => undefined);
        }}
      >
        <picture aria-hidden="true">
          {kind === 'strip' && item.mobileImageUrl ? (
            <source media="(max-width: 480px)" srcSet={item.mobileImageUrl} />
          ) : null}
          {imageUrl ? <img src={imageUrl} alt="" /> : null}
        </picture>
        {figmaLayout ? (
          <span className="recommendation-ad-artwork">
            <span className="recommendation-ad-artwork__badge">
              <svg width="7" height="10" viewBox="0 0 7 10" fill="currentColor" aria-hidden="true">
                <path d="M4.5 0 0 5.5h2.7L2.5 10 7 4.5H4.3L4.5 0Z" />
              </svg>
              {item.badgeText ?? 'Акция'}
            </span>
            {!imageUrl ? <strong>{item.title}</strong> : null}
            {item.footerText ? (
              <span className="recommendation-ad-artwork__footer">{item.footerText}</span>
            ) : null}
          </span>
        ) : kind === 'card' ? (
          <span className="booking-recommendation-ad__content">
            {item.badgeText ? (
              <span className="booking-recommendation-ad__badge">{item.badgeText}</span>
            ) : null}
            {layout === 'compact' && imageUrl ? null : <strong>{item.title}</strong>}
            {item.footerText ? (
              <span className="booking-recommendation-ad__footer">{item.footerText}</span>
            ) : null}
          </span>
        ) : (
          <strong className="booking-recommendation-ad__strip-title">{item.title}</strong>
        )}
      </a>
      {items.length > 1 ? (
        <div className="recommendation-ad-controls" aria-label="Слайды рекламы">
          <div className="recommendation-ad-controls__dots">
            {items.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                aria-label={`Слайд ${index + 1}: ${candidate.title}`}
                aria-pressed={candidate.id === item.id}
                onClick={() => {
                  setSelectedId(candidate.id);
                  setPaused(true);
                }}
              >
                <span />
              </button>
            ))}
          </div>
          {rotating && !reducedMotion ? (
            <button
              type="button"
              className="recommendation-ad-controls__pause"
              aria-label={paused ? 'Продолжить смену рекламы' : 'Приостановить смену рекламы'}
              onClick={() => setPaused((current) => !current)}
            >
              {paused ? '▶' : 'Ⅱ'}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
