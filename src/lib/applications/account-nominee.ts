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
import { query, withTransaction } from '../db/pool';
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

function nomineeProblems(
  fields: MembershipTypeField[],
  normalised: ReturnType<typeof normalise>
): string[] {
  return [
    ...fields
      .filter(
        f => f.isMandatory && (normalised.values[f.fieldKey] ?? '') === ''
      )
      .map(f => `${f.label} is required.`),
    ...normalised.errors.map(e => e.label),
  ];
}

/**
 * What still stops this application's own nominee from standing: a
 * different nominee started but with a mandatory field blank or a value
 * that does not read. Empty when there is nothing to choose, the account
 * keeps the holder's nominee, or the different one is complete.
 */
export async function accountNomineeProblems(
  application: Application
): Promise<string[]> {
  const choice = await accountNomineeChoice(application);
  if (!choice?.own) return [];
  const problems = nomineeProblems(
    choice.fields,
    normalise(choice.own, choice.fields)
  );
  return problems.map(p => `Nominee: ${p}`);
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
    own:
      own && Object.values(own.values).some(v => (v ?? '').trim() !== '')
        ? own.values
        : null,
  };
}

/**
 * The same nominee as the holder's Shares and MSA, or a different one with
 * every mandatory nominee field. Only while the application is the
 * officer's to change.
 *
 * As a draft (the panel saving as the officer types), a different nominee
 * is kept however far it has been filled in; the mandatory fields are
 * asked for when the officer moves on (accountNomineeProblems), and again
 * at submission.
 */
export async function setAccountNominee(
  applicationId: string,
  input: { choice: 'same' | 'different'; values: Record<string, string> },
  actor: Actor,
  options: { draft?: boolean } = {}
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
    const problems = nomineeProblems(choice.fields, normalised);
    if (problems.length > 0 && !options.draft) {
      throw new ApplicationError(problems.join(' '));
    }
    // A draft keeps what was typed where it does not yet read as valid.
    values = options.draft
      ? Object.fromEntries(
          choice.fields.map(f => [
            f.fieldKey,
            normalised.values[f.fieldKey] ??
              (input.values[f.fieldKey] ?? '').trim(),
          ])
        )
      : normalised.values;
  } else if (!choice.existingName && !options.draft) {
    throw new ApplicationError(
      'No nominee is on file for this holder. Name a nominee for this account.'
    );
  }

  const previous = choice.own ? nameOf(choice.own) || 'different' : 'same';
  const next = values ? nameOf(values) || 'different' : 'same';
  const unchanged =
    JSON.stringify(values) === JSON.stringify(choice.own ?? null);
  if (unchanged) return;

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
        previousValue: { nominee: previous },
        newValue: { nominee: next },
      },
      client
    );
  });
}

export interface AccountNomineeSplit {
  // The accounts that go to the holder's founding nominee: "Shares", "MSA",
  // and any further account that kept that nominee, by its number.
  founding: string[];
  // Each further account that names a nominee of its own, by its number,
  // with the application that nominee is written on.
  separate: { label: string; applicationId: string }[];
}

/**
 * Who each open account goes to, for the member page: null when every
 * account goes to the founding nominee (the page then reads "Nominee"), so
 * a holder without a separate nominee looks exactly as before. Matches the
 * death-claim split (ledger/nominee-payouts.ts): a further account counts
 * as separate only when its own application names a nominee.
 */
export async function accountNomineeSplit(holder: {
  memberId: string | null;
  customerId: string | null;
}): Promise<AccountNomineeSplit | null> {
  const accounts = await query<{
    account_no: string | null;
    code: string;
    prefix: string | null;
    application_id: string | null;
    own_nominee: boolean;
  }>(
    `select a.account_no, ty.code, nullif(btrim(ty.number_prefix), '') as prefix,
            a.opened_by_application_id as application_id,
            (app.application_kind = 'additional_account' and exists (
               select 1 from application_party p
                where p.application_id = app.id
                  and p.subject = 'nominee' and p.ordinal = 1
                  and btrim(coalesce(p.values->>'name', '') ||
                            coalesce(p.values->>'surname', '')) <> ''
            )) as own_nominee
       from account a
       join account_type ty on ty.id = a.account_type_id
       left join membership_application app on app.id = a.opened_by_application_id
      where ((a.member_id = $1::uuid) or (a.customer_id = $2::uuid))
        and a.status <> 'closed'
      order by ty.sort_order, a.opened_at`,
    [holder.memberId, holder.customerId]
  );
  const label = (a: (typeof accounts.rows)[number]) =>
    a.account_no ??
    (a.code === 'shares' ? 'Shares' : (a.prefix ?? a.code.toUpperCase()));
  const separate = accounts.rows
    .filter(a => a.own_nominee && a.application_id)
    .map(a => ({ label: label(a), applicationId: a.application_id! }));
  if (separate.length === 0) return null;
  return {
    founding: accounts.rows.filter(a => !a.own_nominee).map(label),
    separate,
  };
}
