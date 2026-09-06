// Moving an application through the approval chain (S-304 to S-307).
//
// The chain is not written down here. Which steps run, in what order, which
// role may act at each and whether a step is enabled all come from the
// workflow configuration of M2 (S-209) — so enabling the Regional Manager
// review is a configuration change, and this code does not need to know.
//
// Three separate controls apply to every action, and they are not
// interchangeable:
//
//   1. A permission — may this person review applications at all?
//   2. The configured step's role — is review this role's job in this chain?
//   3. Segregation of duties — has this same person already acted on THIS
//      record in a way that bars them (S-203)?
//
// The first two are about the person's job. The third is about this record's
// history, and it is the only one that can refuse someone who is otherwise
// entirely entitled to act.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { checkSegregation } from '../admin/segregation';
import { activeChain, type WorkflowStep } from '../config/reference';
import { query, withTransaction } from '../db/pool';
import { checklistFor, type ChecklistEntry } from '../documents/documents';
import { paymentsForApplication, type Payment } from '../payments/payments';
import type { Principal } from '../access/principal';
import {
  ApplicationError,
  loadApplication,
  problemsBlockingSubmission,
  type Actor,
  type Application,
  type MissingField,
  RECEIVED_STATUS,
} from './capture';

export const WORKFLOW_CODE = 'membership_application_approval';
export const ENTITY_TYPE = 'membership_application';

// The action names the segregation rules seeded in migrations 0009 and 0024
// key on. They are the contract between this module and those rules: renaming
// one here silently disables the control, so they are named once and
// referenced.
export const ACTION_CAPTURED = 'membership.application.captured';
// S-611: `regional_review` and `secretary_review` share the same
// `application.review` permission (migration 0011) — both are a review in
// the everyday sense — but they are audited, and segregated, under distinct
// action names, so someone who holds both the Regional Manager and Secretary
// roles cannot sign off on the same application at both stages (0024).
export const ACTION_REGIONAL_REVIEWED =
  'membership.application.regional_reviewed';
export const ACTION_REVIEWED = 'membership.application.reviewed';
export const ACTION_APPROVED = 'membership.application.approved';

export interface Transition {
  fromStatus: string | null;
  toStatus: string;
  stepCode: string | null;
  actorName: string;
  actorEmail: string;
  actorRole: string | null;
  comment: string | null;
  occurredAt: Date;
}

// S-611: a gate step's own from_status and to_status are identical (S-209
// comment on workflow_step.to_status) — acting on it never moves the record,
// which is exactly why the record's status alone cannot say whether it has
// already happened. A recorded transition is the only signal there is:
// `recordTransition` writes one every time a step completes, gate or not.
// Every step this application has ever been through — one read, consulted
// for every gate question below, rather than one query per step asked.
async function passedSteps(applicationId: string): Promise<Set<string>> {
  const result = await query<{ step_code: string }>(
    `select distinct step_code from application_transition
      where application_id = $1`,
    [applicationId]
  );
  return new Set(result.rows.map(r => r.step_code));
}

// Every enabled gate earlier in the chain, sitting on the same status this
// step waits at, that this application has not yet passed — read from
// configuration rather than a hardcoded 'regional_review', so a gate added
// later needs no change here. Disabling a gate (Regional oversight's default)
// drops it from `chain` entirely, so it contributes nothing: that is what
// lets the chain go straight to the next step with no code change.
function unmetGates(
  chain: WorkflowStep[],
  step: WorkflowStep,
  passed: ReadonlySet<string>
): WorkflowStep[] {
  return chain.filter(
    s =>
      s.stepNo < step.stepNo &&
      s.fromStatus === step.fromStatus &&
      s.fromStatus === s.toStatus &&
      !passed.has(s.code)
  );
}

/**
 * Refuse unless this person may perform this step on this record.
 *
 * Order matters for the message as much as for the logic: "you do not review
 * applications" is a different conversation from "that is not your step",
 * which is again different from "you captured this one".
 */
async function assertMayAct(
  principal: Principal,
  application: Application,
  options: { permission: string; stepCode: string; action: string }
): Promise<WorkflowStep> {
  if (!principal.permissions.has(options.permission)) {
    throw new ApplicationError(
      `You do not have permission to ${options.permission.split('.')[1]} ` +
        'applications.',
      'invalid'
    );
  }

  const chain = await activeChain(WORKFLOW_CODE);
  const step = chain.find(s => s.code === options.stepCode);
  if (!step) {
    throw new ApplicationError(
      `The ${options.stepCode.replace('_', ' ')} step is not enabled in the ` +
        'configured workflow.',
      'invalid'
    );
  }

  // S-611: the permission above says review is this person's job in general
  // — `application.review` covers both Regional oversight and Secretary
  // review, deliberately, since both are a review in the everyday sense. The
  // step's own configured role is what says whether THIS review is theirs;
  // without it, either role could act on the other's step.
  if (!principal.roles.includes(step.roleCode)) {
    throw new ApplicationError(
      `${step.name} is the ${step.roleName}'s step, not yours.`,
      'invalid'
    );
  }

  // 'received' — submitted from the member app, with the branch (migration
  // 0039) — is a draft as far as the capture step is concerned: the officer
  // completes the signed form and payment and submits it exactly as one.
  const actsOnReceived =
    step.code === 'capture' && application.status === RECEIVED_STATUS;
  if (application.status !== step.fromStatus && !actsOnReceived) {
    throw new ApplicationError(
      `This application is ${application.status}; that step acts on ` +
        `${step.fromStatus}.`,
      'locked'
    );
  }

  // A gate's own status never moves once passed (S-209), so nothing above
  // catches someone acting on it a second time — the record still reads
  // exactly as ready for it as before. Checked here, once, for both this
  // step (has it already happened?) and every gate earlier in the chain
  // (has each of THEM already happened?).
  const passed = await passedSteps(application.id);
  if (step.fromStatus === step.toStatus && passed.has(step.code)) {
    throw new ApplicationError(
      `${step.name} has already been completed.`,
      'locked'
    );
  }

  const unmet = unmetGates(chain, step, passed);
  if (unmet.length > 0) {
    throw new ApplicationError(
      `${unmet.map(g => g.name).join(', ')} must happen first.`,
      'locked'
    );
  }

  const verdict = await checkSegregation(
    principal.userId,
    ENTITY_TYPE,
    application.id,
    options.action
  );
  if (!verdict.allowed) {
    const when = verdict.conflict!.performedAt.toISOString().slice(0, 10);
    throw new ApplicationError(
      `${verdict.conflict!.description} You acted on this application on ` +
        `${when}, so someone else must take this step.`,
      'invalid'
    );
  }

  return step;
}

async function recordTransition(
  client: PoolClient,
  application: Application,
  step: WorkflowStep | null,
  toStatus: string,
  actor: Actor,
  actorRole: string | null,
  comment: string | null
): Promise<void> {
  await client.query(
    `insert into application_transition
       (application_id, from_status, to_status, step_code, actor_user_id,
        actor_role, comment)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      application.id,
      application.status,
      toStatus,
      step?.code ?? null,
      actor.userId,
      actorRole,
      comment,
    ]
  );
}

/**
 * S-304 · Submit for central processing.
 *
 * Nothing is submitted while a mandatory field is empty, and the caller is
 * told every one of them.
 */
export interface SubmissionReadiness {
  fieldProblems: MissingField[];
  documentsOutstanding: number;
  paymentRecorded: boolean;
}

/**
 * Everything S-304 requires before an application may leave the officer's
 * hands — not just the form fields `problemsBlockingSubmission` checks, but
 * the KYC pack being filed and the money being taken, both of which
 * `submitApplication` below refuses without. One function rather than three
 * separate checks repeated wherever "is this ready" is asked: the capture
 * page uses the same three counts to gate Next and Submit before the officer
 * ever tries, and this is what makes the two agree.
 */
export async function submissionReadiness(
  application: Application
): Promise<SubmissionReadiness> {
  const [fieldProblems, checklist, payments] = await Promise.all([
    problemsBlockingSubmission(application),
    checklistFor({ applicationId: application.id }),
    paymentsForApplication(application.id),
  ]);

  return {
    fieldProblems,
    // Filed, not verified — verifying is the Secretary's job, which is the
    // next step in the chain and cannot be a precondition of reaching it.
    documentsOutstanding: checklist.filter(
      e => e.requirement === 'required' && e.state === 'missing'
    ).length,
    paymentRecorded: payments.some(p => p.kind === 'payment' && !p.voidedAt),
  };
}

export async function submitApplication(
  applicationId: string,
  principal: Principal
): Promise<{ status: string } | { problems: MissingField[] }> {
  const application = await loadApplication(applicationId);
  if (!application) {
    throw new ApplicationError(
      'That application no longer exists.',
      'not_found'
    );
  }

  const actor: Actor = { userId: principal.userId, email: principal.email };
  const step = await assertMayAct(principal, application, {
    permission: 'application.submit',
    stepCode: 'capture',
    action: ACTION_CAPTURED,
  });

  const readiness = await submissionReadiness(application);
  if (readiness.fieldProblems.length > 0) {
    return { problems: readiness.fieldProblems };
  }
  if (readiness.documentsOutstanding > 0) {
    throw new ApplicationError(
      `${readiness.documentsOutstanding} required document(s) still need ` +
        'to be filed before this can be submitted.'
    );
  }
  if (!readiness.paymentRecorded) {
    throw new ApplicationError(
      'Payment must be recorded before this can be submitted.'
    );
  }

  await withTransaction(async client => {
    await client.query(
      `update membership_application
          set status = $2, submitted_at = now()
        where id = $1`,
      [application.id, step.toStatus]
    );

    await recordTransition(
      client,
      application,
      step,
      step.toStatus,
      actor,
      step.roleName,
      null
    );

    // The segregation rules key on this action. It is recorded once per person
    // who worked on the capture — the officer whose draft it is, and the
    // person submitting it if that is someone else (FRD 7.4.2 allows a Clerk
    // to assist). Both statements are true, and recording both is the
    // conservative reading: everyone who had a hand in capture is barred from
    // reviewing or approving it.
    const capturers = new Map<string, string>([
      [application.capturedBy, application.capturedByEmail],
      [actor.userId, actor.email],
    ]);

    for (const [userId, email] of capturers) {
      await recordAudit(
        {
          actorUserId: userId,
          actorDescription: email,
          action: ACTION_CAPTURED,
          entityType: ENTITY_TYPE,
          entityId: application.id,
          newValue: { reference: application.reference, status: step.toStatus },
        },
        client
      );
    }
  });

  return { status: step.toStatus };
}

/**
 * S-608 · Everything the Board needs already true before the Secretary may
 * forward an application to it — not the mandatory fields
 * `problemsBlockingSubmission` already checked at S-304 (those cannot have
 * gone empty since; nothing edits a submitted application), but the three
 * things that can still be wrong at review time: a document filed but never
 * actually verified, no payment recorded, or — since a guardian is a claim
 * about another member's status, not a fact frozen at submission — a
 * guardian who has since stopped being an active member.
 */
export interface BoardReadiness {
  documentsUnverified: number;
  paymentRecorded: boolean;
  guardianProblems: MissingField[];
}

export async function boardReadiness(
  application: Application,
  // What the caller has already read for its own purposes — the application
  // page reads all three to render itself, and repeating them here was three
  // more round trips for the same answer. Anything not supplied is read.
  known: {
    checklist?: ChecklistEntry[];
    payments?: Payment[];
    problems?: MissingField[];
  } = {}
): Promise<BoardReadiness> {
  const [checklist, payments, problems] = await Promise.all([
    known.checklist ?? checklistFor({ applicationId: application.id }),
    known.payments ?? paymentsForApplication(application.id),
    known.problems ?? problemsBlockingSubmission(application),
  ]);

  return {
    // Filed is not enough here — Verifying is the whole point of the
    // Secretary's own review, which is what this gate sits at the end of.
    documentsUnverified: checklist.filter(
      e => e.requirement === 'required' && e.state !== 'verified'
    ).length,
    paymentRecorded: payments.some(p => p.kind === 'payment' && !p.voidedAt),
    // Every other problem problemsBlockingSubmission reports is a mandatory
    // field, which cannot have gone empty since submission locked the form —
    // the guardian check is the one that reads a fact outside this record.
    guardianProblems: problems.filter(p => p.subject === 'guardian'),
  };
}

// Shared by the throw below and by the id page's proactive "not ready yet"
// list, so the two can never name the outstanding items differently.
export function boardReadinessReasons(readiness: BoardReadiness): string[] {
  const reasons: string[] = [];
  if (readiness.documentsUnverified > 0) {
    reasons.push(
      `${readiness.documentsUnverified} required document(s) still need ` +
        'to be Verified'
    );
  }
  if (!readiness.paymentRecorded) {
    reasons.push('payment has not been recorded');
  }
  reasons.push(...readiness.guardianProblems.map(p => p.label));
  return reasons;
}

/**
 * S-305, S-611 · A review step: forward, or return with a comment.
 *
 * `stepCode` defaults to Secretary review, S-305's original and still the
 * common case. Passing `'regional_review'` runs the exact same forward/return
 * shape for Regional oversight (S-611) instead — a gate, so its own "forward"
 * records that it happened without moving the record on (its `toStatus`
 * equals its `fromStatus` by configuration, S-209), while "return" still
 * sends the application back to the originating staff either way.
 */
export async function reviewApplication(
  applicationId: string,
  decision: { outcome: 'forward' | 'return'; comment: string },
  principal: Principal,
  stepCode: string = 'secretary_review'
): Promise<{ status: string }> {
  const application = await loadApplication(applicationId);
  if (!application) {
    throw new ApplicationError(
      'That application no longer exists.',
      'not_found'
    );
  }

  // A return sends work back to a colleague. Without a reason they cannot know
  // what to fix, so the comment is required — and the check is here rather than
  // in the page so the API cannot skip it.
  const comment = decision.comment.trim();
  if (decision.outcome === 'return' && comment === '') {
    throw new ApplicationError(
      'Returning an application requires a comment saying what needs correcting.'
    );
  }

  // S-611: Regional oversight is audited under its own action name, distinct
  // from Secretary review — see ACTION_REGIONAL_REVIEWED's own comment for
  // why (migration 0024's segregation rules key on the two being different).
  const action =
    stepCode === 'regional_review' ? ACTION_REGIONAL_REVIEWED : ACTION_REVIEWED;

  const actor: Actor = { userId: principal.userId, email: principal.email };
  const step = await assertMayAct(principal, application, {
    permission: 'application.review',
    stepCode,
    action,
  });

  // S-608: nothing forwarded to the Board is incomplete — the reasons are
  // named so the Secretary knows exactly what to chase, not just that
  // something is missing. Regional oversight sits before that gate, not at
  // it: verifying a filed document is the Secretary's own review (S-608's
  // own comment), which has not happened yet at this stage, so nothing here
  // asks Regional oversight to re-check it.
  if (decision.outcome === 'forward' && stepCode === 'secretary_review') {
    const reasons = boardReadinessReasons(await boardReadiness(application));
    if (reasons.length > 0) {
      throw new ApplicationError(
        `This application is not ready for the Board: ${reasons.join('; ')}.`
      );
    }
  }

  const toStatus = decision.outcome === 'forward' ? step.toStatus : 'returned';

  await withTransaction(async client => {
    await client.query(
      'update membership_application set status = $2 where id = $1',
      [application.id, toStatus]
    );
    await recordTransition(
      client,
      application,
      step,
      toStatus,
      actor,
      step.roleName,
      comment || null
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action,
        entityType: ENTITY_TYPE,
        entityId: application.id,
        previousValue: { status: application.status },
        newValue: { status: toStatus, outcome: decision.outcome },
      },
      client
    );
  });

  return { status: toStatus };
}

export interface DecisionResult {
  status: string;
  // Present on approval: what the decision created (S-308, S-309).
  member?: {
    id: string;
    memberNo: string;
    // accountNo: set only by openAccountsForCustomerApplication (S-614) — a
    // customer's accounts each carry their own number, unlike a member's.
    accounts: {
      id: string;
      typeCode: string;
      typeName: string;
      accountNo?: string;
    }[];
  };
  // Present when a quorum above one (S-609) has not yet been reached by this
  // sign-off: it was recorded, but the step has not completed and `status`
  // is still whatever it was before this call.
  signoff?: { recorded: number; required: number };
}

const STEP_CODE_PRESIDENT_DECISION = 'president_decision';

/**
 * S-306, S-609 · President decision: approve or reject, with a Board quorum.
 *
 * At quorum 1 — every step ships this way, per S-209 — a single decision
 * still transitions immediately, exactly as before S-609. Above quorum 1
 * this is where FRD 7.10.9's "who signed off" actually lives:
 * `application_step_signoff` gets one row per distinct person who acted,
 * and the step itself does not move until enough of them have.
 *
 * A reject is never something a quorum waits out. FRD 7.10.9 asks for an
 * attributable decision, not a vote nobody can trace to a person — so one
 * reject, from anyone entitled to act, ends it immediately whatever else has
 * already been signed off. Quorum only ever governs how many approvals it
 * takes to move forward.
 *
 * On approval the Member and their default account are created in the SAME
 * transaction as the status change (S-308, S-309). A member without the
 * account, or an approved application without a member, would both be states
 * nobody can act on and nothing would report.
 */
export async function decideApplication(
  applicationId: string,
  decision: { outcome: 'approve' | 'reject'; comment: string },
  principal: Principal,
  createMember: (
    client: PoolClient,
    application: Application,
    actor: Actor
  ) => Promise<{
    id: string;
    memberNo: string;
    accounts: { id: string; typeCode: string; typeName: string }[];
  }>
): Promise<DecisionResult> {
  const application = await loadApplication(applicationId);
  if (!application) {
    throw new ApplicationError(
      'That application no longer exists.',
      'not_found'
    );
  }

  const comment = decision.comment.trim();
  if (decision.outcome === 'reject' && comment === '') {
    throw new ApplicationError(
      'Rejecting an application requires a comment. It is returned to the ' +
        'originating staff, who need to know why.'
    );
  }

  const actor: Actor = { userId: principal.userId, email: principal.email };
  const step = await assertMayAct(principal, application, {
    permission: 'application.approve',
    stepCode: STEP_CODE_PRESIDENT_DECISION,
    action: ACTION_APPROVED,
  });

  return withTransaction(async client => {
    // One sign-off per person per step per application: checked before the
    // write, the same shape as the segregation check assertMayAct already
    // ran, so a repeat attempt reads as a conflict rather than a vote change.
    const already = await client.query(
      `select 1 from application_step_signoff
        where application_id = $1 and step_code = $2 and actor_user_id = $3`,
      [application.id, step.code, actor.userId]
    );
    if ((already.rowCount ?? 0) > 0) {
      throw new ApplicationError(
        'You have already recorded a decision for this step.'
      );
    }

    await client.query(
      `insert into application_step_signoff
         (application_id, step_code, actor_user_id, outcome, comment)
       values ($1, $2, $3, $4, $5)`,
      [
        application.id,
        step.code,
        actor.userId,
        decision.outcome,
        comment || null,
      ]
    );

    let recorded = 1;
    let quorumMet = decision.outcome === 'reject';
    if (decision.outcome === 'approve') {
      const count = await client.query<{ n: string }>(
        `select count(*)::int as n from application_step_signoff
          where application_id = $1 and step_code = $2 and outcome = 'approve'`,
        [application.id, step.code]
      );
      recorded = Number(count.rows[0].n);
      quorumMet = recorded >= step.quorumCount;
    }

    // Every sign-off is audited, whether or not it is the one that completes
    // the step — S-609 asks for the decision recorded with who signed off,
    // not only the final outcome.
    if (!quorumMet) {
      await recordAudit(
        {
          actorUserId: actor.userId,
          actorDescription: actor.email,
          action: ACTION_APPROVED,
          entityType: ENTITY_TYPE,
          entityId: application.id,
          newValue: {
            outcome: decision.outcome,
            stepCode: step.code,
            signoffsRecorded: recorded,
            signoffsRequired: step.quorumCount,
          },
        },
        client
      );
      return {
        status: application.status,
        signoff: { recorded, required: step.quorumCount },
      };
    }

    const toStatus =
      decision.outcome === 'approve' ? step.toStatus : 'rejected';

    await client.query(
      `update membership_application
          set status = $2, decided_at = now()
        where id = $1`,
      [application.id, toStatus]
    );
    await recordTransition(
      client,
      application,
      step,
      toStatus,
      actor,
      step.roleName,
      comment || null
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: ACTION_APPROVED,
        entityType: ENTITY_TYPE,
        entityId: application.id,
        previousValue: { status: application.status },
        newValue: { status: toStatus, outcome: decision.outcome },
      },
      client
    );

    if (decision.outcome !== 'approve') return { status: toStatus };
    const member = await createMember(client, application, actor);
    return { status: toStatus, member };
  });
}

export interface StepSignoff {
  actorName: string;
  actorEmail: string;
  outcome: 'approve' | 'reject';
  comment: string | null;
  occurredAt: Date;
}

// S-609: who has signed off on a quorum step so far, for the Board (and
// whoever is waiting on them) to see — the row this table exists for.
export async function signoffsFor(
  applicationId: string,
  stepCode: string = STEP_CODE_PRESIDENT_DECISION
): Promise<StepSignoff[]> {
  const result = await query<{
    actor_name: string;
    actor_email: string;
    outcome: 'approve' | 'reject';
    comment: string | null;
    occurred_at: Date;
  }>(
    `select u.display_name as actor_name, u.email::text as actor_email,
            s.outcome, s.comment, s.occurred_at
       from application_step_signoff s
       join app_user u on u.id = s.actor_user_id
      where s.application_id = $1 and s.step_code = $2
      order by s.occurred_at`,
    [applicationId, stepCode]
  );
  return result.rows.map(r => ({
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    outcome: r.outcome,
    comment: r.comment,
    occurredAt: r.occurred_at,
  }));
}

// S-307 · The chain, in order, as an auditor reads it.
export async function transitionsFor(
  applicationId: string
): Promise<Transition[]> {
  const result = await query<{
    from_status: string | null;
    to_status: string;
    step_code: string | null;
    actor_name: string;
    actor_email: string;
    actor_role: string | null;
    comment: string | null;
    occurred_at: Date;
  }>(
    `select t.from_status, t.to_status, t.step_code,
            u.display_name as actor_name, u.email::text as actor_email,
            t.actor_role, t.comment, t.occurred_at
       from application_transition t
       join app_user u on u.id = t.actor_user_id
      where t.application_id = $1
      order by t.occurred_at, t.id`,
    [applicationId]
  );

  return result.rows.map(r => ({
    fromStatus: r.from_status,
    toStatus: r.to_status,
    stepCode: r.step_code,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    actorRole: r.actor_role,
    comment: r.comment,
    occurredAt: r.occurred_at,
  }));
}

export interface AvailableAction {
  stepCode: string;
  label: string;
  permission: string;
  // S-609: how many distinct sign-offs this step needs before it completes.
  // 1 everywhere today (S-209's shipped default) — the same single-decision
  // behaviour as before quorum existed.
  quorumCount: number;
}

// What a step is called and which permission it needs, for whichever of the
// review-type steps a code path actually knows how to act on — capture,
// Regional oversight, Secretary review, President decision. `availableActions`
// and `pendingActionCount` both read this rather than each keeping their own
// copy, so a label can never drift between "what button appears" and "what
// the nav badge counts". A step with no entry here (none exist today) is
// configuration an administrator can see but no code path acts on yet — S-209's
// own description of a disabled step, extended to "unrecognised" as well.
const STEP_META: Record<string, { label: string; permission: string }> = {
  capture: {
    label: 'Submit for Processing',
    permission: 'application.submit',
  },
  regional_review: { label: 'Review', permission: 'application.review' },
  secretary_review: { label: 'Review', permission: 'application.review' },
  president_decision: { label: 'Decide', permission: 'application.approve' },
};

/**
 * What this person may do with this application right now.
 *
 * Derived from the configured chain rather than a list of statuses, so a step
 * an administrator enables appears here without a code change. Segregation is
 * NOT evaluated here — it needs a database round trip per action, and offering
 * a button that then explains why it is refused is better than silently hiding
 * it and leaving the reviewer wondering where their work went. An unmet gate
 * (S-611) is different: unlike segregation it is not a one-off, per-attempt
 * refusal — it holds for as long as nobody has passed the gate, so a button
 * that always fails is worse than the one extra query it takes to hide it.
 */
export async function availableActions(
  application: Application,
  principal: Principal
): Promise<AvailableAction[]> {
  const [chain, passed] = await Promise.all([
    activeChain(WORKFLOW_CODE),
    passedSteps(application.id),
  ]);
  const actions: AvailableAction[] = [];

  for (const step of chain) {
    const meta = STEP_META[step.code];
    if (!meta) continue;
    if (step.fromStatus !== application.status) continue;
    if (!principal.permissions.has(meta.permission)) continue;
    // S-611: the step's configured role, not just the permission — see
    // assertMayAct's own comment for why this matters once a permission is
    // shared between two steps (Regional oversight and Secretary review).
    if (!principal.roles.includes(step.roleCode)) continue;
    // A gate's own status never moves once passed, so it would otherwise
    // keep offering itself back to whoever just completed it.
    if (step.fromStatus === step.toStatus && passed.has(step.code)) continue;
    if (unmetGates(chain, step, passed).length > 0) continue;
    actions.push({
      stepCode: step.code,
      label: meta.label,
      permission: meta.permission,
      quorumCount: step.quorumCount,
    });
  }

  return actions;
}

/**
 * S-611 · How many applications are waiting on this person right now, for the
 * "Applications" nav badge — a live count, not a stored number, so it needs
 * nothing incrementing or clearing by hand: an application appearing at a
 * step this principal's role covers raises it by exactly one, and it moving
 * on (to the next step, or off the chain entirely) drops it by exactly one.
 *
 * Only steps a person actually waits to act on count — capture is excluded,
 * since a draft is the originating officer's own work-in-progress (saved
 * automatically, S-302), not something sitting in anyone's queue.
 */
export async function pendingActionCount(
  principal: Principal
): Promise<number> {
  const chain = await activeChain(WORKFLOW_CODE);
  const counts: Promise<number>[] = [];

  for (const step of chain) {
    if (step.code === 'capture') continue;
    const meta = STEP_META[step.code];
    if (!meta) continue;
    if (!principal.permissions.has(meta.permission)) continue;
    if (!principal.roles.includes(step.roleCode)) continue;

    const earlierGates = chain.filter(
      s =>
        s.stepNo < step.stepNo &&
        s.fromStatus === step.fromStatus &&
        s.fromStatus === s.toStatus
    );
    // This step is itself a gate when its own from/to status match (S-209):
    // what counts as pending for it is the applications nobody has passed it
    // for yet, the mirror image of what counts as pending for a step waiting
    // on that gate (only the ones the gate HAS been passed for).
    const isGate = step.fromStatus === step.toStatus;

    const conditions = ['a.status = $1'];
    const params: unknown[] = [step.fromStatus];
    for (const gate of earlierGates) {
      params.push(gate.code);
      conditions.push(
        `exists (select 1 from application_transition t
                  where t.application_id = a.id and t.step_code = $${params.length})`
      );
    }
    if (isGate) {
      params.push(step.code);
      conditions.push(
        `not exists (select 1 from application_transition t
                       where t.application_id = a.id and t.step_code = $${params.length})`
      );
    }

    // One count per step this person waits at, all in flight at once — a
    // President who also reviews should not pay for them one after another.
    counts.push(
      query<{ n: string }>(
        `select count(*)::int as n
           from membership_application a
          where ${conditions.join(' and ')}`,
        params
      ).then(result => Number(result.rows[0]?.n ?? 0))
    );
  }

  return (await Promise.all(counts)).reduce((sum, n) => sum + n, 0);
}

/**
 * Officer feedback: which applications, on the Applications list, are
 * specifically waiting on THIS person right now — so the list can mark them
 * and put them first, rather than leaving the officer to scan every row's
 * status against their own job to find the ones that are actually theirs to
 * act on.
 *
 * Two different things count as "theirs to act on", and they are not the
 * same computation:
 *
 *   - Review or approval: the same role/permission/gate chain
 *     `pendingActionCount` counts, read here as the actual rows rather than
 *     how many. Deliberately excludes the 'capture' step (draft -> new) for
 *     the same reason that count does — capture is the originating officer's
 *     own work in progress, not a queue entry someone else is waiting to see
 *     appear.
 *   - Correction: an application sent back with 'returned' is nobody's
 *     queue entry in the chain sense (no step names 'returned' as its
 *     `fromStatus` — a review outcome sets it directly), but it is very much
 *     the officer who captured it own work to pick back up, so it is
 *     flagged for them specifically rather than for a role.
 */
export async function pendingApplicationIds(
  principal: Principal
): Promise<Set<string>> {
  const ids = new Set<string>();

  if (principal.permissions.has('application.submit')) {
    // A 'received' application (submitted from the member app) is nobody's
    // draft: any officer who can submit may take it up, so it is flagged
    // for all of them.
    const returned = await query<{ id: string }>(
      `select id from membership_application
        where (status = 'returned' and captured_by = $1)
           or status = $2`,
      [principal.userId, RECEIVED_STATUS]
    );
    for (const row of returned.rows) ids.add(row.id);
  }

  const chain = await activeChain(WORKFLOW_CODE);
  const queries: Promise<void>[] = [];

  for (const step of chain) {
    if (step.code === 'capture') continue;
    const meta = STEP_META[step.code];
    if (!meta) continue;
    if (!principal.permissions.has(meta.permission)) continue;
    if (!principal.roles.includes(step.roleCode)) continue;

    const earlierGates = chain.filter(
      s =>
        s.stepNo < step.stepNo &&
        s.fromStatus === step.fromStatus &&
        s.fromStatus === s.toStatus
    );
    const isGate = step.fromStatus === step.toStatus;

    const conditions = ['a.status = $1'];
    const params: unknown[] = [step.fromStatus];
    for (const gate of earlierGates) {
      params.push(gate.code);
      conditions.push(
        `exists (select 1 from application_transition t
                  where t.application_id = a.id and t.step_code = $${params.length})`
      );
    }
    if (isGate) {
      params.push(step.code);
      conditions.push(
        `not exists (select 1 from application_transition t
                       where t.application_id = a.id and t.step_code = $${params.length})`
      );
    }

    queries.push(
      query<{ id: string }>(
        `select a.id from membership_application a where ${conditions.join(' and ')}`,
        params
      ).then(result => {
        for (const row of result.rows) ids.add(row.id);
      })
    );
  }

  await Promise.all(queries);
  return ids;
}

/**
 * S-611 follow-up: who actually holds this application right now, for as
 * long as its status stays 'new'.
 *
 * `applicationTimeline` (`timeline.ts`) folds capture, Regional oversight and
 * Secretary review into one "Submit" step — an officer has exactly one thing
 * left to do once they submit, and the rest is out of their hands either way
 * — but a Regional oversight gate the record's own `status` cannot reflect
 * (S-209: a gate never moves it) left every application at 'new' reading
 * "With the Secretary" whether or not the Regional Manager had acted yet.
 * This walks the same chain `availableActions` does, minus a principal to
 * filter by, and returns the role of whichever step is actually current.
 */
export async function reviewStageLabel(
  application: Application
): Promise<string | null> {
  if (application.status !== 'new') return null;
  const [chain, passed] = await Promise.all([
    activeChain(WORKFLOW_CODE),
    passedSteps(application.id),
  ]);

  for (const step of chain) {
    if (step.fromStatus !== application.status) continue;
    if (step.fromStatus === step.toStatus && passed.has(step.code)) continue;
    if (unmetGates(chain, step, passed).length > 0) continue;
    return `With the ${step.roleName}`;
  }

  return null;
}

/**
 * Which of these applications (assumed already at 'new') have passed the
 * Regional oversight gate — one query for the whole applications list
 * rather than `reviewStageLabel` called once per row.
 */
export async function regionalReviewPassedIds(
  applicationIds: string[]
): Promise<Set<string>> {
  if (applicationIds.length === 0) return new Set();
  const result = await query<{ application_id: string }>(
    `select distinct application_id from application_transition
      where step_code = 'regional_review' and application_id = any($1::uuid[])`,
    [applicationIds]
  );
  return new Set(result.rows.map(r => r.application_id));
}
