// Capturing a membership application (S-301, S-302, S-303).
//
// The form is not written down anywhere in this file. Which fields appear,
// which are mandatory and which subjects exist all come from the membership
// type configuration of M2 (S-205) — so adding a field to the Corporate form
// is a configuration change, and this code does not need to know it happened.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { query, withTransaction } from '../db/pool';
import {
  listMembershipTypes,
  type FieldSubject,
  type MembershipType,
  type MembershipTypeField,
} from '../config/reference';
import { discardApplicationFiles } from '../documents/documents';
import type { Principal } from '../access/principal';
import { toInternational, PhoneFormatError } from './phone';

export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'invalid' | 'locked' | 'forbidden' = 'invalid'
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export interface Actor {
  userId: string;
  email: string;
}

export const DRAFT_STATUS = 'draft';

// Which statuses regional staff may still edit. Anything else has left their
// hands (S-304).
const EDITABLE_STATUSES = new Set([DRAFT_STATUS, 'returned']);

export interface PartyValues {
  subject: FieldSubject;
  ordinal: number;
  values: Record<string, string>;
}

interface ApplicationCommon {
  id: string;
  reference: string;
  status: string;
  capturedBy: string;
  // Both, deliberately: the screen shows the name, because that is how a
  // colleague is known; the audit trail records the address, because that is
  // what identifies the account beyond doubt.
  capturedByName: string;
  capturedByEmail: string;
  submittedAt: Date | null;
  decidedAt: Date | null;
  updatedAt: Date;
  parties: PartyValues[];
}

// S-301's original application, capturing an applicant and, on approval,
// creating a Member.
export interface MembershipApplication extends ApplicationCommon {
  applicationKind: 'membership';
  membershipTypeId: string;
  membershipTypeCode: string;
  membershipTypeName: string;
  // S-614: set only when this application was started from an existing
  // non-member customer (startMembershipApplicationFromCustomer) — names
  // whose account(s) transfer to the new Member on approval
  // (createMemberFromApplication, members/create.ts). Null for every
  // ordinary membership application.
  sourceCustomerId: string | null;
}

// S-613's application, opening an account type an existing member's
// membership did not already open for them. No applicant to capture —
// `parties` is always empty — and nothing to approve into existence:
// approval opens `selectedAccountTypes` under `existingMemberId` instead of
// creating a member (S-612).
export interface AdditionalAccountApplication extends ApplicationCommon {
  applicationKind: 'additional_account';
  existingMemberId: string;
  existingMemberNo: string;
  selectedAccountTypes: {
    id: string;
    code: string;
    name: string;
    minimumOpeningAmount: string;
  }[];
}

// S-614's application: someone not yet on the system at all, opening an
// account of their own. An applicant IS captured here — `parties` behaves
// exactly as it does for a membership application, reusing that type's own
// field and checklist configuration (business direction: no new form to
// design) — but approval creates a customer rather than a member, so it
// also carries `selectedAccountTypes` the same way an additional_account
// application does. The union of what the other two kinds each need, not a
// third unrelated shape.
export interface CustomerAccountApplication extends ApplicationCommon {
  applicationKind: 'customer_account';
  membershipTypeId: string;
  membershipTypeCode: string;
  membershipTypeName: string;
  selectedAccountTypes: {
    id: string;
    code: string;
    name: string;
    minimumOpeningAmount: string;
  }[];
}

// The three kinds share one workflow (S-612) — submitApplication,
// reviewApplication, decideApplication and everything in workflow.ts read
// this union without needing to know which they were handed. A page working
// one kind narrows on `applicationKind` the same way any discriminated union
// does; that narrowing is what makes it a compile error to read
// `membershipTypeId` off an application that might be another kind.
export type Application =
  | MembershipApplication
  | AdditionalAccountApplication
  | CustomerAccountApplication;

// A field that must be filled in but is not, named the way the form names it.
export interface MissingField {
  subject: FieldSubject;
  ordinal: number;
  fieldKey: string;
  label: string;
}

// The type an application is being captured against, refused if it is not one
// the Society currently accepts.
async function acceptingType(code: string): Promise<MembershipType> {
  const type = (await listMembershipTypes()).find(t => t.code === code);
  if (!type) {
    throw new ApplicationError('Unknown membership type.', 'not_found');
  }
  if (!type.isActive) {
    throw new ApplicationError(
      `${type.name} applications are not currently accepted.`
    );
  }
  return type;
}

// The row and its empty parties. Shared by both ways in, so a reference is
// allocated in exactly one place.
async function insertApplication(
  client: PoolClient,
  type: MembershipType,
  actor: Actor
): Promise<{ id: string; reference: string }> {
  const created = await client.query<{ id: string; reference: string }>(
    `insert into membership_application (membership_type_id, captured_by)
     values ($1, $2) returning id, reference`,
    [type.id, actor.userId]
  );
  const { id, reference } = created.rows[0];

  // One empty party per subject the type configures, so the form has
  // something to render into and a draft save has somewhere to land. Every
  // subject gets exactly one — except nominee, which gets as many as the
  // type configures (S-602): "one or more Nominees where configured"
  // (FRD 5.3) is a fact about ordinal count, not about a different subject.
  //
  // One statement for every row rather than one round trip per row: on a
  // database in another region that was measurable — several sequential
  // inserts is several sequential round trips, purely for latency, before
  // an officer's very first click on this application type gets anywhere.
  const subjects = [...new Set(type.fields.map(f => f.subject))];
  const partySubjects: string[] = [];
  const partyOrdinals: number[] = [];
  for (const subject of subjects) {
    const ordinals = subject === 'nominee' ? type.nomineeCount : 1;
    for (let ordinal = 1; ordinal <= ordinals; ordinal++) {
      partySubjects.push(subject);
      partyOrdinals.push(ordinal);
    }
  }
  if (partySubjects.length > 0) {
    await client.query(
      `insert into application_party (application_id, subject, ordinal)
       select $1, s, o from unnest($2::text[], $3::int[]) as t(s, o)`,
      [id, partySubjects, partyOrdinals]
    );
  }

  await recordAudit(
    {
      actorUserId: actor.userId,
      actorDescription: actor.email,
      action: 'membership.application.started',
      entityType: 'membership_application',
      entityId: id,
      newValue: { reference, membershipType: type.code },
    },
    client
  );

  return { id, reference };
}

export async function startApplication(
  membershipTypeCode: string,
  actor: Actor
): Promise<{ id: string; reference: string }> {
  const type = await acceptingType(membershipTypeCode);
  return withTransaction(client => insertApplication(client, type, actor));
}

export interface MemberCandidate {
  memberId: string;
  memberNo: string;
  surname: string;
  name: string;
  nic: string;
}

/**
 * S-613 · Find the member an additional-account application opens an
 * account for.
 *
 * Active only — an additional account is something an active member does,
 * the same restriction problemsBlockingSubmission's own guardian check
 * applies to an active member found there (S-604). Left joined rather than
 * inner joined to `membership_application`/`application_party`: a legacy
 * member imported without one (M7's `member.application_id` is nullable for
 * exactly that reason) is still found by Member No., just without a name to
 * show alongside it.
 */
export async function searchExistingMembers(
  search: string,
  limit = 10
): Promise<MemberCandidate[]> {
  const term = search.trim();
  if (!term) return [];

  const result = await query<{
    member_id: string;
    member_no: string;
    surname: string | null;
    name: string | null;
    nic: string | null;
  }>(
    `select m.id as member_id, m.member_no,
            p.values->>'surname' as surname, p.values->>'name' as name,
            p.values->>'nic' as nic
       from member m
       left join membership_application a on a.id = m.application_id
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
      where m.status = 'active'
        and (strpos(lower(coalesce(p.values->>'surname', '')), lower($1)) > 0
             or strpos(lower(coalesce(p.values->>'name', '')), lower($1)) > 0
             or strpos(lower(coalesce(p.values->>'nic', '')), lower($1)) > 0
             or strpos(lower(m.member_no), lower($1)) > 0)
      order by surname nulls last, name nulls last
      limit $2`,
    [term, limit]
  );

  return result.rows.map(r => ({
    memberId: r.member_id,
    memberNo: r.member_no,
    surname: r.surname ?? '',
    name: r.name ?? '',
    nic: r.nic ?? '',
  }));
}

/**
 * S-613 · Start an additional-account application for an existing member —
 * opening an account type their membership did not already open for them
 * (HSA, Investment, or anything else an administrator adds), through the
 * same chain a membership application already uses (S-612).
 *
 * Unlike a membership application, there is no long form an officer
 * gradually fills in before anything is worth keeping — picking a member
 * and at least one account type already IS the value, so this creates the
 * row immediately rather than waiting for a first keystroke the way
 * startApplicationWithValues does.
 */
export async function startAdditionalAccountApplication(
  existingMemberId: string,
  accountTypeIds: string[],
  actor: Actor
): Promise<{ id: string; reference: string }> {
  if (accountTypeIds.length === 0) {
    throw new ApplicationError('Select at least one account type to open.');
  }

  return withTransaction(async client => {
    const member = await client.query<{ status: string }>(
      `select status from member where id = $1`,
      [existingMemberId]
    );
    if (member.rowCount === 0) {
      throw new ApplicationError('That member no longer exists.', 'not_found');
    }
    if (member.rows[0].status !== 'active') {
      throw new ApplicationError(
        'Only an active member may open a new account.'
      );
    }

    // Neither active nor non-membership-default is optional here: the first
    // keeps someone from opening an account for a type an administrator has
    // since retired, the second is what keeps this flow from being used to
    // open Shares or the MSA a second time — those open only on a
    // membership's own approval (S-308, S-309).
    const types = await client.query<{ id: string }>(
      `select id from account_type
        where id = any($1::uuid[]) and is_active and not is_membership_default`,
      [accountTypeIds]
    );
    if (types.rowCount !== accountTypeIds.length) {
      throw new ApplicationError(
        'One of the selected account types is no longer available to open ' +
          'this way.'
      );
    }

    const created = await client.query<{ id: string; reference: string }>(
      `insert into membership_application
         (application_kind, existing_member_id, captured_by)
       values ('additional_account', $1, $2)
       returning id, reference`,
      [existingMemberId, actor.userId]
    );
    const { id, reference } = created.rows[0];

    // One statement rather than one round trip per row — see
    // insertApplication's own comment for why this matters on a database
    // in another region.
    await client.query(
      `insert into application_account_selection
         (application_id, account_type_id)
       select $1, t from unnest($2::uuid[]) as t`,
      [id, accountTypeIds]
    );

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'membership.application.started',
        entityType: 'membership_application',
        entityId: id,
        newValue: {
          reference,
          applicationKind: 'additional_account',
          existingMemberId,
          accountTypeIds,
        },
      },
      client
    );

    return { id, reference };
  });
}

/**
 * S-614 · Start an application for someone not yet on the system at all.
 *
 * Reuses the Individual membership type's own field and checklist
 * configuration to capture the applicant (business direction: no new form
 * to design for this) — every subject it configures gets an empty party
 * row the same way insertApplication gives a membership application one,
 * so there is something for the capture form to render into from the
 * first load. Account type validation mirrors
 * startAdditionalAccountApplication's own: active and not
 * membership-default, since Shares and the MSA open only through a
 * membership's own approval (S-308, S-309), never through this flow either.
 */
export async function startCustomerAccountApplication(
  accountTypeIds: string[],
  actor: Actor
): Promise<{ id: string; reference: string }> {
  if (accountTypeIds.length === 0) {
    throw new ApplicationError('Select at least one account type to open.');
  }

  const type = await acceptingType('individual');

  return withTransaction(async client => {
    const types = await client.query<{ id: string }>(
      `select id from account_type
        where id = any($1::uuid[]) and is_active and not is_membership_default`,
      [accountTypeIds]
    );
    if (types.rowCount !== accountTypeIds.length) {
      throw new ApplicationError(
        'One of the selected account types is no longer available to open ' +
          'this way.'
      );
    }

    const created = await client.query<{ id: string; reference: string }>(
      `insert into membership_application
         (application_kind, membership_type_id, captured_by)
       values ('customer_account', $1, $2)
       returning id, reference`,
      [type.id, actor.userId]
    );
    const { id, reference } = created.rows[0];

    // One statement per table rather than one round trip per row — see
    // insertApplication's own comment for why this matters on a database
    // in another region.
    const subjects = [...new Set(type.fields.map(f => f.subject))];
    const partySubjects: string[] = [];
    const partyOrdinals: number[] = [];
    for (const subject of subjects) {
      const ordinals = subject === 'nominee' ? type.nomineeCount : 1;
      for (let ordinal = 1; ordinal <= ordinals; ordinal++) {
        partySubjects.push(subject);
        partyOrdinals.push(ordinal);
      }
    }
    if (partySubjects.length > 0) {
      await client.query(
        `insert into application_party (application_id, subject, ordinal)
         select $1, s, o from unnest($2::text[], $3::int[]) as t(s, o)`,
        [id, partySubjects, partyOrdinals]
      );
    }

    await client.query(
      `insert into application_account_selection
         (application_id, account_type_id)
       select $1, t from unnest($2::uuid[]) as t`,
      [id, accountTypeIds]
    );

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'membership.application.started',
        entityType: 'membership_application',
        entityId: id,
        newValue: {
          reference,
          applicationKind: 'customer_account',
          membershipType: type.code,
          accountTypeIds,
        },
      },
      client
    );

    return { id, reference };
  });
}

/**
 * S-614 · Start a membership application for a non-member already on the
 * system, prefilled from what their customer_account application already
 * captured — an officer reviewing it corrects or adds to what is there
 * rather than retyping a name and NIC the applicant already gave once.
 *
 * Always against Individual: the only membership type a customer_account
 * application is ever captured against (capture.ts's own business
 * decision — startCustomerAccountApplication, above), so the customer's own
 * field values line up with Individual's own field configuration exactly.
 * From here on this is an ordinary Individual application — the same
 * capture, review and approval chain, unrelated to the account(s) the
 * customer already holds. Approval creates a new Member; it does not touch
 * the existing customer record or reassign their account(s) to it, which
 * would be its own, separate decision this does not make.
 */
export async function startMembershipApplicationFromCustomer(
  customerId: string,
  actor: Actor
): Promise<{ id: string; reference: string }> {
  const type = await acceptingType('individual');

  return withTransaction(async client => {
    const customer = await client.query<{
      status: string;
      application_id: string;
    }>(`select status, application_id from customer where id = $1`, [
      customerId,
    ]);
    if (customer.rowCount === 0) {
      throw new ApplicationError(
        'That customer no longer exists.',
        'not_found'
      );
    }
    if (customer.rows[0].status !== 'active') {
      throw new ApplicationError(
        'Only an active customer may apply to become a member.'
      );
    }

    const priorParties = await client.query<{
      subject: FieldSubject;
      ordinal: number;
      values: Record<string, string>;
    }>(
      `select subject, ordinal, values
         from application_party
        where application_id = $1`,
      [customer.rows[0].application_id]
    );

    const { id, reference } = await insertApplication(client, type, actor);

    // Named on the application itself — not only in the audit entry below —
    // so createMemberFromApplication (members/create.ts) knows at approval
    // time whose account(s) transfer to the new Member, without going back
    // to the audit trail to find out (migration 0029).
    await client.query(
      `update membership_application set source_customer_id = $2 where id = $1`,
      [id, customerId]
    );

    // insertApplication just seeded one empty party row per subject
    // Individual currently configures — filled in here from what the
    // customer already gave, not created again. A subject or nominee
    // ordinal added to Individual's own configuration since the customer
    // applied has no prior value to carry over and is simply left as
    // insertApplication made it: empty, for the officer to fill in.
    for (const party of priorParties.rows) {
      await client.query(
        `update application_party set values = $4
           where application_id = $1 and subject = $2 and ordinal = $3`,
        [id, party.subject, party.ordinal, JSON.stringify(party.values)]
      );
    }

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'membership.application.started_from_customer',
        entityType: 'membership_application',
        entityId: id,
        newValue: { reference, fromCustomerId: customerId },
      },
      client
    );

    return { id, reference };
  });
}

// Is there anything here at all? What decides whether an application exists.
export function hasAnyValue(parties: PartyValues[]): boolean {
  return parties.some(party =>
    Object.values(party.values).some(value => value.trim() !== '')
  );
}

/**
 * Create an application from the first thing the officer typed (S-301, S-302).
 *
 * Opening the capture form is not starting an application. An officer who
 * clicks Capture, sees it is the wrong applicant and closes the tab should
 * leave nothing behind — a reference allocated to an empty form is a reference
 * spent, a row in the list to explain, and a draft somebody has to delete.
 *
 * So nothing exists until a value does. Returns null when the form is entirely
 * blank, and the caller has nothing to redirect to because nothing happened.
 * The rule lives here rather than on the page: a page that merely declines to
 * post is still a page that can post.
 */
export async function startApplicationWithValues(
  membershipTypeCode: string,
  parties: PartyValues[],
  actor: Actor
): Promise<{
  id: string;
  reference: string;
  savedAt: Date;
  problems: MissingField[];
} | null> {
  const type = await acceptingType(membershipTypeCode);
  if (!hasAnyValue(parties)) return null;

  const fields = visibleFields(type);
  const problems: MissingField[] = [];

  return withTransaction(async client => {
    const { id, reference } = await insertApplication(client, type, actor);

    // One statement for every party rather than one round trip each — see
    // insertApplication's own comment for why this matters on a database
    // in another region, and it matters more here: this is what runs on
    // the officer's very first Next.
    const partySubjects: string[] = [];
    const partyOrdinals: number[] = [];
    const partyValues: string[] = [];
    for (const party of parties) {
      const subjectFields = fields.get(party.subject) ?? [];
      const { values, errors } = normalise(party.values, subjectFields);
      problems.push(...errors.map(e => ({ ...e, ordinal: party.ordinal })));
      partySubjects.push(party.subject);
      partyOrdinals.push(party.ordinal);
      partyValues.push(JSON.stringify(values));
    }
    if (partySubjects.length > 0) {
      await client.query(
        `update application_party ap
            set values = u.new_values::jsonb
           from unnest($2::text[], $3::int[], $4::jsonb[])
                  as u(subject, ordinal, new_values)
          where ap.application_id = $1
            and ap.subject = u.subject
            and ap.ordinal = u.ordinal`,
        [id, partySubjects, partyOrdinals, partyValues]
      );
    }

    const touched = await client.query<{ updated_at: Date }>(
      `update membership_application set updated_at = now()
        where id = $1 returning updated_at`,
      [id]
    );

    return { id, reference, savedAt: touched.rows[0].updated_at, problems };
  });
}

export async function loadApplication(id: string): Promise<Application | null> {
  // The row and its parties are independent reads on the same id, so they
  // go out together rather than one after the other.
  const [result, parties] = await Promise.all([
    query<{
      id: string;
      reference: string;
      application_kind:
        'membership' | 'additional_account' | 'customer_account';
      membership_type_id: string | null;
      membership_type_code: string | null;
      membership_type_name: string | null;
      existing_member_id: string | null;
      existing_member_no: string | null;
      source_customer_id: string | null;
      status: string;
      captured_by: string;
      captured_by_name: string;
      captured_by_email: string;
      submitted_at: Date | null;
      decided_at: Date | null;
      updated_at: Date;
    }>(
      // Both membership_type and member are left joins: exactly one of the two
      // is ever populated for a given row, decided by application_kind, never
      // both (membership_application_kind_shape, migration 0025).
      `select a.id, a.reference, a.application_kind, a.membership_type_id,
            mt.code as membership_type_code, mt.name as membership_type_name,
            a.existing_member_id, mb.member_no as existing_member_no,
            a.source_customer_id,
            a.status, a.captured_by,
            u.display_name as captured_by_name,
            u.email::text as captured_by_email,
            a.submitted_at, a.decided_at, a.updated_at
       from membership_application a
       left join membership_type mt on mt.id = a.membership_type_id
       left join member mb          on mb.id = a.existing_member_id
       join app_user u               on u.id = a.captured_by
      where a.id = $1`,
      [id]
    ),
    query<{
      subject: FieldSubject;
      ordinal: number;
      values: Record<string, string>;
    }>(
      `select subject, ordinal, values
         from application_party
        where application_id = $1
        order by subject, ordinal`,
      [id]
    ),
  ]);
  if (result.rowCount === 0) return null;
  const row = result.rows[0];

  const common = {
    id: row.id,
    reference: row.reference,
    status: row.status,
    capturedBy: row.captured_by,
    capturedByName: row.captured_by_name,
    capturedByEmail: row.captured_by_email,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    updatedAt: row.updated_at,
    parties: parties.rows.map(p => ({
      subject: p.subject,
      ordinal: p.ordinal,
      values: p.values,
    })),
  };

  if (row.application_kind === 'additional_account') {
    return {
      ...common,
      applicationKind: 'additional_account',
      existingMemberId: row.existing_member_id!,
      existingMemberNo: row.existing_member_no!,
      selectedAccountTypes: await selectedAccountTypesFor(id),
    };
  }

  if (row.application_kind === 'customer_account') {
    return {
      ...common,
      applicationKind: 'customer_account',
      membershipTypeId: row.membership_type_id!,
      membershipTypeCode: row.membership_type_code!,
      membershipTypeName: row.membership_type_name!,
      selectedAccountTypes: await selectedAccountTypesFor(id),
    };
  }

  return {
    ...common,
    applicationKind: 'membership',
    membershipTypeId: row.membership_type_id!,
    membershipTypeCode: row.membership_type_code!,
    membershipTypeName: row.membership_type_name!,
    sourceCustomerId: row.source_customer_id,
  };
}

// Shared by additional_account and customer_account (S-612, S-614) — the
// account type(s) selected, whichever of the two kinds is asking.
async function selectedAccountTypesFor(applicationId: string): Promise<
  {
    id: string;
    code: string;
    name: string;
    minimumOpeningAmount: string;
  }[]
> {
  const selection = await query<{
    id: string;
    code: string;
    name: string;
    minimum_opening_amount: string;
  }>(
    `select t.id, t.code, t.name, t.minimum_opening_amount
       from application_account_selection s
       join account_type t on t.id = s.account_type_id
      where s.application_id = $1
      order by t.sort_order, t.name`,
    [applicationId]
  );
  return selection.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    minimumOpeningAmount: r.minimum_opening_amount,
  }));
}

// The fields this application's type configures, grouped as the form shows
// them. Hidden fields are dropped: a field an administrator has switched off
// is not part of this form.
export function visibleFields(
  type: MembershipType
): Map<FieldSubject, MembershipTypeField[]> {
  const bySubject = new Map<FieldSubject, MembershipTypeField[]>();
  for (const field of type.fields) {
    if (!field.isVisible) continue;
    const list = bySubject.get(field.subject) ?? [];
    list.push(field);
    bySubject.set(field.subject, list);
  }
  for (const list of bySubject.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return bySubject;
}

/**
 * Normalise what was typed into what is stored.
 *
 * Phone fields become E.164 here rather than at display time, because the
 * stored value is the one M9 will send to. A number that cannot be placed
 * fails the save — see phone.ts for why guessing is worse.
 */
function normalise(
  values: Record<string, string>,
  fields: MembershipTypeField[]
): { values: Record<string, string>; errors: MissingField[] } {
  const out: Record<string, string> = {};
  const errors: MissingField[] = [];

  for (const field of fields) {
    const raw = (values[field.fieldKey] ?? '').trim();
    if (raw === '') continue;

    if (field.dataType === 'phone') {
      try {
        out[field.fieldKey] = toInternational(raw);
      } catch (error) {
        if (error instanceof PhoneFormatError) {
          errors.push({
            subject: field.subject,
            ordinal: 1,
            fieldKey: field.fieldKey,
            label: `${field.label}: ${error.message}`,
          });
          // Keep what was typed so the officer sees their own input to fix,
          // rather than an empty box and no idea what they entered.
          out[field.fieldKey] = raw;
          continue;
        }
        throw error;
      }
    } else if (field.dataType === 'choice') {
      if (field.choices.length > 0 && !field.choices.includes(raw)) {
        errors.push({
          subject: field.subject,
          ordinal: 1,
          fieldKey: field.fieldKey,
          label: `${field.label} must be one of: ${field.choices.join(', ')}`,
        });
      }
      out[field.fieldKey] = raw;
    } else {
      out[field.fieldKey] = raw;
    }
  }

  return { values: out, errors };
}

/**
 * Save a draft (S-302).
 *
 * Partial by design: an officer on a tablet is interrupted mid-form, and the
 * point of saving continuously is that whatever has been typed survives. So
 * mandatory fields are NOT enforced here — that check belongs at submission
 * (S-304), where the application leaves their hands. Format errors are
 * reported but do not block the save, for the same reason.
 */
export async function saveDraft(
  applicationId: string,
  parties: PartyValues[],
  actor: Actor
): Promise<{ savedAt: Date; problems: MissingField[] }> {
  const application = await loadApplication(applicationId);
  if (!application) {
    throw new ApplicationError(
      'That application no longer exists.',
      'not_found'
    );
  }
  if (!EDITABLE_STATUSES.has(application.status)) {
    throw new ApplicationError(
      `This application has been submitted and can no longer be edited ` +
        `(status: ${application.status}).`,
      'locked'
    );
  }

  // S-613: an additional-account application has no applicant fields to
  // autosave — member and account type are chosen once, at
  // startAdditionalAccountApplication, and nothing after that is a form
  // field the way a membership application's own capture is. A
  // customer_account application (S-614) is the opposite: it captures an
  // applicant the same way a membership application does, reusing the same
  // membership type's field configuration — so it saves the same way too.
  if (application.applicationKind === 'additional_account') {
    throw new ApplicationError(
      'This application has no fields to save.',
      'invalid'
    );
  }

  const type = (await listMembershipTypes()).find(
    t => t.id === application.membershipTypeId
  );
  if (!type) {
    throw new ApplicationError('Unknown membership type.', 'not_found');
  }
  const fields = visibleFields(type);

  const problems: MissingField[] = [];

  const savedAt = await withTransaction(async client => {
    // One statement for every party rather than one round trip each — see
    // insertApplication's own comment for why this matters on a database
    // in another region, and it matters more here: this runs on every Next
    // an officer clicks through the capture step.
    const partySubjects: string[] = [];
    const partyOrdinals: number[] = [];
    const partyValues: string[] = [];
    for (const party of parties) {
      const subjectFields = fields.get(party.subject) ?? [];
      const { values, errors } = normalise(party.values, subjectFields);
      problems.push(...errors.map(e => ({ ...e, ordinal: party.ordinal })));
      partySubjects.push(party.subject);
      partyOrdinals.push(party.ordinal);
      partyValues.push(JSON.stringify(values));
    }
    if (partySubjects.length > 0) {
      await client.query(
        `insert into application_party (application_id, subject, ordinal, values)
         select $1, u.subject, u.ordinal, u.new_values::jsonb
           from unnest($2::text[], $3::int[], $4::jsonb[])
                  as u(subject, ordinal, new_values)
         on conflict (application_id, subject, ordinal)
         do update set values = excluded.values`,
        [applicationId, partySubjects, partyOrdinals, partyValues]
      );
    }

    const touched = await client.query<{ updated_at: Date }>(
      `update membership_application set updated_at = now()
        where id = $1 returning updated_at`,
      [applicationId]
    );
    return touched.rows[0].updated_at;
  });

  return { savedAt, problems };
}

// S-604, relaxed on officer feedback: a guardian resolves the same way
// searchGuardianCandidates finds them — an active member, or someone still
// on the way to becoming one (an Individual application not yet decided).
// NIC is not stored on `member` itself, only on the applicant party of
// whatever application created it, which is why this joins back to that
// party rather than reading a column; the not-yet-a-member arm reads the
// same column directly off the application in progress.
//
// A rejected application is the one dead end: it will never produce a
// member, so it resolves to nobody — the same reasoning that keeps it out
// of the search results a Member No. field like this was filled in from.
async function findGuardian(
  memberNoCandidate: string,
  nicCandidate: string
): Promise<{ memberNo: string; status: string; isMember: boolean } | null> {
  if (!memberNoCandidate && !nicCandidate) return null;

  const member = await query<{ member_no: string; status: string }>(
    `select m.member_no, m.status
       from member m
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where ($1 <> '' and lower(m.member_no) = lower($1))
         or ($2 <> '' and p.values->>'nic' = $2)
      limit 1`,
    [memberNoCandidate, nicCandidate]
  );
  if (member.rowCount! > 0) {
    return {
      memberNo: member.rows[0].member_no,
      status: member.rows[0].status,
      isMember: true,
    };
  }

  const application = await query<{ reference: string; status: string }>(
    `select a.reference, a.status
       from membership_application a
       join membership_type t on t.id = a.membership_type_id
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
      where t.code = 'individual'
        and a.status not in ('approved', 'rejected')
        and (($1 <> '' and lower(a.reference) = lower($1))
             or ($2 <> '' and p.values->>'nic' = $2))
      limit 1`,
    [memberNoCandidate, nicCandidate]
  );
  if (application.rowCount! > 0) {
    return {
      memberNo: application.rows[0].reference,
      status: application.rows[0].status,
      isMember: false,
    };
  }

  return null;
}

export interface GuardianCandidate {
  // A not-yet-a-member parent has no Member No. yet — reference is theirs
  // to have anyway: the application's own reference, human-recognisable on
  // the form and unambiguous with a real Member No. (never the same shape).
  kind: 'member' | 'application';
  reference: string;
  status: string;
  surname: string;
  name: string;
  nic: string;
  // S-604 follow-up: the guardian block also asks for a mobile number, so a
  // picked result fills that in too rather than leaving it the one field the
  // officer still has to type by hand.
  mobile: string;
}

// Lets an officer find a parent to link as guardian — an existing member, or
// someone joining as an Individual applicant at the same time as the minor
// (FRD 7.10.2 does not require the parent to already be a member; only
// submission does, see findGuardian/problemsBlockingSubmission below).
// A rejected application produced no member and never will; an approved one
// already has its own member row, found by the first half of the union —
// listing it again under the second half would show the same person twice.
export async function searchGuardianCandidates(
  search: string,
  limit = 10
): Promise<GuardianCandidate[]> {
  const term = search.trim();
  if (!term) return [];

  const result = await query<{
    kind: 'member' | 'application';
    reference: string;
    status: string;
    surname: string | null;
    name: string | null;
    nic: string | null;
    mobile: string | null;
  }>(
    `select 'member' as kind, m.member_no as reference, m.status as status,
            p.values->>'surname' as surname, p.values->>'name' as name,
            p.values->>'nic' as nic, p.values->>'mobile' as mobile
       from member m
       join membership_application a on a.id = m.application_id
       join membership_type t on t.id = a.membership_type_id
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
      where t.code = 'individual'
        and (strpos(lower(coalesce(p.values->>'surname', '')), lower($1)) > 0
             or strpos(lower(coalesce(p.values->>'name', '')), lower($1)) > 0
             or strpos(lower(coalesce(p.values->>'nic', '')), lower($1)) > 0
             or strpos(lower(m.member_no), lower($1)) > 0)

      union all

      select 'application' as kind, a.reference as reference, a.status as status,
             p.values->>'surname' as surname, p.values->>'name' as name,
             p.values->>'nic' as nic, p.values->>'mobile' as mobile
       from membership_application a
       join membership_type t on t.id = a.membership_type_id
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
      where t.code = 'individual'
        and a.status not in ('approved', 'rejected')
        and (strpos(lower(coalesce(p.values->>'surname', '')), lower($1)) > 0
             or strpos(lower(coalesce(p.values->>'name', '')), lower($1)) > 0
             or strpos(lower(coalesce(p.values->>'nic', '')), lower($1)) > 0
             or strpos(lower(a.reference), lower($1)) > 0)

      order by surname nulls last, name nulls last
      limit $2`,
    [term, limit]
  );

  return result.rows.map(r => ({
    kind: r.kind,
    reference: r.reference,
    status: r.status,
    surname: r.surname ?? '',
    name: r.name ?? '',
    nic: r.nic ?? '',
    mobile: r.mobile ?? '',
  }));
}

/**
 * What stops this application being submitted (S-301, S-304, S-605).
 *
 * Returns every problem, not the first: an officer told about one missing
 * field at a time, on a form of forty, will fill it in and be told about the
 * next one. Nothing is submitted while this is non-empty.
 */
export async function problemsBlockingSubmission(
  application: Application
): Promise<MissingField[]> {
  // S-613: an additional-account application has no applicant fields, and
  // therefore nothing here to be missing — startAdditionalAccountApplication
  // already refuses to create one with an empty account-type selection, so
  // there is nothing left for this to catch by the time one exists. A
  // customer_account application (S-614) captures an applicant the same way
  // a membership application does, so it is checked the same way too.
  if (application.applicationKind === 'additional_account') return [];

  const type = (await listMembershipTypes()).find(
    t => t.id === application.membershipTypeId
  );
  if (!type) {
    throw new ApplicationError('Unknown membership type.', 'not_found');
  }

  const fields = visibleFields(type);
  const problems: MissingField[] = [];

  for (const [subject, subjectFields] of fields) {
    const parties = application.parties.filter(p => p.subject === subject);
    // A subject the type configures but the application has no row for is
    // itself the problem: every mandatory field on it is missing.
    const rows =
      parties.length > 0 ? parties : [{ subject, ordinal: 1, values: {} }];

    for (const party of rows) {
      // S-602, relaxed on officer feedback: FRD 5.3 asks for "one or more
      // Nominees where configured" — read as "at least one", not "all N a
      // type happens to configure". The first nominee still has to be
      // complete; a second or third is there for a family that wants to
      // name one, not a form that demands every slot be filled. Every other
      // subject is unaffected — nominee is the only one ever asked for more
      // than a single instance.
      if (subject === 'nominee' && party.ordinal !== 1) continue;
      for (const field of subjectFields) {
        if (!field.isMandatory) continue;
        const value = (party.values[field.fieldKey] ?? '').trim();
        if (value === '') {
          problems.push({
            subject,
            ordinal: party.ordinal,
            fieldKey: field.fieldKey,
            label: field.label,
          });
        }
      }
    }
  }

  // S-604/S-605, relaxed on officer feedback: a guardian is not just a
  // filled-in field, it is a claim about a real person — a minor's
  // application cannot be submitted on the strength of a name and a Member
  // No. nobody has verified. What counts as real is exactly what the search
  // above offers to link: an active member, or an Individual application
  // still on its way to becoming one. A parent and their minor can join at
  // the same visit, and requiring the parent's approval first would force
  // the officer to hold the minor's form until a second visit for no reason
  // the parent's own status changes. Checked here rather than at save time
  // (S-302): an officer mid-typing has not necessarily reached the guardian
  // block yet, and a lookup on every keystroke would be a query the save
  // does not need to make.
  const guardianFields = fields.get('guardian');
  if (guardianFields?.some(f => f.fieldKey === 'member_id')) {
    for (const party of application.parties.filter(
      p => p.subject === 'guardian'
    )) {
      const memberNo = (party.values.member_id ?? '').trim();
      const nic = (party.values.nic ?? '').trim();
      // Empty is already reported above as a missing mandatory field; this
      // is for a value that is there but does not resolve to anyone real.
      if (!memberNo && !nic) continue;

      const guardian = await findGuardian(memberNo, nic);
      if (!guardian) {
        problems.push({
          subject: 'guardian',
          ordinal: party.ordinal,
          fieldKey: 'member_id',
          label:
            'No member or application matches the guardian’s Member No. ' +
            'or NIC — they must join as a member first.',
        });
      } else if (guardian.isMember && guardian.status !== 'active') {
        // Only a real member can be inactive in this sense — an in-progress
        // application has no "active" to fall short of; it is simply still
        // in progress, which is exactly the case this relaxation exists for.
        problems.push({
          subject: 'guardian',
          ordinal: party.ordinal,
          fieldKey: 'member_id',
          label: `The guardian (${guardian.memberNo}) is not an active member.`,
        });
      }
    }
  }

  // S-602: a type that wants nominees to divide the membership by percentage
  // asks for it the same way it asks for any other nominee field — a
  // mandatory 'percentage' field, nothing more. Detected from that alone, so
  // it can never drift out of sync with whether the field actually exists.
  // Checked only once every nominee has entered one: an empty percentage is
  // already reported above as its own missing field, and totalling a split
  // that is not yet complete would just be noise on top of that.
  const nomineeFields = fields.get('nominee');
  if (nomineeFields?.some(f => f.fieldKey === 'percentage' && f.isMandatory)) {
    const nomineeParties = application.parties.filter(
      p => p.subject === 'nominee'
    );
    const entered = nomineeParties.map(p => (p.values.percentage ?? '').trim());
    if (entered.length > 0 && entered.every(v => v !== '')) {
      const total = entered.reduce((sum, v) => sum + Number(v), 0);
      // Percentages are typed as whole-ish numbers; rounding away floating
      // point noise (33.33 x 3) before comparing avoids refusing a split that
      // is, for any practical purpose, exactly 100.
      if (Math.round(total * 100) / 100 !== 100) {
        problems.push({
          subject: 'nominee',
          ordinal: nomineeParties[0].ordinal,
          fieldKey: 'percentage',
          label: `Nominee percentages must add up to 100% (currently ${total}%).`,
        });
      }
    }
  }

  return problems;
}

/**
 * Delete a draft the officer no longer needs.
 *
 * Only a draft. That is the one state where deleting loses nothing: it has
 * never been submitted, so no one else has read it, no one has reviewed or
 * decided it, and there is no member behind it. A `returned` application looks
 * editable for the same reason a draft does, but it has been through central
 * processing and carries that history — it is corrected and resubmitted, never
 * deleted.
 *
 * Anyone who may capture applications may delete a draft, whoever started it.
 * Capture staff already create and edit these freely, and the audit entry
 * below records who deleted which.
 *
 * The row is deleted rather than flagged, because a draft that was started by
 * mistake is not history worth keeping and holding an applicant's details
 * indefinitely for a form nobody submitted is not something to do by default.
 * What remains is the audit entry below.
 */
export async function deleteDraftApplication(
  applicationId: string,
  principal: Principal,
  discardFiles: (reference: string) => Promise<void> = discardApplicationFiles
): Promise<{ reference: string }> {
  if (!principal.permissions.has('application.capture')) {
    throw new ApplicationError(
      'You do not have permission to delete applications.',
      'forbidden'
    );
  }

  return withTransaction(async client => {
    // Re-read under a lock. Without it, a delete and a submit racing on the
    // same draft could both read `draft` and both proceed, and the submitted
    // application would vanish from under central processing.
    const locked = await client.query<{
      reference: string;
      status: string;
      captured_by: string;
      created_at: Date;
      membership_type_code: string | null;
    }>(
      // Left joined: an additional_account draft (S-613) has no membership
      // type to name, and an inner join here would read as "no such
      // application" for an abandoned one an officer is trying to delete.
      `select a.reference, a.status, a.captured_by, a.created_at,
              m.code as membership_type_code
         from membership_application a
         left join membership_type m on m.id = a.membership_type_id
        where a.id = $1
          for no key update of a`,
      [applicationId]
    );
    if (locked.rowCount === 0) {
      throw new ApplicationError(
        'That application no longer exists.',
        'not_found'
      );
    }
    const row = locked.rows[0];

    if (row.status !== DRAFT_STATUS) {
      throw new ApplicationError(
        'Only a draft can be deleted. This application has already been ' +
          `submitted (status: ${row.status}), so it has a history that has to ` +
          'be kept.',
        'locked'
      );
    }
    // Belt and braces against a status that arrived some other way: anything
    // with a transition behind it has been acted on by someone.
    const acted = await client.query<{ n: number }>(
      `select count(*)::int as n from application_transition
        where application_id = $1`,
      [applicationId]
    );
    if (acted.rows[0].n > 0) {
      throw new ApplicationError(
        'This application has already been acted on and cannot be deleted.',
        'locked'
      );
    }

    // Money has changed hands against this draft, and the applicant is holding
    // the receipt. The payment names this application, and a receipt that
    // points at nothing is not a receipt — so the application stays, voided
    // receipt or not. Deleting an abandoned draft is for a draft nobody has
    // acted on; taking payment is acting on it.
    //
    // The foreign key refuses this anyway. Refusing here is what makes it a
    // sentence the officer can act on rather than a constraint violation.
    const receipted = await client.query<{ receipt_no: string }>(
      `select r.receipt_no
         from payment p
         join receipt_number r on r.id = p.receipt_number_id
        where p.application_id = $1
        order by r.serial_no
        limit 1`,
      [applicationId]
    );
    if (receipted.rowCount && receipted.rowCount > 0) {
      throw new ApplicationError(
        `Receipt ${receipted.rows[0].receipt_no} was issued against this ` +
          'application, so it cannot be deleted.',
        'locked'
      );
    }

    const filed = await client.query<{ n: number }>(
      `select count(*)::int as n
         from document_version v
         join document d on d.id = v.document_id
        where d.application_id = $1`,
      [applicationId]
    );

    // The row is about to go, so this entry is the whole record of it. It
    // deliberately does not copy what was captured: the point of deleting an
    // abandoned draft is not to keep an applicant's details, and the audit log
    // cannot be edited afterwards.
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'membership.application.deleted',
        entityType: 'membership_application',
        entityId: applicationId,
        previousValue: {
          reference: row.reference,
          membershipType: row.membership_type_code,
          status: row.status,
          startedAt: row.created_at,
          documentsDiscarded: filed.rows[0].n,
        },
      },
      client
    );

    await client.query('delete from membership_application where id = $1', [
      applicationId,
    ]);

    // Inside the transaction, deliberately. The parties, transitions and
    // document rows cascade away here; the files in SharePoint do not, and a
    // failure to remove them has to take the deletion down with it rather than
    // leave scans behind that nothing accounts for. Skipped entirely when
    // nothing was ever uploaded, which is the usual case for an abandoned
    // draft — and means deleting one does not depend on Graph being reachable.
    if (filed.rows[0].n > 0) {
      await discardFiles(row.reference);
    }

    return { reference: row.reference };
  });
}

export async function listApplications(options: {
  capturedBy?: string;
  // Officer feedback: a draft is the officer's own work in progress, not
  // something a colleague browsing the same list should see before they
  // have chosen to submit it. Every OTHER status stays visible to anyone
  // who already holds application.view — this narrows drafts alone, to
  // whoever captured them.
  viewerUserId?: string;
  statuses?: string[];
  // Officer feedback: finding one applicant among many by scrolling and
  // sorting was the only way to do it. Matches the reference or the
  // applicant's name — an officer rarely has the other on hand when they are
  // looking for a specific application.
  search?: string;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    reference: string;
    applicationKind: 'membership' | 'additional_account' | 'customer_account';
    // A membership type's name for a membership application; the selected
    // account type(s), joined, for the other two kinds — an
    // additional_account row has no membership type to name at all
    // (migration 0025), and a customer_account row has one only to source
    // its field configuration from, not to describe itself by (S-614).
    membershipTypeName: string;
    status: string;
    applicantName: string;
    capturedByName: string;
    updatedAt: Date;
  }>
> {
  const result = await query<{
    id: string;
    reference: string;
    application_kind: 'membership' | 'additional_account' | 'customer_account';
    membership_type_name: string | null;
    account_type_names: string | null;
    status: string;
    applicant_name: string | null;
    captured_by_name: string;
    updated_at: Date;
  }>(
    `with rows as (
       select a.id, a.reference, a.application_kind,
              m.name as membership_type_name, accounts.names as account_type_names,
              a.status,
              trim(coalesce(p.values->>'name', ep.values->>'name', '') || ' '
                   || coalesce(p.values->>'surname', ep.values->>'surname', ''))
                as applicant_name,
              u.display_name as captured_by_name,
              a.updated_at
         from membership_application a
         left join membership_type m on m.id = a.membership_type_id
         join app_user u        on u.id = a.captured_by
         left join application_party p
           on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
         -- S-613: an additional_account application captures no applicant of
         -- its own — the person is the existing member it names, whose own
         -- name comes from the membership application that made them one.
         left join member em on em.id = a.existing_member_id
         left join application_party ep
           on ep.application_id = em.application_id
          and ep.subject = 'applicant' and ep.ordinal = 1
         left join lateral (
           select string_agg(t.name, ' + ' order by t.sort_order) as names
             from application_account_selection s
             join account_type t on t.id = s.account_type_id
            where s.application_id = a.id
         ) accounts on true
        where ($1::uuid is null or a.captured_by = $1::uuid)
          and ($2::text[] is null or a.status = any($2::text[]))
          and (a.status != 'draft'
               or $3::uuid is null
               or a.captured_by = $3::uuid)
          -- Officer feedback: once approved, an application is a member (or
          -- an opened account) already, and lives on the Members page from
          -- then on — carrying it here too is a stale duplicate of a record
          -- this list is not the place to keep showing.
          and a.status != 'approved'
     )
     select * from rows
      where $4::text is null
         or strpos(lower(reference), lower($4::text)) > 0
         or strpos(lower(applicant_name), lower($4::text)) > 0
      order by updated_at desc
      limit $5::int`,
    [
      options.capturedBy ?? null,
      options.statuses ?? null,
      options.viewerUserId ?? null,
      options.search?.trim() || null,
      options.limit ?? 100,
    ]
  );

  return result.rows.map(r => ({
    id: r.id,
    reference: r.reference,
    applicationKind: r.application_kind,
    membershipTypeName:
      r.application_kind === 'membership'
        ? r.membership_type_name!
        : `Account: ${r.account_type_names ?? '—'}`,
    status: r.status,
    applicantName: r.applicant_name || '(no name yet)',
    capturedByName: r.captured_by_name,
    updatedAt: r.updated_at,
  }));
}

// Officer feedback: the Applications section had no sense of how many
// applications there actually are — only the (capped) rows a query happened
// to fetch. A separate count() rather than reading listApplications'
// row.length, which is bounded by its own `limit` and would silently
// undercount once there are more applications than that.
//
// Drafts are excluded unconditionally — they are the capturing officer's own
// work in progress (listApplications' own viewerUserId rule), not a count
// every officer should read as "how many applications exist" — the same
// reason 'approved' is excluded too: those already live on the Members page.
export async function countApplications(
  options: { statuses?: string[] } = {}
): Promise<number> {
  const result = await query<{ n: string }>(
    `select count(*)::int as n
       from membership_application a
      where ($1::text[] is null or a.status = any($1::text[]))
        and a.status != 'draft'
        and a.status != 'approved'`,
    [options.statuses ?? null]
  );
  return Number(result.rows[0].n);
}
