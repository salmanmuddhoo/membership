import { describe, expect, it } from 'vitest';
import {
  ApiError,
  apiError,
  apiSuccess,
  correlationIdFrom,
  statusFor,
} from './envelope';

async function body(response: Response) {
  return JSON.parse(await response.text());
}

describe('the error envelope (S-109)', () => {
  it('carries a stable code, a safe message and a correlation id', async () => {
    const response = apiError('forbidden', 'corr-1');

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      error: {
        code: 'forbidden',
        message: 'You do not have access to this resource.',
        correlationId: 'corr-1',
      },
    });
  });

  it('echoes the correlation id in a header so a caller can quote it', () => {
    expect(
      apiError('not_found', 'corr-2').headers.get('x-correlation-id')
    ).toBe('corr-2');
  });

  it('never lets an API response be cached by a shared proxy', () => {
    // Responses are per-user; a caching proxy could otherwise serve one
    // member's data to another.
    expect(apiSuccess({ a: 1 }, 'c').headers.get('cache-control')).toBe(
      'no-store'
    );
    expect(apiError('forbidden', 'c').headers.get('cache-control')).toBe(
      'no-store'
    );
  });

  it('maps each code to the right status', () => {
    expect(statusFor('unauthenticated')).toBe(401);
    expect(statusFor('forbidden')).toBe(403);
    expect(statusFor('not_found')).toBe(404);
    expect(statusFor('validation_failed')).toBe(422);
    expect(statusFor('conflict')).toBe(409);
    expect(statusFor('rate_limited')).toBe(429);
    expect(statusFor('internal_error')).toBe(500);
  });

  it('carries field detail only when given', async () => {
    const plain = await body(apiError('validation_failed', 'c'));
    expect(plain.error.details).toBeUndefined();

    const detailed = await body(
      apiError('validation_failed', 'c', undefined, {
        email: ['is required'],
      })
    );
    expect(detailed.error.details).toEqual({ email: ['is required'] });
  });

  it('wraps success with the correlation id alongside the data', async () => {
    const response = apiSuccess({ id: 7 }, 'corr-3', 201);
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({
      data: { id: 7 },
      correlationId: 'corr-3',
    });
  });
});

describe('ApiError', () => {
  it('defaults to the standard wording for its code', () => {
    expect(new ApiError('conflict').message).toBe(
      'The request conflicts with the current state of the resource.'
    );
  });

  it('allows a more specific message', () => {
    expect(
      new ApiError('conflict', 'That member number is already in use.').message
    ).toBe('That member number is already in use.');
  });
});

describe('correlationIdFrom', () => {
  it('reuses the platform request id so logs can be joined', () => {
    const headers = new Headers({ 'x-vercel-id': 'lhr1::abc123' });
    expect(correlationIdFrom(headers)).toBe('lhr1::abc123');
  });

  it('generates one when the request carries none', () => {
    expect(correlationIdFrom(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a caller-supplied value that could forge a log line', () => {
    // The value is echoed back and written to our logs, so it is not taken at
    // face value. A literal newline cannot be tested here — the Headers API
    // rejects one outright, so the runtime stops that case before this code
    // sees it — but length and character set are ours to enforce.
    for (const hostile of [
      'a'.repeat(200),
      'has spaces',
      '"quoted"',
      '{"kind":"api","status":200}',
    ]) {
      const generated = correlationIdFrom(
        new Headers({ 'x-correlation-id': hostile })
      );
      expect(generated).not.toBe(hostile);
      expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
