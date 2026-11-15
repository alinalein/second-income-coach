import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth } from './requireAuth.js';

function fakeReq(userId?: string): Request {
  return { session: userId ? { userId } : {} } as unknown as Request;
}

function fakeRes(): Response {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

// I/O matrix: "Unauthenticated API call" -> "401 before the route handler
// runs" / "No capability leaked".
describe('requireAuth (I/O matrix: unauthenticated API call)', () => {
  it('responds 401 and does not call next() when there is no session userId', () => {
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sends no response when a session userId is present', () => {
    const req = fakeReq('user-1');
    const res = fakeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
