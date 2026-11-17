import { useEffect, useState } from 'react';
import type { CanonicalProfileLevel } from '@phub/api-sdk';
import type { AuthGateway } from './auth-gateway.js';

export type ParticipationLevelGateway = Pick<
  AuthGateway,
  'getOwnPlayerLevel' | 'setOwnPlayerLevel'
>;

/**
 * Self-declared level recovery used while CUP has not projected the player's level. The server
 * refuses the write once CUP is authoritative and re-evaluates eligibility on the retried command.
 */
export function ParticipationLevelPicker({
  gateway,
  onSaved,
  onCancel,
}: {
  gateway: ParticipationLevelGateway;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [levels, setLevels] = useState<readonly CanonicalProfileLevel[] | null>(null),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!gateway.getOwnPlayerLevel) return;
    gateway.getOwnPlayerLevel('PADEL').then(
      (state) => {
        if (!active) return;
        setLevels(state.levels.filter((level) => level.active));
        if (state.currentLevel) setSelected(state.currentLevel.levelId);
      },
      () => {
        if (active) setError('Не удалось загрузить уровни. Укажите уровень в профиле.');
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);
  async function save() {
    if (!selected || busy || !gateway.setOwnPlayerLevel) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.setOwnPlayerLevel(selected, 'PADEL');
      onSaved();
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
      setError(
        code === 'PROFILE_LEVEL_CUP_AUTHORITATIVE'
          ? 'Ваш уровень уже задан ЦУП и не меняется здесь.'
          : 'Не удалось сохранить уровень. Повторите.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="participation-level-picker" role="group" aria-label="Выбор уровня">
      <label>
        Ваш уровень
        <select
          value={selected}
          disabled={busy || !levels}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">{levels ? 'Выберите уровень' : 'Загружаем…'}</option>
          {levels?.map((level) => (
            <option key={level.id} value={level.id}>
              {level.title}
            </option>
          ))}
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={busy || !selected} onClick={() => void save()}>
        Сохранить и записаться
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>
        Отмена
      </button>
    </div>
  );
}
