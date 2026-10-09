// What the deposit form offers a signed-in member (officer direction,
// October 2026; docs/member-app.md): how they may have paid — bank transfer
// or Juice, nothing else — and the Society's bank accounts with the number
// to pay to. The numbers are shown whole here, to a member who has signed
// in, and never on the public reference.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { depositOptions } from '@lib/member/transactions';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/deposit-options',
    summary: 'How a deposit from the app may be paid, and where to',
    description:
      'The ways a deposit from the app may have been paid (bank transfer ' +
      'or Juice, while the Society offers them) and its active bank ' +
      'accounts with their account numbers. touchesBank: name one of ' +
      'bankAccounts; requiresReference: give the reference of the payment. ' +
      '403 for an applicant, who holds no account.',
    tag: 'Transactions',
    caller: 'member',
    responseSchema: {
      type: 'object',
      required: ['methods', 'bankAccounts'],
      properties: {
        methods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'name', 'requiresReference', 'touchesBank'],
            properties: {
              code: { type: 'string', enum: ['bank_transfer', 'juice'] },
              name: { type: 'string' },
              requiresReference: { type: 'boolean' },
              touchesBank: { type: 'boolean' },
            },
          },
        },
        bankAccounts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'name', 'bankName', 'accountNumber'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              bankName: { type: 'string' },
              accountNumber: { type: 'string' },
            },
          },
        },
      },
    },
  },
  async ({ member, correlationId }) =>
    apiSuccess(await depositOptions(member), correlationId)
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
