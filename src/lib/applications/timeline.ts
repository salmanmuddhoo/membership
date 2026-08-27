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
  }> = [
    {
      key: 'capture',
      label: 'Capture the application',
      done: input.mandatoryFieldsOutstanding === 0,
      detail: returned
        ? 'Returned for correction'
        : input.mandatoryFieldsOutstanding > 0
          ? `${input.mandatoryFieldsOutstanding} required ${
              input.mandatoryFieldsOutstanding === 1 ? 'field' : 'fields'
            } empty`
          : undefined,
    },
    {
      key: 'sign',
      label: 'Print and have it signed',
      // The only evidence a signature exists is the signed form coming back.
      done: input.signedFormFiled,
    },
    {
      key: 'documents',
      label: 'File the signed form and KYC documents',
      done: input.requiredDocumentsOutstanding === 0,
      detail:
        input.requiredDocumentsOutstanding > 0
          ? `${input.requiredDocumentsOutstanding} outstanding`
          : undefined,
    },
    {
      key: 'payment',
      label: 'Record the payment and receipt',
      done: input.paymentRecorded,
      detail:
        input.paymentRecorded && input.paymentReceiptNo
          ? input.paymentReceiptNo
          : undefined,
    },
    {
      key: 'submitted',
      label: 'Submit for review',
      done: rank >= 1,
    },
    {
      key: 'secretary',
      label: 'Secretary review',
      // Done once it has moved past the Secretary to the President or beyond.
      done: rank >= 3,
      detail:
        input.status === 'submitted_for_review'
          ? 'With the Secretary'
          : undefined,
    },
    {
      key: 'decision',
      label: 'President decision',
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
    };
  });
}
