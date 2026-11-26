// The nominee of an account opened for someone who already holds accounts
// here (officer request, 26 November 2026).
//
// An existing member opening a Hajj Savings or Investment account names who
// receives it if they die: the nominee already on their Shares and MSA (the
// one on their founding application), or a different person. A different
// nominee is written on this application as its own nominee party
// (application_party, subject 'nominee', ordinal 1), with the fields the
// holder's membership type captures for a nominee; the same nominee writes
// nothing, so the account falls back to the founding one
// (ledger/nominee-payouts.ts, accountNominee). On a death claim the payout
// is split by these nominees.
import { recordAudit } from '../access/audit';
import {
  listMembershipTypes,
  type MembershipTypeField,
} from '../config/reference';
import { withTransaction } from '../db/pool';
import {
  ApplicationError,
  isEditableStatus,
  loadApplication,
  normalise,
  visibleFields,
  type Actor,
  type Application,
} from './capture';

export interface AccountNomineeChoice {
  // The holder's nominee as on their founding application: a name, or ''
  // when they named none.
  existingName: string;
  // The nominee fields the holder's membership type captures.
  fields: MembershipTypeField[];
  // This application's own nominee, when a different one was named.
  own: Record<string, string> | null;
}

function nameOf(values: Record<string, string> | undefined): string {
  if (!values) return '';
  return [values.name, values.surname]
    .map(part => (part ?? '').trim())
    .filter(part => part !== '')
    .join(' ');
}

async function holderApplication(
  application: Application
): Promise<Application | null> {
  if (application.applicationKind !== 'additional_account') return null;
  return application.existingHolderApplicationId
    ? loadApplication(application.existingHolderApplicationId)
    : null;
}

/** What the account page offers: the nominee on file, or a different one. */
export async function accountNomineeChoice(
  application: Application
): Promise<AccountNomineeChoice | null> {
  const holder = await holderApplication(application);
  if (!holder || holder.applicationKind === 'additional_account') return null;
  const type = (await listMembershipTypes()).find(
    t => t.id === holder.membershipTypeId
  );
  const fields = type ? (visibleFields(type).get('nominee') ?? []) : [];
  if (fields.length === 0) return null;
  const existing = holder.parties.find(
    p => p.subject === 'nominee' && p.ordinal === 1
  )?.values;
  const own = application.parties.find(
    p => p.subject === 'nominee' && p.ordinal === 1
  );
  return {
    existingName: nameOf(existing),
    fields,
    own: own && nameOf(own.values) !== '' ? own.values : null,
  };
}

/**
 * The same nominee as the holder's Shares and MSA, or a different one with
 * every mandatory nominee field. Only while the application is the
 * officer's to change.
 */
export async function setAccountNominee(
  applicationId: string,
  input: { choice: 'same' | 'different'; values: Record<string, string> },
  actor: Actor
): Promise<void> {
  const application = await loadApplication(applicationId);
  if (!application) {
    throw new ApplicationError(
      'That application no longer exists.',
      'not_found'
    );
  }
  if (!isEditableStatus(application.status)) {
    throw new ApplicationError(
      'This application has been submitted and can no longer be edited.',
      'locked'
    );
  }
  const choice = await accountNomineeChoice(application);
  if (!choice) {
    throw new ApplicationError('This application has no nominee to choose.');
  }

  let values: Record<string, string> | null = null;
  if (input.choice === 'different') {
    const normalised = normalise(input.values, choice.fields);
    const missing = choice.fields.filter(
      f => f.isMandatory && (normalised.values[f.fieldKey] ?? '') === ''
    );
    const problems = [
      ...missing.map(f => `${f.label} is required.`),
      ...normalised.errors.map(e => e.label),
    ];
    if (problems.length > 0) {
      throw new ApplicationError(problems.join(' '));
    }
    values = normalised.values;
  } else if (!choice.existingName) {
    throw new ApplicationError(
      'No nominee is on file for this holder. Name a nominee for this account.'
    );
  }

  await withTransaction(async client => {
    if (values) {
      await client.query(
        `insert into application_party (application_id, subject, ordinal, values)
         values ($1, 'nominee', 1, $2::jsonb)
         on conflict (application_id, subject, ordinal)
         do update set values = excluded.values`,
        [applicationId, JSON.stringify(values)]
      );
    } else {
      await client.query(
        `delete from application_party
          where application_id = $1 and subject = 'nominee'`,
        [applicationId]
      );
    }
    await client.query(
      `update membership_application set updated_at = now() where id = $1`,
      [applicationId]
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'membership.application.nominee_set',
        entityType: 'membership_application',
        entityId: applicationId,
        previousValue: { nominee: choice.own ? nameOf(choice.own) : 'same' },
        newValue: { nominee: values ? nameOf(values) : 'same' },
      },
      client
    );
  });
}
