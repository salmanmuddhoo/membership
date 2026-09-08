// Officer feedback: a regional officer corrects a phone number or address at
// the counter — a member reads it out, or a letter comes back undelivered —
// and the person is standing right there. member_details_request
// (details-requests.ts) exists for the opposite case: a change the member
// themselves sent in from the app, unattended, which is why it goes through
// member.details_verify before it lands. Neither reason applies here, so
// this writes straight to application_party and skips that queue entirely
// (migration 0045).
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { toInternational, PhoneFormatError } from '../applications/phone';
import { listMembershipTypes } from '../config/reference';
import { query, withTransaction } from '../db/pool';

export const PERMISSION_EDIT_CONTACT = 'member.edit_contact';
const ACTION_UPDATED = 'member.contact.updated';

// Only what officer feedback asked for. Widening this to every applicant
// field would reopen the review workflow member.details_verify exists for —
// this path is deliberately narrower, and saves straight through.
const EDITABLE_FIELD_KEYS = new Set(['telephone', 'address']);

export class ContactUpdateError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_found' | 'forbidden' | 'invalid' = 'invalid'
  ) {
    super(message);
    this.name = 'ContactUpdateError';
  }
}

function assertMayEdit(principal: Principal): void {
  if (!principal.permissions.has(PERMISSION_EDIT_CONTACT)) {
    throw new ContactUpdateError(
      'You do not have permission to edit contact details.',
      'forbidden'
    );
  }
}

export interface EditableContactField {
  fieldKey: string;
  label: string;
  dataType: string;
  value: string;
}

// The applicant's telephone/address fields this application's type actually
// configures, with their current values — what the member/customer page
// renders as inputs. A type that configures neither returns nothing to
// edit, same as a type that never asked for a Nominee renders no Nominee
// section.
export async function editableContactFields(
  applicationId: string
): Promise<EditableContactField[]> {
  const application = await query<{ membership_type_id: string }>(
    `select membership_type_id from membership_application where id = $1`,
    [applicationId]
  );
  if (application.rowCount === 0) return [];

  const type = (await listMembershipTypes()).find(
    t => t.id === application.rows[0].membership_type_id
  );
  const fields = (type?.fields ?? []).filter(
    f =>
      f.subject === 'applicant' &&
      f.isVisible &&
      EDITABLE_FIELD_KEYS.has(f.fieldKey)
  );
  if (fields.length === 0) return [];

  const party = await query<{ values: Record<string, string> }>(
    `select values from application_party
      where application_id = $1 and subject = 'applicant' and ordinal = 1`,
    [applicationId]
  );
  const values = party.rows[0]?.values ?? {};

  return fields.map(f => ({
    fieldKey: f.fieldKey,
    label: f.label,
    dataType: f.dataType,
    value: values[f.fieldKey] ?? '',
  }));
}

/**
 * Save telephone/address straight onto the applicant party — no draft, no
 * submission, no approval. Only the fields that actually changed are
 * written (jsonb || jsonb), so this can never disturb a field the officer
 * did not touch.
 */
export async function updateContactDetails(
  applicationId: string,
  changes: Record<string, string>,
  entity: { entityType: 'member' | 'customer'; entityId: string },
  principal: Principal
): Promise<{ updated: string[] }> {
  assertMayEdit(principal);

  return withTransaction(async client => {
    const current = await client.query<{ values: Record<string, string> }>(
      `select values from application_party
        where application_id = $1 and subject = 'applicant' and ordinal = 1
        for no key update`,
      [applicationId]
    );
    const before = current.rows[0]?.values;
    if (!before) {
      throw new ContactUpdateError(
        'This record has no applicant details to edit.',
        'not_found'
      );
    }

    const patch: Record<string, string> = {};
    for (const [key, raw] of Object.entries(changes)) {
      if (!EDITABLE_FIELD_KEYS.has(key)) continue;
      let value = raw.trim();
      if (key === 'telephone' && value !== '') {
        try {
          value = toInternational(value);
        } catch (error) {
          if (error instanceof PhoneFormatError) {
            throw new ContactUpdateError(
              `Telephone: ${error.message}`,
              'invalid'
            );
          }
          throw error;
        }
      }
      if (value === (before[key] ?? '')) continue;
      patch[key] = value;
    }

    if (Object.keys(patch).length === 0) {
      return { updated: [] };
    }

    await client.query(
      `update application_party set values = values || $2::jsonb
        where application_id = $1 and subject = 'applicant' and ordinal = 1`,
      [applicationId, JSON.stringify(patch)]
    );

    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_UPDATED,
        entityType: entity.entityType,
        entityId: entity.entityId,
        previousValue: Object.fromEntries(
          Object.keys(patch).map(key => [key, before[key] ?? ''])
        ),
        newValue: patch,
      },
      client
    );

    return { updated: Object.keys(patch) };
  });
}
