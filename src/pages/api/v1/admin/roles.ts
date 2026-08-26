// Roles and their permissions (S-201).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { AdminError, createRole, listRoles } from '@lib/admin/roles';

const ROLE_SCHEMA = {
  type: 'object',
  required: ['id', 'code', 'name', 'isSystem', 'permissions', 'userCount'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    isSystem: { type: 'boolean' },
    permissions: { type: 'array', items: { type: 'string' } },
    userCount: { type: 'integer' },
  },
};

const list = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/admin/roles',
    summary: 'List roles',
    description:
      'Every role with the permissions it grants and how many people hold it. ' +
      'The count is what makes a refused deletion explicable.',
    tag: 'Administration',
    permission: 'role.view',
    responseSchema: { type: 'array', items: ROLE_SCHEMA },
  },
  async ({ correlationId }) => apiSuccess(await listRoles(), correlationId)
);

const create = defineEndpoint(
  {
    method: 'POST',
    path: '/api/v1/admin/roles',
    summary: 'Create a role',
    description:
      'Creates a role and grants it permissions. An unknown permission code is ' +
      'refused rather than silently granting nothing.',
    tag: 'Administration',
    permission: 'role.manage',
    requestSchema: {
      type: 'object',
      required: ['code', 'name', 'permissions'],
      properties: {
        code: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_]{2,49}$',
          examples: ['regional_manager'],
        },
        name: { type: 'string' },
        description: { type: 'string' },
        permissions: { type: 'array', items: { type: 'string' } },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } },
    },
  },
  async ({ context, principal, correlationId }) => {
    const payload = (await context.request.json().catch(() => null)) as {
      code?: string;
      name?: string;
      description?: string;
      permissions?: string[];
    } | null;

    if (
      !payload?.code ||
      !payload.name ||
      !Array.isArray(payload.permissions)
    ) {
      throw new ApiError('validation_failed', undefined, {
        body: ['code, name and permissions are required'],
      });
    }

    try {
      const id = await createRole(
        {
          code: payload.code,
          name: payload.name,
          description: payload.description,
          permissions: payload.permissions,
        },
        { userId: principal.userId, email: principal.email }
      );
      return apiSuccess({ id }, correlationId, 201);
    } catch (error) {
      if (error instanceof AdminError) {
        throw new ApiError(
          error.reason === 'duplicate' ? 'conflict' : 'validation_failed',
          error.message
        );
      }
      throw error;
    }
  }
);

export const descriptors = [list.descriptor, create.descriptor];
export const GET: APIRoute = list.handler;
export const POST: APIRoute = create.handler;
