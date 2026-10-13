// The members who could pay a new member's fees by transfer, as their
// number or name is typed on the Payments step (officer request): each with
// every open account and what it can pay now. Guarded as transaction.capture
// (authorise.ts), the permission starting such a transfer needs.
import type { APIRoute } from 'astro';
import { payersMatching } from '@lib/payments/fee-transfers';

export const GET: APIRoute = async ({ url }) => {
  const typed = (url.searchParams.get('q') ?? '').slice(0, 80);
  const payers = typed.trim().length >= 2 ? await payersMatching(typed) : [];
  return new Response(JSON.stringify(payers), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
};
