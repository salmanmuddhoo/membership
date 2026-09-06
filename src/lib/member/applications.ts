// A membership application made from the phone (docs/member-app.md).
//
// The same application the officer captures — same table, same parties,
// same field configuration, same checklist, same submission checks — with
// two differences. It is captured by a system user rather than an officer,
// and tied to the applicant's verified mobile; and submitting it lands on
// 'received' rather than 'new', because the officer's own submit requires a
// signed form and a payment that only the branch can produce. From there an
// officer works it exactly as a returned one: checks the documents, prints
// the form for signing, takes the payment, submits it into the chain.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { ApiError } from '../api/envelope';
import {
  deleteDraftApplication,
  loadApplication,
  problemsBlockingSubmission,
  saveDraft,
  startApplication,
  visibleFields,
  type Actor,
  type Application,
  type MembershipApplication,
  type PartyValues,
} from '../applications/capture';
import { listMembershipTypes, type FieldSubject } from '../config/reference';
import { query, withTransaction } from '../db/pool';
import {
  beginUpload,
  checklistFor,
  commitUpload,
  type ChecklistEntry,
} from '../documents/documents';
import type { MemberPrincipal, RequestOrigin } from './identity';
import { maskMobile } from './otp';
import { memberDocumentState } from './profile';

// Submitted from the phone; the branch takes it from here. Seeded by
// migration 0039 as configuration, the same as every other status.
export const RECEIVED_STATUS = 'received';
export const ACTION_RECEIVED = 'membership.application.received';

// The applicant may still change it. Once the branch has it ('received'
// and beyond) they may not: an officer may be working on it.
const APPLICANT_EDITABLE = new Set(['draft', 'returned']);

// The signed form is a branch step: the applicant signs the printed form
// when they pay. It is on the checklist for the officer, not for the phone.
const BRANCH_ONLY_DOCUMENTS = new Set(['signed_form']);

// --- The system user the app captures as -----------------------------------

const SYSTEM_SUBJECT = 'system:member-app';
let systemUserId: Promise<string> | undefined;

async function systemUser(): Promise<string> {
  systemUserId ??= query<{ id: string }>(
    `select id from app_user where entra_subject = $1`,
    [SYSTEM_SUBJECT]
  ).then(result => {
    const id = result.rows[0]?.id;
    if (!id) {
      systemUserId = undefined;
      throw new Error(
        'The member-app system user is missing; migration 0039 has not been applied.'
      );
    }
    return id;
  });
  return systemUserId;
}

// What the audit trail records for an action from the phone: the system
// user, described by the (masked) mobile that did it.
async function actorFor(principal: MemberPrincipal): Promise<Actor> {
  return {
    userId: await systemUser(),
    email: `member-app:${maskMobile(principal.mobile)}`,
  };
}

// deleteDraftApplication takes a staff Principal and checks one permission
// on it. The system user holds none — it cannot reach a page — so this is
// the narrowest thing that satisfies that check, built here and nowhere
// else, for that one call.
async function deletingPrincipal(
  principal: MemberPrincipal
): Promise<Principal> {
  const actor = await actorFor(principal);
  return {
    userId: actor.userId,
    entraSubject: SYSTEM_SUBJECT,
    email: actor.email,
    displayName: 'Member app',
    roles: [],
    roleNames: [],
    permissions: new Set(['application.capture']),
  };
}

// --- What the phone sees ---------------------------------------------------

export type MemberApplicationStatus =
  | 'draft'
  | 'received'
  | 'new'
  | 'submitted_for_review'
  | 'returned'
  | 'approved'
  | 'rejected';

export interface ApplicationDocumentView {
  // `${documentTypeId}:${subject}` — what begin-upload takes back.
  checklistItemId: string;
  documentCode: string;
  documentName: string;
  requirement: 'required' | 'optional';
  status: 'missing' | 'pending' | 'filed' | 'verified' | 'rejected';
  fileName: string | null;
  rejectionReason: string | null;
}

export interface TimelineEntry {
  at: string;
  label: string;
  comment: string | null;
}

export interface MemberApplicationView {
  id: string;
  reference: string;
  status: string;
  membershipTypeCode: string;
  membershipTypeName: string;
  parties: PartyValues[];
  documents: ApplicationDocumentView[];
  submittedAt: string | null;
  decidedAt: string | null;
  updatedAt: string;
  timeline: TimelineEntry[];
  returnComment: string | null;
}

export function checklistItemId(documentTypeId: string, subject: FieldSubject) {
  return `${documentTypeId}:${subject}`;
}

export function documentView(entry: ChecklistEntry): ApplicationDocumentView {
  return {
    checklistItemId: checklistItemId(entry.documentTypeId, entry.subject),
    documentCode: entry.documentCode,
    documentName: entry.documentName,
    requirement: entry.requirement,
    status:
      entry.state === 'missing' ? 'missing' : memberDocumentState(entry.state),
    fileName: entry.fileName,
    rejectionReason:
      entry.state === 'expired'
        ? 'This document has expired.'
        : entry.rejectionReason,
  };
}

// What each status change means to the applicant. Officer names never
// appear; a review comment does only where it was written for the
// applicant to act on (a return) or to know (a rejection).
function timelineLabel(
  fromStatus: string | null,
  toStatus: string,
  stepCode: string | null
) {
  if (fromStatus === toStatus) {
    return stepCode === 'regional_review'
      ? 'Checked by the regional office'
      : 'Reviewed';
  }
  switch (toStatus) {
    case 'received':
      return 'Submitted';
    case 'new':
      return 'Received by the branch';
    case 'submitted_for_review':
    case 'submitted_for_approval':
      return 'Under review';
    case 'abeyance':
      return 'On hold';
    case 'returned':
      return 'Returned for correction';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Not approved';
    default:
      return toStatus.replace(/_/g, ' ');
  }
}

async function timelineFor(
  application: Application
): Promise<{ timeline: TimelineEntry[]; returnComment: string | null }> {
  const [started, transitions] = await Promise.all([
    query<{ created_at: Date }>(
      `select created_at from membership_application where id = $1`,
      [application.id]
    ),
    query<{
      from_status: string | null;
      to_status: string;
      step_code: string | null;
      comment: string | null;
      occurred_at: Date;
    }>(
      `select from_status, to_status, step_code, comment, occurred_at
         from application_transition
        where application_id = $1
        order by occurred_at, id`,
      [application.id]
    ),
  ]);

  const timeline: TimelineEntry[] = [
    {
      at: (started.rows[0]?.created_at ?? application.updatedAt).toISOString(),
      label: 'Started',
      comment: null,
    },
  ];
  let returnComment: string | null = null;
  for (const t of transitions.rows) {
    const showComment =
      t.to_status === 'returned' || t.to_status === 'rejected';
    timeline.push({
      at: t.occurred_at.toISOString(),
      label: timelineLabel(t.from_status, t.to_status, t.step_code),
      comment: showComment ? t.comment : null,
    });
    if (t.to_status === 'returned') returnComment = t.comment;
  }
  if (application.status !== 'returned') returnComment = null;

  return { timeline, returnComment };
}

async function viewOf(
  application: Application
): Promise<MemberApplicationView> {
  if (application.applicationKind !== 'membership') {
    throw new ApiError('not_found', 'That application no longer exists.');
  }
  const [checklist, history] = await Promise.all([
    checklistFor({ applicationId: application.id }),
    timelineFor(application),
  ]);
  return {
    id: application.id,
    reference: application.reference,
    status: application.status,
    membershipTypeCode: application.membershipTypeCode,
    membershipTypeName: application.membershipTypeName,
    parties: application.parties,
    documents: checklist
      .filter(e => !BRANCH_ONLY_DOCUMENTS.has(e.documentCode))
      .map(documentView),
    submittedAt: application.submittedAt?.toISOString() ?? null,
    decidedAt: application.decidedAt?.toISOString() ?? null,
    updatedAt: application.updatedAt.toISOString(),
    ...history,
  };
}

// --- Ownership --------------------------------------------------------------

// The caller's own applications: those started from their verified mobile,
// plus, for a member, the one that made them a member. Nothing else exists
// as far as this session is concerned.
async function ownedIds(principal: MemberPrincipal): Promise<string[]> {
  const result = await query<{ id: string }>(
    `select a.id
       from membership_application a
      where a.applicant_mobile = $1
         or ($2::uuid is not null
             and a.id = (select application_id from member where id = $2::uuid))
      order by a.updated_at desc`,
    [principal.mobile, principal.memberId]
  );
  return result.rows.map(r => r.id);
}

async function loadOwned(
  principal: MemberPrincipal,
  applicationId: string
): Promise<MembershipApplication> {
  if (!isUuid(applicationId)) {
    throw new ApiError('not_found', 'That application no longer exists.');
  }
  const owned = await query<{ n: number }>(
    `select count(*)::int as n
       from membership_application a
      where a.id = $1
        and (a.applicant_mobile = $2
             or ($3::uuid is not null
                 and a.id = (select application_id from member where id = $3::uuid)))`,
    [applicationId, principal.mobile, principal.memberId]
  );
  if (owned.rows[0].n === 0) {
    throw new ApiError('not_found', 'That application no longer exists.');
  }
  const application = await loadApplication(applicationId);
  if (!application || application.applicationKind !== 'membership') {
    throw new ApiError('not_found', 'That application no longer exists.');
  }
  return application;
}

function assertApplicantMayEdit(application: Application): void {
  if (!APPLICANT_EDITABLE.has(application.status)) {
    throw new ApiError(
      'conflict',
      'This application has been submitted and can no longer be changed.'
    );
  }
}

// --- Reading ----------------------------------------------------------------

export async function listMemberApplications(
  principal: MemberPrincipal
): Promise<MemberApplicationView[]> {
  const ids = await ownedIds(principal);
  const views: MemberApplicationView[] = [];
  for (const id of ids) {
    const application = await loadApplication(id);
    if (application?.applicationKind === 'membership') {
      views.push(await viewOf(application));
    }
  }
  return views;
}

export async function getMemberApplication(
  principal: MemberPrincipal,
  applicationId: string
): Promise<MemberApplicationView> {
  return viewOf(await loadOwned(principal, applicationId));
}

// --- Starting, saving, deleting --------------------------------------------

export async function startMemberApplication(
  principal: MemberPrincipal,
  membershipTypeCode: string,
  origin: RequestOrigin
): Promise<MemberApplicationView> {
  const open = await query<{ reference: string }>(
    `select reference from membership_application
      where applicant_mobile = $1
        and status not in ('approved', 'rejected')
      order by created_at
      limit 1`,
    [principal.mobile]
  );
  if (open.rows[0]) {
    throw new ApiError(
      'conflict',
      `You already have an application in progress (${open.rows[0].reference}).`
    );
  }

  const actor = await actorFor(principal);
  const { id } = await startApplication(
    String(membershipTypeCode ?? ''),
    actor
  );

  // Tie the row to the verified mobile, and put that number on the form:
  // it is the one detail the backend already knows to be true.
  await withTransaction(async client => {
    await client.query(
      `update membership_application set applicant_mobile = $2 where id = $1`,
      [id, principal.mobile]
    );
    await client.query(
      `update application_party
          set values = values || jsonb_build_object('mobile', $2::text)
        where application_id = $1 and subject = 'applicant' and ordinal = 1`,
      [id, principal.mobile]
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'membership.application.started_online',
        entityType: 'membership_application',
        entityId: id,
        newValue: { sessionId: principal.sessionId },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      },
      client
    );
  });

  return getMemberApplication(principal, id);
}

export async function saveMemberApplication(
  principal: MemberPrincipal,
  applicationId: string,
  parties: PartyValues[]
): Promise<MemberApplicationView> {
  const application = await loadOwned(principal, applicationId);
  assertApplicantMayEdit(application);

  const type = (await listMembershipTypes()).find(
    t => t.id === application.membershipTypeId
  );
  if (!type) throw new ApiError('not_found', 'Unknown membership type.');
  const configured = visibleFields(type);

  // Only parties the application has, only fields the type configures, and
  // the applicant's mobile is the session's whatever was sent.
  const accepted: PartyValues[] = [];
  for (const incoming of Array.isArray(parties) ? parties : []) {
    const existing = application.parties.find(
      p => p.subject === incoming?.subject && p.ordinal === incoming?.ordinal
    );
    const fields = configured.get(incoming?.subject as FieldSubject);
    if (!existing || !fields) continue;
    const values: Record<string, string> = {};
    for (const field of fields) {
      const raw = incoming.values?.[field.fieldKey];
      if (raw !== undefined && raw !== null)
        values[field.fieldKey] = String(raw);
    }
    if (
      existing.subject === 'applicant' &&
      fields.some(f => f.fieldKey === 'mobile')
    ) {
      values.mobile = principal.mobile;
    }
    accepted.push({
      subject: existing.subject,
      ordinal: existing.ordinal,
      values,
    });
  }

  // A draft save keeps whatever was typed; format problems are reported at
  // submit, not here (S-302).
  await saveDraft(applicationId, accepted, await actorFor(principal));
  return getMemberApplication(principal, applicationId);
}

export async function deleteMemberDraft(
  principal: MemberPrincipal,
  applicationId: string
): Promise<void> {
  const application = await loadOwned(principal, applicationId);
  if (application.status !== 'draft') {
    throw new ApiError('conflict', 'Only a draft can be deleted.');
  }
  await deleteDraftApplication(
    applicationId,
    await deletingPrincipal(principal)
  );
}

// --- Documents --------------------------------------------------------------

export interface UploadTicketView {
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  acceptedTypes: string[];
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/pdf',
];

export async function beginMemberUpload(
  principal: MemberPrincipal,
  applicationId: string,
  input: {
    checklistItemId: string;
    fileName: string;
    sizeBytes: number;
    contentType: string;
  }
): Promise<UploadTicketView> {
  const application = await loadOwned(principal, applicationId);
  assertApplicantMayEdit(application);

  const [documentTypeId, subject] = String(input.checklistItemId ?? '').split(
    ':'
  );
  const checklist = await checklistFor({ applicationId });
  const item = checklist.find(
    e =>
      e.documentTypeId === documentTypeId &&
      e.subject === subject &&
      !BRANCH_ONLY_DOCUMENTS.has(e.documentCode)
  );
  if (!item) {
    throw new ApiError('not_found', 'That document is not on this checklist.');
  }
  if (item.tracksExpiry) {
    // Expiry is set by the officer who verifies it, from the document itself.
  }

  const result = await beginUpload(
    {
      applicationId,
      documentTypeId: item.documentTypeId,
      subject: item.subject,
      fileName: String(input.fileName ?? 'document'),
      contentType: String(input.contentType ?? ''),
      sizeBytes: Number(input.sizeBytes ?? 0),
      // A document that tracks expiry gets its date from the officer who
      // verifies it, reading the document — not from the phone.
      expiresAt: null,
    },
    await actorFor(principal)
  );

  return {
    uploadId: result.versionId,
    uploadUrl: result.ticket.uploadUrl,
    expiresAt: new Date(result.ticket.expiresAt).toISOString(),
    maxBytes: MAX_UPLOAD_BYTES,
    acceptedTypes: ACCEPTED_TYPES,
  };
}

export async function commitMemberUpload(
  principal: MemberPrincipal,
  applicationId: string,
  uploadId: string
): Promise<MemberApplicationView> {
  await loadOwned(principal, applicationId);
  // The version must be one of this application's: a session cannot commit
  // another applicant's upload by guessing its id.
  const owned = await query<{ n: number }>(
    `select count(*)::int as n
       from document_version v
       join document d on d.id = v.document_id
      where v.id = $1::uuid and d.application_id = $2::uuid`,
    [isUuid(uploadId) ? uploadId : null, applicationId]
  );
  if (owned.rows[0].n === 0) {
    throw new ApiError('not_found', 'That upload was not started here.');
  }
  await commitUpload(uploadId, await actorFor(principal));
  return getMemberApplication(principal, applicationId);
}

// --- Submitting -------------------------------------------------------------

/**
 * Submit: every blank mandatory field, every phone that cannot be placed and
 * every required document not filed, all named in one answer. On success the
 * application is 'received' — the branch's to complete and submit into the
 * chain.
 */
export async function submitMemberApplication(
  principal: MemberPrincipal,
  applicationId: string,
  origin: RequestOrigin
): Promise<MemberApplicationView> {
  const application = await loadOwned(principal, applicationId);
  assertApplicantMayEdit(application);

  const [fieldProblems, checklist] = await Promise.all([
    problemsBlockingSubmission(application),
    checklistFor({ applicationId }),
  ]);
  const details: Record<string, string[]> = {};
  for (const p of fieldProblems) {
    const path = `${p.subject}.${p.ordinal}.${p.fieldKey}`;
    details[path] = [...(details[path] ?? []), problemMessage(p.label)];
  }
  for (const entry of checklist) {
    if (BRANCH_ONLY_DOCUMENTS.has(entry.documentCode)) continue;
    if (entry.requirement === 'required' && entry.state === 'missing') {
      details[`document.${entry.documentCode}`] = [
        `${entry.documentName} is required.`,
      ];
    }
  }
  if (Object.keys(details).length > 0) {
    throw new ApiError(
      'validation_failed',
      'Some details are missing.',
      details
    );
  }

  const actor = await actorFor(principal);
  await withTransaction(async client => {
    await client.query(
      `update membership_application
          set status = $2, submitted_at = now()
        where id = $1`,
      [application.id, RECEIVED_STATUS]
    );
    await client.query(
      `insert into application_transition
         (application_id, from_status, to_status, step_code, actor_user_id,
          actor_role, comment)
       values ($1, $2, $3, null, $4, 'Applicant', null)`,
      [application.id, application.status, RECEIVED_STATUS, actor.userId]
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: ACTION_RECEIVED,
        entityType: 'membership_application',
        entityId: application.id,
        newValue: { reference: application.reference, status: RECEIVED_STATUS },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      },
      client
    );
  });

  return getMemberApplication(principal, applicationId);
}

// problemsBlockingSubmission names a missing field by its label, and a
// guardian or percentage problem by a full sentence. Only the former needs
// "is required" adding.
function problemMessage(label: string): string {
  return /[.!]$/.test(label) || label.length > 60
    ? label
    : `${label} is required.`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value ?? ''
  );
}
