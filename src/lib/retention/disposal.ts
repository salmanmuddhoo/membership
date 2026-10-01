// Disposing of what is past its retention period (S-1003).
//
// Three rules hold across every class, and they are what makes this safe to
// run on a schedule against member data:
//
//   1. NOTHING HAPPENS UNTIL A PERIOD IS SET. A class with no period is not
//      queried at all. On a database where the Society has stated nothing,
//      this job reads three rows and exits.
//
//   2. WHAT WENT IS RECORDED. Every disposal writes to the audit trail, which
//      cannot be edited afterwards. The record deliberately does not copy what
//      it disposed of — keeping a copy of an applicant's details in the audit
//      log would defeat the point of deleting them from the application.
//
//   3. IT IS IDEMPOTENT. A run killed halfway repeats nothing: notifications
//      and drafts are gone (so not selected again), and a redacted application
//      carries disposed_at. That is what lets the job resume rather than
//      restart, which docs/jobs.md requires of every job body.
//
// The audit trail itself is NOT disposed of here, and cannot be: migration
// 0004 refuses UPDATE and DELETE on audit_event with a trigger and migration
// 0005 revokes the privileges as well. See docs/retention.md — honouring a
// period on the trail is a decision for the Society, not a consequence of
// building this.
import { recordAudit } from '../access/audit';
import {
  deleteDraftApplication,
  ApplicationError,
} from '../applications/capture';
import {
  discardApplicationDocuments,
  discardApplicationFiles,
  discardMemberFiles,
} from '../documents/documents';
import { query, withTransaction } from '../db/pool';
import type { Principal } from '../access/principal';
import {
  listRetentionPolicies,
  type RetentionClass,
  type RetentionPolicy,
} from './policy';

// Named so an audit reader can tell a disposal from an officer's own delete.
const ACTOR_DESCRIPTION = 'scheduled job: retention disposal';

// The entra_subject of the system user migration 0061 seeds. No token can
// carry it, so no real sign-in can ever bind to this account.
const SYSTEM_SUBJECT = 'system:retention';

export interface DisposalDue {
  code: RetentionClass;
  label: string;
  periodMonths: number | null;
  // The date a record must predate to be disposed of. Null when no period is
  // set, which is what the screen reads as "kept indefinitely".
  cutoff: Date | null;
  dueCount: number;
}

export interface DisposalOutcome {
  notificationsDeleted: number;
  applicationsRedacted: number;
  // Former members whose documents went (S-1703): the rows and the files.
  // The member, their applications' facts and their ledger stay.
  formerMembersDisposed: number;
  draftsDeleted: number;
  // Drafts that looked due but that deleteDraftApplication refused — one that
  // has been paid against, or acted on. Counted rather than thrown: a single
  // stuck row must not stop the rest of a scheduled run.
  draftsRefused: number;
  // Applications whose files could not be removed from SharePoint. Also
  // counted rather than thrown, for the same reason, and for one more: these
  // are ordered oldest first, so one permanently failing application would
  // otherwise be the first row of every run forever and nothing behind it
  // would ever be disposed of.
  filesFailed: number;
}

function cutoffFor(periodMonths: number | null, now: Date): Date | null {
  if (periodMonths === null) return null;
  const cutoff = new Date(now);
  // setUTCMonth past the end of a month rolls forward (31 March less one month
  // is 3 March, not 28 February). Immaterial at a scale of months, and the
  // alternative — clamping to the last day — would be arbitrary in the other
  // direction. What matters is that it is deterministic, so the preview on the
  // screen and the job agree to the day.
  cutoff.setUTCMonth(cutoff.getUTCMonth() - periodMonths);
  return cutoff;
}

// ---------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------

async function countNotifications(cutoff: Date): Promise<number> {
  const result = await query<{ n: number }>(
    'select count(*)::int as n from notification where created_at < $1',
    [cutoff]
  );
  return result.rows[0].n;
}

async function countRejectedApplications(cutoff: Date): Promise<number> {
  const result = await query<{ n: number }>(
    `select count(*)::int as n
       from membership_application
      where status = 'rejected'
        and disposed_at is null
        and decided_at is not null
        and decided_at < $1`,
    [cutoff]
  );
  return result.rows[0].n;
}

async function countAbandonedDrafts(cutoff: Date): Promise<number> {
  const result = await query<{ n: number }>(
    `select count(*)::int as n
       from membership_application
      where status = 'draft'
        and submitted_at is null
        and updated_at < $1`,
    [cutoff]
  );
  return result.rows[0].n;
}

// A member who resigned or died (S-1701's vocabulary), the membership having
// ended before the cutoff, whose documents are still held.
async function countFormerMembers(cutoff: Date): Promise<number> {
  const result = await query<{ n: number }>(
    `select count(*)::int as n
       from member
      where status in ('resigned', 'demised')
        and documents_disposed_at is null
        and status_changed_at is not null
        and status_changed_at < $1`,
    [cutoff]
  );
  return result.rows[0].n;
}

const COUNTS: Record<RetentionClass, (cutoff: Date) => Promise<number>> = {
  notification_log: countNotifications,
  rejected_application: countRejectedApplications,
  abandoned_draft: countAbandonedDrafts,
  former_member_documents: countFormerMembers,
};

/**
 * What the disposal job would dispose of if it ran now.
 *
 * This is what the screen shows beside each period, and it is the point of the
 * screen: nobody should set a period that destroys member data without first
 * seeing how much of it would go.
 */
export async function previewDisposal(
  now: Date = new Date()
): Promise<DisposalDue[]> {
  const policies = await listRetentionPolicies();

  return Promise.all(
    policies.map(async (policy: RetentionPolicy) => {
      const cutoff = cutoffFor(policy.periodMonths, now);
      return {
        code: policy.code,
        label: policy.label,
        periodMonths: policy.periodMonths,
        cutoff,
        // No period set: nothing is due, and the table is not queried.
        dueCount: cutoff === null ? 0 : await COUNTS[policy.code](cutoff),
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

async function disposeNotifications(
  cutoff: Date,
  limit: number
): Promise<number> {
  return withTransaction(async client => {
    // Deleted by id from a bounded select rather than by `created_at < cutoff`
    // directly, so a run is chunked and a long-overdue first sweep does not
    // hold one transaction open over the whole table.
    const deleted = await client.query<{ id: string }>(
      `delete from notification
        where id in (
          select id from notification
           where created_at < $1
           order by created_at
           limit $2
        )
        returning id`,
      [cutoff, limit]
    );
    const count = deleted.rowCount ?? 0;

    if (count > 0) {
      // One entry for the run's chunk, not one per notification: a first sweep
      // of a years-deep log would otherwise write thousands of audit rows
      // saying the same thing, in a table that cannot be tidied afterwards.
      await recordAudit(
        {
          actorUserId: null,
          actorDescription: ACTOR_DESCRIPTION,
          action: 'retention.disposed',
          entityType: 'notification',
          entityId: 'notification_log',
          newValue: { disposed: count, sentBefore: cutoff.toISOString() },
        },
        client
      );
    }

    return count;
  });
}

async function disposeRejectedApplications(
  cutoff: Date,
  limit: number,
  disposeFiles: typeof discardApplicationDocuments
): Promise<{ disposed: number; filesFailed: number }> {
  const due = await query<{ id: string; reference: string; decided_at: Date }>(
    `select id, reference, decided_at
       from membership_application
      where status = 'rejected'
        and disposed_at is null
        and decided_at is not null
        and decided_at < $1
      order by decided_at
      limit $2`,
    [cutoff, limit]
  );

  let disposed = 0;
  let filesFailed = 0;

  for (const row of due.rows) {
    // The files go FIRST, while the rows that say where they are still exist.
    // Redacting first would leave an applicant's identity papers in SharePoint
    // with nothing left in this system able to name them — the exact outcome
    // disposal is for.
    //
    // The cost of this order is the opposite failure: a crash after the files
    // are gone and before the rows are, which leaves an application that still
    // reads as holding documents it no longer has. That is recoverable by
    // running the job again, and the other way round is not.
    try {
      await disposeFiles(row.id);
    } catch (error) {
      // Nothing is redacted, so this application is selected again next run.
      // Loud, because it is the one failure mode where a person's identity
      // papers stay in SharePoint after the Society's period has passed.
      console.error(
        '[retention] files not removed, application NOT disposed of:',
        row.reference,
        error
      );
      filesFailed += 1;
      continue;
    }

    await withTransaction(async client => {
      const documents = await client.query<{ n: number }>(
        `select count(*)::int as n from document where application_id = $1`,
        [row.id]
      );

      // The rows go; document_version cascades with them (0013).
      await client.query('delete from document where application_id = $1', [
        row.id,
      ]);

      // What the applicant typed. Emptied rather than the row deleted: the
      // parties are what say an application HAD an applicant and a nominee,
      // which is true of it regardless of who they were.
      await client.query(
        `update application_party set values = '{}'::jsonb
          where application_id = $1`,
        [row.id]
      );

      await client.query(
        'update membership_application set disposed_at = now() where id = $1',
        [row.id]
      );

      // Deliberately records the reference and the count, never what was in
      // the fields: disposal that kept a copy in a table nobody can edit would
      // be no disposal at all.
      await recordAudit(
        {
          actorUserId: null,
          actorDescription: ACTOR_DESCRIPTION,
          action: 'retention.disposed',
          entityType: 'membership_application',
          entityId: row.id,
          newValue: {
            reference: row.reference,
            decidedAt: row.decided_at,
            documentsDisposed: documents.rows[0].n,
          },
        },
        client
      );
    });

    disposed += 1;
  }

  return { disposed, filesFailed };
}

// A former member's documents (S-1703): the files first, for the same
// reason as an application's, then every document row about them — filed
// against them, against a request of theirs, or against an application of
// theirs. What stays says what happened without saying who: the member
// row and its number, the applications and their statuses, every ledger
// entry and every receipt. The applicant's own captured details stay too:
// the ledger names the member by them, and money that moved is a fact the
// Society keeps (docs/ledger.md, "What cannot change").
async function disposeFormerMembers(
  cutoff: Date,
  limit: number,
  disposeFiles: typeof discardMemberFiles
): Promise<{ disposed: number; filesFailed: number }> {
  const due = await query<{
    id: string;
    member_no: string;
    status: string;
    status_changed_at: Date;
  }>(
    `select id, member_no, status, status_changed_at
       from member
      where status in ('resigned', 'demised')
        and documents_disposed_at is null
        and status_changed_at is not null
        and status_changed_at < $1
      order by status_changed_at
      limit $2`,
    [cutoff, limit]
  );

  let disposed = 0;
  let filesFailed = 0;

  for (const row of due.rows) {
    try {
      await disposeFiles(row.id);
    } catch (error) {
      console.error(
        '[retention] files not removed, former member NOT disposed of:',
        row.member_no,
        error
      );
      filesFailed += 1;
      continue;
    }

    await withTransaction(async client => {
      const documents = await client.query<{ n: number }>(
        `select count(*)::int as n
           from document d
           left join transaction t on t.id = d.transaction_id
           left join membership_application a on a.id = d.application_id
          where d.member_id = $1 or t.member_id = $1
             or a.existing_member_id = $1
             or a.id = (select application_id from member where id = $1)`,
        [row.id]
      );
      await client.query(
        `delete from document d
          using (select d2.id
                   from document d2
                   left join transaction t on t.id = d2.transaction_id
                   left join membership_application a on a.id = d2.application_id
                  where d2.member_id = $1 or t.member_id = $1
                     or a.existing_member_id = $1
                     or a.id = (select application_id from member where id = $1)) gone
          where d.id = gone.id`,
        [row.id]
      );
      await client.query(
        'update member set documents_disposed_at = now() where id = $1',
        [row.id]
      );
      await recordAudit(
        {
          actorUserId: null,
          actorDescription: ACTOR_DESCRIPTION,
          action: 'retention.disposed',
          entityType: 'member',
          entityId: row.id,
          newValue: {
            memberNo: row.member_no,
            status: row.status,
            statusChangedAt: row.status_changed_at,
            documentsDisposed: documents.rows[0].n,
          },
        },
        client
      );
    });

    disposed += 1;
  }

  return { disposed, filesFailed };
}

async function disposeAbandonedDrafts(
  cutoff: Date,
  limit: number,
  discardFiles: typeof discardApplicationFiles
): Promise<{ deleted: number; refused: number }> {
  const due = await query<{ id: string }>(
    `select id
       from membership_application
      where status = 'draft'
        and submitted_at is null
        and updated_at < $1
      order by updated_at
      limit $2`,
    [cutoff, limit]
  );

  const principal = await disposingPrincipal();
  let deleted = 0;
  let refused = 0;

  for (const row of due.rows) {
    try {
      // The officer's own delete path, unchanged: it re-reads under a lock,
      // refuses a draft that has been paid against or acted on, writes its own
      // audit entry, and discards the files. Reusing it means a disposal and a
      // delete leave the system in exactly the same state, and there is one
      // set of guards rather than two that can drift.
      await deleteDraftApplication(row.id, principal, discardFiles);
      deleted += 1;
    } catch (error) {
      if (error instanceof ApplicationError) {
        // A draft with a receipt against it, or one that has a transition
        // behind it. It stays, and it will be offered again on every run —
        // which is correct: it is not disposable, and saying so repeatedly is
        // better than forgetting it exists.
        refused += 1;
        continue;
      }
      throw error;
    }
  }

  return { deleted, refused };
}

// deleteDraftApplication checks one staff permission on a Principal. The
// system user holds none, so this is the narrowest thing that satisfies that
// check — the same shape the public API builds for its own delete.
async function disposingPrincipal(): Promise<Principal> {
  const user = await query<{ id: string; email: string }>(
    'select id, email from app_user where entra_subject = $1',
    [SYSTEM_SUBJECT]
  );
  if (user.rowCount === 0) {
    throw new Error('The retention system user is missing.');
  }

  return {
    userId: user.rows[0].id,
    entraSubject: SYSTEM_SUBJECT,
    email: ACTOR_DESCRIPTION,
    displayName: 'Retention',
    roles: [],
    roleNames: [],
    permissions: new Set(['application.capture']),
  };
}

export interface DisposalOptions {
  now?: Date;
  // The most records of each class one call will dispose of. The job loops
  // until a pass does nothing, checkpointing between passes, so this bounds a
  // transaction rather than a run.
  limit?: number;
  // Deleting an abandoned draft's files, through deleteDraftApplication's own
  // parameter of the same shape.
  discardFiles?: typeof discardApplicationFiles;
  // Deleting a disposed application's files, which is a different question —
  // see discardApplicationDocuments.
  disposeFiles?: typeof discardApplicationDocuments;
  // Deleting a former member's files (S-1703) — see discardMemberFiles.
  disposeMemberFiles?: typeof discardMemberFiles;
}

/**
 * One pass. Returns what it disposed of, so the job can tell a pass that did
 * work from one that found nothing and stop.
 */
export async function disposeDueRecords(
  options: DisposalOptions = {}
): Promise<DisposalOutcome> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 200;
  const discardFiles = options.discardFiles ?? discardApplicationFiles;
  const disposeFiles = options.disposeFiles ?? discardApplicationDocuments;
  const disposeMemberFiles = options.disposeMemberFiles ?? discardMemberFiles;

  const policies = await listRetentionPolicies();
  const periodOf = (code: RetentionClass) =>
    policies.find(p => p.code === code)?.periodMonths ?? null;

  const outcome: DisposalOutcome = {
    notificationsDeleted: 0,
    applicationsRedacted: 0,
    formerMembersDisposed: 0,
    draftsDeleted: 0,
    draftsRefused: 0,
    filesFailed: 0,
  };

  const notificationCutoff = cutoffFor(periodOf('notification_log'), now);
  if (notificationCutoff) {
    outcome.notificationsDeleted = await disposeNotifications(
      notificationCutoff,
      limit
    );
  }

  const rejectedCutoff = cutoffFor(periodOf('rejected_application'), now);
  if (rejectedCutoff) {
    const rejected = await disposeRejectedApplications(
      rejectedCutoff,
      limit,
      disposeFiles
    );
    outcome.applicationsRedacted = rejected.disposed;
    outcome.filesFailed = rejected.filesFailed;
  }

  const formerCutoff = cutoffFor(periodOf('former_member_documents'), now);
  if (formerCutoff) {
    const former = await disposeFormerMembers(
      formerCutoff,
      limit,
      disposeMemberFiles
    );
    outcome.formerMembersDisposed = former.disposed;
    outcome.filesFailed += former.filesFailed;
  }

  const draftCutoff = cutoffFor(periodOf('abandoned_draft'), now);
  if (draftCutoff) {
    const drafts = await disposeAbandonedDrafts(
      draftCutoff,
      limit,
      discardFiles
    );
    outcome.draftsDeleted = drafts.deleted;
    outcome.draftsRefused = drafts.refused;
  }

  return outcome;
}

// Whether a pass did anything worth running another for. A refusal and a
// failed file removal are not progress: both are offered again every pass, so
// counting either would loop forever.
export function disposedAnything(outcome: DisposalOutcome): boolean {
  return (
    outcome.notificationsDeleted +
      outcome.applicationsRedacted +
      outcome.formerMembersDisposed +
      outcome.draftsDeleted >
    0
  );
}
