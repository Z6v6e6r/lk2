interface JsonObject {
  readonly [key: string]: unknown;
}

function bodyPreview(body: string): string {
  return JSON.stringify(body.slice(0, 200));
}

export async function requestJson(
  baseUrl: string,
  path: string,
  expectedStatus: number,
): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'X-Correlation-ID': `smoke-${crypto.randomUUID()}` },
    signal: AbortSignal.timeout(5_000),
  });
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const bodyText = await response.text();

  if (!contentType.startsWith('application/json')) {
    throw new Error(
      `${path} returned ${contentType || 'no Content-Type'} instead of application/json: ${bodyPreview(bodyText)}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error(`${path} returned invalid JSON: ${bodyPreview(bodyText)}`);
  }

  if (response.status !== expectedStatus) {
    throw new Error(
      `${path} returned HTTP ${response.status}, expected ${expectedStatus}: ${bodyPreview(bodyText)}`,
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${path} returned a non-object JSON body: ${bodyPreview(bodyText)}`);
  }

  return body as JsonObject;
}

export function requireJsonField(
  path: string,
  body: JsonObject,
  field: string,
  expectedValue: string,
): void {
  if (body[field] !== expectedValue) {
    throw new Error(
      `${path} returned unexpected ${field}: ${JSON.stringify(body[field])}; expected ${JSON.stringify(expectedValue)}`,
    );
  }
}
