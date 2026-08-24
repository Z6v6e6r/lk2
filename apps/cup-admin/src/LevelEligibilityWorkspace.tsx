import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  LevelEligibilityActivityType,
  LevelEligibilityImpactAdminView,
  LevelEligibilityPolicyAdminView,
  LevelEligibilityPolicyInput,
  LevelEligibilityPolicyState,
  NotificationAdminClient,
} from './notification-admin-client.js';

type LevelClient = Pick<
  NotificationAdminClient,
  | 'getLevelEligibilityState'
  | 'getLevelEligibilityImpact'
  | 'getLevelEligibilityHistory'
  | 'publishLevelEligibilityPolicy'
  | 'rollbackLevelEligibilityPolicy'
  | 'previewLevelEligibility'
>;
type Tab = 'scale' | 'rules' | 'validation' | 'history';

const activities: readonly {
  readonly id: LevelEligibilityActivityType;
  readonly title: string;
}[] = [
  { id: 'GAME', title: 'Игры' },
  { id: 'TOURNAMENT', title: 'Турниры' },
  { id: 'TRAINING', title: 'Тренировки' },
];

function draft(policy: LevelEligibilityPolicyAdminView): LevelEligibilityPolicyInput {
  return {
    expectedVersion: policy.version,
    mode: policy.mode,
    lowerToleranceSteps: policy.lowerToleranceSteps,
    upperToleranceSteps: policy.upperToleranceSteps,
    missingActivityConstraintAction: policy.missingActivityConstraintAction,
    legacyTextConstraintAction: policy.legacyTextConstraintAction,
    recheckWaitlistPromotion: policy.recheckWaitlistPromotion,
    changeComment: '',
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Операция не выполнена.';
}

export function LevelEligibilityWorkspace({
  client,
}: {
  readonly client: LevelClient;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('rules');
  const [state, setState] = useState<LevelEligibilityPolicyState>();
  const [impact, setImpact] = useState<readonly LevelEligibilityImpactAdminView[]>([]);
  const [drafts, setDrafts] = useState<
    Partial<Record<LevelEligibilityActivityType, LevelEligibilityPolicyInput>>
  >({});
  const [historyType, setHistoryType] = useState<LevelEligibilityActivityType>('GAME');
  const [history, setHistory] = useState<readonly LevelEligibilityPolicyAdminView[]>([]);
  const [busy, setBusy] = useState<string | undefined>('load');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{
    readonly status: string;
    readonly result: {
      readonly outcome: string;
      readonly reasonCode: string;
      readonly metadata?: Record<string, unknown>;
    };
  }>();
  const [simulation, setSimulation] = useState({
    activityType: 'GAME' as LevelEligibilityActivityType,
    playerLevelId: '',
    minimumLevelId: '',
    maximumLevelId: '',
    personalInvitation: false,
    organizerCreation: false,
  });

  const applyState = useCallback(
    (
      nextState: LevelEligibilityPolicyState,
      nextImpact: { readonly items: readonly LevelEligibilityImpactAdminView[] },
    ): void => {
      setState(nextState);
      setImpact(nextImpact.items);
      setDrafts(
        Object.fromEntries(
          nextState.policies.map((policy) => [policy.activityType, draft(policy)]),
        ),
      );
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const values = await Promise.all([
      client.getLevelEligibilityState(),
      client.getLevelEligibilityImpact(),
    ]);
    applyState(...values);
  }, [applyState, client]);

  useEffect(() => {
    void Promise.all([client.getLevelEligibilityState(), client.getLevelEligibilityImpact()])
      .then((values) => applyState(...values))
      .catch((reason) => setError(message(reason)))
      .finally(() => setBusy(undefined));
  }, [applyState, client]);

  useEffect(() => {
    if (tab !== 'history') return;
    void client
      .getLevelEligibilityHistory(historyType)
      .then((value) => setHistory(value.items))
      .catch((reason) => setError(message(reason)));
  }, [client, historyType, tab]);

  const policyByType = useMemo(
    () => new Map(state?.policies.map((policy) => [policy.activityType, policy]) ?? []),
    [state],
  );

  function change(
    activityType: LevelEligibilityActivityType,
    update: Partial<LevelEligibilityPolicyInput>,
  ): void {
    setDrafts((current) => ({
      ...current,
      [activityType]: { ...current[activityType]!, ...update },
    }));
  }

  async function publish(activityType: LevelEligibilityActivityType): Promise<void> {
    const input = drafts[activityType];
    if (!input) return;
    setBusy(`publish-${activityType}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await client.publishLevelEligibilityPolicy(activityType, input);
      setNotice(
        `${activities.find((item) => item.id === activityType)?.title}: опубликована версия ${result.policy.version}.`,
      );
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function runPreview(): Promise<void> {
    const policy = drafts[simulation.activityType];
    if (!policy) return;
    setBusy('preview');
    setError(undefined);
    try {
      setPreview(
        await client.previewLevelEligibility({
          sportCode: 'PADEL',
          activityType: simulation.activityType,
          playerLevelId: simulation.playerLevelId || null,
          minimumLevelId: simulation.minimumLevelId || null,
          maximumLevelId: simulation.maximumLevelId || null,
          personalInvitation: simulation.personalInvitation,
          organizerCreation: simulation.organizerCreation,
          policy: {
            mode: policy.mode,
            lowerToleranceSteps: policy.lowerToleranceSteps,
            upperToleranceSteps: policy.upperToleranceSteps,
            missingActivityConstraintAction: policy.missingActivityConstraintAction,
            legacyTextConstraintAction: policy.legacyTextConstraintAction,
            recheckWaitlistPromotion: policy.recheckWaitlistPromotion,
          },
        }),
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function rollback(target: LevelEligibilityPolicyAdminView): Promise<void> {
    const current = policyByType.get(target.activityType);
    if (!current) return;
    setBusy(`rollback-${target.version}`);
    setError(undefined);
    try {
      await client.rollbackLevelEligibilityPolicy(target.activityType, {
        expectedVersion: current.version,
        targetVersion: target.version,
        changeComment: `Rollback к версии ${target.version}`,
      });
      setNotice(`Настройки восстановлены из версии ${target.version}. Создана новая версия.`);
      await refresh();
      const value = await client.getLevelEligibilityHistory(historyType);
      setHistory(value.items);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main className="workspace level-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Уровни</p>
          <h1>Допуск к участию</h1>
          <p className="muted">Единые правила для игр, турниров и тренировок.</p>
        </div>
        <span className="environment-badge">PADEL · v{state?.levels[0]?.scaleVersion ?? '—'}</span>
      </header>

      <nav className="settings-tabs" aria-label="Настройки уровней">
        {(
          [
            ['scale', 'Шкала уровней'],
            ['rules', 'Правила допуска'],
            ['validation', 'Проверка конфигурации'],
            ['history', 'История изменений'],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </nav>

      {error ? <div className="notice danger">{error}</div> : null}
      {notice ? <div className="notice success">{notice}</div> : null}
      {busy === 'load' ? <div className="panel">Загрузка правил…</div> : null}

      {tab === 'scale' && state ? (
        <section className="panel level-scale-panel">
          <h2>Канонический порядок</h2>
          <p className="muted">
            Сравнение выполняется по rank; отображаемый код не участвует в расчёте.
          </p>
          <ol className="level-scale-list">
            {state.levels.map((level) => (
              <li key={level.id}>
                <strong>{level.code}</strong>
                <span>rank {level.rank}</span>
                <small>{level.aliases.join(', ')}</small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {tab === 'rules' && state ? (
        <div className="level-policy-grid">
          <section className="panel level-policy-card">
            <h2>Готовность BLOCK</h2>
            {state.readiness.map((item) => (
              <p key={item.activityType}>
                {activities.find((activity) => activity.id === item.activityType)?.title}:{' '}
                {item.readyForBlock ? 'готово' : `заблокировано (${item.missingGates.join(', ')})`}
              </p>
            ))}
          </section>
          {activities.map((activity) => {
            const policy = policyByType.get(activity.id);
            const input = drafts[activity.id];
            if (!policy || !input) return null;
            return (
              <section className="panel level-policy-card" key={activity.id}>
                <header>
                  <div>
                    <h2>{activity.title}</h2>
                    <small>Версия {policy.version}</small>
                  </div>
                  <span className={`policy-mode mode-${input.mode.toLowerCase()}`}>
                    {input.mode}
                  </span>
                </header>
                <label>
                  Режим
                  <select
                    value={input.mode}
                    onChange={(event) =>
                      change(activity.id, {
                        mode: event.target.value as LevelEligibilityPolicyInput['mode'],
                      })
                    }
                  >
                    <option>OFF</option>
                    <option>SHADOW</option>
                    <option>WARN</option>
                    <option>BLOCK</option>
                  </select>
                </label>
                <div className="level-tolerance-grid">
                  <label>
                    Допуск ниже
                    <input
                      type="number"
                      min="0"
                      max={Math.max(0, state.levels.length - 1)}
                      value={input.lowerToleranceSteps}
                      onChange={(event) =>
                        change(activity.id, { lowerToleranceSteps: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Допуск выше
                    <input
                      type="number"
                      min="0"
                      max={Math.max(0, state.levels.length - 1)}
                      value={input.upperToleranceSteps}
                      onChange={(event) =>
                        change(activity.id, { upperToleranceSteps: Number(event.target.value) })
                      }
                    />
                  </label>
                </div>
                <label>
                  Если у активности нет диапазона
                  <select
                    value={input.missingActivityConstraintAction}
                    onChange={(event) =>
                      change(activity.id, {
                        missingActivityConstraintAction: event.target
                          .value as LevelEligibilityPolicyInput['missingActivityConstraintAction'],
                      })
                    }
                  >
                    <option value="ALLOW">Разрешить</option>
                    <option value="WARN">Предупредить</option>
                    <option value="BLOCK">Блокировать</option>
                  </select>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={activity.id === 'GAME' ? true : input.recheckWaitlistPromotion}
                    disabled={activity.id === 'GAME'}
                    onChange={(event) =>
                      change(activity.id, { recheckWaitlistPromotion: event.target.checked })
                    }
                  />
                  {activity.id === 'GAME'
                    ? 'Повторная проверка при продвижении обязательна'
                    : 'Повторять проверку при продвижении из очереди'}
                </label>
                <label>
                  Комментарий к публикации
                  <textarea
                    value={input.changeComment}
                    maxLength={500}
                    onChange={(event) => change(activity.id, { changeComment: event.target.value })}
                    placeholder="Причина изменения"
                  />
                </label>
                <button
                  className="primary-button"
                  type="button"
                  disabled={Boolean(busy) || input.changeComment.trim().length < 3}
                  onClick={() => void publish(activity.id)}
                >
                  {busy === `publish-${activity.id}` ? 'Публикация…' : 'Опубликовать настройки'}
                </button>
              </section>
            );
          })}
          <section className="panel system-exceptions">
            <h2>Системные исключения</h2>
            <p>Персональное приглашение обходит только ограничение уровня.</p>
            <p>Организатор может создать активность вне собственного уровня.</p>
            <p>Публичная ссылка, сообщество и команда не дают bypass.</p>
          </section>
        </div>
      ) : null}

      {tab === 'validation' && state ? (
        <div className="level-validation-grid">
          <section className="panel level-preview-form">
            <h2>Preview simulator</h2>
            <label>
              Тип активности
              <select
                value={simulation.activityType}
                onChange={(event) =>
                  setSimulation({
                    ...simulation,
                    activityType: event.target.value as LevelEligibilityActivityType,
                  })
                }
              >
                {activities.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ['playerLevelId', 'Уровень игрока'],
                ['minimumLevelId', 'Минимальный уровень'],
                ['maximumLevelId', 'Максимальный уровень'],
              ] as const
            ).map(([key, title]) => (
              <label key={key}>
                {title}
                <select
                  value={simulation[key]}
                  onChange={(event) => setSimulation({ ...simulation, [key]: event.target.value })}
                >
                  <option value="">Не указан</option>
                  {state.levels.map((level) => (
                    <option key={level.id} value={level.id}>
                      {level.code}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={simulation.personalInvitation}
                onChange={(event) =>
                  setSimulation({ ...simulation, personalInvitation: event.target.checked })
                }
              />
              Персональное приглашение
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={simulation.organizerCreation}
                onChange={(event) =>
                  setSimulation({ ...simulation, organizerCreation: event.target.checked })
                }
              />
              Создание организатором
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void runPreview()}
            >
              Проверить
            </button>
          </section>
          <section className="panel level-preview-result">
            <h2>Результат</h2>
            {preview ? (
              <>
                <strong className={`preview-status status-${preview.status.toLowerCase()}`}>
                  {preview.status}
                </strong>
                <p>
                  {preview.result.outcome} · {preview.result.reasonCode}
                </p>
                <pre>{JSON.stringify(preview.result.metadata ?? {}, null, 2)}</pre>
              </>
            ) : (
              <p className="muted">Заполните сценарий и выполните проверку.</p>
            )}
          </section>
          <section className="panel level-impact-panel">
            <h2>Impact preview</h2>
            {impact.map((item) => (
              <article key={item.activityType}>
                <strong>
                  {activities.find((activity) => activity.id === item.activityType)?.title}
                </strong>
                {item.supported ? (
                  <dl>
                    <div>
                      <dt>Без уровня активности</dt>
                      <dd>{item.activitiesWithoutLevel}</dd>
                    </div>
                    <div>
                      <dt>Некорректный диапазон</dt>
                      <dd>{item.activitiesWithInvalidRange}</dd>
                    </div>
                    <div>
                      <dt>Legacy</dt>
                      <dd>{item.legacyActivities}</dd>
                    </div>
                    <div>
                      <dt>Игроков без уровня</dt>
                      <dd>{item.playersWithoutLevel}</dd>
                    </div>
                    <div>
                      <dt>Участников вне диапазона</dt>
                      <dd>{item.existingParticipantsOutsideRange}</dd>
                    </div>
                  </dl>
                ) : (
                  <small>
                    Источник ещё не перенесён в PadlHub API; публикация BLOCK запрещена операционным
                    регламентом.
                  </small>
                )}
              </article>
            ))}
          </section>
        </div>
      ) : null}

      {tab === 'history' ? (
        <section className="panel level-history-panel">
          <header>
            <h2>История</h2>
            <select
              value={historyType}
              onChange={(event) =>
                setHistoryType(event.target.value as LevelEligibilityActivityType)
              }
            >
              {activities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </header>
          {history.map((item) => (
            <article key={item.id}>
              <div>
                <strong>
                  v{item.version} · {item.mode}
                </strong>
                <small>
                  {new Date(item.createdAt).toLocaleString('ru-RU')} ·{' '}
                  {item.changeComment ?? 'Без комментария'}
                </small>
              </div>
              <span>
                −{item.lowerToleranceSteps} / +{item.upperToleranceSteps}
              </span>
              {item.version !== policyByType.get(item.activityType)?.version ? (
                <button type="button" disabled={Boolean(busy)} onClick={() => void rollback(item)}>
                  Rollback
                </button>
              ) : (
                <em>Текущая</em>
              )}
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}
