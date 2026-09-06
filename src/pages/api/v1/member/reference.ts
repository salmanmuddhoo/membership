// What a person can apply for, from the phone (docs/member-app.md).
//
// The membership types and their field configuration exactly as the
// officer's capture screen renders them (config/reference), with the
// applicant-facing checklist and the fees in force. Public: nothing here is
// about anyone. Nothing else from the reference configuration is exposed —
// no workflows, no account types, no administration detail.
import type { APIRoute } from 'astro';
import { defineMemberEndpoint, apiSuccess } from '@lib/member/endpoint';
import { checklistItemId } from '@lib/member/applications';
import {
  listChecklists,
  listFeeSchedules,
  listMembershipTypes,
} from '@lib/config/reference';
import { COMPONENT_LABELS } from '@lib/payments/payments';

const BRANCH_ONLY_DOCUMENTS = new Set(['signed_form']);

const endpoint = defineMemberEndpoint(
  {
    method: 'GET',
    path: '/api/v1/member/reference',
    summary: 'Read the membership types a person can apply for',
    description:
      'Active membership types with their field configuration, the ' +
      'documents an applicant files from the phone (the signed form is a ' +
      'branch step and is left out), and the fees in force. Public.',
    tag: 'Member app',
    caller: 'public',
    responseSchema: {
      type: 'object',
      required: ['membershipTypes'],
      properties: {
        membershipTypes: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'id',
              'code',
              'name',
              'isActive',
              'fields',
              'nomineeCount',
              'checklist',
              'fees',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              code: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              isActive: { type: 'boolean' },
              nomineeCount: { type: 'integer' },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  required: [
                    'id',
                    'fieldKey',
                    'label',
                    'dataType',
                    'choices',
                    'subject',
                    'isVisible',
                    'isMandatory',
                    'sortOrder',
                  ],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    fieldKey: { type: 'string' },
                    label: { type: 'string' },
                    dataType: {
                      type: 'string',
                      enum: [
                        'text',
                        'number',
                        'date',
                        'email',
                        'phone',
                        'choice',
                      ],
                    },
                    choices: { type: 'array', items: { type: 'string' } },
                    subject: {
                      type: 'string',
                      enum: [
                        'applicant',
                        'nominee',
                        'guardian',
                        'beneficiary',
                        'employment',
                      ],
                    },
                    isVisible: { type: 'boolean' },
                    isMandatory: { type: 'boolean' },
                    sortOrder: { type: 'integer' },
                  },
                },
              },
              checklist: {
                type: 'array',
                items: {
                  type: 'object',
                  required: [
                    'id',
                    'documentCode',
                    'documentName',
                    'subject',
                    'requirement',
                    'tracksExpiry',
                    'sortOrder',
                  ],
                  properties: {
                    id: {
                      type: 'string',
                      description:
                        'Opaque; what begin-upload takes as checklistItemId.',
                    },
                    documentCode: { type: 'string' },
                    documentName: { type: 'string' },
                    subject: { type: 'string' },
                    requirement: {
                      type: 'string',
                      enum: ['required', 'optional'],
                    },
                    tracksExpiry: { type: 'boolean' },
                    sortOrder: { type: 'integer' },
                  },
                },
              },
              fees: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['code', 'name', 'amount', 'requirement'],
                  properties: {
                    code: { type: 'string' },
                    name: { type: 'string' },
                    amount: {
                      type: 'string',
                      description: 'Decimal string, never a number.',
                    },
                    requirement: {
                      type: 'string',
                      enum: ['required', 'optional', 'not_applicable'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  async ({ correlationId }) => {
    const [types, checklists, schedules] = await Promise.all([
      listMembershipTypes(),
      listChecklists(),
      listFeeSchedules(),
    ]);

    const membershipTypes = types
      .filter(t => t.isActive)
      .map(t => {
        const checklist = checklists.find(c => c.id === t.checklistId);
        const schedule = schedules.find(s => s.id === t.feeScheduleId);
        return {
          id: t.id,
          code: t.code,
          name: t.name,
          description: t.description,
          isActive: t.isActive,
          nomineeCount: t.nomineeCount,
          fields: t.fields.map(f => ({
            id: f.id,
            fieldKey: f.fieldKey,
            label: f.label,
            dataType: f.dataType,
            choices: f.choices,
            subject: f.subject,
            isVisible: f.isVisible,
            isMandatory: f.isMandatory,
            sortOrder: f.sortOrder,
          })),
          checklist: (checklist?.items ?? [])
            .filter(i => !BRANCH_ONLY_DOCUMENTS.has(i.documentCode))
            .map(i => ({
              id: checklistItemId(i.documentTypeId, i.subject),
              documentCode: i.documentCode,
              documentName: i.documentName,
              subject: i.subject,
              requirement: i.requirement,
              tracksExpiry: i.tracksExpiry,
              sortOrder: i.sortOrder,
            })),
          fees: (schedule?.current?.components ?? []).map(c => ({
            code: c.code,
            name: COMPONENT_LABELS[c.code] ?? c.code,
            amount: c.amount,
            requirement: c.requirement,
          })),
        };
      });

    return apiSuccess({ membershipTypes }, correlationId);
  }
);

export const descriptor = endpoint.descriptor;
export const GET: APIRoute = endpoint.handler;
