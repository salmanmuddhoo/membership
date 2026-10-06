// Where the membership card earns a discount (docs/member-app.md).
//
// The active partner outlets, as an administrator wrote them on the Member
// app configuration page. Nothing here is about the caller; the session is
// asked for so the Society's partner list is not a public feed.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { activeOutlets } from '@lib/config/outlets';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/outlets',
    summary: 'Where the membership card earns a discount',
    description:
      'The active partner outlets, in the order to show them: logo, ' +
      'category tag, discount percentage, a line of description, the ' +
      "address and a link. Written on the web application's Member app " +
      'configuration page. Any session; the same for everyone.',
    tag: 'Member app',
    caller: 'member',
    responseSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'name',
          'logoUrl',
          'category',
          'discountPercent',
          'description',
          'address',
          'linkUrl',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          logoUrl: { type: 'string', description: 'The logo, https.' },
          category: {
            type: 'string',
            description:
              'A lower-case tag such as "education", "groceries" or "food".',
          },
          discountPercent: {
            type: 'string',
            description: 'Decimal string, e.g. "10.00".',
          },
          description: { type: 'string' },
          address: { type: 'string', nullable: true },
          linkUrl: {
            type: 'string',
            nullable: true,
            description: 'https, mailto or tel.',
          },
        },
      },
    },
  },
  async ({ correlationId }) =>
    apiSuccess(
      (await activeOutlets()).map(o => ({
        id: o.id,
        name: o.name,
        logoUrl: o.logoUrl,
        category: o.category,
        discountPercent: o.discountPercent,
        description: o.description,
        address: o.address,
        linkUrl: o.linkUrl,
      })),
      correlationId
    )
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
