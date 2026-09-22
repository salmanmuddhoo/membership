// The member-facing viewer the Phase 4 note left open: streams one of the
// caller's own filed documents from this origin, for the app to render in
// place. Scoped by ownedDocumentId exactly as /me/documents is.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint } from '@lib/member/endpoint';
import { ownedDocumentId } from '@lib/member/profile';
import { getDocumentContent } from '@lib/documents/documents';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/me/documents/{id}/content',
    summary: "One of the caller's documents: the file itself",
    description:
      'Streams the filed document from this origin, for the app to ' +
      "render in place. 404 unless the document is the caller's own " +
      '(what /me/documents lists).',
    tag: 'Member app',
    caller: 'member',
    responseSchema: { type: 'string', format: 'binary' },
  },
  async ({ member, context }) => {
    const id = await ownedDocumentId(member, String(context.params.id ?? ''));
    const { body, fileName, contentType } = await getDocumentContent(id);

    return new Response(body, {
      headers: {
        'content-type': contentType,
        // Rendered in place, never saved.
        'content-disposition': `inline; filename="${fileName.replace(/"/g, '')}"`,
        // Short-lived and personal.
        'cache-control': 'private, no-store',
        // Uploads are already held to a short allow-list (upload.ts); say
        // so outright rather than leaving it to sniffing.
        'x-content-type-options': 'nosniff',
      },
    });
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
