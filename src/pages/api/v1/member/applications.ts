// The caller's applications: those started from their verified mobile and,
// for a member, the one that made them a member.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import {
  listMemberApplications,
  startMemberApplication,
} from '@lib/member/applications';
import { applicationSchema } from '@lib/member/schemas';

const list = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/applications',
    summary: "The caller's applications",
    tag: 'Member app',
    caller: 'member',
    responseSchema: { type: 'array', items: applicationSchema },
  },
  async ({ member, correlationId }) =>
    apiSuccess(await listMemberApplications(member), correlationId)
);

const start = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/applications',
    summary: 'Start a membership application',
    description:
      'Captured by the member-app system user and tied to the verified ' +
      "mobile, which is pre-filled as the applicant's. One in progress at a " +
      'time; a second is refused with the reference of the first.',
    tag: 'Member app',
    caller: 'member',
    requestSchema: {
      type: 'object',
      required: ['membershipTypeCode'],
      properties: { membershipTypeCode: { type: 'string' } },
    },
    responseSchema: applicationSchema,
  },
  async ({ member, body, correlationId, clientIp }) => {
    const input = await body<{ membershipTypeCode?: string }>();
    const application = await startMemberApplication(
      member,
      String(input.membershipTypeCode ?? ''),
      { ip: clientIp, correlationId }
    );
    return apiSuccess(application, correlationId);
  }
);

export const descriptors = [list.descriptor, start.descriptor];
export const GET: APIRoute = list.handler;
export const POST: APIRoute = start.handler;
