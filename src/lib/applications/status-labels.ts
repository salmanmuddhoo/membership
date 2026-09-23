// No 'approved' entry: an approved application no longer appears in that
// list at all (listApplications excludes it — it lives on the Members page
// from then on), so offering it as a filter would only ever show "no
// applications match."
export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  // Submitted from the member app and with the branch — worked exactly as a
  // draft (docs/member-app.md). Named for what an officer has to do with it
  // rather than for where it came from.
  received: 'Received online',
  new: 'New',
  // No enabled step produces 'submitted_for_review' (migration 0011: the
  // Secretary acts on New directly), so it is not offered as a filter; an
  // application somehow at it shows its code.
  submitted_for_approval: 'Submit for Approval',
  rejected: 'Rejected',
  returned: 'Returned for Correction',
  abeyance: 'Abeyance',
};
