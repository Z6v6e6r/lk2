const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export {};

for (const path of ['/health/live', '/health/ready']) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'X-Correlation-ID': `smoke-${crypto.randomUUID()}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  process.stdout.write(`${path}: ok\n`);
}
