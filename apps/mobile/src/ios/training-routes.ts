import { ApiClientError } from '@phub/api-sdk';
import type { IOSConfiguration } from './session.js';
export interface NativeTrainingRequest {
  readonly resource: 'catalog' | 'register' | 'status';
  readonly resourceId?: string;
  readonly query: Record<string, string>;
}
const uuid =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
function deny(): never {
  throw new ApiClientError(
    'Native training request rejected',
    400,
    'NATIVE_REQUEST_REJECTED',
    'native',
  );
}
function day(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function validTrainingCatalogue(query: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(query)) {
    if (name === 'limit') {
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) return false;
    } else if (name === 'cursor') {
      if (!new RegExp(`^${uuid}$`).test(value)) return false;
    } else if (name === 'localDates') {
      const days = value.split(',');
      if (days.length > 7 || new Set(days).size !== days.length || !days.every(day)) return false;
    } else if (name === 'kinds') {
      if (
        !/^(?:COACH_GAME|GROUP_TRAINING|SPLIT)(?:,(?:COACH_GAME|GROUP_TRAINING|SPLIT)){0,2}$/.test(
          value,
        )
      )
        return false;
    } else if (name === 'categoryIds' || name === 'stationIds') {
      if (!new RegExp(`^${uuid}(?:,${uuid}){0,49}$`).test(value)) return false;
    } else if (name === 'availability') {
      if (!/^(?:INCLUDE_FULL|EXCLUDE_FULL)$/.test(value)) return false;
    } else if (name === 'levelFrom' || name === 'levelTo') {
      if (!/^(?:D\+?|C\+?|B\+?|A)$/.test(value)) return false;
    } else if (name === 'startsAfterLocal') {
      if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) return false;
    } else return false;
  }
  return query.cursor !== undefined
    ? Object.keys(query).length === (query.limit !== undefined ? 2 : 1)
    : query.localDates !== undefined &&
        query.kinds !== undefined &&
        query.availability !== undefined;
}
export function trainingRequest(
  value: string,
  init: RequestInit | undefined,
  config: IOSConfiguration,
): NativeTrainingRequest | null {
  if (!value.includes('/trainings')) return null;
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}/trainings/`;
  if (
    !value.startsWith(root) ||
    value.length > 10000 ||
    /[%#\\\s]|\.\./.test(value.split('?')[0] ?? '')
  )
    deny();
  const parts = value.slice(root.length).split('?');
  if (parts.length > 2 || parts[1] === '') deny();
  const headers = new Headers(init?.headers);
  for (const [name, v] of headers)
    if (
      ![
        'accept',
        'content-type',
        'authorization',
        'idempotency-key',
        'x-correlation-id',
        'x-app-platform',
        'x-app-version',
        'x-app-build',
      ].includes(name) ||
      v.length > 8192 ||
      /[\r\n]/.test(v)
    )
      deny();
  if (!/^Bearer [A-Za-z0-9._-]{8,8192}$/.test(headers.get('authorization') ?? '')) deny();
  const method = init?.method ?? 'GET';
  if (parts[0] === 'catalog') {
    if (
      method !== 'GET' ||
      init?.body != null ||
      headers.has('idempotency-key') ||
      !parts[1] ||
      parts[1].length > 8192
    )
      deny();
    const query: Record<string, string> = {};
    for (const part of parts[1].split('&')) {
      const pair = part.split('=');
      if (pair.length !== 2 || !/^[A-Za-z]+$/.test(pair[0]!) || Object.hasOwn(query, pair[0]!))
        deny();
      try {
        query[pair[0]!] = decodeURIComponent(pair[1]!.replace(/\+/g, ' '));
      } catch {
        deny();
      }
    }
    if (!validTrainingCatalogue(query)) deny();
    return { resource: 'catalog', query };
  }
  const match = new RegExp(`^(${uuid})/(registrations|registration-operation)$`).exec(parts[0]!);
  if (!match || parts.length !== 1 || !key.test(headers.get('idempotency-key') ?? '')) deny();
  if (match[2] === 'registration-operation') {
    if (method !== 'GET' || init?.body != null) deny();
    return { resource: 'status', resourceId: match[1]!, query: {} };
  }
  if (
    method !== 'POST' ||
    typeof init?.body !== 'string' ||
    new TextEncoder().encode(init.body).length > 256
  )
    deny();
  const date = '"dateHint"\\s*:\\s*"[0-9]{4}-[0-9]{2}-[0-9]{2}"';
  const sub = `"subscriptionId"\\s*:\\s*"${uuid}"`;
  if (
    !new RegExp(`^\\s*\\{\\s*(?:${date}\\s*,\\s*${sub}|${sub}\\s*,\\s*${date})\\s*\\}\\s*$`).test(
      init.body,
    )
  )
    deny();
  if (!day((JSON.parse(init.body) as { dateHint: string }).dateHint)) deny();
  return { resource: 'register', resourceId: match[1]!, query: {} };
}
export function trainingRequestKey(
  request: NativeTrainingRequest,
  key?: string,
  body?: string,
): string {
  return JSON.stringify([
    request.resource,
    request.resourceId ?? null,
    Object.entries(request.query).sort(([a], [b]) => a.localeCompare(b)),
    key ?? null,
    body ?? null,
  ]);
}
