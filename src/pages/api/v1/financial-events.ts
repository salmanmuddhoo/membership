// The financial event stream (S-504).
//
// Phase 3 posts these to an accounting system. It is a stream rather than a
// report because a consumer needs to know what it has already seen: each event
// carries an ordinal to checkpoint on, and asking for everything after that
// ordinal is the whole protocol.
//
// Events are never edited. A payment that was wrong produces a further event —
// a refund or a void — and the original stands, so a consumer that has already
// posted an event never has to unpost it.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { financialEventsSince } from '@lib/payments/payments';

const endpoint = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/financial-events',
    summary: 'Read financial events in order',
    description:
      'Returns events with a sequence number greater than `after`, oldest ' +
      'first. Record the highest sequenceNo you have processed and pass it ' +
      'back as `after` next time. Amounts are decimal strings, never ' +
      'numbers.',
    tag: 'Payments',
    permission: 'payment.view',
    responseSchema: {
      type: 'object',
      required: ['events'],
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'sequenceNo',
              'eventType',
              'paymentId',
              'receiptNo',
              'occurredAt',
              'payload',
            ],
            properties: {
              sequenceNo: { type: 'integer' },
              eventType: {
                type: 'string',
                enum: [
                  'payment.recorded',
                  'payment.refunded',
                  'payment.voided',
                ],
              },
              paymentId: { type: 'string', format: 'uuid' },
              receiptNo: { type: 'string' },
              occurredAt: { type: 'string', format: 'date-time' },
              payload: {
                type: 'object',
                description:
                  'The event in full: fee version, components, amounts, ' +
                  'method and who recorded it. Self-contained, so a ' +
                  'consumer never has to join back into tables that have ' +
                  'moved on.',
              },
            },
          },
        },
      },
    },
  },
  async ({ context, correlationId }) => {
    const params = context.url.searchParams;

    const after = Number(params.get('after') ?? '0');
    if (!Number.isInteger(after) || after < 0) {
      throw new ApiError('validation_failed', undefined, {
        after: ['must be a sequence number you have already processed'],
      });
    }

    const limit = Number(params.get('limit') ?? '100');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError('validation_failed', undefined, {
        limit: ['must be between 1 and 500'],
      });
    }

    return apiSuccess(
      { events: await financialEventsSince(after, limit) },
      correlationId
    );
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
