// A member's statement as a file, on the signed link it was sent with: no
// sign-in, one holder, one period, thirty days. What an email attachment or
// a WhatsApp document is fetched from at send time, and what the member
// opens from the link in the message (src/lib/ledger/member-statement.ts).
import type { APIRoute } from 'astro';
import {
  memberStatement,
  renderMemberStatementPdf,
  statementPdfFileName,
  verifyStatementToken,
} from '@lib/ledger/member-statement';

export const GET: APIRoute = async ({ params }) => {
  const named = params.token ? await verifyStatementToken(params.token) : null;
  const statement = named
    ? await memberStatement(named.holder, named.period)
    : null;
  if (!statement) {
    return new Response('This link has expired or is not valid.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(renderMemberStatementPdf(statement), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${statementPdfFileName(statement)}"`,
      // Personal, and reachable by anyone holding the link: never in a
      // shared cache.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
