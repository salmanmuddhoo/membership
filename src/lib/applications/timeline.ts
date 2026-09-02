// Where an application has got to, as the officer working it thinks of it.
//
// The status column says what the workflow believes; this says what is left to
// do. They are not the same thing. An application can be `new` — submitted,
// out of the officer's hands — while its documents are still incomplete, and
// an officer who sees only "New" has no idea that anything is outstanding.
//
// The order here is the order of the real-world process, which is not the
// order the software would naturally impose: the form is captured, printed and
// physically signed BEFORE any document exists to scan. Filing the KYC pack
// first would mean asking for a signed form nobody has signed yet. The money
// is taken after the pack is complete and before the application leaves the
// office, which is where the payment step sits.
//
// Every step is derived from state that is recorded elsewhere. Nothing here is
// stored, so nothing here can disagree with the record.

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

export interface TimelineInput {
  status: string;
  // Mandatory fields still empty (S-304's own blocking count).
  mandatoryFieldsOutstanding: number;
  // The signed form, back from the applicant and filed.
  signedFormFiled: boolean;
  // Required checklist items with nothing filed against them. Counts the
  // signed form too, which is why the signing step reads it separately.
  requiredDocumentsOutstanding: number;
  // A live receipt against this application (M5). A voided one does not count:
  // the money went back.
  paymentRecorded: boolean;
  // Shown on the step once there is one, so the officer can quote it without
  // scrolling.
  paymentReceiptNo?: string | null;
}

// How far through the approval chain a status is. Two statuses share a rank
// where they mean the same thing for progress: `returned` is back with the
// officer exactly as a draft is, and a decision is a decision whichever way it
// went.
const RANK: Record<string, number> = {
  draft: 0,
  returned: 0,
  new: 1,
  submitted_for_review: 2,
  abeyance: 2,
  submitted_for_approval: 3,
  approved: 4,
  rejected: 4,
};

function rankOf(status: string): number {
  return RANK[status] ?? 0;
}

export function applicationTimeline(input: TimelineInput): TimelineStep[] {
  const rank = rankOf(input.status);
  const returned = input.status === 'returned';

  // Each step's own test for being finished, in process order.
  const planned: Array<{
    key: string;
    label: string;
    done: boolean;
    detail?: string;
    problem?: boolean;
  }> = [
    {
      key: 'capture',
      label: 'Applicant details',
      done: input.mandatoryFieldsOutstanding === 0,
      detail: returned
        ? 'Returned for correction'
        : input.mandatoryFieldsOutstanding > 0
          ? `${input.mandatoryFieldsOutstanding} required ${
              input.mandatoryFieldsOutstanding === 1 ? 'field' : 'fields'
            } empty`
          : undefined,
      problem: returned || input.mandatoryFieldsOutstanding > 0,
    },
    {
      key: 'sign',
      label: 'Application signature',
      // The only evidence a signature exists is the signed form coming back.
      done: input.signedFormFiled,
    },
    {
      key: 'documents',
      label: 'KYC Documents',
      done: input.requiredDocumentsOutstanding === 0,
      detail:
        input.requiredDocumentsOutstanding > 0
          ? `${input.requiredDocumentsOutstanding} outstanding`
          : undefined,
      problem: input.requiredDocumentsOutstanding > 0,
    },
    {
      key: 'payment',
      label: 'Payments',
      done: input.paymentRecorded,
      detail:
        input.paymentRecorded && input.paymentReceiptNo
          ? input.paymentReceiptNo
          : undefined,
    },
    // Submission and Secretary review used to be two steps. An officer has
    // exactly one thing to do at this point — submit — and everything after
    // that is the Secretary's, all the way through to forwarding it on, so
    // it reads as one step: done once it is fully past the Secretary.
    {
      key: 'submit',
      label: 'Submit',
      done: rank >= 3,
      detail: rank >= 1 && rank < 3 ? 'With the Secretary' : undefined,
    },
    {
      key: 'decision',
      label: 'Approval Stage',
      done: rank >= 4,
      detail:
        input.status === 'approved'
          ? 'Approved'
          : input.status === 'rejected'
            ? 'Declined'
            : input.status === 'submitted_for_approval'
              ? 'With the President'
              : undefined,
    },
  ];

  // Exactly one step reads as current: the first that is not finished.
  // Marking several would leave the officer choosing, which is the question
  // the timeline exists to answer.
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
      // Never on a step still ahead in the chain: a step's own data can be
      // "wrong" (no documents filed yet, nothing paid) purely because
      // nothing has happened there YET, which is not the same as something
      // being missing that should already be there. Only a step that is
      // current or already done — one the officer has actually reached —
      // can be a problem.
      ...(step.problem && state !== 'todo' ? { problem: true } : {}),
    };
  });
}
