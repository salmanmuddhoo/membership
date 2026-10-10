// This phone, for push notifications (docs/member-app.md; migration 0118).
//
// The token is Firebase's name for one app install on one phone. It can
// only receive, it is tied to the session that registered it, and it is
// silenced with that session: signing out, or a branch revoking a lost
// phone, is enough. The app registers on every start, so the same token
// arriving again is the normal case and simply refreshes the row.
import type { APIRoute } from 'astro';
import { ApiError } from '@lib/api/envelope';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { okSchema } from '@lib/member/schemas';
import {
  DeviceError,
  registerDevice,
  unregisterDevice,
} from '@lib/notifications/push';

const register = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/me/devices',
    summary: 'Register this phone for push notifications',
    description:
      "The phone's Firebase device token, tied to the caller's session. " +
      'Idempotent: the same token again refreshes the registration, and a ' +
      'token that moves to another session moves with it. 422 without a ' +
      'token or a platform.',
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['token', 'platform'],
      properties: {
        token: {
          type: 'string',
          description: 'The Firebase Cloud Messaging device token.',
        },
        platform: { type: 'string', enum: ['android', 'ios'] },
        appBuild: {
          type: 'string',
          nullable: true,
          description: 'The app version, for the record.',
        },
      },
    },
    responseSchema: okSchema,
  },
  async ({ member, correlationId, body }) => {
    const input = await body<{
      token?: unknown;
      platform?: unknown;
      appBuild?: unknown;
    }>();
    try {
      await registerDevice(member, {
        token: typeof input.token === 'string' ? input.token : '',
        platform: input.platform as 'android' | 'ios',
        appBuild: typeof input.appBuild === 'string' ? input.appBuild : null,
      });
    } catch (error) {
      if (error instanceof DeviceError) {
        throw new ApiError('validation_failed', error.message, error.details);
      }
      throw error;
    }
    return apiSuccess({ ok: true as const }, correlationId);
  }
);

const withdraw = defineMemberEndpoint(
  {
    method: 'DELETE',
    path: '/api/v1/member/me/devices',
    summary: 'Withdraw this phone from push notifications',
    description:
      "Disables the token for the caller's own session; the app calls it " +
      'before signing out. Revoking the session disables every token of ' +
      'it regardless, so this is belt and braces. Always 200.',
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['token'],
      properties: { token: { type: 'string' } },
    },
    responseSchema: okSchema,
  },
  async ({ member, correlationId, body }) => {
    const input = await body<{ token?: unknown }>();
    await unregisterDevice(
      member,
      typeof input.token === 'string' ? input.token : ''
    );
    return apiSuccess({ ok: true as const }, correlationId);
  }
);

export const descriptors = [register.descriptor, withdraw.descriptor];
export const POST: APIRoute = register.handler;
export const DELETE: APIRoute = withdraw.handler;
