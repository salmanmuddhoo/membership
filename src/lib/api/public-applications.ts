// An application submitted from Albarakah.mu (S-908).
//
// The story's own constraint is the important one: this creates an
// application through THE SAME service the staff screens use, so the two
// cannot diverge. Nothing here writes to membership_application directly —
// startApplication and saveDraft do, exactly as they do for an officer at a
// branch and for the member app, which means the field configuration, the
// phone normalisation, the reference allocation and the audit trail are all
// whatever the Society last configured rather than a second implementation
// that drifts.
//
// It lands in `received`, not `new` (migration 0039). An officer's own submit
// requires the signed form filed and the payment recorded, and a website can
// do neither — so a public submission goes back into the officer's hands, the
// same place a member-app submission lands, and enters the chain from there
// with the same required documents.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import {
  deleteDraftApplication,
  problemsBlockingSubmission,
  saveDraft,
  startApplication,
  loadApplication,
  type Actor,
  type PartyValues,
} from '../applications/capture';
import { PhoneFormatError, toInternational } from '../applications/phone';
import { listMembershipTypes, type FieldSubject } from '../config/reference';
import { query, withTransaction } from '../db/pool';
import { ApiError } from './envelope';
import type { ApiCredential } from './credentials';

const RECEIVED_STATUS = 'received';
const SYSTEM_SUBJECT = 'system:public-api';

export const ACTION_SUBMITTED = 'membership.application.submitted_public';

export interface PublicApplicationInput {
  membershipTypeCode: string;
  parties: PartyValues[];
}

export interface PublicApplicationResult {
  // The reference, and only the reference. A public caller gets no internal
  // id: it has no endpoint to use one on, and handing it out invites a later
  // endpoint that trusts it.
  reference: string;
  status: string;
}

export interface RequestOrigin {
  correlationId: string;
  ip: string | null;
}

// Attributed to the system user (migration 0059), named by the credential
// that called. "The website did this" has to be answerable, and the
// credential is the only identity there is — nobody is present.
async function actorFor(credential: ApiCredential): Promise<Actor> {
  const result = await query<{ id: string }>(
    'select id from app_user where entra_subject = $1',
    [SYSTEM_SUBJECT]
  );
  const id = result.rows[0]?.id;
  if (!id) {
    // The migration creates it. If it is missing, something is wrong that
    // writing an application anonymously would only hide.
    throw new Error('The public API system user is missing.');
  }
  return { userId: id, email: `public-api:${credential.clientId}` };
}

// deleteDraftApplication checks one staff permission on a Principal. The
// system user holds none, so this is the narrowest thing that satisfies that
// check — built here, for that one call, exactly as the member app does for
// its own delete.
function deletingPrincipal(actor: Actor): Principal {
  return {
    userId: actor.userId,
    entraSubject: SYSTEM_SUBJECT,
    email: actor.email,
    displayName: 'Public API',
    roles: [],
    roleNames: [],
    permissions: new Set(['application.capture']),
  };
}

/**
 * One in progress at a time, per number.
 *
 * The same rule the member app applies, for the same reasons: it stops a
 * double submission from a retried request becoming two applications an
 * officer has to reconcile, and it bounds what a working credential can
 * create no matter how the rate limit is set.
 */
async function refuseIfAlreadyApplying(mobile: string): Promise<void> {
  const open = await query<{ reference: string }>(
    `select reference from membership_application
      where applicant_mobile = $1
        and status not in ('approved', 'rejected')
      order by created_at
      limit 1`,
    [mobile]
  );
  if (open.rows[0]) {
    throw new ApiError(
      'conflict',
      `There is already an application in progress for this number ` +
        `(${open.rows[0].reference}).`
    );
  }
}

/**
 * Submit an application on behalf of someone filling in the website form.
 *
 * Validates the FIELDS the membership type requires, and not the documents:
 * a website cannot file an identity card, and the checklist is the officer's
 * to complete once the application is in front of them. That is the same
 * split the member app makes.
 */
export async function submitPublicApplication(
  input: PublicApplicationInput,
  credential: ApiCredential,
  origin: RequestOrigin
): Promise<PublicApplicationResult> {
  const typeCode = String(input?.membershipTypeCode ?? '').trim();
  const type = (await listMembershipTypes()).find(t => t.code === typeCode);
  if (!type || !type.isActive) {
    throw new ApiError(
      'validation_failed',
      'Unknown or unavailable membership type.',
      { membershipTypeCode: ['Not a membership type currently accepted.'] }
    );
  }

  // Only fields this type configures, only for subjects it has. Anything else
  // the caller sends is dropped rather than refused: a website form that has
  // grown an extra box should not start failing every submission.
  const configured = new Map<FieldSubject, Set<string>>();
  for (const field of type.fields) {
    if (!field.isVisible) continue;
    const keys = configured.get(field.subject) ?? new Set<string>();
    keys.add(field.fieldKey);
    configured.set(field.subject, keys);
  }

  const parties: PartyValues[] = [];
  for (const incoming of Array.isArray(input?.parties) ? input.parties : []) {
    const keys = configured.get(incoming?.subject as FieldSubject);
    if (!keys) continue;
    const values: Record<string, string> = {};
    for (const [key, raw] of Object.entries(incoming?.values ?? {})) {
      if (keys.has(key) && raw !== undefined && raw !== null) {
        values[key] = String(raw);
      }
    }
    parties.push({
      subject: incoming.subject,
      ordinal: Number(incoming.ordinal) || 1,
      values,
    });
  }

  const applicant = parties.find(
    p => p.subject === 'applicant' && p.ordinal === 1
  );
  if (!applicant) {
    throw new ApiError('validation_failed', 'Applicant details are required.', {
      parties: ['An applicant party is required.'],
    });
  }

  // Both of these happen BEFORE anything is created. A website whose form is
  // wrong, or a person who already has an application open, must not leave a
  // draft behind on every attempt: those would pile up in the officer's queue
  // and, since applicant_mobile is only set on success, would not even stop
  // the next one.
  const rawMobile = String(applicant.values.mobile ?? '').trim();
  let mobile: string | null = null;
  if (rawMobile !== '') {
    try {
      mobile = toInternational(rawMobile);
    } catch (error) {
      if (!(error instanceof PhoneFormatError)) throw error;
      throw new ApiError('validation_failed', 'Some details are missing.', {
        'applicant.1.mobile': [error.message],
      });
    }
    await refuseIfAlreadyApplying(mobile);
  }

  const actor = await actorFor(credential);
  const { id, reference } = await startApplication(typeCode, actor);

  // saveDraft normalises telephone numbers to international form (S-301), so
  // what is stored is the converted number rather than whatever the website's
  // form accepted.
  await saveDraft(id, parties, actor);

  const saved = await loadApplication(id);
  const problems = await problemsBlockingSubmission(saved!);
  if (problems.length > 0) {
    const details: Record<string, string[]> = {};
    for (const problem of problems) {
      const path = `${problem.subject}.${problem.ordinal}.${problem.fieldKey}`;
      details[path] = [
        ...(details[path] ?? []),
        `${problem.label} is required.`,
      ];
    }
    // Nothing is left behind. The caller has the reasons and will send the
    // whole form again; a rejected submission that still produced a record
    // would fill the officer's queue with drafts nobody asked for.
    await deleteDraftApplication(id, deletingPrincipal(actor));
    throw new ApiError(
      'validation_failed',
      'Some details are missing.',
      details
    );
  }

  await withTransaction(async client => {
    await client.query(
      `update membership_application
          set status = $2, submitted_at = now(), applicant_mobile = $3
        where id = $1`,
      [id, RECEIVED_STATUS, mobile ?? null]
    );
    await client.query(
      `insert into application_transition
         (application_id, from_status, to_status, step_code, actor_user_id,
          actor_role, comment)
       values ($1, 'draft', $2, null, $3, 'Applicant', null)`,
      [id, RECEIVED_STATUS, actor.userId]
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: ACTION_SUBMITTED,
        entityType: 'membership_application',
        entityId: id,
        newValue: {
          reference,
          status: RECEIVED_STATUS,
          credential: credential.name,
        },
        requestId: origin.correlationId,
        ipAddress: origin.ip,
      },
      client
    );
  });

  return { reference, status: RECEIVED_STATUS };
}
