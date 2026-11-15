import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createRequireSameOrigin } from './requireSameOrigin.js';
import type { Env } from '../../config/env.js';

function testEnv(overrides: Partial<Pick<Env, 'CORS_ORIGIN' | 'NODE_ENV'>> = {}) {
  return { CORS_ORIGIN: 'https://app.example.com', NODE_ENV: 'production' as const, ...overrides };
}

function fakeReq(method: string, origin?: string): Request {
  return { method, headers: origin ? { origin } : {} } as unknown as Request;
}

function fakeRes(): Response {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

// I/O matrix: "Cross-origin mutation" -> "Rejected" / "Distinct 4xx, not a
// generic 500" (Intent: CSRF defense = SameSite=Lax + Origin-header check).
describe('createRequireSameOrigin (I/O matrix: cross-origin mutation)', () => {
  it('rejects a mutating request with a mismatched Origin with 403', () => {
    const middleware = createRequireSameOrigin(testEnv());
    const req = fakeReq('POST', 'https://evil.example.com');
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a mutating request with no Origin header with 403', () => {
    const middleware = createRequireSameOrigin(testEnv());
    const req = fakeReq('POST');
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows a mutating request whose Origin matches CORS_ORIGIN', () => {
    const middleware = createRequireSameOrigin(testEnv());
    const req = fakeReq('POST', 'https://app.example.com');
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not check Origin for a non-mutating method', () => {
    const middleware = createRequireSameOrigin(testEnv());
    const req = fakeReq('GET', 'https://evil.example.com');
    const res = fakeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
