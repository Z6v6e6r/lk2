const mediaFields = new Set([
  'avatarUrl',
  'logoUrl',
  'imageUrl',
  'coverImageUrl',
  'squareImageUrl',
]);

/** The same DTOs contain avatars, promotions and recommendation images on several screens.
 * Resolve only media fields; navigation routes must remain inside the Capacitor application.
 */
export function resolveCabinetMedia<T>(value: T, apiOrigin: string): T {
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mediaFields.has(key) &&
        typeof item === 'string' &&
        item.startsWith('/') &&
        !item.startsWith('//')
          ? new URL(item, apiOrigin).href
          : visit(item),
      ]),
    );
  }
  return visit(value) as T;
}
