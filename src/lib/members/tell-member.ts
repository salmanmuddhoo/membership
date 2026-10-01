// Telling a member something about their membership itself — dormant,
// reactivated, a details update decided — as opposed to about an
// application (notifications/events.ts) or a transaction (ledger/*).
//
// The address is the one the member's founding application recorded, read
// through the same contactFor the application events use, so a member is
// written to at one place however the news arises. A legacy member with no
// application (M7) has no such address and is told nothing; the caller's
// own record — the status, the decision — is never failed by a message that
// could not be queued, because the delivery log is where a failure shows.
import { loadApplication } from '../applications/capture';
import { query } from '../db/pool';
import { contactFor } from '../notifications/events';
import { notify } from '../notifications/notify';

export async function tellMember(
  memberId: string,
  eventCode: string,
  values: Record<string, string>
): Promise<void> {
  try {
    const member = await query<{
      member_no: string;
      application_id: string | null;
    }>(`select member_no, application_id from member where id = $1`, [
      memberId,
    ]);
    const row = member.rows[0];
    if (!row?.application_id) return;
    const application = await loadApplication(row.application_id);
    const contact = application ? await contactFor(application) : null;
    if (!contact || (!contact.email && !contact.mobile)) return;
    await notify({
      eventCode,
      recipients: { email: contact.email, mobile: contact.mobile },
      values: {
        member_name: contact.name,
        member_no: row.member_no,
        ...values,
      },
      entityType: 'member',
      entityId: memberId,
    });
  } catch (error) {
    console.error(`[${eventCode}] notification failed`, error);
  }
}
