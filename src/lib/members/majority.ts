// A minor reaching the age of majority (S-610, FRD 7.10.10).
//
// Nobody submits this — a birthday is not an action anyone takes, so there is
// no request to hang it off. It runs as a scheduled job (docs/jobs.md), on
// the runner proved in M1 (S-113), the same shape as document expiry.
//
// Detected from configuration alone, the same reasoning as S-602's
// percentage field: a type only transitions members if an administrator has
// set both membership_type.majority_age and majority_transition_type_id
// (migration 0023). Neither is set by default, so this finds nothing to do
// until the Society confirms what majority actually changes and turns it on.
import { recordAudit } from '../access/audit';
import { withTransaction } from '../db/pool';

export interface MajorityTransition {
  memberId: string;
  memberNo: string;
  fromTypeCode: string;
  toTypeCode: string;
}

/**
 * Move every eligible member into the type their own type's configuration
 * names, once they have reached that type's configured age.
 *
 * Eligible means active — a member already inactive is not one this Society
 * is tracking day to day, and reaching an age is not itself a reason to
 * revisit that. Age is read off the applicant's own date of birth, which is
 * why a type with no `date_of_birth` field configured (nothing but Minor
 * asks for one) can never produce a match: there is nothing to compare.
 */
export async function transitionMinorsAtMajority(
  now: Date = new Date()
): Promise<{ transitioned: MajorityTransition[] }> {
  return withTransaction(async client => {
    const due = await client.query<{
      id: string;
      member_no: string;
      from_type_code: string;
      to_type_id: string;
      to_type_code: string;
    }>(
      `select m.id, m.member_no, t.code as from_type_code,
              tt.id as to_type_id, tt.code as to_type_code
         from member m
         join membership_type t  on t.id = m.membership_type_id
         join membership_type tt on tt.id = t.majority_transition_type_id
         join membership_application a on a.id = m.application_id
         join application_party p
           on p.application_id = a.id and p.subject = 'applicant' and p.ordinal = 1
        where m.status = 'active'
          and t.majority_age is not null
          and (p.values->>'date_of_birth') is not null
          and (p.values->>'date_of_birth')::date
                + make_interval(years => t.majority_age)
              <= $1::date`,
      [now]
    );

    const transitioned: MajorityTransition[] = [];
    for (const row of due.rows) {
      await client.query(
        `update member set membership_type_id = $2 where id = $1`,
        [row.id, row.to_type_id]
      );
      await recordAudit(
        {
          actorUserId: null,
          actorDescription: 'scheduled job: minor majority transition',
          action: 'member.majority_transition',
          entityType: 'member',
          entityId: row.id,
          previousValue: { membershipType: row.from_type_code },
          newValue: { membershipType: row.to_type_code },
        },
        client
      );
      transitioned.push({
        memberId: row.id,
        memberNo: row.member_no,
        fromTypeCode: row.from_type_code,
        toTypeCode: row.to_type_code,
      });
    }

    return { transitioned };
  });
}
