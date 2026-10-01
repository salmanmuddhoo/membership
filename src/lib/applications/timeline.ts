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

//
// The step shape and the one-current rule are shared with every other record
// that has a chain (src/lib/workflow/timeline.ts, S-1405); what is this
// module's own is the six stages an application goes through.
import {
  assignStates,
  type PlannedStep,
  type StepState,
  type TimelineStep,
} from '../workflow/timeline';

export type { StepState, TimelineStep };

export interface TimelineInput {
  status: string;
  // Mandatory fields still empty (S-304's own blocking count).
  mandatoryFieldsOutstanding: number;
  // Filled-in values that do not stand up — an NIC already on file, a
  // guardian nobody can find. Not "empty", so not counted as such (lifecycle
  // test, LC-04).
  valuesToCorrect?: number;
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
  // S-611 follow-up: who actually holds it while status is still 'new' —
  // "With the Regional Manager" or "With the Secretary", from
  // workflow.ts's reviewStageLabel. Falls back to "With the Secretary" when
  // absent, the only thing this could ever have meant before Regional
  // oversight was ever enforced.
  reviewStageLabel?: string | null;
  // Who returned this application in the current pass, for a 'returned'
  // application — "Returned by the Regional Manager" etc. Shown on the Submit
  // step so the officer knows which reviewer sent it back.
  returnedByLabel?: string | null;
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
  const planned: PlannedStep[] = [
    {
      key: 'capture',
      label: 'Applicant details',
      done:
        input.mandatoryFieldsOutstanding === 0 && !(input.valuesToCorrect ?? 0),
      detail: returned
        ? 'Returned for correction'
        : input.mandatoryFieldsOutstanding > 0
          ? `${input.mandatoryFieldsOutstanding} required ${
              input.mandatoryFieldsOutstanding === 1 ? 'field' : 'fields'
            } empty`
          : (input.valuesToCorrect ?? 0) > 0
            ? `${input.valuesToCorrect} to correct`
            : undefined,
      problem:
        returned ||
        input.mandatoryFieldsOutstanding > 0 ||
        (input.valuesToCorrect ?? 0) > 0,
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
    // Submission, Regional oversight (S-611, where enabled) and Secretary
    // review used to be two steps and are now as many as three. An officer
    // has exactly one thing to do at this point — submit — and everything
    // after that is out of their hands either way, so it still reads as one
    // step: done once it is fully past the Secretary.
    {
      key: 'submit',
      label: 'Submit',
      done: rank >= 3,
      detail:
        rank >= 1 && rank < 3
          ? (input.reviewStageLabel ?? 'With the Secretary')
          : returned && input.returnedByLabel
            ? input.returnedByLabel
            : undefined,
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

  return assignStates(planned);
}
