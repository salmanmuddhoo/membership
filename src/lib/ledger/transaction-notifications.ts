// What a member hears about their own transactions (S-1803, NOTIF-US-001,
// FRD 11.1) and what the staff hear about work that waits on them
// (S-1804, NOTIF-US-002/003, FRD 11.2). Raised by the ledger after a
// transaction has committed, the way workflow.ts raises application
// events: never inside the transaction, never failing what raised it
// (notify.ts's bargain), and the wording the Society's to edit
// (migration 0081).
//
// A member's events go to the address their application recorded, as a
// receipt does (receipt-notifications.ts). Staff events go by email to
// app_user (notifications/staff.ts): the holders of a step's role when a
// transaction arrives there, and the captor when it comes back. Whoever
// caused the arrival — the submitter, the forwarding reviewer — is not
// written to about it.
//
// Exits (closure, resignation, demise) tell their member or claimant
// through exit-notifications.ts; here they raise only the staff events.
import {
  listAccountTypes,
  listWorkflows,
  nearFloorMargin,
} from '../config/reference';
import { notify } from '../notifications/notify';
import { staffMember, staffWithRole } from '../notifications/staff';
import { toCents } from '../payments/money';
import { contactForHolder } from './receipt-notifications';
import type { TransactionSummary } from './review';
import { appLink, bareAmount, KIND_WORDS } from './void-notifications';

const accountLabel = (t: TransactionSummary) =>
  `${t.accountNo} · ${t.accountTypeName}`;

const counterpartLabel = (t: TransactionSummary) =>
  t.counterpartAccountNo
    ? `${t.counterpartAccountNo} · ${t.counterpartAccountTypeName}`
    : (t.payeeName ?? '');

function memberValues(t: TransactionSummary, name: string) {
  return {
    member_name: name || t.holderName,
    reference: t.transferReference ?? t.reference,
    amount: bareAmount(t.amount, t.currency),
    account: accountLabel(t),
  };
}

async function toHolder(
  t: TransactionSummary,
  eventCode: string,
  extras: Record<string, string> = {}
): Promise<string[]> {
  const contact = await contactForHolder(t.holderKind, t.holderId);
  if (!contact || (!contact.email && !contact.mobile)) return [];
  return notify({
    eventCode,
    recipients: { email: contact.email, mobile: contact.mobile },
    values: { ...memberValues(t, contact.name), ...extras },
    entityType: 'transaction',
    entityId: t.id,
  });
}

function staffValues(t: TransactionSummary) {
  return {
    kind: KIND_WORDS[t.kind] ?? t.kind,
    reference: t.transferReference ?? t.reference,
    member_name: t.holderName,
    amount: bareAmount(t.amount, t.currency),
    account: accountLabel(t),
    link: appLink(`/transactions/${t.id}`),
  };
}

async function toStaff(
  t: TransactionSummary,
  eventCode: string,
  recipients: { userId: string; name: string; email: string }[],
  extras: Record<string, string>
): Promise<string[]> {
  const written: string[] = [];
  for (const recipient of recipients) {
    written.push(
      ...(await notify({
        eventCode,
        recipients: { email: recipient.email, mobile: null },
        values: {
          recipient_name: recipient.name,
          ...staffValues(t),
          ...extras,
        },
        entityType: 'transaction',
        entityId: t.id,
      }))
    );
  }
  return written;
}

// The step a transaction now waits at, from the chain it was routed to.
async function stepWaitingAt(t: TransactionSummary) {
  if (!t.workflowCode || !t.currentStepCode) return null;
  const definition = (await listWorkflows()).find(
    w => w.code === t.workflowCode
  );
  return definition?.steps.find(s => s.code === t.currentStepCode) ?? null;
}

// S-1804: everyone who may act at this step, except whoever sent it there.
async function notifyAwaiting(
  t: TransactionSummary,
  step: { name: string; roleCode: string },
  byUserId: string
): Promise<string[]> {
  const recipients = (await staffWithRole(step.roleCode)).filter(
    r => r.userId !== byUserId
  );
  return toStaff(t, 'transaction.awaiting', recipients, {
    step: step.name,
    captured_by: t.capturedByName,
  });
}

// S-1803: an account a debit left within the margin of its floor. The
// margin at 0 is the advisory off.
async function notifyNearFloor(t: TransactionSummary): Promise<string[]> {
  if (t.balanceAfter === null) return [];
  const debit =
    t.kind === 'withdrawal' ||
    (t.kind === 'transfer_leg' && t.legDirection === 'debit');
  if (!debit) return [];
  const margin = toCents(await nearFloorMargin());
  if (margin <= 0) return [];
  const type = (await listAccountTypes()).find(a => a.id === t.accountTypeId);
  const floor = toCents(type?.minimumBalance ?? '0');
  if (toCents(t.balanceAfter) - floor > margin) return [];
  return toHolder(t, 'balance.near_floor', {
    balance: bareAmount(t.balanceAfter, t.currency),
    floor: bareAmount(type?.minimumBalance ?? '0', t.currency),
  });
}

/**
 * A transaction — or a transfer's two legs — posted. The member hears
 * what happened to their money; a debit near the floor adds the advisory.
 * Never throws.
 */
export async function notifyPosted(
  legs: (TransactionSummary | null)[]
): Promise<string[]> {
  const written: string[] = [];
  try {
    const posted = legs.filter(
      (l): l is TransactionSummary => l !== null && l.status === 'posted'
    );
    const told = new Set<string>();
    for (const t of posted) {
      const balance = t.balanceAfter
        ? bareAmount(t.balanceAfter, t.currency)
        : '';
      if (t.kind === 'deposit') {
        written.push(...(await toHolder(t, 'deposit.posted', { balance })));
      } else if (t.kind === 'withdrawal') {
        written.push(
          ...(await toHolder(t, 'withdrawal.disbursed', {
            method: t.methodName,
            receipt_no: t.receiptNo ?? '',
            balance,
          }))
        );
      } else if (t.kind === 'transfer_leg' && !told.has(t.holderId)) {
        // Both sides theirs: one message, from the leg the money left.
        told.add(t.holderId);
        const [from, to] =
          t.legDirection === 'debit'
            ? [accountLabel(t), counterpartLabel(t)]
            : [counterpartLabel(t), accountLabel(t)];
        written.push(
          ...(await toHolder(t, 'transfer.posted', {
            from_account: from,
            to_account: to,
            balance,
          }))
        );
      }
      written.push(...(await notifyNearFloor(t)));
    }
  } catch (error) {
    console.error('[transactions] could not send notification:', error);
  }
  return written;
}

/**
 * A transaction submitted or resubmitted — posted at once by the matrix,
 * or arrived at the first step of its chain (or back at the step that
 * returned it). The routed leg comes first; a transfer's other leg after
 * it. Never throws.
 */
export async function notifySubmitted(
  legs: (TransactionSummary | null)[],
  options: { byUserId: string; resubmitted?: boolean }
): Promise<string[]> {
  const routed = legs[0];
  if (!routed) return [];
  if (routed.status === 'posted') return notifyPosted(legs);
  const written: string[] = [];
  try {
    // A member is told once that it is in; a resubmission after a return
    // is the office's business.
    if (routed.kind === 'withdrawal' && !options.resubmitted) {
      written.push(...(await toHolder(routed, 'withdrawal.submitted')));
    }
    const step = await stepWaitingAt(routed);
    if (step) {
      written.push(...(await notifyAwaiting(routed, step, options.byUserId)));
    }
  } catch (error) {
    console.error('[transactions] could not send notification:', error);
  }
  return written;
}

/**
 * A reviewer's decision, after it has committed: forwarded to a further
 * step (that step's role is told, and a withdrawal's member), returned to
 * its captor with the comment, or rejected with the reason. Never throws.
 */
export async function notifyReviewed(
  t: TransactionSummary,
  decision: {
    outcome: 'forward' | 'return' | 'reject';
    comment: string;
    by: { userId: string; displayName: string };
    // Where a forward sent it; null at the last step.
    next: { name: string; roleCode: string } | null;
  }
): Promise<string[]> {
  const written: string[] = [];
  try {
    const comment = decision.comment.trim();
    switch (decision.outcome) {
      case 'forward':
        if (decision.next) {
          if (t.kind === 'withdrawal') {
            written.push(
              ...(await toHolder(t, 'withdrawal.under_review', { comment }))
            );
          }
          written.push(
            ...(await notifyAwaiting(t, decision.next, decision.by.userId))
          );
        }
        break;
      case 'return': {
        const captor = await staffMember(t.capturedById);
        if (captor) {
          written.push(
            ...(await toStaff(t, 'transaction.returned', [captor], {
              returned_by: decision.by.displayName,
              comment,
            }))
          );
        }
        break;
      }
      case 'reject':
        if (t.kind === 'withdrawal') {
          written.push(
            ...(await toHolder(t, 'withdrawal.rejected', { comment }))
          );
        }
        break;
    }
  } catch (error) {
    console.error('[transactions] could not send notification:', error);
  }
  return written;
}
