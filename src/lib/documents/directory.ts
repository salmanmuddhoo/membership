// The document directory (officer feedback): every paper filed for a
// member or a non-member customer, in one place, reached from the dashboard
// and the menu rather than from inside each record.
//
// A document has one of four owners (documents.ts): the application it was
// uploaded for, the member or the customer it was filed against directly
// (from this directory, outside any application: officer request,
// migration 0115), or the transaction it was signed for (a closure or
// resignation request, a deposit's Source of Fund form). A holder's
// directory is all of them: the applications that made them (the founding
// one and any additional-account one since), the member or customer row
// itself, and every transaction of theirs.
import type { FieldSubject } from '../config/reference';
import { query } from '../db/pool';

export type HolderKind = 'member' | 'customer';

export interface DirectoryDocument {
  documentId: string;
  documentName: string;
  fileName: string;
  filedAt: Date;
  filedByName: string;
  state: string;
  // Where it was filed: the application's reference, the transaction's
  // reference, or nothing for one filed against the member directly.
  source: string | null;
  sourceKind: 'application' | 'transaction' | 'member';
}

// The applications a holder's documents were filed under: every one that is
// theirs, as the member page reads them (applications-of.ts, LC-02) — the
// one that made them, every further account, a rejoin, and for someone who
// became a member from a non-member the applications they made as one, all
// tied together by the folder they share. A draft is someone's work in
// progress and not on file, unless it is the one the record itself points at.
const HOLDER_APPLICATIONS_SQL = `
  with anchor as (
    select m.id as holder_id, a.id as application_id,
           m.application_id as current_id
      from member m
      join membership_application a
        on a.id = m.application_id
        or a.rejoins_member_id = m.id
        or a.existing_member_id = m.id
     where m.id = any($1::uuid[])
    union all
    select c.id, a.id, c.application_id
      from customer c
      join membership_application a
        on a.id = c.application_id
        or a.existing_customer_id = c.id
     where c.id = any($1::uuid[])
  )
  select distinct an.holder_id, p.id as application_id
    from anchor an
    join membership_application r on r.id = an.application_id
    join membership_application p
      on p.id = r.id
      or coalesce(p.folder_application_id, p.id)
         = coalesce(r.folder_application_id, r.id)
   where p.status <> 'draft' or p.id = an.current_id`;

// What a holder filed outside any application (their Documents page): the
// member's or customer's own documents, and for a member those filed for
// the customer they were before joining (S-614, migration 0115).
const HOLDER_OWN_SQL = `
  select d.member_id as holder_id, d.id as document_id
    from document d
   where d.member_id = any($1::uuid[])
  union
  select d.customer_id, d.id
    from document d
   where d.customer_id = any($1::uuid[])
  union
  select m.id, d.id
    from member m
    join membership_application a
      on a.id = m.application_id
      or a.rejoins_member_id = m.id
      or a.existing_member_id = m.id
    join document d on d.customer_id = a.source_customer_id
   where m.id = any($1::uuid[])`;

// A document counts once it has a committed version on file.
const FILED_SQL = `
  join document_version v
    on v.document_id = d.id
   and v.state = 'committed' and v.superseded_at is null`;

/** How many documents are on file for each of these holders. */
export async function documentCountsForHolders(
  holderIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (holderIds.length === 0) return counts;
  const result = await query<{ holder_id: string; n: number }>(
    `with holder_application as (${HOLDER_APPLICATIONS_SQL}),
     owned as (
       select h.holder_id, d.id as document_id
         from holder_application h
         join document d on d.application_id = h.application_id
       union
       select holder_id, document_id from (${HOLDER_OWN_SQL}) own
       union
       select coalesce(t.member_id, t.customer_id), d.id
         from document d
         join transaction t on t.id = d.transaction_id
        where t.member_id = any($1::uuid[]) or t.customer_id = any($1::uuid[])
     )
     select o.holder_id, count(distinct o.document_id)::int as n
       from owned o
       join document d on d.id = o.document_id
       ${FILED_SQL}
      group by o.holder_id`,
    [holderIds]
  );
  for (const row of result.rows) counts.set(row.holder_id, row.n);
  return counts;
}

/** Everything on file for one holder, newest first. */
export async function documentsForHolder(
  holderId: string
): Promise<DirectoryDocument[]> {
  const result = await query<{
    document_id: string;
    document_name: string;
    file_name: string;
    committed_at: Date;
    filed_by_name: string;
    state: string;
    source: string | null;
    source_kind: 'application' | 'transaction' | 'member';
  }>(
    `with holder_application as (${HOLDER_APPLICATIONS_SQL}),
     owned as (
       select d.id as document_id, a.reference as source,
              'application'::text as source_kind
         from holder_application h
         join membership_application a on a.id = h.application_id
         join document d on d.application_id = a.id
       union
       select own.document_id, null, 'member'
         from (${HOLDER_OWN_SQL}) own
       union
       select d.id, t.reference, 'transaction'
         from document d
         join transaction t on t.id = d.transaction_id
        where t.member_id = $2::uuid or t.customer_id = $2::uuid
     )
     select d.id as document_id, ty.name as document_name, v.file_name,
            v.committed_at, u.display_name as filed_by_name, d.state,
            o.source, o.source_kind
       from owned o
       join document d on d.id = o.document_id
       join document_type ty on ty.id = d.document_type_id
       ${FILED_SQL}
       join app_user u on u.id = v.uploaded_by
      order by v.committed_at desc`,
    [[holderId], holderId]
  );
  return result.rows.map(r => ({
    documentId: r.document_id,
    documentName: r.document_name,
    fileName: r.file_name,
    filedAt: r.committed_at,
    filedByName: r.filed_by_name,
    state: r.state,
    source: r.source,
    sourceKind: r.source_kind,
  }));
}

export interface DocumentGroup {
  label: string;
  documents: DirectoryDocument[];
}

/**
 * A holder's documents grouped by where each was filed, in the order first
 * seen, oldest first: the founding application's papers lead. The one way
 * the Documents page and the member page both show them, so the two never
 * disagree about what is on file.
 */
export function groupHolderDocuments(
  documents: DirectoryDocument[],
  holderKind: HolderKind
): DocumentGroup[] {
  const groups = new Map<string, DirectoryDocument[]>();
  for (const document of [...documents].reverse()) {
    const label =
      document.sourceKind === 'member'
        ? holderKind === 'member'
          ? 'On file for the member'
          : 'On file for the customer'
        : `${document.sourceKind === 'application' ? 'Application' : 'Transaction'} ${document.source}`;
    groups.set(label, [...(groups.get(label) ?? []), document]);
  }
  return [...groups.entries()].map(([label, entries]) => ({
    label,
    documents: entries,
  }));
}

export interface FilingChoice {
  // documentTypeId:subject — what the form posts, and what an application's
  // checklist matches a carried document on.
  value: string;
  documentTypeId: string;
  subject: FieldSubject;
  label: string;
  tracksExpiry: boolean;
}

const SUBJECT_WORDS: Partial<Record<FieldSubject, string>> = {
  nominee: 'Nominee',
  guardian: 'Guardian',
  beneficiary: 'Beneficiary',
};

/**
 * What may be filed for a holder outside an application (officer request):
 * every document an application checklist asks for, for whom — the
 * holder's own identity card, a nominee's, a guardian's utility bill — so
 * a document filed here is the one the next application's checklist picks
 * up (carryForwardMemberDocuments matches on type and subject). The signed
 * application form is left out: it belongs to the application it was
 * signed for.
 */
export async function filingChoices(): Promise<FilingChoice[]> {
  const result = await query<{
    document_type_id: string;
    subject: FieldSubject;
    name: string;
    tracks_expiry: boolean;
  }>(
    `select distinct ci.document_type_id, ci.subject, t.name, t.tracks_expiry
       from document_checklist_item ci
       join document_checklist c on c.id = ci.checklist_id
       join document_type t on t.id = ci.document_type_id
      where c.is_active and t.is_active and t.code <> 'signed_form'
      order by t.name, ci.subject`
  );
  return result.rows
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        Number(a.subject !== 'applicant') - Number(b.subject !== 'applicant') ||
        a.subject.localeCompare(b.subject)
    )
    .map(r => ({
      value: `${r.document_type_id}:${r.subject}`,
      documentTypeId: r.document_type_id,
      subject: r.subject,
      label: SUBJECT_WORDS[r.subject]
        ? `${r.name} (${SUBJECT_WORDS[r.subject]})`
        : r.name,
      tracksExpiry: r.tracks_expiry,
    }));
}
