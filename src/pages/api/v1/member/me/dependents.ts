import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { listDependents } from '@lib/member/dependents';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/dependents',
    summary: 'The minors the caller is guardian of, with their accounts',
    description:
      'Each active minor — member or non-member account holder — whose ' +
      "guardian block names the caller, with that minor's accounts and the " +
      "ledger's balance for each. Empty for a member who guards nobody. " +
      "Read-only; a minor's transactions are under " +
      '/me/dependents/{dependentId}/accounts/{accountId}/transactions.',
    tag: 'Accounts',
    caller: 'member',
    responseSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'kind',
          'memberNo',
          'name',
          'relationship',
          'status',
          'accounts',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['member', 'customer'] },
          memberNo: { type: 'string', nullable: true },
          name: { type: 'string' },
          relationship: { type: 'string', nullable: true },
          status: { type: 'string' },
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              required: [
                'id',
                'accountNo',
                'typeCode',
                'typeName',
                'category',
                'status',
                'openedAt',
                'balance',
              ],
              properties: {
                id: { type: 'string', format: 'uuid' },
                accountNo: { type: 'string' },
                typeCode: { type: 'string' },
                typeName: { type: 'string' },
                category: { type: 'string' },
                status: { type: 'string' },
                openedAt: { type: 'string', format: 'date-time' },
                balance: {
                  type: 'string',
                  nullable: true,
                  description: 'Decimal string.',
                },
              },
            },
          },
        },
      },
    },
  },
  async ({ member, correlationId }) =>
    apiSuccess(await listDependents(member), correlationId)
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
