export function safeMessagingBaseUrl(value: string, invalidCode: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(invalidCode);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(invalidCode);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(invalidCode);
  }
  return url.toString();
}
