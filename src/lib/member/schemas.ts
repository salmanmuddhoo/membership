// Response shapes shared across the member surface.
export const partySchema = {
  type: 'object',
  required: ['subject', 'ordinal', 'values'],
  properties: {
    subject: {
      type: 'string',
      enum: ['applicant', 'nominee', 'guardian', 'beneficiary', 'employment'],
    },
    ordinal: { type: 'integer', minimum: 1 },
    values: { type: 'object', additionalProperties: { type: 'string' } },
  },
};

export const applicationSchema = {
  type: 'object',
  required: [
    'id',
    'reference',
    'status',
    'membershipTypeCode',
    'membershipTypeName',
    'parties',
    'documents',
    'submittedAt',
    'decidedAt',
    'updatedAt',
    'timeline',
    'returnComment',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    reference: { type: 'string' },
    status: {
      type: 'string',
      description:
        "The application's workflow status. 'received' is submitted from the phone and with the branch.",
    },
    membershipTypeCode: { type: 'string' },
    membershipTypeName: { type: 'string' },
    parties: { type: 'array', items: partySchema },
    documents: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'checklistItemId',
          'documentCode',
          'documentName',
          'requirement',
          'status',
          'fileName',
          'rejectionReason',
        ],
        properties: {
          checklistItemId: { type: 'string' },
          documentCode: { type: 'string' },
          documentName: { type: 'string' },
          requirement: { type: 'string', enum: ['required', 'optional'] },
          status: {
            type: 'string',
            enum: ['missing', 'pending', 'filed', 'verified', 'rejected'],
          },
          fileName: { type: 'string', nullable: true },
          rejectionReason: { type: 'string', nullable: true },
        },
      },
    },
    submittedAt: { type: 'string', format: 'date-time', nullable: true },
    decidedAt: { type: 'string', format: 'date-time', nullable: true },
    updatedAt: { type: 'string', format: 'date-time' },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        required: ['at', 'label', 'comment'],
        properties: {
          at: { type: 'string', format: 'date-time' },
          label: { type: 'string' },
          comment: { type: 'string', nullable: true },
        },
      },
    },
    returnComment: { type: 'string', nullable: true },
  },
};

export const okSchema = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean', enum: [true] } },
};

// --- auth ---------------------------------------------------------------
export const challengeSchema = {
  type: 'object',
  required: ['challengeId', 'purpose', 'sentTo', 'expiresInSeconds'],
  properties: {
    challengeId: { type: 'string', format: 'uuid' },
    purpose: { type: 'string', enum: ['link_member', 'sign_up'] },
    sentTo: {
      type: 'string',
      nullable: true,
      description:
        'Masked, e.g. +2305xxx234, for a sign-up. Always null for a link: the code went to the mobile on record, and saying which would confirm the pair named someone.',
    },
    expiresInSeconds: { type: 'integer' },
  },
};

export const sessionSchema = {
  type: 'object',
  required: ['accessToken', 'refreshToken', 'expiresInSeconds', 'identity'],
  properties: {
    accessToken: { type: 'string', description: 'Bearer token; short-lived.' },
    refreshToken: {
      type: 'string',
      description: 'Rotated on every use; revocable.',
    },
    expiresInSeconds: { type: 'integer' },
    identity: {
      type: 'object',
      required: ['kind', 'memberNo', 'displayName', 'mobile', 'linkedAt'],
      properties: {
        kind: { type: 'string', enum: ['member', 'customer', 'applicant'] },
        memberNo: { type: 'string', nullable: true },
        displayName: { type: 'string' },
        mobile: { type: 'string', description: 'E.164' },
        linkedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};
