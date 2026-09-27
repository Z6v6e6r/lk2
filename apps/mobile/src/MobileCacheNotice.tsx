import type { StaleMobileReads } from './mobile-read-cache.js';

export function MobileCacheNotice({
  stale,
}: {
  readonly stale: StaleMobileReads;
}): React.JSX.Element | null {
  const items = Object.entries(stale);
  if (items.length === 0) return null;
  return (
    <aside className="mobile-cache-notice" role="status" aria-live="polite">
      <span>Не удалось обновить данные. Показана сохранённая копия:</span>
      <ul>
        {items.map(([path, savedAt]) => (
          <li key={path}>
            {path.endsWith('/home/base') ? 'Главная' : 'Локации'} —{' '}
            <time dateTime={new Date(savedAt).toISOString()}>
              {new Date(savedAt).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </li>
        ))}
      </ul>
    </aside>
  );
}
