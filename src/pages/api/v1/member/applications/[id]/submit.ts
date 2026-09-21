// Submit from the phone. Lands on 'received': the branch completes the
// signed form and payment and submits it into the chain.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { submitMemberApplication } from '@lib/member/applications';
import { applicationSchema } from '@lib/member/schemas';

const endpoint = defineMemberEndpoint(
  {
    method: 'POST',
    path: '/api/v1/member/applications/{id}/submit',
    summary: 'Submit for the branch to take up',
    description:
      'Refused with every blank mandatory field, unplaceable phone and ' +
      'missing required document named at once (details keyed ' +
      'subject.ordinal.fieldKey or document.<code>). On success the status ' +
      "is 'received'.",
    tag: 'Member app',
    caller: 'member',
    responseSchema: applicationSchema,
  },
  async ({ member, context, correlationId, clientIp }) =>
    apiSuccess(
      await submitMemberApplication(member, String(context.params.id ?? ''), {
        ip: clientIp,
        correlationId,
      }),
      correlationId
    )
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
