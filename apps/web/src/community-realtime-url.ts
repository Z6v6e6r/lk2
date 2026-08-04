const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function buildCommunityRealtimeUrl(baseUrl: string, tenantKey: string): string {
  if (!TENANT_KEY_PATTERN.test(tenantKey)) {
    throw new Error('COMMUNITY_REALTIME_TENANT_KEY_INVALID');
  }
  const url = new URL(baseUrl);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('COMMUNITY_REALTIME_BASE_URL_INVALID');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('COMMUNITY_REALTIME_BASE_URL_INVALID');
  }
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `/realtime/v1/${tenantKey}`;
  return url.toString();
}
