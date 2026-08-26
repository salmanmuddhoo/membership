// The reference configuration, as the rest of the system reads it
// (M2 Feature 2.2, S-205 to S-209).
//
// Read-only. Configuration is changed through the administration screens,
// where a person can see what a fee change means before publishing it; this
// endpoint exists so the capture screens, the printed form and the external
// API of FRD Section 12 all render from one source rather than three copies.
import type { APIRoute } from 'astro';
import { defineEndpoint, apiSuccess } from '@lib/api/endpoint';
import {
  listAccountTypes,
  listChecklists,
  listDocumentTypes,
  listFeeSchedules,
  listMembershipTypes,
  listWorkflows,
  listWorkflowStatuses,
} from '@lib/config/reference';

const stringArray = { type: 'array', items: { type: 'string' } };

const membershipTypeSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'isActive', 'fields'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    checklistId: { type: 'string', format: 'uuid', nullable: true },
    feeScheduleId: { type: 'string', format: 'uuid', nullable: true },
    isActive: { type: 'boolean' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fieldKey', 'label', 'subject', 'isVisible', 'isMandatory'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          fieldKey: { type: 'string' },
          label: { type: 'string' },
          dataType: { type: 'string' },
          choices: stringArray,
          subject: {
            type: 'string',
            enum: ['applicant', 'nominee', 'guardian', 'beneficiary'],
          },
          isVisible: { type: 'boolean' },
          isMandatory: { type: 'boolean' },
          sortOrder: { type: 'integer' },
        },
      },
    },
  },
};

const feeScheduleSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'current'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    isActive: { type: 'boolean' },
    current: {
      type: 'object',
      nullable: true,
      description:
        'The version in force. Amounts are decimal strings, never numbers: ' +
        'money through a float is a rounding error waiting for a ' +
        'reconciliation to find it.',
      properties: {
        id: { type: 'string', format: 'uuid' },
        versionNo: { type: 'integer' },
        effectiveFrom: { type: 'string', format: 'date-time' },
        components: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'amount', 'requirement'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'entrance',
                  'takaful',
                  'shares',
                  'msa_deposit',
                  'processing',
                ],
              },
              amount: { type: 'string' },
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
};

const read = defineEndpoint(
  {
    method: 'GET',
    path: '/api/v1/config/reference',
    summary: 'Read the reference configuration',
    description:
      'Membership types and their field rules, account types and which one a ' +
      'membership opens, fee schedules in force, document checklists, and the ' +
      'approval workflow with its statuses. Superseded fee versions are not ' +
      'included — a caller pricing an application wants what applies now.',
    tag: 'Configuration',
    permission: 'config.view',
    responseSchema: {
      type: 'object',
      required: [
        'membershipTypes',
        'accountTypes',
        'feeSchedules',
        'documentTypes',
        'checklists',
        'workflows',
        'statuses',
      ],
      properties: {
        membershipTypes: { type: 'array', items: membershipTypeSchema },
        accountTypes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'code', 'name', 'isMembershipDefault'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              code: { type: 'string' },
              name: { type: 'string' },
              category: { type: 'string' },
              minimumOpeningAmount: { type: 'string' },
              checklistId: { type: 'string', format: 'uuid', nullable: true },
              requiresApproval: { type: 'boolean' },
              defaultStatus: { type: 'string' },
              isMembershipDefault: {
                type: 'boolean',
                description:
                  'True for exactly one active type: the account a membership ' +
                  'approval opens.',
              },
              isActive: { type: 'boolean' },
            },
          },
        },
        feeSchedules: { type: 'array', items: feeScheduleSchema },
        documentTypes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'code', 'name'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              code: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              tracksExpiry: { type: 'boolean' },
              isActive: { type: 'boolean' },
            },
          },
        },
        checklists: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'code', 'name', 'items'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              code: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              isActive: { type: 'boolean' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['documentCode', 'subject', 'requirement'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    documentTypeId: { type: 'string', format: 'uuid' },
                    documentCode: { type: 'string' },
                    documentName: { type: 'string' },
                    tracksExpiry: { type: 'boolean' },
                    subject: {
                      type: 'string',
                      enum: ['applicant', 'nominee', 'guardian', 'beneficiary'],
                    },
                    requirement: {
                      type: 'string',
                      enum: ['required', 'optional'],
                    },
                  },
                },
              },
            },
          },
        },
        workflows: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'code', 'name', 'entityType', 'steps'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              code: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              entityType: { type: 'string' },
              isActive: { type: 'boolean' },
              steps: {
                type: 'array',
                description:
                  'Every step, disabled ones included. A caller running the ' +
                  'chain uses only those with isEnabled true; an administration ' +
                  'screen shows them all.',
                items: {
                  type: 'object',
                  required: ['stepNo', 'code', 'name', 'roleId', 'isEnabled'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    stepNo: { type: 'integer' },
                    code: { type: 'string' },
                    name: { type: 'string' },
                    roleId: { type: 'string', format: 'uuid' },
                    roleName: { type: 'string' },
                    fromStatus: { type: 'string' },
                    toStatus: {
                      type: 'string',
                      description:
                        'Equal to fromStatus for a gate: a step that must be ' +
                        'acted on but does not move the record.',
                    },
                    isEnabled: { type: 'boolean' },
                    quorumCount: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
        statuses: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'entityType', 'code', 'name', 'isActive'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              entityType: { type: 'string' },
              code: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              isTerminal: { type: 'boolean' },
              isActive: { type: 'boolean' },
              sortOrder: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  async ({ correlationId }) => {
    const [
      membershipTypes,
      accountTypes,
      feeSchedules,
      documentTypes,
      checklists,
      workflows,
      statuses,
    ] = await Promise.all([
      listMembershipTypes(),
      listAccountTypes(),
      listFeeSchedules(),
      listDocumentTypes(),
      listChecklists(),
      listWorkflows(),
      listWorkflowStatuses(),
    ]);

    return apiSuccess(
      {
        membershipTypes,
        accountTypes,
        // History is deliberately dropped here: it exists so a receipt stays
        // readable, and a caller pricing an application has no use for it.
        feeSchedules: feeSchedules.map(
          ({ history: _history, ...rest }) => rest
        ),
        documentTypes,
        checklists,
        workflows,
        statuses,
      },
      correlationId
    );
  }
);

export const descriptors = [read.descriptor];
export const GET: APIRoute = read.handler;
