// Filing documents, and knowing whether the file is complete
// (M4, S-405 to S-410).
//
// SharePoint holds the files; this module is the system of record for what a
// document IS — which requirement it satisfies, who filed it, whether anyone
// has checked it (FRD 8.3). The two are kept apart on purpose: a file moved in
// SharePoint must not cost us the knowledge that the Secretary verified it.
//
// The checklist itself is not defined here. It comes from the M2 configuration
// (S-208), so what an Individual application requires is a matter of
// configuration, and this module only reports what has and has not been filed
// against it.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { checkSegregation } from '../admin/segregation';
import {
  checklistForMembershipType,
  type FieldSubject,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';
import {
  deleteItemByPath,
  ensureFolder,
  getItemByPath,
  type GraphConfig,
} from './graph';
import {
  createUploadTicket,
  sanitiseFileName,
  validateUploadRequest,
  type UploadTicket,
} from './upload';

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'invalid' | 'conflict' | 'refused' = 'invalid'
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

export interface Actor {
  userId: string;
  email: string;
}

export const ENTITY_TYPE = 'document';
// The segregation rule seeded in migration 0013 keys on these. Named once, so
// renaming one cannot silently disable the control.
export const ACTION_FILED = 'document.filed';
export const ACTION_VERIFIED = 'document.verified';

// FRD 8.4's states, plus Missing — which is the absence of a document rather
// than a stored value, so it can never disagree with what is actually there.
export type ChecklistState =
  'missing' | 'uploaded' | 'under_review' | 'verified' | 'rejected' | 'expired';

export interface ChecklistEntry {
  documentTypeId: string;
  documentCode: string;
  documentName: string;
  subject: FieldSubject;
  requirement: 'required' | 'optional';
  tracksExpiry: boolean;
  state: ChecklistState;
  documentId: string | null;
  fileName: string | null;
  webPath: string | null;
  uploadedByName: string | null;
  uploadedAt: Date | null;
  verifiedByName: string | null;
  rejectionReason: string | null;
  expiresAt: Date | null;
  versionCount: number;
}

/**
 * The folder a member's documents live in (FRD 8.1).
 *
 * The name carries the Member ID first so the folder sorts and searches by the
 * identifier that never changes, with the name after it for a human scanning
 * the library.
 */
export const ROOT_FOLDER = 'Al Barakah MCSL – Member Documents';

export const MEMBER_SUBFOLDERS = [
  '01 – Membership',
  '02 – Accounts',
  '03 – Financing',
  '04 – Other',
] as const;

export function memberFolderName(memberNo: string, name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .trim();
  return cleaned ? `${memberNo} – ${cleaned}` : memberNo;
}

/**
 * Where a document is filed before the applicant is a member.
 *
 * Applications get their own area rather than a member folder, because most of
 * them are not members yet and some never will be. On approval the documents
 * are already filed; M4 does not move them, and the metadata points at the
 * path either way.
 */
export function applicationFolderPath(reference: string): string {
  return `${ROOT_FOLDER}/Applications/${reference}`;
}

export function memberFolderPath(memberNo: string, name: string): string {
  return `${ROOT_FOLDER}/${memberFolderName(memberNo, name)}`;
}

/**
 * Create a folder path, one segment at a time, skipping what exists (S-405).
 *
 * Recorded in sharepoint_folder so a path created once is not asked about
 * again — the common case is a second document for the same application, and
 * that should not cost four Graph round trips.
 */
export async function ensureFolderPath(
  path: string,
  config?: GraphConfig
): Promise<void> {
  const known = await query('select 1 from sharepoint_folder where path = $1', [
    path,
  ]);
  if (known.rowCount) return;

  const segments = path.split('/').filter(Boolean);
  let parent = '';
  for (const segment of segments) {
    await ensureFolder(parent, segment, config);
    parent = parent ? `${parent}/${segment}` : segment;
  }

  // on conflict: two requests can reach here at once for the same application,
  // and both creating the folder is fine — both recording it must be too.
  await query(
    'insert into sharepoint_folder (path) values ($1) on conflict (path) do nothing',
    [path]
  );
}

interface OwnerRow {
  application_id: string | null;
  member_id: string | null;
  membership_type_code: string;
  folder_path: string;
}

async function resolveOwner(
  applicationId: string | null,
  memberId: string | null
): Promise<OwnerRow> {
  if (applicationId) {
    const result = await query<{
      reference: string;
      membership_type_code: string;
    }>(
      `select a.reference, m.code as membership_type_code
         from membership_application a
         join membership_type m on m.id = a.membership_type_id
        where a.id = $1`,
      [applicationId]
    );
    if (result.rowCount === 0) {
      throw new DocumentError(
        'That application no longer exists.',
        'not_found'
      );
    }
    return {
      application_id: applicationId,
      member_id: null,
      membership_type_code: result.rows[0].membership_type_code,
      folder_path: applicationFolderPath(result.rows[0].reference),
    };
  }

  if (!memberId) {
    throw new DocumentError(
      'A document must belong to an application or a member.'
    );
  }

  const result = await query<{
    member_no: string;
    membership_type_code: string;
    name: string;
  }>(
    `select m.member_no, t.code as membership_type_code,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as name
       from member m
       join membership_type t on t.id = m.membership_type_id
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where m.id = $1`,
    [memberId]
  );
  if (result.rowCount === 0) {
    throw new DocumentError('That member no longer exists.', 'not_found');
  }

  return {
    application_id: null,
    member_id: memberId,
    membership_type_code: result.rows[0].membership_type_code,
    folder_path: memberFolderPath(
      result.rows[0].member_no,
      result.rows[0].name ?? ''
    ),
  };
}

/**
 * S-407 · The checklist, as the Secretary reads it.
 *
 * Every item the configuration requires, with what has been filed against it.
 * An item with no committed document reads Missing — computed, so it cannot
 * drift from what is actually in the drive.
 */
export async function checklistFor(options: {
  applicationId?: string;
  memberId?: string;
}): Promise<ChecklistEntry[]> {
  const owner = await resolveOwner(
    options.applicationId ?? null,
    options.memberId ?? null
  );

  const configured = await checklistForMembershipType(
    owner.membership_type_code
  );

  const filed = await query<{
    id: string;
    document_type_id: string;
    subject: FieldSubject;
    state: ChecklistState;
    rejection_reason: string | null;
    expires_at: Date | null;
    file_name: string | null;
    sharepoint_path: string | null;
    uploaded_by_name: string | null;
    committed_at: Date | null;
    verified_by_name: string | null;
    version_count: string;
  }>(
    `select d.id, d.document_type_id, d.subject, d.state, d.rejection_reason,
            d.expires_at,
            v.file_name, v.sharepoint_path, v.committed_at,
            up.display_name as uploaded_by_name,
            vp.display_name as verified_by_name,
            (select count(*) from document_version dv
              where dv.document_id = d.id and dv.state = 'committed')
              as version_count
       from document d
       left join document_version v
         on v.document_id = d.id
        and v.state = 'committed' and v.superseded_at is null
       left join app_user up on up.id = v.uploaded_by
       left join app_user vp on vp.id = d.verified_by
      where ($1::uuid is not null and d.application_id = $1::uuid)
         or ($2::uuid is not null and d.member_id = $2::uuid)`,
    [owner.application_id, owner.member_id]
  );

  const byKey = new Map(
    filed.rows.map(r => [`${r.document_type_id}:${r.subject}`, r])
  );

  const entries: ChecklistEntry[] = [];
  for (const [subject, items] of configured) {
    for (const item of items) {
      const found = byKey.get(`${item.documentTypeId}:${subject}`);
      entries.push({
        documentTypeId: item.documentTypeId,
        documentCode: item.documentCode,
        documentName: item.documentName,
        subject,
        requirement: item.requirement,
        tracksExpiry: item.tracksExpiry,
        // A document row with no committed version is an upload that never
        // finished, and reads Missing (S-408).
        state: found
          ? found.committed_at
            ? found.state
            : 'missing'
          : 'missing',
        documentId: found?.id ?? null,
        fileName: found?.file_name ?? null,
        webPath: found?.sharepoint_path ?? null,
        uploadedByName: found?.uploaded_by_name ?? null,
        uploadedAt: found?.committed_at ?? null,
        verifiedByName: found?.verified_by_name ?? null,
        rejectionReason: found?.rejection_reason ?? null,
        expiresAt: found?.expires_at ?? null,
        versionCount: Number(found?.version_count ?? 0),
      });
    }
  }

  return entries;
}

/** Whether every required item is Verified — and nothing else may assert it. */
export function isDocumentComplete(entries: ChecklistEntry[]): boolean {
  return entries
    .filter(e => e.requirement === 'required')
    .every(e => e.state === 'verified');
}

export interface BeginUploadResult {
  documentId: string;
  versionId: string;
  ticket: UploadTicket;
}

/**
 * Phase one: authorise an upload and record the intent (S-403, S-404, S-408).
 *
 * Nothing is on the checklist yet. The version is `pending`, so until commit
 * confirms the bytes are in SharePoint the item still reads Missing — which is
 * exactly what should happen if the tablet loses signal halfway.
 */
export async function beginUpload(
  input: {
    applicationId?: string;
    memberId?: string;
    documentTypeId: string;
    subject: FieldSubject;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    expiresAt?: Date | null;
  },
  actor: Actor,
  config?: GraphConfig
): Promise<BeginUploadResult> {
  const owner = await resolveOwner(
    input.applicationId ?? null,
    input.memberId ?? null
  );

  const type = await query<{ code: string; tracks_expiry: boolean }>(
    'select code, tracks_expiry from document_type where id = $1 and is_active',
    [input.documentTypeId]
  );
  if (type.rowCount === 0) {
    throw new DocumentError(
      'That document type is not available.',
      'not_found'
    );
  }
  if (type.rows[0].tracks_expiry && !input.expiresAt) {
    throw new DocumentError(
      `${type.rows[0].code} expires, so an expiry date is required. Without ` +
        'one nothing can tell you when it lapses.'
    );
  }

  // Checked before anything is created. createUploadTicket checks again — it
  // is the function that talks to Graph and must not trust its caller — but
  // doing it here as well means a file of the wrong type or size is refused
  // without first creating a SharePoint folder for an upload that is never
  // going to happen, and without the officer waiting on a round trip to be
  // told something we already knew.
  validateUploadRequest({
    folderPath: owner.folder_path,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  // Created before the ticket, so a folder failure refuses the upload rather
  // than producing a ticket that points nowhere.
  await ensureFolderPath(owner.folder_path, config);

  const { documentId, versionId, itemName } = await withTransaction(
    async client => {
      const existing = await client.query<{ id: string }>(
        `select id from document
          where document_type_id = $1 and subject = $2
            and (($3::uuid is not null and application_id = $3::uuid)
              or ($4::uuid is not null and member_id = $4::uuid))`,
        [
          input.documentTypeId,
          input.subject,
          owner.application_id,
          owner.member_id,
        ]
      );

      let id: string;
      if (existing.rowCount) {
        // Deliberately unchanged here. Re-filing over a verified or rejected
        // document must not alter it until the replacement actually arrives:
        // an upload that fails would otherwise downgrade a perfectly good
        // filed document to "uploaded" and discard the Secretary's verdict on
        // a file that is still the live one. The reset happens at commit.
        id = existing.rows[0].id;
      } else {
        const created = await client.query<{ id: string }>(
          `insert into document
             (document_type_id, subject, application_id, member_id, expires_at)
           values ($1, $2, $3, $4, $5) returning id`,
          [
            input.documentTypeId,
            input.subject,
            owner.application_id,
            owner.member_id,
            input.expiresAt ?? null,
          ]
        );
        id = created.rows[0].id;
      }

      // The stored name carries the version, so two versions never collide in
      // the drive and a human can see which is which.
      const nextVersion = await client.query<{ next: number }>(
        `select coalesce(max(version_no), 0) + 1 as next
           from document_version where document_id = $1`,
        [id]
      );
      const versionNo = nextVersion.rows[0].next;
      const safeName = sanitiseFileName(input.fileName);
      const name = versionNo === 1 ? safeName : `v${versionNo} ${safeName}`;

      const version = await client.query<{ id: string }>(
        `insert into document_version
           (document_id, version_no, file_name, content_type, size_bytes,
            sharepoint_path, intended_expires_at, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          id,
          versionNo,
          name,
          input.contentType,
          input.sizeBytes,
          `${owner.folder_path}/${name}`,
          input.expiresAt ?? null,
          actor.userId,
        ]
      );

      return { documentId: id, versionId: version.rows[0].id, itemName: name };
    }
  );

  const ticket = await createUploadTicket(
    {
      folderPath: owner.folder_path,
      fileName: itemName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    },
    config
  );

  return { documentId, versionId, ticket };
}

/**
 * Phase two: confirm with SharePoint, not with the browser (S-408).
 *
 * The bytes never pass through this application, so the client's word that an
 * upload finished is not evidence. Graph is asked whether the file is there
 * and how big it is; only then does the version commit and the checklist item
 * stop reading Missing.
 */
export async function commitUpload(
  versionId: string,
  actor: Actor,
  options: { checksumSha256?: string } = {},
  config?: GraphConfig
): Promise<{ state: 'committed' }> {
  const version = await query<{
    id: string;
    document_id: string;
    state: string;
    sharepoint_path: string;
    size_bytes: string;
    file_name: string;
    intended_expires_at: Date | null;
    uploaded_by: string;
  }>(
    `select id, document_id, state, sharepoint_path, size_bytes, file_name,
            intended_expires_at, uploaded_by
       from document_version where id = $1`,
    [versionId]
  );
  if (version.rowCount === 0) {
    throw new DocumentError('That upload no longer exists.', 'not_found');
  }
  const row = version.rows[0];
  if (row.state === 'committed') return { state: 'committed' };

  // Only the person who started this upload may finish it. Not a theft
  // concern — the bytes are whatever they are, and Graph is what confirms
  // them. It is that the commit is what writes `document.filed` to the audit
  // trail, and segregation of duties reads that trail to decide who may not
  // verify this document (S-203). Letting anyone commit anyone's upload would
  // put the wrong name against the filing, barring a person who did nothing
  // and clearing the person who actually did it.
  if (row.uploaded_by !== actor.userId) {
    throw new DocumentError(
      'This upload was started by someone else, so only they can complete it.',
      'refused'
    );
  }

  const item = await getItemByPath(row.sharepoint_path, config);
  if (!item) {
    await markVersionFailed(versionId, 'SharePoint has no file at that path.');
    throw new DocumentError(
      'The file is not in SharePoint, so it has not been filed. Please try ' +
        'the upload again.',
      'refused'
    );
  }

  // A size mismatch means the transfer was truncated. Recording it as filed
  // would put a half a document behind a Verified tick.
  if (Number(item.size) !== Number(row.size_bytes)) {
    await markVersionFailed(
      versionId,
      `Expected ${row.size_bytes} bytes, SharePoint holds ${item.size}.`
    );
    throw new DocumentError(
      'The uploaded file is incomplete, so it has not been filed. Please try ' +
        'again.',
      'refused'
    );
  }

  await withTransaction(async client => {
    // Supersede whatever was live before this version (S-409). Done here
    // rather than at begin, so a failed replacement never removes the document
    // that was already good.
    await client.query(
      `update document_version
          set superseded_at = now()
        where document_id = $1 and id <> $2
          and state = 'committed' and superseded_at is null`,
      [row.document_id, versionId]
    );

    await client.query(
      `update document_version
          set state = 'committed', committed_at = now(),
              sharepoint_item_id = $2, checksum_sha256 = $3
        where id = $1`,
      [versionId, item.id, options.checksumSha256 ?? null]
    );

    // Now — and only now — the document takes on this upload. A rejection or
    // an expiry applied to the file this one replaces is cleared, because the
    // verdict was about a file that is no longer the live one.
    await client.query(
      `update document
          set state = 'under_review', rejection_reason = null,
              verified_by = null, verified_at = null,
              expires_at = coalesce($2, expires_at)
        where id = $1`,
      [row.document_id, row.intended_expires_at]
    );

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: ACTION_FILED,
        entityType: ENTITY_TYPE,
        entityId: row.document_id,
        newValue: {
          fileName: row.file_name,
          sharePointItemId: item.id,
          sizeBytes: Number(row.size_bytes),
        },
      },
      client
    );
  });

  return { state: 'committed' };
}

async function markVersionFailed(
  versionId: string,
  reason: string
): Promise<void> {
  await query(
    `update document_version set state = 'failed' where id = $1 and state = 'pending'`,
    [versionId]
  );
  console.warn(`[documents] upload ${versionId} failed: ${reason}`);
}

/**
 * S-407 · Verify or reject a filed document.
 *
 * The person who filed it may not be the one who verifies it — the same
 * per-record segregation the approval chain uses (S-203), so an officer cannot
 * sign off their own scan.
 */
export async function reviewDocument(
  documentId: string,
  decision: { outcome: 'verify' | 'reject'; reason?: string },
  principal: { userId: string; email: string; permissions: ReadonlySet<string> }
): Promise<{ state: ChecklistState }> {
  if (!principal.permissions.has('document.verify')) {
    throw new DocumentError(
      'You do not have permission to verify documents.',
      'refused'
    );
  }

  const reason = (decision.reason ?? '').trim();
  if (decision.outcome === 'reject' && reason === '') {
    throw new DocumentError(
      'Rejecting a document requires a reason. The person who has to replace ' +
        'it needs to know what is wrong with it.'
    );
  }

  const document = await query<{ id: string; state: string }>(
    'select id, state from document where id = $1',
    [documentId]
  );
  if (document.rowCount === 0) {
    throw new DocumentError('That document no longer exists.', 'not_found');
  }

  const committed = await query(
    `select 1 from document_version
      where document_id = $1 and state = 'committed' and superseded_at is null`,
    [documentId]
  );
  if (committed.rowCount === 0) {
    throw new DocumentError(
      'There is no filed version of that document to verify.',
      'conflict'
    );
  }

  const verdict = await checkSegregation(
    principal.userId,
    ENTITY_TYPE,
    documentId,
    ACTION_VERIFIED
  );
  if (!verdict.allowed) {
    throw new DocumentError(
      `${verdict.conflict!.description} You filed this document, so someone ` +
        'else must check it.',
      'refused'
    );
  }

  const state: ChecklistState =
    decision.outcome === 'verify' ? 'verified' : 'rejected';

  await withTransaction(async client => {
    await client.query(
      `update document
          set state = $2, rejection_reason = $3,
              verified_by = $4, verified_at = now()
        where id = $1`,
      [
        documentId,
        state,
        decision.outcome === 'reject' ? reason : null,
        principal.userId,
      ]
    );

    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_VERIFIED,
        entityType: ENTITY_TYPE,
        entityId: documentId,
        previousValue: { state: document.rows[0].state },
        newValue: { state, reason: reason || null },
      },
      client
    );
  });

  return { state };
}

export interface DocumentVersionSummary {
  id: string;
  versionNo: number;
  fileName: string;
  sizeBytes: number;
  sharepointPath: string;
  checksumSha256: string | null;
  uploadedByName: string;
  committedAt: Date | null;
  supersededAt: Date | null;
}

/**
 * S-402, S-409 · Every version of a document, newest first.
 *
 * Superseded versions are kept, not deleted. For the signed application form
 * that is the point: what the applicant signed must remain retrievable and
 * provably unchanged, whatever is filed over it afterwards.
 */
export async function versionsOf(
  documentId: string
): Promise<DocumentVersionSummary[]> {
  const result = await query<{
    id: string;
    version_no: number;
    file_name: string;
    size_bytes: string;
    sharepoint_path: string;
    checksum_sha256: string | null;
    uploaded_by_name: string;
    committed_at: Date | null;
    superseded_at: Date | null;
  }>(
    `select v.id, v.version_no, v.file_name, v.size_bytes, v.sharepoint_path,
            v.checksum_sha256, u.display_name as uploaded_by_name,
            v.committed_at, v.superseded_at
       from document_version v
       join app_user u on u.id = v.uploaded_by
      where v.document_id = $1 and v.state = 'committed'
      order by v.version_no desc`,
    [documentId]
  );

  return result.rows.map(r => ({
    id: r.id,
    versionNo: r.version_no,
    fileName: r.file_name,
    sizeBytes: Number(r.size_bytes),
    sharepointPath: r.sharepoint_path,
    checksumSha256: r.checksum_sha256,
    uploadedByName: r.uploaded_by_name,
    committedAt: r.committed_at,
    supersededAt: r.superseded_at,
  }));
}

/**
 * S-410 · Expire documents whose date has passed.
 *
 * Run as a scheduled job. Only verified documents expire: one still awaiting
 * review has a more pressing problem than its date, and moving it to Expired
 * would hide that.
 */
export async function expireDocuments(
  now: Date = new Date()
): Promise<{ expired: number }> {
  const result = await withTransaction(async client => {
    const due = await client.query<{ id: string }>(
      `select id from document
        where state = 'verified'
          and expires_at is not null
          and expires_at <= $1
        for update`,
      [now]
    );

    for (const row of due.rows) {
      await client.query(
        `update document set state = 'expired' where id = $1`,
        [row.id]
      );
      await recordAudit(
        {
          actorUserId: null,
          actorDescription: 'scheduled job: document expiry',
          action: 'document.expired',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          previousValue: { state: 'verified' },
          newValue: { state: 'expired' },
        },
        client
      );
    }

    return due.rowCount ?? 0;
  });

  return { expired: result };
}

/**
 * Remove everything filed against an application (used when a draft is
 * abandoned).
 *
 * The document rows cascade away with the application. The files would not:
 * they would sit in SharePoint as an applicant's identity papers with nothing
 * in this system saying whose they are or why they are held. So the
 * application's folder goes too, and the record that it was created with it —
 * otherwise ensureFolderPath would later believe a folder exists that does
 * not.
 */
export async function discardApplicationFiles(
  reference: string,
  config?: GraphConfig
): Promise<void> {
  const folder = applicationFolderPath(reference);
  await deleteItemByPath(folder, config);
  await query(
    `delete from sharepoint_folder
      where path = $1 or starts_with(path, $1 || '/')`,
    [folder]
  );
}
