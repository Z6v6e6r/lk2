import { useEffect, useMemo, useState } from 'react';

import type {
  CreateGiftCertificateOrderRequest,
  GiftCertificateOrder,
  GiftCertificateOrderCommandResult,
  GiftCertificatePaymentIntent,
  PublicGiftCertificateCatalog,
} from './auth-gateway.js';
import giftCardStackUrl from './assets/gift-certificates/gift-card-stack.webp';
import glassHeartUrl from './assets/gift-certificates/glass-heart.webp';
import heartCoinFlatUrl from './assets/gift-certificates/heart-coin-flat.webp';
import heartCoinSideUrl from './assets/gift-certificates/heart-coin-side.webp';
import { GiftCardNominalStep } from './GiftCardNominalStep.js';

export interface GiftCertificateSaleGateway {
  readonly getCatalog: () => Promise<PublicGiftCertificateCatalog>;
  readonly createOrder: (
    input: CreateGiftCertificateOrderRequest,
  ) => Promise<GiftCertificateOrderCommandResult>;
  readonly createPayment: (orderId: string) => Promise<GiftCertificatePaymentIntent>;
  readonly getOrder: (orderId: string) => Promise<GiftCertificateOrder>;
  readonly downloadCertificate: (orderId: string) => Promise<Blob>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestedOrderId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URL(window.location.href).searchParams.get('orderId');
  return value && UUID_PATTERN.test(value) ? value : undefined;
}

function rubles(amountMinor: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function scrollToStep(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    switch ((error as { readonly code?: unknown }).code) {
      case 'GIFT_CATALOG_VERSION_STALE':
      case 'GIFT_DESIGN_UNAVAILABLE':
      case 'GIFT_DENOMINATION_UNAVAILABLE':
        return 'Витрина обновилась. Перезагрузите страницу и выберите вариант ещё раз.';
      case 'GIFT_PAYMENT_SANDBOX_DISABLED':
        return 'Тестовая оплата сейчас выключена.';
      default:
        break;
    }
  }
  return 'Не удалось подготовить заказ. Проверьте данные и повторите.';
}

export function GiftCertificatesPage(props: {
  readonly gateway: GiftCertificateSaleGateway;
  readonly surface: 'public' | 'user';
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<PublicGiftCertificateCatalog | null>(null);
  const [audience, setAudience] = useState<'FOR_HER' | 'FOR_HIM'>('FOR_HER');
  const [designId, setDesignId] = useState('');
  const [denominationId, setDenominationId] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [message, setMessage] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<'IMMEDIATE' | 'SCHEDULED'>('IMMEDIATE');
  const [scheduledFor, setScheduledFor] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [payment, setPayment] = useState<GiftCertificatePaymentIntent | null>(null);
  const [order, setOrder] = useState<GiftCertificateOrderCommandResult | null>(null);
  const [recoveredOrder, setRecoveredOrder] = useState<GiftCertificateOrder | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void props.gateway.getCatalog().then(
      (loaded) => {
        if (!active) return;
        setCatalog(loaded);
        setDesignId(loaded.designs[0]?.id ?? '');
        setDenominationId(loaded.denominations[0]?.id ?? '');
        setLoading(false);
      },
      () => {
        if (!active) return;
        setError('Витрина сертификатов пока недоступна.');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [props.gateway]);

  useEffect(() => {
    const orderId = requestedOrderId();
    if (!orderId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
      try {
        const current = await props.gateway.getOrder(orderId);
        if (!active) return;
        setRecoveredOrder(current);
        attempts += 1;
        if (!current.fulfillment?.certificate.downloadReady && attempts < 60) {
          timer = setTimeout(() => void poll(), 1_000);
        }
      } catch {
        if (active)
          setError('Не удалось открыть оплаченный заказ. Проверьте ссылку или войдите снова.');
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [props.gateway]);

  async function downloadIssuedCertificate(): Promise<void> {
    if (!recoveredOrder?.fulfillment?.certificate.downloadReady) return;
    setDownloadBusy(true);
    setError(null);
    try {
      const blob = await props.gateway.downloadCertificate(recoveredOrder.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${recoveredOrder.fulfillment.certificate.certificateNumber}.pdf`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setError('Сертификат готов, но скачивание временно недоступно. Повторите ещё раз.');
    } finally {
      setDownloadBusy(false);
    }
  }

  const selectedDesign = useMemo(
    () => catalog?.designs.find((design) => design.id === designId),
    [catalog, designId],
  );
  const selectedDenomination = useMemo(
    () => catalog?.denominations.find((item) => item.id === denominationId),
    [catalog, denominationId],
  );
  const visibleDesigns = useMemo(
    () =>
      catalog?.designs.filter(
        (design) => design.audience === audience || design.audience === 'UNIVERSAL',
      ) ?? [],
    [audience, catalog],
  );

  function selectAudience(nextAudience: 'FOR_HER' | 'FOR_HIM'): void {
    setAudience(nextAudience);
    const nextDesigns =
      catalog?.designs.filter(
        (design) => design.audience === nextAudience || design.audience === 'UNIVERSAL',
      ) ?? [];
    if (!nextDesigns.some((design) => design.id === designId)) {
      setDesignId(nextDesigns[0]?.id ?? catalog?.designs[0]?.id ?? '');
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!catalog || !designId || !denominationId || !termsAccepted) return;
    setBusy(true);
    setError(null);
    try {
      const created = await props.gateway.createOrder({
        catalogId: catalog.id,
        designId,
        denominationId,
        buyerEmail,
        recipientName,
        recipientEmail,
        message: message.trim() || null,
        deliveryMode,
        scheduledFor:
          deliveryMode === 'SCHEDULED' && scheduledFor
            ? new Date(scheduledFor).toISOString()
            : null,
        termsAccepted: true,
      });
      setOrder(created);
      setPayment(await props.gateway.createPayment(created.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="gift-sale-shell gift-sale-state" aria-busy="true">
        <span className="loader" aria-hidden="true" />
        <h1>Загружаем сертификаты</h1>
      </main>
    );
  }
  if (!catalog) {
    return (
      <main className="gift-sale-shell gift-sale-state">
        <h1>Сертификаты недоступны</h1>
        <p role="alert">{error}</p>
        <a href={props.surface === 'user' ? '/' : 'https://padlhub.ru/'}>Вернуться</a>
      </main>
    );
  }

  return (
    <main className="gift-sale-shell">
      {props.surface === 'user' ? (
        <section className="gift-sale-mobile-intro">
          <header className="gift-sale-mobile-header">
            <a className="gift-sale-mobile-back" href="/" aria-label="Вернуться на Главную">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M15 5 8 12l7 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
            <h1>Подарочная карта</h1>
            <span className="gift-sale-mobile-header-spacer" aria-hidden="true" />
          </header>

          <section className="gift-sale-mobile-hero" aria-labelledby="gift-sale-mobile-description">
            <div className="gift-sale-mobile-visual">
              <img
                className="gift-sale-mobile-decor gift-sale-mobile-heart-top"
                src={glassHeartUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <img
                className="gift-sale-mobile-decor gift-sale-mobile-coin-top"
                src={heartCoinFlatUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <img
                className="gift-sale-mobile-decor gift-sale-mobile-coin-side"
                src={heartCoinSideUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <img
                className="gift-sale-mobile-decor gift-sale-mobile-heart-bottom"
                src={glassHeartUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <span className="gift-sale-mobile-plus" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path
                    d="M9 4v10M4 9h10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <img
                className="gift-sale-mobile-cards"
                src={giftCardStackUrl}
                alt="Пример двух подарочных карт ПадлХАБ"
                draggable={false}
                fetchPriority="high"
              />
            </div>

            <div className="gift-sale-mobile-content">
              <p id="gift-sale-mobile-description">
                Собери в конструкторе дизайн подарочной карты и порадуй своих близких
              </p>
              <button type="button" onClick={() => scrollToStep('gift-design-builder')}>
                Перейти к дизайну
              </button>
              <span className="gift-sale-mobile-chevron" aria-hidden="true">
                <svg width="32" height="18" viewBox="0 0 32 18" fill="none">
                  <path
                    d="M2 2l14 13L30 2"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
          </section>
        </section>
      ) : (
        <>
          <nav className="gift-sale-nav" aria-label="Навигация витрины сертификатов">
            <a href="https://padlhub.ru/" aria-label="Вернуться">
              <span aria-hidden="true">←</span>
            </a>
            <span className="gift-sale-nav-mark" aria-hidden="true">
              PH
            </span>
            <a href="/gift-certificates">Начать играть</a>
          </nav>

          <header className="gift-sale-header">
            <h1>
              Идеальный подарок <span className="gift-sale-title-gradient">без хлопот</span>
            </h1>
          </header>

          <section className="gift-sale-hero" aria-labelledby="gift-sale-hero-copy">
            <div className="gift-sale-hero-card" aria-hidden="true">
              {selectedDesign ? <img src={selectedDesign.imageUrl} alt="" /> : null}
            </div>
            <div className="gift-sale-hero-coin gift-sale-hero-coin--left" aria-hidden="true">
              ×
            </div>
            <div className="gift-sale-hero-coin gift-sale-hero-coin--right" aria-hidden="true">
              ×
            </div>
            <div className="gift-sale-hero-copy" id="gift-sale-hero-copy">
              <p>Соберите в конструкторе ниже дизайн подарочной карты и порадуйте своих близких</p>
              <a href="#gift-design-builder">Перейти к дизайну</a>
            </div>
          </section>
        </>
      )}

      {recoveredOrder ? (
        <section className="gift-sale-ready gift-sale-fulfillment" role="status">
          <div>
            <small>Заказ {recoveredOrder.orderNumber}</small>
            <strong>
              {recoveredOrder.fulfillment?.certificate.downloadReady
                ? `Сертификат ${recoveredOrder.fulfillment.certificate.certificateNumber} готов`
                : recoveredOrder.status === 'PAID'
                  ? 'Оплата подтверждена — выпускаем сертификат'
                  : 'Ожидаем подтверждение оплаты'}
            </strong>
            {recoveredOrder.fulfillment?.delivery ? (
              <span>
                Доставка:{' '}
                {recoveredOrder.fulfillment.delivery.status === 'SANDBOXED'
                  ? 'проверена в sandbox, письмо наружу не отправлялось'
                  : recoveredOrder.fulfillment.delivery.status === 'DELIVERED'
                    ? 'отправлено'
                    : recoveredOrder.fulfillment.delivery.status === 'FAILED'
                      ? 'нужна повторная отправка'
                      : 'в очереди'}
              </span>
            ) : null}
          </div>
          {recoveredOrder.fulfillment?.certificate.downloadReady ? (
            <button
              type="button"
              disabled={downloadBusy}
              onClick={() => void downloadIssuedCertificate()}
            >
              {downloadBusy ? 'Готовим файл…' : 'Скачать PDF'}
            </button>
          ) : (
            <span className="loader" aria-hidden="true" />
          )}
        </section>
      ) : null}

      <form className="gift-sale-form" onSubmit={(event) => void submit(event)}>
        <section className="gift-sale-builder" id="gift-design-builder">
          <header className="gift-sale-builder-header">
            <small>■ BL–02</small>
            <h2>Собери карту в 3 шага</h2>
            <span aria-hidden="true">＋</span>
          </header>

          <div className="gift-sale-audience-row">
            <span className="gift-sale-step-pill">01&nbsp;&nbsp;|&nbsp;&nbsp;Для кого</span>
            <div className="gift-sale-audience-tabs" role="group" aria-label="Для кого сертификат">
              <button
                type="button"
                className={audience === 'FOR_HER' ? 'is-selected' : ''}
                onClick={() => selectAudience('FOR_HER')}
              >
                Для неё
              </button>
              <button
                type="button"
                className={audience === 'FOR_HIM' ? 'is-selected' : ''}
                onClick={() => selectAudience('FOR_HIM')}
              >
                Для него
              </button>
            </div>
          </div>

          <div className="gift-sale-design-stage">
            {selectedDesign ? <img src={selectedDesign.imageUrl} alt={selectedDesign.alt} /> : null}
          </div>

          <footer className="gift-sale-builder-footer">
            <div className="gift-sale-design-picker" id="gift-design-step">
              <span className="gift-sale-step-pill">02&nbsp;&nbsp;|&nbsp;&nbsp;Дизайн</span>
              <div className="gift-sale-designs">
                {visibleDesigns.map((design) => (
                  <label className={design.id === designId ? 'is-selected' : ''} key={design.id}>
                    <input
                      type="radio"
                      name="design"
                      value={design.id}
                      checked={design.id === designId}
                      onChange={() => setDesignId(design.id)}
                    />
                    <img src={design.imageUrl} alt={design.alt} />
                    <span className="sr-only">{design.title}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="gift-sale-denomination-picker">
              <span className="gift-sale-step-pill">03&nbsp;&nbsp;|&nbsp;&nbsp;Номинал</span>
              <div className="gift-sale-denominations">
                {catalog.denominations.map((denomination) => (
                  <label
                    className={denomination.id === denominationId ? 'is-selected' : ''}
                    key={denomination.id}
                  >
                    <input
                      type="radio"
                      name="denomination"
                      value={denomination.id}
                      checked={denomination.id === denominationId}
                      onChange={() => setDenominationId(denomination.id)}
                    />
                    <strong>{rubles(denomination.amountMinor)}</strong>
                  </label>
                ))}
              </div>
            </div>
            <GiftCardNominalStep
              denominations={catalog.denominations}
              value={denominationId || null}
              onChange={setDenominationId}
            />
          </footer>
        </section>

        <section className="gift-sale-section gift-sale-checkout" id="gift-checkout-step">
          <div className="gift-sale-section-title">
            <span>04</span>
            <div>
              <small>Финальный шаг</small>
              <h2>Оформление карты</h2>
              <p>Укажите получателя — адреса защищены и не попадают в события или логи.</p>
            </div>
          </div>
          <div className="gift-sale-fields">
            <label>
              Ваша почта
              <input
                type="email"
                required
                value={buyerEmail}
                onChange={(event) => setBuyerEmail(event.target.value)}
                placeholder="buyer@example.ru"
              />
            </label>
            <label>
              Имя получателя
              <input
                required
                maxLength={120}
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
              />
            </label>
            <label>
              Почта получателя
              <input
                type="email"
                required
                value={recipientEmail}
                onChange={(event) => setRecipientEmail(event.target.value)}
                placeholder="recipient@example.ru"
              />
            </label>
            {catalog.flowSteps.includes('MESSAGE') ? (
              <label className="gift-sale-wide">
                Поздравление
                <textarea
                  maxLength={500}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
            ) : null}
            {catalog.flowSteps.includes('DELIVERY') && catalog.policy.scheduledDeliveryEnabled ? (
              <>
                <label>
                  Доставка
                  <select
                    value={deliveryMode}
                    onChange={(event) => {
                      const next = event.target.value as 'IMMEDIATE' | 'SCHEDULED';
                      setDeliveryMode(next);
                      if (next === 'IMMEDIATE') setScheduledFor('');
                    }}
                  >
                    <option value="IMMEDIATE">Сразу после выпуска</option>
                    <option value="SCHEDULED">В выбранное время</option>
                  </select>
                </label>
                {deliveryMode === 'SCHEDULED' ? (
                  <label>
                    Дата и время
                    <input
                      type="datetime-local"
                      required
                      value={scheduledFor}
                      onChange={(event) => setScheduledFor(event.target.value)}
                    />
                  </label>
                ) : null}
              </>
            ) : null}
          </div>
        </section>

        <aside className="gift-sale-summary" aria-label="Ваш выбор">
          {selectedDesign ? (
            <div className="gift-sale-summary-card">
              <img
                src={selectedDesign.imageUrl}
                alt={`${selectedDesign.alt}. Номинал ${
                  selectedDenomination ? rubles(selectedDenomination.amountMinor) : 'не выбран'
                }`}
              />
              <strong className="gift-sale-summary-card-amount" aria-hidden="true">
                {selectedDenomination ? rubles(selectedDenomination.amountMinor) : '—'}
              </strong>
            </div>
          ) : null}
          <div className="gift-sale-summary-copy">
            <small>Ваш выбор</small>
            <strong>{selectedDesign?.title ?? 'Дизайн'}</strong>
          </div>
          <strong className="gift-sale-summary-amount">
            {selectedDenomination ? rubles(selectedDenomination.amountMinor) : '—'}
          </strong>
        </aside>
        <label className="gift-sale-terms">
          <input
            type="checkbox"
            checked={termsAccepted}
            onChange={(event) => setTermsAccepted(event.target.checked)}
          />
          <span>Принимаю условия тестового оформления и обработку данных заказа.</span>
        </label>
        {error ? (
          <p className="gift-sale-error" role="alert">
            {error}
          </p>
        ) : null}
        {payment && order ? (
          <section className="gift-sale-ready" role="status">
            <div>
              <small>Заказ {order.orderNumber}</small>
              <strong>Сумма подтверждена сервером: {rubles(order.amountMinor)}</strong>
            </div>
            <a href={payment.nextAction.url}>Перейти к тестовой оплате</a>
          </section>
        ) : (
          <button type="submit" disabled={busy || !termsAccepted}>
            {busy ? 'Создаём заказ…' : 'Оформить тестовый заказ'}
          </button>
        )}
        <p className="gift-sale-sandbox-note">
          Сейчас оплата и email работают в локальном sandbox: деньги не списываются, а внешнее
          письмо не отправляется. После подтверждения создаётся приватный PDF для скачивания.
        </p>
      </form>
    </main>
  );
}
