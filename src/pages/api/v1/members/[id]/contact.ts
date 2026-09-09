// The member/customer detail page's own edit block, saved without a page
// reload (officer feedback): the same write updateContactDetails
// (members/contact.ts) always did, reached from a fetch() instead of a
// full-page POST so the block can update in place and the rest of the
// page — payments, documents, accounts — is never re-rendered for a
// contact correction.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess, ApiError } from '@lib/api/endpoint';
import { loadMember, loadCustomer } from '@lib/members/create';
import {
  editableContactFields,
  updateContactDetails,
  ContactUpdateError,
  PERMISSION_EDIT_CONTACT,
  type ContactFieldChange,
} from '@lib/members/contact';

const endpoint = defineEndpoint(
  {
    method: 'PATCH',
    path: '/api/v1/members/{id}/contact',
    summary: 'Save contact/guardian details for a member or non-member',
    description:
      'Straight through, no draft, no approval — the same write the ' +
      'member/customer page itself makes. Only the fields that actually ' +
      'changed are written. Returns the field list refreshed with what ' +
      'was actually saved, so the page can update in place.',
    tag: 'Members',
    permission: PERMISSION_EDIT_CONTACT,
    requestSchema: {
      type: 'object',
      required: ['changes'],
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['subject', 'fieldKey', 'value'],
            properties: {
              subject: {
                type: 'string',
                enum: ['applicant', 'employment', 'guardian'],
              },
              fieldKey: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['updated', 'fields'],
      properties: {
        updated: { type: 'array', items: { type: 'string' } },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'subject',
              'fieldKey',
              'label',
              'dataType',
              'value',
              'editable',
            ],
            properties: {
              subject: {
                type: 'string',
                enum: ['applicant', 'employment', 'guardian'],
              },
              fieldKey: { type: 'string' },
              label: { type: 'string' },
              dataType: { type: 'string' },
              value: { type: 'string' },
              editable: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  async ({ principal, context, correlationId }) => {
    const id = context.params.id;
    if (!id) throw new ApiError('not_found');

    const member = await loadMember(id);
    const customer = !member ? await loadCustomer(id) : null;
    if (!member && !customer) throw new ApiError('not_found');

    const applicationId = (member ?? customer)!.applicationId;
    if (!applicationId) {
      throw new ApiError(
        'validation_failed',
        'This record has no application to save these details to.'
      );
    }

    const payload = (await context.request.json().catch(() => null)) as {
      changes?: ContactFieldChange[];
    } | null;
    const changes = payload?.changes ?? [];

    try {
      const { updated } = await updateContactDetails(
        applicationId,
        changes,
        member
          ? { entityType: 'member', entityId: member.id }
          : { entityType: 'customer', entityId: customer!.id },
        principal
      );
      const fields = await editableContactFields(applicationId);
      return apiSuccess({ updated, fields }, correlationId);
    } catch (error) {
      if (error instanceof ContactUpdateError) {
        throw new ApiError(
          error.reason === 'forbidden'
            ? 'forbidden'
            : error.reason === 'not_found'
              ? 'not_found'
              : 'validation_failed',
          error.message
        );
      }
      throw error;
    }
  }
);

export const descriptor = endpoint.descriptor;
export const PATCH: APIRoute = endpoint.handler;
