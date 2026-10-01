// Suggestions for the Deposit, Withdrawal and Transfer lookups (officer
// feedback): the accounts of the chosen type whose number starts with, or
// whose holder's name holds, what has been typed so far. Read by the list
// under the box (src/lib/client/account-suggest.ts); guarded as
// transaction.capture, the permission of the pages that use it.
import type { APIRoute } from 'astro';
import { suggestAccounts } from '@lib/ledger/lookup';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ url }) => {
  const type = url.searchParams.get('type') ?? '';
  const typed = (url.searchParams.get('q') ?? '').slice(0, 80);
  const matches =
    UUID.test(type) && typed.trim().length >= 2
      ? await suggestAccounts(type, typed)
      : [];
  return new Response(
    JSON.stringify(
      matches.map(m => ({
        accountId: m.accountId,
        accountNo: m.accountNo,
        holderId: m.holderId,
        holderName: m.holderName,
      }))
    ),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    }
  );
};
