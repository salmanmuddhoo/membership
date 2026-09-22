// The strip at the top of a record that has a chain (S-1405, FRD 8): the
// steps this one will actually go through, read from the live configuration
// rather than built into the front end, so the screen and Configuration →
// Workflows cannot disagree. A disabled step disappears from every chevron
// rendered from then on; a deposit routed nowhere has no approval stage at
// all.
//
// Two layers. The pure part — `assignStates` and `transactionTimeline` —
// maps recorded state to steps and is what the tests exercise.
// `chainTimeline` is the database-backed caller for a given entity.
// `applicationTimeline` (src/lib/applications/timeline.ts) is the other
// caller of `assignStates`: an application's stages are fixed by its
// process (capture, sign, documents, pay, submit, decide), a transaction's
// come from its chain.
import { activeChain, type WorkflowStep } from '../config/reference';
import { closureChecklist, checklistComplete } from '../ledger/closures';
import { loadTransaction, positionOf, transitionsFor } from '../ledger/review';
import { resolveRoute } from '../ledger/routing';
import { toCents } from '../payments/money';

export type StepState =
  // Finished, on the evidence.
  | 'done'
  // The next thing to do.
  | 'current'
  // Ahead of the current step.
  | 'todo';

export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
  // One short phrase, only where it tells the officer something the label
  // does not.
  detail?: string;
  // True when this step's own detail describes something missing rather than
  // merely upcoming — fields still empty, documents still outstanding, a
  // return for correction. Distinct from `state`: `current` just means "the
  // next thing to do," which is a normal thing for an untouched step ahead in
  // the chain to be. This is for the screen to say "something here needs
  // attention" specifically, which is not true of every current step (being
  // next in line to record a payment is not a problem).
  problem?: boolean;
}

export interface PlannedStep {
  key: string;
  label: string;
  done: boolean;
  detail?: string;
  problem?: boolean;
}

// Exactly one step reads as current: the first that is not finished.
// Marking several would leave the officer choosing, which is the question
// the timeline exists to answer. A problem is never shown on a step still
// ahead: a step nobody has reached yet always looks incomplete read on its
// own, and that is not a problem — it is just next.
export function assignStates(planned: PlannedStep[]): TimelineStep[] {
  let currentTaken = false;
  return planned.map(step => {
    let state: StepState;
    if (step.done) {
      state = 'done';
    } else if (!currentTaken) {
      state = 'current';
      currentTaken = true;
    } else {
      state = 'todo';
    }
    return {
      key: step.key,
      label: step.label,
      state,
      ...(step.detail ? { detail: step.detail } : {}),
      ...(step.problem && state !== 'todo' ? { problem: true } : {}),
    };
  });
}

export interface TransactionTimelineInput {
  status: string;
  // The chain as it is now — enabled steps only — or none.
  chain: Pick<WorkflowStep, 'code' | 'name' | 'roleName'>[];
  // The step it stands at (positionOf), null when it stands at none.
  currentStepCode: string | null;
  // Steps it has been forwarded from, off the trail.
  passedStepCodes: readonly string[];
  // Where it was rejected, off the trail, when it was.
  rejectedAtStepCode: string | null;
  // Who returned it, for the correction step's detail.
  returnedBy: string | null;
  receiptNo: string | null;
  // A request built up before it is submitted (a closure, S-1702): the
  // steps the officer walks first, in order, each with its own test for
  // being finished. Absent for a transaction recorded in one act.
  prelude?: PlannedStep[];
  // What the first and last steps are called: 'Recorded' and 'Posted' for
  // money moving, 'Submitted' and 'Closed' for a closure.
  submitLabel?: string;
  postedLabel?: string;
}

const ENDED: Record<string, string> = {
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/**
 * Recorded → each enabled step of its chain → Posted. Pure: what the trail
 * and the chain say, and nothing stored.
 */
export function transactionTimeline(
  input: TransactionTimelineInput
): TimelineStep[] {
  const returned = input.status === 'returned';
  const posted = input.status === 'posted';
  const approved = input.status === 'approved';
  const ended = ENDED[input.status] ?? null;
  const passed = new Set(input.passedStepCodes);
  const currentIndex = input.chain.findIndex(
    s => s.code === input.currentStepCode
  );
  const rejectedIndex = input.chain.findIndex(
    s => s.code === input.rejectedAtStepCode
  );

  // A request still being built (status 'draft') has not been submitted:
  // the submit step is the one with something to do.
  const draft = input.status === 'draft';
  const planned: PlannedStep[] = [
    ...(input.prelude ?? []),
    {
      key: 'capture',
      label: input.submitLabel ?? 'Recorded',
      // A returned transaction is back with its captor: the first step is
      // the one with something to do.
      done: !draft && !returned && !(ended && rejectedIndex < 0),
      detail: returned
        ? input.returnedBy
          ? `Returned by ${input.returnedBy}`
          : 'Returned for correction'
        : ended && rejectedIndex < 0
          ? ended
          : undefined,
      problem: returned || (ended !== null && rejectedIndex < 0),
    },
    ...input.chain.map((step, index) => {
      const rejectedHere = ended !== null && index === rejectedIndex;
      const done =
        posted ||
        approved ||
        passed.has(step.code) ||
        (currentIndex >= 0 && index < currentIndex);
      return {
        key: step.code,
        label: step.name,
        done: done && !rejectedHere,
        detail: rejectedHere ? ended! : step.roleName,
        problem: rejectedHere,
      };
    }),
    {
      key: 'posted',
      label: input.postedLabel ?? 'Posted',
      done: posted,
      detail: posted
        ? (input.receiptNo ?? undefined)
        : approved
          ? 'Approved, to post'
          : undefined,
    },
  ];
  return assignStates(planned);
}

/**
 * The chevron for one entity, from the record. Only transactions have a
 * chain read this way today; an application's fixed stages are
 * `applicationTimeline`'s.
 */
export async function chainTimeline(
  entityType: 'transaction',
  id: string
): Promise<TimelineStep[] | null> {
  if (entityType !== 'transaction') return null;
  const transaction = await loadTransaction(id);
  if (!transaction) return null;
  const [chain, position, trail] = await Promise.all([
    transaction.workflowCode
      ? activeChain(transaction.workflowCode)
      : transaction.status === 'draft'
        ? // Not routed yet: the chain the matrix would send it to today,
          // so the officer building a request sees who will decide it.
          expectedChain(transaction)
        : Promise.resolve([]),
    positionOf(transaction),
    transitionsFor(transaction.id),
  ]);
  const passedStepCodes = trail
    .filter(
      t =>
        t.stepCode !== null &&
        t.toStatus !== 'returned' &&
        t.toStatus !== 'rejected'
    )
    .map(t => t.stepCode!);
  const rejected = [...trail].reverse().find(t => t.toStatus === 'rejected');
  const lastReturn = [...trail].reverse().find(t => t.toStatus === 'returned');
  const closure =
    transaction.kind === 'closure'
      ? closurePrelude(await closureChecklist(transaction.id))
      : {};
  return transactionTimeline({
    status: transaction.status,
    chain,
    currentStepCode: position?.step.code ?? null,
    passedStepCodes,
    rejectedAtStepCode: rejected?.stepCode ?? null,
    returnedBy: lastReturn?.actorRole ?? null,
    receiptNo: transaction.receiptNo,
    ...closure,
  });
}

async function expectedChain(transaction: {
  kind: string;
  accountTypeId: string;
  amount: string;
}): Promise<WorkflowStep[]> {
  if (transaction.kind !== 'closure') return [];
  const route = await resolveRoute({
    kind: 'closure',
    accountTypeId: transaction.accountTypeId,
    amountCents: toCents(transaction.amount),
    roleCodes: [],
  });
  return route.definition ? activeChain(route.definition.code) : [];
}

/**
 * A closure's own steps before its chain (S-1702): the details are on the
 * request from the moment it exists; the signature is the signed request
 * on file; the documents step reads the same checklist, which today is
 * that one form. Pure, so the tests can say what each state looks like.
 */
export function closurePrelude(
  checklist: { documentName: string; filed: unknown | null }[]
): Pick<TransactionTimelineInput, 'prelude' | 'submitLabel' | 'postedLabel'> {
  const complete = checklistComplete(
    checklist as Parameters<typeof checklistComplete>[0]
  );
  const missing = checklist.filter(i => i.filed === null);
  return {
    prelude: [
      { key: 'details', label: 'Details', done: true },
      {
        key: 'signature',
        label: 'Signature',
        done: complete,
        detail: complete ? 'Signed request on file' : 'Not signed yet',
        problem: !complete,
      },
      {
        key: 'documents',
        label: 'Documents',
        done: complete,
        detail: complete ? undefined : `${missing.length} to file`,
        problem: !complete,
      },
    ],
    submitLabel: 'Submitted',
    postedLabel: 'Closed',
  };
}
