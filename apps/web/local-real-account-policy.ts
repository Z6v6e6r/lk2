// This gate applies only to the launcher's opt-in real-account development preview.
// Keep the API private: this is the sole browser-facing API ingress for that contour.
const root = '/user/api/v1/local-padel';
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const posts = [
  new RegExp(`^${root}/auth/challenges$`),
  new RegExp(`^${root}/auth/challenges/${uuid}/verify$`),
  new RegExp(`^${root}/auth/(?:session/refresh|viva/access)$`),
  new RegExp(`^${root}/booking-screen-read-jobs$`),
  new RegExp(`^${root}/booking-screen-read-jobs/${uuid}/(?:results/${uuid}|complete)$`),
];

export function realAccountRequestAllowed(method: string, rawUrl: string): boolean {
  const path = rawUrl.split('?', 1)[0] ?? '';
  // Match one canonical wire spelling. Never normalize a suspicious path into an allowed one.
  if (
    !path.startsWith('/') ||
    /[%\\\s]/.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.includes('//') ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  )
    return false;
  if (path.startsWith('/realtime') || path.startsWith('/internal/')) return false;
  if (path.startsWith(`${root}/auth/viva/`) && path !== `${root}/auth/viva/access`) return false;
  if (method === 'DELETE') return path === `${root}/auth/session`;
  if (method === 'POST') return posts.some((pattern) => pattern.test(path));
  if (method !== 'GET' && method !== 'HEAD') return false;
  // Only the selected tenant's public/user reads; unrelated API prefixes fail closed.
  return (
    path.startsWith(`${root}/`) ||
    path.startsWith('/user/api/v2/local-padel/') ||
    path.startsWith('/public/api/v1/local-padel/') ||
    new RegExp(`^/public/api/v1/media/(?:profile-photos|community-logos)/${uuid}/${uuid}$`).test(
      path,
    )
  );
}

export function isApiRequest(rawUrl: string): boolean {
  // Detect ambiguous API prefixes without treating encoded Vite module paths as API traffic.
  let path = rawUrl.split('?', 1)[0] ?? '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '/');
    if (/^\/(?:user|public|internal|realtime)(?:\/|%|$)/i.test(normalized)) return true;
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    } catch {
      break;
    }
  }
  return false;
}
