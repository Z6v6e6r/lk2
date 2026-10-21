import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  binaryMediaPrincipalKey,
  createBinaryMediaReadBudget,
} from './binary-media-read-budget.js';

describe('Android binary media read budget', () => {
  it('bounds per-principal and combined concurrent buffers and releases exactly once', () => {
    const budget = createBinaryMediaReadBudget();
    const first = Array.from({ length: 4 }, () => budget.acquire('a'));
    expect(first.every(Boolean)).toBe(true);
    expect(budget.acquire('a')).toBeUndefined();
    const second = Array.from({ length: 4 }, () => budget.acquire('b'));
    expect(second.every(Boolean)).toBe(true);
    expect(budget.acquire('c')).toBeUndefined();
    first[0]?.();
    first[0]?.();
    const replacement = budget.acquire('c');
    expect(replacement).toBeTypeOf('function');
    expect(budget.acquire('d')).toBeUndefined();
    replacement?.();
    for (const release of [...first, ...second]) release?.();
    expect(budget.acquire('a')).toBeTypeOf('function');
  });
  it('shares the same opaque key for different JWTs of a verified principal', () => {
    const request = (token: string) =>
      ({
        tenantId: 'synthetic-tenant',
        padlHubClaims: { sub: 'synthetic-user' },
        headers: { authorization: token },
      }) as unknown as FastifyRequest;
    const key = binaryMediaPrincipalKey(request('Bearer one'));
    expect(key).toBe(binaryMediaPrincipalKey(request('Bearer two')));
    expect(key).not.toContain('synthetic');
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
  });
});
