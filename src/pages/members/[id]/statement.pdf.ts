// A member's or non-member's statement as a file, for staff at their own
// page — as opposed to statements/shared/[token].pdf.ts, the signed link a
// holder themselves opens with no sign-in.
import type { APIRoute } from 'astro';
import { loadCustomer, loadMember } from '@lib/members/create';
import {
  memberStatement,
  renderMemberStatementPdf,
  statementPdfFileName,
  type Holder,
} from '@lib/ledger/member-statement';
import { statementPeriod } from '@lib/ledger/statement';

export const GET: APIRoute = async ({ params, url, locals }) => {
  // The middleware has already checked member.view for '/members/'; the
  // money itself needs account.view, same as the page this file backs.
  if (!locals.principal?.permissions.has('account.view')) {
    return new Response('Forbidden', { status: 403 });
  }

  const { id } = params;
  const member = id ? await loadMember(id) : null;
  const customer = !member && id ? await loadCustomer(id) : null;
  if (!member && !customer) {
    return new Response('Not found', { status: 404 });
  }
  const holder: Holder = member
    ? { kind: 'member', id: member.id }
    : { kind: 'customer', id: customer!.id };

  const period = statementPeriod({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  if (!period) {
    return new Response('Choose a valid period.', { status: 400 });
  }

  const statement = await memberStatement(holder, period);
  if (!statement) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(renderMemberStatementPdf(statement), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${statementPdfFileName(statement)}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
