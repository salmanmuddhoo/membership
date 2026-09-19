/**
 * Who hands over the money, as against whose account it goes into.
 *
 * For an ordinary Individual the two are the same person and this is simply
 * the applicant. For the two types where they are not, the paper forms have
 * always named the person actually standing at the counter:
 *
 *  - a **Minor** cannot pay in for themselves, so their parent or guardian
 *    does (officer feedback: the receipt and the Cash Deposit Form both
 *    named the child, who had signed nothing and handed over nothing);
 *  - a **Corporate** entity is not a person at all, so its Contact Person
 *    does — that is the name the Society's own Cash Deposit Form asks for.
 *
 * Kept in one place because a receipt and a Source of Fund form that
 * disagree about who paid are worse than either being wrong alone: the two
 * are filed together and read against each other.
 *
 * NIC follows the same person, which means a Corporate deposit has none to
 * print — the form asks for no NIC against the Contact Person, and a ruled
 * blank is what the paper form leaves there.
 */
import { loadApplication, type PartyValues } from './capture';

export interface Depositor {
  name: string;
  nic: string;
}

function joined(values: Record<string, string> | undefined, ...keys: string[]) {
  return keys
    .map(k => (values?.[k] ?? '').trim())
    .filter(v => v !== '')
    .join(' ');
}

/**
 * `typeCode` is the membership type's own code, not its label: an
 * administrator may rename "Minor" without changing who signs for a child.
 */
export function depositorFor(
  typeCode: string,
  parties: readonly PartyValues[]
): Depositor {
  const applicant = parties.find(
    p => p.subject === 'applicant' && p.ordinal === 1
  );

  if (typeCode === 'minor') {
    const guardian = parties.find(
      p => p.subject === 'guardian' && p.ordinal === 1
    );
    return {
      name: joined(guardian?.values, 'name', 'surname'),
      nic: (guardian?.values.nic ?? '').trim(),
    };
  }

  if (typeCode === 'corporate') {
    // Captured on the applicant party rather than one of its own — a
    // Corporate application has a Contact Person field, not a contact party.
    return {
      name: joined(applicant?.values, 'contact_person'),
      nic: '',
    };
  }

  return {
    name: joined(applicant?.values, 'name', 'surname'),
    nic: (applicant?.values.nic ?? '').trim(),
  };
}

/**
 * The same rule, for a caller that has an application's id and not its
 * parties — the receipt, and the Cash Deposit Form.
 *
 * An additional account captures nobody of its own, so the rule is applied
 * to whoever holds it: their founding application is where a guardian or a
 * contact person was captured. Where that cannot be read there is nothing to
 * name, and the caller falls back to the holder's own label as the paper
 * form did.
 */
export async function depositorForApplication(
  applicationId: string | null
): Promise<Depositor> {
  const blank = { name: '', nic: '' };
  if (!applicationId) return blank;

  const application = await loadApplication(applicationId);
  if (!application) return blank;

  const source =
    application.applicationKind === 'additional_account'
      ? application.existingHolderApplicationId
        ? await loadApplication(application.existingHolderApplicationId)
        : null
      : application;

  // A founding application is never itself an additional account, but the
  // type says it might be, and it carries no membership type to read.
  if (!source || source.applicationKind === 'additional_account') return blank;
  return depositorFor(source.membershipTypeCode, source.parties);
}
