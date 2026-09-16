// An application submitted from Albarakah.mu (S-908).
import type { APIRoute } from 'astro';
import { apiSuccess } from '@lib/api/envelope';
import { SCOPE_APPLICATIONS_SUBMIT } from '@lib/api/credentials';
import { defineIntegrationEndpoint } from '@lib/api/integration-endpoint';
import {
  submitPublicApplication,
  type PublicApplicationInput,
} from '@lib/api/public-applications';

const endpoint = defineIntegrationEndpoint(
  {
    method: 'POST',
    path: '/api/v1/public/applications',
    summary: 'Submit a membership application from the public website',
    description:
      'Creates the application through the same service the staff screens ' +
      'use, so the two cannot diverge. It lands in the branch queue as ' +
      '`received`: a website can neither file the signed form nor take the ' +
      'payment, so an officer completes the document checklist and submits ' +
      'it into the approval chain. Fields are validated against the ' +
      "membership type's current configuration; documents are not, because " +
      'they are collected at the branch. Only the reference is returned.',
    tag: 'Public website',
    caller: 'integration',
    scope: SCOPE_APPLICATIONS_SUBMIT,
    requestSchema: {
      type: 'object',
      required: ['membershipTypeCode', 'parties'],
      properties: {
        membershipTypeCode: {
          type: 'string',
          description:
            'A membership type the Society currently accepts, e.g. ' +
            '`individual`. Read them from /api/v1/member/reference.',
        },
        parties: {
          type: 'array',
          description:
            'One entry per person on the form. The applicant (subject ' +
            '`applicant`, ordinal 1) is required; a nominee or guardian is ' +
            'sent the same way when the type configures one. Fields the type ' +
            'does not configure are ignored rather than refused.',
          items: {
            type: 'object',
            required: ['subject', 'ordinal', 'values'],
            properties: {
              subject: {
                type: 'string',
                enum: [
                  'applicant',
                  'nominee',
                  'guardian',
                  'beneficiary',
                  'employment',
                ],
              },
              ordinal: { type: 'integer', minimum: 1 },
              values: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description:
                  'Keyed by field key, e.g. `name`, `surname`, `mobile`, ' +
                  '`nic`. A telephone number is converted to international ' +
                  'form on the way in.',
              },
            },
          },
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['reference', 'status'],
      properties: {
        reference: {
          type: 'string',
          description:
            'Quote this to the Society. It is the only identifier a public ' +
            'caller is given.',
        },
        status: { type: 'string', enum: ['received'] },
      },
    },
  },
  async ({ credential, correlationId, clientIp, body }) => {
    const input = await body<PublicApplicationInput>();
    const result = await submitPublicApplication(input, credential, {
      correlationId,
      ip: clientIp,
    });
    return apiSuccess(result, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const POST: APIRoute = endpoint.handler;
