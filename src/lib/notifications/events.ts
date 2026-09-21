// What the Society actually writes to people, and when (S-902, FRD Section 9).
//
// workflow.ts decides what happened; this decides who hears about it and what
// they are told. Keeping the two apart is what stops a notification rule from
// being buried inside an approval: every event the member hears about is named
// once, here, and the wording itself is not here at all — it is a template an
// administrator edits (S-901).
//
// Every function here is fire-and-forget by construction: notify() never
// throws, and each of these is awaited only so the outbox row is written
// before the request ends. An approval that succeeded is never reported as
// failed because a relay was down.
import { loadApplication, type Application } from '../applications/capture';
import { eventCodeForKind, type Happening } from './event-codes';
import { notify } from './notify';

export const ENTITY_TYPE = 'membership_application';

// Where a member's own contact details live. There is no email or mobile
// column on `member`: contact details are captured on the application, field
// by field, against the membership type's own configuration (migration 0010),
// so the application is the only place to read them from.
const EMAIL_FIELD = 'email';
const MOBILE_FIELD = 'mobile';

export interface Contact {
  // Who the message is about, which is not always who receives it — a minor's
  // approval is read by their guardian, but it is the minor who was approved.
  name: string;
  email: string | null;
  mobile: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function partyValues(
  application: Application,
  subject: string
): Record<string, string> | null {
  const party = application.parties.find(
    p => p.subject === subject && p.ordinal === 1
  );
  return party?.values ?? null;
}

function nameFrom(values: Record<string, string> | null): string {
  if (!values) return '';
  return [values.name, values.surname]
    .map(part => (part ?? '').trim())
    .filter(part => part !== '')
    .join(' ');
}

/**
 * Who to write to about this application.
 *
 * A minor captures no contact details of their own — migration 0010 puts the
 * mobile on the `guardian` subject for that type — so the guardian's address
 * is used when the applicant has none. The name stays the applicant's either
 * way: the guardian is reading about the minor, not about themselves.
 *
 * An additional-account application captures no applicant at all (S-613): the
 * person is the member or customer it names, whose details are on the
 * application that first recorded them. A legacy member imported in M7 has no
 * such application, and therefore no contact details anywhere in the system —
 * nothing is sent, which the delivery log shows as nothing rather than as a
 * failure.
 */
export async function contactFor(
  application: Application
): Promise<Contact | null> {
  if (application.applicationKind === 'additional_account') {
    if (!application.existingHolderApplicationId) return null;
    const holder = await loadApplication(
      application.existingHolderApplicationId
    );
    return holder ? contactFor(holder) : null;
  }

  const applicant = partyValues(application, 'applicant');
  const guardian = partyValues(application, 'guardian');

  return {
    name: nameFrom(applicant),
    email:
      nonEmpty(applicant?.[EMAIL_FIELD]) ?? nonEmpty(guardian?.[EMAIL_FIELD]),
    mobile:
      nonEmpty(applicant?.[MOBILE_FIELD]) ?? nonEmpty(guardian?.[MOBILE_FIELD]),
  };
}

// The same question, asked about an application rather than about a kind.
export function eventCodeFor(
  application: Application,
  happening: Happening
): string {
  return eventCodeForKind(application.applicationKind, happening);
}

async function notifyAbout(
  application: Application,
  happening: Happening,
  values: Record<string, string | null | undefined> = {}
): Promise<void> {
  const contact = await contactFor(application);
  if (!contact) return;

  await notify({
    eventCode: eventCodeFor(application, happening),
    recipients: { email: contact.email, mobile: contact.mobile },
    values: {
      applicant_name: contact.name,
      reference: application.reference,
      ...values,
    },
    entityType: ENTITY_TYPE,
    entityId: application.id,
  });
}

// Told that it arrived, so nobody is left wondering whether it did.
export async function notifySubmitted(application: Application): Promise<void> {
  await notifyAbout(application, 'submitted');
}

// Told what to correct. The comment is the whole point of the message, and
// reviewApplication already refuses a return without one.
export async function notifyReturned(
  application: Application,
  comment: string
): Promise<void> {
  await notifyAbout(application, 'returned', { comment });
}

// Told they are in, and given the number they will be asked for from now on.
// `memberNo` is absent for an account application, whose template names the
// account rather than a member.
export async function notifyApproved(
  application: Application,
  memberNo?: string
): Promise<void> {
  await notifyAbout(application, 'approved', { member_no: memberNo });
}

// Told it was not approved, and why. Like a return, the comment is required
// before the decision is recorded at all.
export async function notifyRejected(
  application: Application,
  comment: string
): Promise<void> {
  await notifyAbout(application, 'rejected', { comment });
}
