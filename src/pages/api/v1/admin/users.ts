// Staff accounts and the roles they hold (S-202, S-204).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import {
  AdminError,
  listUsers,
  setUserActive,
  setUserRoles,
  USER_PAGE_LIMIT,
} from '@lib/admin/roles';

const list = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/admin/users',
    summary: 'List staff accounts',
    description:
      'Every account, its roles, whether it is active, and whether the person ' +
      'has yet signed in — an account created by email binds to an Entra ' +
      'identity on first sign-in.',
    tag: 'Administration',
    permission: 'user.view',
    query: [
      {
        name: 'q',
        description:
          'Case-insensitive substring matched against name and email. ' +
          `The response is capped at ${USER_PAGE_LIMIT} accounts, so this ` +
          'is how a caller reaches the ones beyond the cap.',
        schema: { type: 'string' },
      },
    ],
    responseSchema: {
      type: 'object',
      required: ['users', 'total', 'truncated'],
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'id',
              'email',
              'displayName',
              'isActive',
              'hasSignedIn',
              'roles',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string' },
              displayName: { type: 'string' },
              isActive: { type: 'boolean' },
              hasSignedIn: { type: 'boolean' },
              roles: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        total: {
          type: 'integer',
          description: 'Accounts matching the search, before the cap.',
        },
        truncated: {
          type: 'boolean',
          description: 'True when the cap hid some of the matches.',
        },
      },
    },
  },
  async ({ context, correlationId }) =>
    apiSuccess(
      await listUsers({
        search: context.url.searchParams.get('q') ?? undefined,
      }),
      correlationId
    )
);

const update = defineEndpoint(
  {
    method: 'PATCH',
    path: '/api/v1/admin/users',
    summary: "Change a user's roles or active state",
    description:
      'Roles are replaced wholesale, so the request states the intended final ' +
      'set. Deactivation never deletes: audit rows and approvals point at the ' +
      'person for longer than their employment lasts.',
    tag: 'Administration',
    permission: 'user.manage',
    requestSchema: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string', format: 'uuid' },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'The complete intended set of role codes.',
        },
        isActive: { type: 'boolean' },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['updated'],
      properties: { updated: { type: 'boolean' } },
    },
  },
  async ({ context, principal, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      userId?: string;
      roles?: string[];
      isActive?: boolean;
    } | null;

    if (!payload?.userId) {
      throw new ApiError('validation_failed', undefined, {
        userId: ['is required'],
      });
    }

    if (payload.roles === undefined && payload.isActive === undefined) {
      throw new ApiError('validation_failed', 'Nothing to change.', {
        body: ['provide roles, isActive, or both'],
      });
    }

    const actor = { userId: principal.userId, email: principal.email };

    try {
      if (payload.roles !== undefined) {
        await setUserRoles(payload.userId, payload.roles, actor);
      }
      if (payload.isActive !== undefined) {
        await setUserActive(payload.userId, payload.isActive, actor);
      }
      return apiSuccess({ updated: true }, correlationId);
    } catch (error) {
      if (error instanceof AdminError) {
        throw new ApiError(
          error.reason === 'not_found' ? 'not_found' : 'validation_failed',
          error.message
        );
      }
      throw error;
    }
  }
);

export const descriptors = [list.descriptor, update.descriptor];
export const GET: APIRoute = list.handler;
export const PATCH: APIRoute = update.handler;
