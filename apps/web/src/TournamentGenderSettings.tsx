import type { TournamentPlayerGenderSettings, TournamentPlayerGenderUpdate } from '@phub/api-sdk';
import { useEffect, useState } from 'react';

export interface TournamentGenderActions {
  load: () => Promise<TournamentPlayerGenderSettings>;
  save: (input: TournamentPlayerGenderUpdate) => Promise<TournamentPlayerGenderSettings>;
}

export function TournamentGenderSettings({ load, save }: TournamentGenderActions) {
  const [settings, setSettings] = useState<TournamentPlayerGenderSettings>();
  const [gender, setGender] = useState<TournamentPlayerGenderSettings['gender']>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void load().then(
      (result) => {
        if (!active) return;
        setSettings(result);
        setGender(result.gender);
        setLoading(false);
        setError('');
      },
      () => {
        if (!active) return;
        setLoading(false);
        setError('Не удалось загрузить настройки участия.');
      },
    );
    return () => {
      active = false;
    };
  }, [load, reload]);

  async function submit() {
    if (!settings || saving) return;
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const result = await save({ gender, expectedVersion: settings.version });
      setSettings(result);
      setGender(result.gender);
      setNotice('Пол сохранён.');
    } catch (cause) {
      setSettings(undefined);
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'status' in cause &&
        cause.status === 409
      ) {
        setError('Настройка уже изменилась. Загрузите её снова.');
      } else {
        setError('Не удалось подтвердить сохранение. Загрузите настройку снова.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="profile-privacy-settings profile-tournament-gender"
      aria-labelledby="tournament-gender-title"
    >
      <h3 id="tournament-gender-title">Участие в турнирах</h3>
      {loading ? <p role="status">Загрузка настройки…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {settings ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="profile-tournament-gender">Пол</label>
          <select
            id="profile-tournament-gender"
            value={gender ?? ''}
            disabled={saving}
            onChange={(event) =>
              setGender(
                event.target.value === 'FEMALE'
                  ? 'FEMALE'
                  : event.target.value === 'MALE'
                    ? 'MALE'
                    : null,
              )
            }
          >
            <option value="">Не указан в ЛК2</option>
            <option value="FEMALE">Женский</option>
            <option value="MALE">Мужской</option>
          </select>
          <button type="submit" disabled={saving || gender === settings.gender}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </form>
      ) : !loading ? (
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setReload((value) => value + 1);
          }}
        >
          Загрузить снова
        </button>
      ) : null}
    </section>
  );
}
