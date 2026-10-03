// The cards on the app's home screen (docs/member-app.md).
//
// Whatever an administrator has made live on the Member app configuration
// page, in order. Nothing here is about the caller; the session is asked
// for only so the home screen's one source of content is not a public
// feed anyone can scrape for the Society's offers.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { livePromotions } from '@lib/config/promotions';

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/promotions',
    summary: 'The cards on the home screen',
    description:
      'What the Society is promoting right now: the active cards inside ' +
      'their dates, in the order to show them. Written on the web ' +
      "application's Member app configuration page. Any session, " +
      'applicant included; the same for everyone.',
    tag: 'Member app',
    caller: 'member',
    responseSchema: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'title',
          'body',
          'imageUrl',
          'linkUrl',
          'linkLabel',
          'accent',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          body: { type: 'string' },
          imageUrl: {
            type: 'string',
            nullable: true,
            description: 'A picture across the top of the card, https.',
          },
          linkUrl: {
            type: 'string',
            nullable: true,
            description:
              'Where the card goes when tapped: https, mailto or tel.',
          },
          linkLabel: { type: 'string', nullable: true },
          accent: {
            type: 'string',
            nullable: true,
            description:
              "The card's background as #rrggbb; null for the app's own.",
          },
        },
      },
    },
  },
  async ({ correlationId }) =>
    apiSuccess(
      (await livePromotions()).map(p => ({
        id: p.id,
        title: p.title,
        body: p.body,
        imageUrl: p.imageUrl,
        linkUrl: p.linkUrl,
        linkLabel: p.linkLabel,
        accent: p.accent,
      })),
      correlationId
    )
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
