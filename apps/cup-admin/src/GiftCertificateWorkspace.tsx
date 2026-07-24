import { ApiClientError } from '@phub/api-sdk';
import {
  giftCertificateCatalogInputSchema,
  type GiftCertificateCatalogInput,
  type GiftCertificateCatalogView,
  type GiftCertificateFlowStep,
} from '@phub/gift-certificates';
import { useEffect, useMemo, useState } from 'react';

import type { NotificationAdminClient } from './notification-admin-client.js';

const flowStepCopy: Readonly<Record<GiftCertificateFlowStep, string>> = {
  RECIPIENT_KIND: 'Кому подарок',
  DESIGN: 'Дизайн',
  DENOMINATION: 'Номинал',
  MESSAGE: 'Поздравление',
  DELIVERY: 'Доставка',
  REVIEW: 'Проверка заказа',
};

const allFlowSteps = Object.keys(flowStepCopy) as GiftCertificateFlowStep[];
const requiredFlowSteps = new Set<GiftCertificateFlowStep>(['DESIGN', 'DENOMINATION', 'REVIEW']);

const initialCatalog: GiftCertificateCatalogInput = {
  title: 'Подарочные сертификаты ПаделХАБ',
  publicEnabled: false,
  availableFrom: null,
  availableTo: null,
  flowSteps: ['RECIPIENT_KIND', 'DESIGN', 'DENOMINATION', 'MESSAGE', 'DELIVERY', 'REVIEW'],
  policy: {
    validityStart: 'ISSUE',
    validityDays: 365,
    activationDeadlineDays: null,
    scheduledDeliveryEnabled: true,
    emailAttachmentEnabled: true,
  },
  designs: [
    {
      key: 'classic',
      audience: 'UNIVERSAL',
      title: 'Классический',
      description: null,
      imageUrl: '',
      alt: 'Подарочный сертификат ПаделХАБ',
      codeXPercent: 5.1,
      codeYPercent: 88,
      amountXPercent: 78.3,
      amountYPercent: 88,
      active: true,
      sortOrder: 10,
    },
  ],
  denominations: [
    { amountMinor: 300_000, currency: 'RUB', active: true, sortOrder: 10 },
    { amountMinor: 500_000, currency: 'RUB', active: true, sortOrder: 20 },
    { amountMinor: 10_000_00, currency: 'RUB', active: true, sortOrder: 30 },
  ],
};

function toCatalogInput(catalog: GiftCertificateCatalogView): GiftCertificateCatalogInput {
  return {
    title: catalog.title,
    publicEnabled: catalog.publicEnabled,
    availableFrom: catalog.availableFrom,
    availableTo: catalog.availableTo,
    flowSteps: [...catalog.flowSteps],
    policy: { ...catalog.policy },
    designs: catalog.designs.map(({ id, ...design }) => {
      void id;
      return design;
    }),
    denominations: catalog.denominations.map(({ id, ...denomination }) => {
      void id;
      return denomination;
    }),
  };
}

function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Не удалось выполнить операцию.';
}

function validationText(catalog: GiftCertificateCatalogInput): readonly string[] {
  const parsed = giftCertificateCatalogInputSchema.safeParse(catalog);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 5).map((issue) => issue.message);
  }
  const issues: string[] = [];
  if (!catalog.designs.some((design) => design.active)) {
    issues.push('Нужен хотя бы один активный дизайн.');
  }
  if (!catalog.denominations.some((denomination) => denomination.active)) {
    issues.push('Нужен хотя бы один активный номинал.');
  }
  return issues;
}

export function GiftCertificateWorkspace(props: {
  readonly client: NotificationAdminClient;
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<GiftCertificateCatalogInput>(initialCatalog);
  const [catalogId, setCatalogId] = useState<string>();
  const [revision, setRevision] = useState<number | null>(null);
  const [published, setPublished] = useState<GiftCertificateCatalogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'publish' | `upload-${number}`>();
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const issues = useMemo(() => validationText(catalog), [catalog]);
  const missingFlowSteps = allFlowSteps.filter((step) => !catalog.flowSteps.includes(step));
  const previewDesign = catalog.designs.find((design) => design.active) ?? catalog.designs[0];
  const previewDenomination =
    catalog.denominations.find((denomination) => denomination.active) ?? catalog.denominations[0];

  useEffect(() => {
    void props.client
      .getGiftCertificateCatalogState()
      .then((state) => {
        setPublished(state.published);
        const editable = state.draft ?? state.published;
        if (editable) {
          setCatalog(toCatalogInput(editable));
          if (state.draft) {
            setCatalogId(state.draft.id);
            setRevision(state.draft.revision);
          }
        }
      })
      .catch((loadError: unknown) => setError(errorText(loadError)))
      .finally(() => setLoading(false));
  }, [props.client]);

  function change(next: GiftCertificateCatalogInput): void {
    setCatalog(next);
    setDirty(true);
    setMessage(undefined);
  }

  async function save(): Promise<void> {
    const parsed = giftCertificateCatalogInputSchema.safeParse(catalog);
    if (!parsed.success) {
      setError('Исправьте ошибки в настройках перед сохранением.');
      return;
    }
    setBusy('save');
    setError(undefined);
    setMessage(undefined);
    try {
      const saved = await props.client.saveGiftCertificateCatalogDraft(revision, parsed.data);
      setCatalog(toCatalogInput(saved));
      setCatalogId(saved.id);
      setRevision(saved.revision);
      setDirty(false);
      setMessage(saved.replayed ? 'Черновик уже был сохранён.' : 'Черновик сохранён.');
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(undefined);
    }
  }

  async function publish(): Promise<void> {
    if (!catalogId || revision === null || dirty || issues.length > 0) return;
    setBusy('publish');
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await props.client.publishGiftCertificateCatalogDraft(catalogId, revision);
      setPublished(result);
      setCatalog(toCatalogInput(result));
      setCatalogId(undefined);
      setRevision(null);
      setDirty(false);
      setMessage('Каталог опубликован и доступен витрине.');
    } catch (publishError) {
      setError(errorText(publishError));
    } finally {
      setBusy(undefined);
    }
  }

  function moveFlowStep(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= catalog.flowSteps.length) return;
    const flowSteps = [...catalog.flowSteps];
    const current = flowSteps[index];
    const replacement = flowSteps[target];
    if (!current || !replacement) return;
    flowSteps[index] = replacement;
    flowSteps[target] = current;
    change({ ...catalog, flowSteps });
  }

  async function uploadDesign(index: number, file: File): Promise<void> {
    setBusy(`upload-${index}`);
    setError(undefined);
    setMessage(undefined);
    try {
      const asset = await props.client.uploadGiftCertificateMedia(file);
      change({
        ...catalog,
        designs: catalog.designs.map((design, designIndex) =>
          designIndex === index ? { ...design, imageUrl: asset.mediaUrl } : design,
        ),
      });
      setMessage(asset.replayed ? 'Изображение уже было загружено.' : 'Изображение загружено.');
    } catch (uploadError) {
      setError(errorText(uploadError));
    } finally {
      setBusy(undefined);
    }
  }

  if (loading) {
    return (
      <main className="workspace">
        <section className="panel gift-loading">Загружаем настройки сертификатов…</section>
      </main>
    );
  }

  return (
    <main className="workspace gift-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Коммерция · LOCAL_PRIMARY</p>
          <h1>Подарочные сертификаты</h1>
          <p className="muted">
            Настройте витрину, номиналы и правила. Заказы доступны только в локальном sandbox.
          </p>
        </div>
        <div className="gift-statuses">
          <span className={`environment-badge ${published ? 'published' : ''}`}>
            {published ? `Опубликовано · v${published.catalogNumber}` : 'Не опубликовано'}
          </span>
          {dirty ? <span className="draft-badge">Есть изменения</span> : null}
        </div>
      </header>

      <section className="gift-layout">
        <div className="gift-editor-stack">
          <section className="panel editor-section">
            <div className="section-heading compact">
              <div>
                <h2>Основные настройки</h2>
                <p>Публичный флаг применяется только после публикации версии.</p>
              </div>
            </div>
            <div className="gift-form-grid">
              <label className="span-two">
                Заголовок витрины
                <input
                  value={catalog.title}
                  onChange={(event) => change({ ...catalog, title: event.target.value })}
                />
              </label>
              <label>
                Доступен с · ISO 8601
                <input
                  value={catalog.availableFrom ?? ''}
                  placeholder="2026-12-01T00:00:00+03:00"
                  onChange={(event) =>
                    change({ ...catalog, availableFrom: event.target.value.trim() || null })
                  }
                />
              </label>
              <label>
                Доступен до · ISO 8601
                <input
                  value={catalog.availableTo ?? ''}
                  placeholder="Без ограничения"
                  onChange={(event) =>
                    change({ ...catalog, availableTo: event.target.value.trim() || null })
                  }
                />
              </label>
              <label className="gift-toggle span-two">
                <input
                  type="checkbox"
                  checked={catalog.publicEnabled}
                  onChange={(event) => change({ ...catalog, publicEnabled: event.target.checked })}
                />
                <span>
                  <strong>Показывать опубликованную версию на витрине</strong>
                  <small>Черновик никогда не отображается пользователям.</small>
                </span>
              </label>
            </div>
          </section>

          <section className="panel editor-section">
            <div className="section-heading compact">
              <div>
                <h2>Срок действия</h2>
                <p>Правило фиксируется в версии каталога и позже попадёт в выданный сертификат.</p>
              </div>
            </div>
            <div className="gift-form-grid">
              <label>
                Отсчёт срока
                <select
                  value={catalog.policy.validityStart}
                  onChange={(event) => {
                    const validityStart = event.target.value as 'ISSUE' | 'ACTIVATION';
                    change({
                      ...catalog,
                      policy: {
                        ...catalog.policy,
                        validityStart,
                        activationDeadlineDays:
                          validityStart === 'ACTIVATION'
                            ? (catalog.policy.activationDeadlineDays ?? 90)
                            : null,
                      },
                    });
                  }}
                >
                  <option value="ISSUE">С момента оплаты</option>
                  <option value="ACTIVATION">С момента активации</option>
                </select>
              </label>
              <label>
                Срок действия, дней
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={catalog.policy.validityDays}
                  onChange={(event) =>
                    change({
                      ...catalog,
                      policy: { ...catalog.policy, validityDays: Number(event.target.value) },
                    })
                  }
                />
              </label>
              {catalog.policy.validityStart === 'ACTIVATION' ? (
                <label>
                  Активировать в течение, дней
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={catalog.policy.activationDeadlineDays ?? 90}
                    onChange={(event) =>
                      change({
                        ...catalog,
                        policy: {
                          ...catalog.policy,
                          activationDeadlineDays: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              ) : null}
              <label className="gift-toggle">
                <input
                  type="checkbox"
                  checked={catalog.policy.scheduledDeliveryEnabled}
                  onChange={(event) =>
                    change({
                      ...catalog,
                      policy: {
                        ...catalog.policy,
                        scheduledDeliveryEnabled: event.target.checked,
                      },
                    })
                  }
                />
                <span>Разрешить отложенную отправку</span>
              </label>
              <label className="gift-toggle">
                <input
                  type="checkbox"
                  checked={catalog.policy.emailAttachmentEnabled}
                  onChange={(event) =>
                    change({
                      ...catalog,
                      policy: {
                        ...catalog.policy,
                        emailAttachmentEnabled: event.target.checked,
                      },
                    })
                  }
                />
                <span>Прикладывать PDF к письму</span>
              </label>
            </div>
          </section>

          <section className="panel editor-section">
            <div className="section-heading compact gift-heading-action">
              <div>
                <h2>Дизайны</h2>
                <p>До 20 вариантов. На витрину попадут только активные.</p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  change({
                    ...catalog,
                    designs: [
                      ...catalog.designs,
                      {
                        key: `design-${catalog.designs.length + 1}`,
                        audience: 'UNIVERSAL',
                        title: 'Новый дизайн',
                        description: null,
                        imageUrl: '',
                        alt: 'Подарочный сертификат ПаделХАБ',
                        codeXPercent: 5.1,
                        codeYPercent: 88,
                        amountXPercent: 78.3,
                        amountYPercent: 88,
                        active: false,
                        sortOrder: (catalog.designs.length + 1) * 10,
                      },
                    ],
                  })
                }
              >
                + Добавить
              </button>
            </div>
            <div className="gift-card-list">
              {catalog.designs.map((design, index) => (
                <article className="gift-item-card" key={`${design.key}-${index}`}>
                  <div className="gift-form-grid">
                    <label>
                      Ключ
                      <input
                        value={design.key}
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, key: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Для кого
                      <select
                        value={design.audience}
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    audience: event.target.value as typeof design.audience,
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="UNIVERSAL">Универсальный</option>
                        <option value="FOR_HER">Для неё</option>
                        <option value="FOR_HIM">Для него</option>
                      </select>
                    </label>
                    <label>
                      Название
                      <input
                        value={design.title}
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, title: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Порядок
                      <input
                        type="number"
                        min={0}
                        max={999}
                        value={design.sortOrder}
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, sortOrder: Number(event.target.value) }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="span-two">
                      Изображение сертификата
                      <input
                        value={design.imageUrl}
                        placeholder="https://cdn.padlhub.ru/gift/classic.webp"
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, imageUrl: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="span-two gift-upload-control">
                      JPEG, PNG или WebP · до 8 МБ
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={busy !== undefined}
                        aria-label={`Загрузить изображение для дизайна ${design.title}`}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadDesign(index, file);
                          event.target.value = '';
                        }}
                      />
                      {busy === `upload-${index}` ? (
                        <small>Подготавливаем и загружаем…</small>
                      ) : null}
                    </label>
                    <label className="span-two">
                      Alt-текст
                      <input
                        value={design.alt}
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, alt: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    {(
                      [
                        ['Код · X, %', 'codeXPercent'],
                        ['Код · Y, %', 'codeYPercent'],
                        ['Номинал · X, %', 'amountXPercent'],
                        ['Номинал · Y, %', 'amountYPercent'],
                      ] as const
                    ).map(([label, field]) => (
                      <label key={field}>
                        {label}
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={design[field]}
                          onChange={(event) =>
                            change({
                              ...catalog,
                              designs: catalog.designs.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, [field]: Number(event.target.value) }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="gift-item-actions">
                    <label className="gift-toggle">
                      <input
                        type="checkbox"
                        checked={design.active}
                        onChange={(event) =>
                          change({
                            ...catalog,
                            designs: catalog.designs.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, active: event.target.checked }
                                : item,
                            ),
                          })
                        }
                      />
                      <span>Активен</span>
                    </label>
                    <button
                      type="button"
                      className="text-button danger-text"
                      onClick={() =>
                        change({
                          ...catalog,
                          designs: catalog.designs.filter((_, itemIndex) => itemIndex !== index),
                        })
                      }
                    >
                      Удалить
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel editor-section">
            <div className="section-heading compact gift-heading-action">
              <div>
                <h2>Номиналы</h2>
                <p>Сумма хранится в копейках, в ЦУП показывается в рублях.</p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  change({
                    ...catalog,
                    denominations: [
                      ...catalog.denominations,
                      {
                        amountMinor: 100_000,
                        currency: 'RUB',
                        active: false,
                        sortOrder: (catalog.denominations.length + 1) * 10,
                      },
                    ],
                  })
                }
              >
                + Добавить
              </button>
            </div>
            <div className="denomination-list">
              {catalog.denominations.map((denomination, index) => (
                <div className="denomination-row" key={`${denomination.amountMinor}-${index}`}>
                  <label>
                    Номинал, ₽
                    <input
                      type="number"
                      min={100}
                      max={1_000_000}
                      value={denomination.amountMinor / 100}
                      onChange={(event) =>
                        change({
                          ...catalog,
                          denominations: catalog.denominations.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  amountMinor: Math.round(Number(event.target.value) * 100),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Порядок
                    <input
                      type="number"
                      min={0}
                      max={999}
                      value={denomination.sortOrder}
                      onChange={(event) =>
                        change({
                          ...catalog,
                          denominations: catalog.denominations.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, sortOrder: Number(event.target.value) }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="gift-toggle">
                    <input
                      type="checkbox"
                      checked={denomination.active}
                      onChange={(event) =>
                        change({
                          ...catalog,
                          denominations: catalog.denominations.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, active: event.target.checked } : item,
                          ),
                        })
                      }
                    />
                    <span>Активен</span>
                  </label>
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() =>
                      change({
                        ...catalog,
                        denominations: catalog.denominations.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel editor-section">
            <div className="section-heading compact">
              <div>
                <h2>Структура оформления</h2>
                <p>Порядок шагов задаётся опубликованной версией каталога.</p>
              </div>
            </div>
            <ol className="flow-step-list">
              {catalog.flowSteps.map((step, index) => (
                <li key={step}>
                  <span className="flow-step-number">{index + 1}</span>
                  <strong>{flowStepCopy[step]}</strong>
                  <span className="flow-step-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveFlowStep(index, -1)}
                      aria-label={`Поднять шаг ${flowStepCopy[step]}`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === catalog.flowSteps.length - 1}
                      onClick={() => moveFlowStep(index, 1)}
                      aria-label={`Опустить шаг ${flowStepCopy[step]}`}
                    >
                      ↓
                    </button>
                    {!requiredFlowSteps.has(step) ? (
                      <button
                        type="button"
                        onClick={() =>
                          change({
                            ...catalog,
                            flowSteps: catalog.flowSteps.filter((item) => item !== step),
                          })
                        }
                        aria-label={`Удалить шаг ${flowStepCopy[step]}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
            {missingFlowSteps.length > 0 ? (
              <label className="add-flow-step">
                Добавить шаг
                <select
                  value=""
                  onChange={(event) => {
                    const step = event.target.value as GiftCertificateFlowStep;
                    if (step) change({ ...catalog, flowSteps: [...catalog.flowSteps, step] });
                  }}
                >
                  <option value="">Выберите…</option>
                  {missingFlowSteps.map((step) => (
                    <option value={step} key={step}>
                      {flowStepCopy[step]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </section>
        </div>

        <aside className="gift-preview-column">
          <section className="panel gift-preview-panel">
            <p className="eyebrow">Предпросмотр</p>
            <div className="certificate-preview">
              <div className="certificate-artwork-preview">
                {previewDesign?.imageUrl ? (
                  <img src={previewDesign.imageUrl} alt={previewDesign.alt} />
                ) : (
                  <div className="certificate-placeholder">PH</div>
                )}
                {previewDesign ? (
                  <>
                    <span
                      className="certificate-code-overlay"
                      style={{
                        left: `${previewDesign.codeXPercent}%`,
                        top: `${previewDesign.codeYPercent}%`,
                      }}
                    >
                      FM15-NI*KZ4
                    </span>
                    <span
                      className="certificate-amount-overlay"
                      style={{
                        left: `${previewDesign.amountXPercent}%`,
                        top: `${previewDesign.amountYPercent}%`,
                      }}
                    >
                      {previewDenomination
                        ? `${new Intl.NumberFormat('ru-RU').format(previewDenomination.amountMinor / 100)} ₽`
                        : '— ₽'}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <dl className="gift-summary">
              <div>
                <dt>Дизайнов</dt>
                <dd>{catalog.designs.filter((item) => item.active).length}</dd>
              </div>
              <div>
                <dt>Номиналов</dt>
                <dd>{catalog.denominations.filter((item) => item.active).length}</dd>
              </div>
              <div>
                <dt>Срок</dt>
                <dd>{catalog.policy.validityDays} дн.</dd>
              </div>
            </dl>
          </section>

          <section className="panel gift-publish-panel">
            <h2>Версия каталога</h2>
            <p className="muted">
              Сначала сохраните черновик. Публикация атомарно заменит предыдущую версию.
            </p>
            {issues.length > 0 ? (
              <div className="notice warning">
                <strong>Нужно исправить:</strong>
                <ul>
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="notice success">Настройки готовы к сохранению.</div>
            )}
            <button
              className="secondary-button gift-action"
              type="button"
              disabled={Boolean(busy) || issues.length > 0}
              onClick={() => void save()}
            >
              {busy === 'save'
                ? 'Сохраняем…'
                : revision === null
                  ? 'Создать черновик'
                  : 'Сохранить'}
            </button>
            <button
              className="primary-button gift-action"
              type="button"
              disabled={
                Boolean(busy) || !catalogId || revision === null || dirty || issues.length > 0
              }
              onClick={() => void publish()}
            >
              {busy === 'publish' ? 'Публикуем…' : 'Опубликовать'}
            </button>
            {dirty && catalogId ? (
              <p className="send-hint">Сохраните текущие изменения перед публикацией.</p>
            ) : null}
            {error ? <div className="notice danger">{error}</div> : null}
            {message ? <div className="notice success">{message}</div> : null}
          </section>
        </aside>
      </section>
    </main>
  );
}
