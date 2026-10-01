// The document directory (officer feedback): every paper filed for a
// member or a non-member customer, in one place, reached from the dashboard
// and the menu rather than from inside each record.
//
// A document has one of three owners (documents.ts): the application it
// was uploaded for, the member it was filed against directly, or the
// transaction it was signed for (a closure or resignation request, a
// deposit's Source of Fund form). A holder's directory is all three: the
// applications that made them (the founding one and any additional-account
// one since), the member row itself, and every transaction of theirs.
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

// The applications a holder's documents were filed under. A member's are
// the one that made them and any additional-account one since; a customer
// only ever has the one.
const HOLDER_APPLICATIONS_SQL = `
  select m.id as holder_id, a.id as application_id
    from member m
    join membership_application a
      on a.id = m.application_id
      or (a.existing_member_id = m.id
          and a.application_kind = 'additional_account'
          and a.status <> 'draft')
   where m.id = any($1::uuid[])
  union all
  select c.id, c.application_id
    from customer c
   where c.id = any($1::uuid[]) and c.application_id is not null`;

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
       select d.member_id, d.id
         from document d
        where d.member_id = any($1::uuid[])
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
       select d.id, null, 'member'
         from document d
        where d.member_id = $2::uuid
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
