import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import {
  deleteMemberDraft,
  getMemberApplication,
} from '@lib/member/applications';
import { applicationSchema, okSchema } from '@lib/member/schemas';

const get = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/applications/{id}',
    summary: 'Read one of the caller’s applications',
    tag: 'Member app',
    caller: 'member',
    responseSchema: applicationSchema,
  },
  async ({ member, context, correlationId }) =>
    apiSuccess(
      await getMemberApplication(member, String(context.params.id ?? '')),
      correlationId
    )
);

const remove = defineMemberEndpoint(
  {
    method: 'DELETE',
    path: '/api/v1/member/applications/{id}',
    summary: 'Delete a draft',
    description: 'Draft only. Anything submitted has a history that is kept.',
    tag: 'Member app',
    caller: 'member',
    responseSchema: okSchema,
  },
  async ({ member, context, correlationId }) => {
    await deleteMemberDraft(member, String(context.params.id ?? ''));
    return apiSuccess({ ok: true as const }, correlationId);
  }
);

export const descriptors = [get.descriptor, remove.descriptor];
export const GET: APIRoute = get.handler;
export const DELETE: APIRoute = remove.handler;
