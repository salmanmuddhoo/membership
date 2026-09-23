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
import {
  activeChain,
  type TransactionKind,
  type WorkflowStep,
} from '../config/reference';
import {
  checklistComplete,
  isExitRequest,
  requestChecklist,
} from '../ledger/closures';
import { rolesHoldingPermission } from '../access/holders';
import { sourceOfFundItem } from '../ledger/deposit-requests';
import { finalStepLabel } from '../ledger/labels';
import {
  loadTransaction,
  PERMISSION_DISBURSE,
  PERMISSION_POST,
  permissionToPost,
  positionOf,
  transitionsFor,
} from '../ledger/review';
import { describeBand, resolveRoute, routeBands } from '../ledger/routing';
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
  // money in, 'Disbursement' for money out, 'Submitted' first for an exit.
  submitLabel?: string;
  postedLabel?: string;
  // Who takes the last step — the roles holding the permission it needs
  // ("Treasurer" under Disbursement) — shown until it is done.
  postedDetail?: string;
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
        : (input.postedDetail ?? (approved ? 'Approved, to post' : undefined)),
    },
  ];
  return assignStates(planned);
}

/**
 * The timeline a transaction WOULD take, before it exists (the timeline
 * experience): what an officer sees over the form, so the first chevron is
 * theirs and the rest say who decides. Recorded is current, every step of
 * the chain to come, Posted at the end — or Recorded then Posted alone
 * where the matrix posts at once.
 */
export function previewTimeline(
  chain: Pick<WorkflowStep, 'code' | 'name' | 'roleName'>[],
  labels: {
    submitLabel?: string;
    postedLabel?: string;
    postedDetail?: string;
  } = {}
): TimelineStep[] {
  return transactionTimeline({
    status: 'draft',
    chain,
    currentStepCode: null,
    passedStepCodes: [],
    rejectedAtStepCode: null,
    returnedBy: null,
    receiptNo: null,
    submitLabel: labels.submitLabel ?? 'Record',
    postedLabel: labels.postedLabel ?? 'Posted',
    // A chain ends with someone paying out or posting; with none, the
    // officer recording it does both at once.
    postedDetail: chain.length > 0 ? labels.postedDetail : undefined,
  });
}

// What the form pages show above their fields: for each of a holder's
// accounts, the bands the matrix draws for this kind and this officer, each
// with its own line and its own preview timeline. Bands are computed once
// per account type — two accounts of one type route alike.
export interface RoutePreviewBand {
  key: string;
  fromCents: number;
  toCents: number | null;
  summary: string;
  steps: TimelineStep[];
  // No chain: recorded and posted in one act, by whoever records it.
  atOnce: boolean;
}
export interface RoutePreviewGroup {
  accountId: string;
  bands: RoutePreviewBand[];
}

/** The band the form starts on: its account and amount, else the first. */
export function initialRouteBand(
  groups: RoutePreviewGroup[],
  accountId: string | undefined,
  amountCents: number | null
): RoutePreviewBand | null {
  const group =
    groups.find(g => g.accountId === accountId) ?? groups[0] ?? null;
  return (
    group?.bands.find(
      b =>
        amountCents !== null &&
        b.fromCents <= amountCents &&
        (b.toCents === null || amountCents <= b.toCents)
    ) ??
    group?.bands[0] ??
    null
  );
}

export async function routePreviewGroups(
  kind: TransactionKind,
  accounts: { id: string; accountTypeId: string }[],
  roleCodes: readonly string[]
): Promise<RoutePreviewGroup[]> {
  const byType = new Map<string, RoutePreviewBand[]>();
  // A withdrawal is disbursed by whoever holds transaction.disburse (the
  // Treasurer); a transfer's payee is not known until the form is filled,
  // so its preview says Posted and the chevron after submit says which.
  const labels =
    kind === 'withdrawal'
      ? {
          postedLabel: 'Disbursement',
          postedDetail: await roleNamesHolding(PERMISSION_DISBURSE),
        }
      : { postedDetail: await roleNamesHolding(PERMISSION_POST) };
  for (const typeId of new Set(accounts.map(a => a.accountTypeId))) {
    const bands = await routeBands({ kind, accountTypeId: typeId, roleCodes });
    byType.set(
      typeId,
      bands.map((band, i) => ({
        key: `${typeId}:${i}`,
        fromCents: band.fromCents,
        toCents: band.toCents,
        summary: describeBand(band),
        steps: previewTimeline(band.chain, labels),
        atOnce: band.definitionCode === null,
      }))
    );
  }
  return accounts.map(a => ({
    accountId: a.id,
    bands: byType.get(a.accountTypeId) ?? [],
  }));
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
  const closure = isExitRequest(transaction.kind)
    ? closurePrelude(
        await requestChecklist(
          transaction.id,
          transaction.kind,
          transaction.claimantKind !== null
        ),
        transaction.kind,
        transaction.claimantKind !== null
      )
    : transaction.kind === 'deposit'
      ? await depositRequestPrelude(transaction.id, transaction.status)
      : {};
  return transactionTimeline({
    status: transaction.status,
    chain,
    currentStepCode: position?.step.code ?? null,
    passedStepCodes,
    rejectedAtStepCode: rejected?.stepCode ?? null,
    returnedBy: lastReturn?.actorRole ?? null,
    receiptNo: transaction.receiptNo,
    // Money paid out ends in Disbursement, by whoever holds the permission
    // for it (officer direction: the Treasurer); money in ends in Posted.
    postedLabel: finalStepLabel(transaction),
    postedDetail:
      chain.length > 0
        ? await roleNamesHolding(permissionToPost(transaction))
        : undefined,
    ...closure,
  });
}

async function roleNamesHolding(
  permission: string
): Promise<string | undefined> {
  const names = await rolesHoldingPermission(permission);
  return names.length > 0 ? names.join(' / ') : undefined;
}

async function expectedChain(transaction: {
  kind: string;
  accountTypeId: string;
  amount: string;
}): Promise<WorkflowStep[]> {
  if (!isExitRequest(transaction.kind) && transaction.kind !== 'deposit') {
    return [];
  }
  const route = await resolveRoute({
    kind: transaction.kind as TransactionKind,
    accountTypeId: transaction.accountTypeId,
    amountCents: toCents(transaction.amount),
    roleCodes: [],
  });
  return route.definition ? activeChain(route.definition.code) : [];
}

/**
 * A large cash deposit's own steps before its chain (S-1306): the details
 * are on the request from the moment it exists; the Source of Fund form is
 * the signed sheet on file. Only a deposit that went through the request —
 * a draft, or one with the form filed — has them; one recorded in one act
 * has none.
 */
async function depositRequestPrelude(
  transactionId: string,
  status: string
): Promise<Pick<TransactionTimelineInput, 'prelude' | 'submitLabel'>> {
  const item = await sourceOfFundItem(transactionId);
  if (status !== 'draft' && !item?.filed) return {};
  return depositPrelude(Boolean(item?.filed));
}

export function depositPrelude(
  signed: boolean
): Pick<TransactionTimelineInput, 'prelude' | 'submitLabel'> {
  return {
    prelude: [
      { key: 'details', label: 'Details', done: true },
      {
        key: 'signature',
        label: 'Source of Fund form',
        done: signed,
        detail: signed ? undefined : 'Not signed yet',
        problem: !signed,
      },
    ],
    submitLabel: 'Submitted',
  };
}

/**
 * A closure's own steps before its chain (S-1702): the details are on the
 * request from the moment it exists; the signature is the signed request
 * on file; the documents step reads the same checklist, which today is
 * that one form. Pure, so the tests can say what each state looks like.
 */
export function closurePrelude(
  checklist: { documentName: string; filed: unknown | null }[],
  kind: string = 'closure',
  // A closure on a death: no signature to take, the certificate filed.
  onDeath = false
): Pick<TransactionTimelineInput, 'prelude' | 'submitLabel'> {
  const complete = checklistComplete(
    checklist as Parameters<typeof checklistComplete>[0]
  );
  const missing = checklist.filter(i => i.filed === null);
  const documents = {
    key: 'documents',
    label: 'Documents',
    done: complete,
    detail: complete ? undefined : `${missing.length} to file`,
    problem: !complete,
  };
  // A claim (S-1704) has no signature of the member's to take: the
  // claimant is named, the certificate and the affidavit are filed.
  if (kind === 'demise' || onDeath) {
    return {
      prelude: [
        {
          key: 'details',
          label: kind === 'demise' ? 'Claimant' : 'Details',
          done: true,
        },
        documents,
      ],
      submitLabel: 'Submitted',
    };
  }
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
      documents,
    ],
    // Its last step is Disbursement, like any money paid out (QA-10,
    // business decision): finalStepLabel, not a word of its own.
    submitLabel: 'Submitted',
  };
}
