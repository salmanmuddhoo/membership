// One account's balance, from the ledger's cache (S-1309, S-1310).
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { accountBalance } from '@lib/ledger/ledger';
import { query } from '@lib/db/pool';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/accounts/{id}/balance',
    summary: "Read one account's balance",
    description:
      'The balance the ledger holds for the account: the sum of every ' +
      'posted entry, maintained by the engine as each one posts ' +
      '(docs/ledger.md). An account nothing has ever posted to reads as ' +
      '"0.00" with no entries.',
    tag: 'Transactions',
    permission: 'payment.view',
    responseSchema: {
      type: 'object',
      required: ['accountId', 'accountNo', 'balance', 'currency', 'entryCount'],
      properties: {
        accountId: { type: 'string', format: 'uuid' },
        accountNo: { type: 'string' },
        accountTypeName: { type: 'string' },
        status: { type: 'string' },
        balance: { type: 'string' },
        currency: { type: 'string' },
        entryCount: { type: 'integer' },
        asOfSequenceNo: { type: 'integer', nullable: true },
        updatedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  },
  async ({ context, correlationId }) => {
    const id = context.params.id;
    const account = id
      ? await query<{ account_no: string; type_name: string; status: string }>(
          `select coalesce(a.account_no, m.member_no) as account_no,
                  t.name as type_name, a.status
             from account a
             join account_type t on t.id = a.account_type_id
             left join member m on m.id = a.member_id
            where a.id = $1`,
          [id]
        )
      : null;
    if (!account?.rows[0]) throw new ApiError('not_found');
    const balance = await accountBalance(id!);
    return apiSuccess(
      {
        accountId: id,
        accountNo: account.rows[0].account_no,
        accountTypeName: account.rows[0].type_name,
        status: account.rows[0].status,
        balance: balance?.balance ?? '0.00',
        currency: 'MUR',
        entryCount: balance?.entryCount ?? 0,
        asOfSequenceNo: balance?.asOfSequenceNo ?? null,
        updatedAt: balance?.updatedAt.toISOString() ?? null,
      },
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
