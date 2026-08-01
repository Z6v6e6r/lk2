export function tournamentDetailRange(now = new Date()): {
  readonly dateFrom: string;
  readonly dateTo: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: 'year' | 'month' | 'day'): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const from = new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 15);
  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
  };
}
