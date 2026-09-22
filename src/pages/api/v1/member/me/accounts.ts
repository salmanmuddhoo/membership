import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { memberAccounts } from '@lib/member/profile';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/accounts',
    summary: "The caller's accounts",
    description:
      "Every account the caller holds, with the ledger's balance for each " +
      '(null for an account nothing has ever posted to). Balance, history ' +
      'and statement per account are under /me/accounts/{id}.',
    tag: 'Accounts',
    caller: 'member',
    responseSchema: {
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
  async ({ member, correlationId }) =>
    apiSuccess(await memberAccounts(member), correlationId)
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
