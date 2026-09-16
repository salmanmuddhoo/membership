// The reports (S-905, S-906, S-907).
//
// One shape for all of them, so the page renders any report without knowing
// which, and adding one is a definition rather than a screen.
//
// Two rules hold across every report here.
//
// A report names an EXISTING data permission rather than one of its own.
// Reporting is a second way to read data that is already governed, and giving
// reports their own permissions would create a parallel scheme that drifts
// from the first — the day somebody forgot to bar a role twice is the day a
// report became the way round it.
//
// A report reads. Nothing here writes, and nothing takes a value the caller
// supplies into SQL except as a bound parameter.
import { query } from '../db/pool';

export type FilterKind = 'date' | 'text' | 'choice';

export interface ReportFilter {
  name: string;
  label: string;
  kind: FilterKind;
  // For 'choice'. Resolved when the page loads, so a list of membership types
  // is whatever the Society currently configures.
  choices?: () => Promise<{ value: string; label: string }[]>;
}

export type FilterValues = Record<string, string | undefined>;

export interface ReportColumn {
  key: string;
  label: string;
  // Right-aligned and summed in the footer. Money and counts.
  numeric?: boolean;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  // Shown above the table: the answer in one line, where there is one.
  summary?: string;
}

export interface ReportDefinition {
  code: string;
  title: string;
  category: 'Membership' | 'Money' | 'Operations';
  // What question it answers. One line, in the officer's words.
  summary: string;
  permission: string;
  filters: ReportFilter[];
  run(filters: FilterValues): Promise<ReportResult>;
}

// A date filter left empty means "no bound", which is what every report here
// wants: an officer who has not chosen a period is asking about all of it.
function dateOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function textOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

const membershipTypeChoices = async () => {
  const result = await query<{ code: string; name: string }>(
    'select code, name from membership_type order by sort_order, name'
  );
  return result.rows.map(r => ({ value: r.code, label: r.name }));
};

const accountTypeChoices = async () => {
  const result = await query<{ code: string; name: string }>(
    'select code, name from account_type order by sort_order, name'
  );
  return result.rows.map(r => ({ value: r.code, label: r.name }));
};

// The component codes are configuration (S-207) but their wording is the
// Society's own, and the same table the fee screen uses.
const COMPONENT_LABELS: Record<string, string> = {
  entrance: 'Entrance Fee',
  takaful: 'Takaful Contribution',
  shares: 'Shares',
  msa_deposit: 'Deposit into the default account',
  processing: 'Processing Fee',
};

const PERIOD: ReportFilter[] = [
  { name: 'from', label: 'From', kind: 'date' },
  { name: 'to', label: 'To', kind: 'date' },
];

// ---------------------------------------------------------------------------
// S-905 · Membership, documents and accounts
// ---------------------------------------------------------------------------

const members: ReportDefinition = {
  code: 'members',
  title: 'Members',
  category: 'Membership',
  summary: 'Who is a member, of what type, and since when.',
  permission: 'member.view',
  filters: [
    ...PERIOD,
    {
      name: 'type',
      label: 'Membership type',
      kind: 'choice',
      choices: membershipTypeChoices,
    },
    { name: 'status', label: 'Status', kind: 'text' },
  ],
  async run(filters) {
    const result = await query<Record<string, string>>(
      `select m.member_no        as "Member no",
              t.name             as "Type",
              m.status           as "Status",
              to_char(m.joined_at, 'DD Mon YYYY') as "Joined",
              coalesce(m.legacy_code, '')         as "Legacy code",
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as "Name"
         from member m
         join membership_type t on t.id = m.membership_type_id
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
        where ($1::date is null or m.joined_at >= $1::date)
          and ($2::date is null or m.joined_at < $2::date + 1)
          and ($3::text is null or t.code = $3::text)
          and ($4::text is null or m.status = $4::text)
        order by m.member_no`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.type),
        textOrNull(filters.status),
      ]
    );

    return {
      columns: [
        { key: 'Member no', label: 'Member no' },
        { key: 'Name', label: 'Name' },
        { key: 'Type', label: 'Type' },
        { key: 'Status', label: 'Status' },
        { key: 'Joined', label: 'Joined' },
        { key: 'Legacy code', label: 'Legacy code' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} member(s).`,
    };
  },
};

const applications: ReportDefinition = {
  code: 'applications',
  title: 'Applications',
  category: 'Membership',
  summary: 'Every application and where it has got to.',
  permission: 'application.view',
  filters: [...PERIOD, { name: 'status', label: 'Status', kind: 'text' }],
  async run(filters) {
    const result = await query<Record<string, string>>(
      `select a.reference   as "Reference",
              a.application_kind as "Kind",
              coalesce(t.name, '') as "Type",
              a.status      as "Status",
              to_char(a.created_at, 'DD Mon YYYY') as "Started",
              coalesce(to_char(a.submitted_at, 'DD Mon YYYY'), '') as "Submitted",
              coalesce(to_char(a.decided_at, 'DD Mon YYYY'), '')   as "Decided",
              u.display_name as "Captured by"
         from membership_application a
         left join membership_type t on t.id = a.membership_type_id
         join app_user u on u.id = a.captured_by
        where ($1::date is null or a.created_at >= $1::date)
          and ($2::date is null or a.created_at < $2::date + 1)
          and ($3::text is null or a.status = $3::text)
        order by a.created_at desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.status),
      ]
    );

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Type', label: 'Type' },
        { key: 'Status', label: 'Status' },
        { key: 'Started', label: 'Started' },
        { key: 'Submitted', label: 'Submitted' },
        { key: 'Decided', label: 'Decided' },
        { key: 'Captured by', label: 'Captured by' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} application(s).`,
    };
  },
};

const accounts: ReportDefinition = {
  code: 'accounts',
  title: 'Accounts',
  category: 'Membership',
  summary: 'Accounts open, by product and holder.',
  permission: 'member.view',
  filters: [
    ...PERIOD,
    {
      name: 'type',
      label: 'Account type',
      kind: 'choice',
      choices: accountTypeChoices,
    },
  ],
  async run(filters) {
    const result = await query<Record<string, string>>(
      `select coalesce(a.account_no, '') as "Account no",
              t.name                     as "Type",
              a.status                   as "Status",
              to_char(a.opened_at, 'DD Mon YYYY') as "Opened",
              coalesce(m.member_no, '')  as "Member no",
              case when a.opened_via_migration then 'Migration' else 'Application' end
                as "Opened by",
              case when a.is_membership_default then 'Yes' else 'No' end
                as "Default"
         from account a
         join account_type t on t.id = a.account_type_id
         left join member m on m.id = a.member_id
        where ($1::date is null or a.opened_at >= $1::date)
          and ($2::date is null or a.opened_at < $2::date + 1)
          and ($3::text is null or t.code = $3::text)
        order by a.opened_at desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.type),
      ]
    );

    return {
      columns: [
        { key: 'Account no', label: 'Account no' },
        { key: 'Type', label: 'Type' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Status', label: 'Status' },
        { key: 'Opened', label: 'Opened' },
        { key: 'Opened by', label: 'Opened by' },
        { key: 'Default', label: 'Default' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} account(s).`,
    };
  },
};

const documentsOutstanding: ReportDefinition = {
  code: 'documents',
  title: 'Documents outstanding and expiring',
  category: 'Membership',
  summary:
    'What is filed but unverified, rejected, or due to expire — the chasing list.',
  permission: 'document.view',
  filters: [
    {
      name: 'expiringBefore',
      label: 'Expiring before',
      kind: 'date',
    },
  ],
  async run(filters) {
    // Only what somebody has to act on. A verified document with no expiry is
    // finished business and would bury the rows that are not.
    const result = await query<Record<string, string>>(
      `select t.name        as "Document",
              d.subject      as "Subject",
              d.state        as "State",
              coalesce(a.reference, '') as "Application",
              coalesce(m.member_no, '') as "Member no",
              coalesce(to_char(d.expires_at, 'DD Mon YYYY'), '') as "Expires",
              coalesce(d.rejection_reason, '') as "Reason"
         from document d
         join document_type t on t.id = d.document_type_id
         left join membership_application a on a.id = d.application_id
         left join member m on m.id = d.member_id
        where (
                d.state in ('under_review', 'rejected', 'expired')
                or (
                  $1::date is not null
                  and d.expires_at is not null
                  and d.expires_at < $1::date + 1
                )
              )
        order by d.expires_at nulls last, t.name`,
      [dateOrNull(filters.expiringBefore)]
    );

    return {
      columns: [
        { key: 'Document', label: 'Document' },
        { key: 'Subject', label: 'Subject' },
        { key: 'State', label: 'State' },
        { key: 'Application', label: 'Application' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Expires', label: 'Expires' },
        { key: 'Reason', label: 'Reason' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} document(s) need attention.`,
    };
  },
};

// ---------------------------------------------------------------------------
// S-906 · Payments and receipts
//
// Dormancy is the third thing this story names, and there is nothing to
// report: dormancy is M8, deferred to Phase 2, so no member has ever been
// marked dormant and no rule decides it. A report over a state the system does
// not have would show an empty table that reads as "nobody is dormant" rather
// than "this is not built yet", which is worse than not offering it.
// ---------------------------------------------------------------------------

const payments: ReportDefinition = {
  code: 'payments',
  title: 'Payments received',
  category: 'Money',
  summary: 'What was taken, by whom, and against which application.',
  permission: 'payment.view',
  filters: [...PERIOD, { name: 'method', label: 'Method', kind: 'text' }],
  async run(filters) {
    const result = await query<Record<string, string | number>>(
      `select coalesce(r.receipt_no, '') as "Receipt",
              to_char(p.received_at, 'DD Mon YYYY') as "Received",
              p.kind      as "Kind",
              p.method    as "Method",
              p.total_amount::float8 as "Amount",
              coalesce(a.reference, '') as "Application",
              u.display_name as "Recorded by",
              case when p.voided_at is null then '' else 'Voided' end as "Voided"
         from payment p
         left join receipt_number r on r.id = p.receipt_number_id
         left join membership_application a on a.id = p.application_id
         join app_user u on u.id = p.recorded_by
        where ($1::date is null or p.received_at >= $1::date)
          and ($2::date is null or p.received_at < $2::date + 1)
          and ($3::text is null or p.method = $3::text)
        order by p.received_at desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.method),
      ]
    );

    // Voided payments are shown but not counted: they are part of the record
    // of what happened, and not part of what the Society took.
    const total = result.rows
      .filter(r => r.Voided === '')
      .reduce((sum, r) => sum + Number(r.Amount ?? 0), 0);

    return {
      columns: [
        { key: 'Receipt', label: 'Receipt' },
        { key: 'Received', label: 'Received' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Method', label: 'Method' },
        { key: 'Application', label: 'Application' },
        { key: 'Recorded by', label: 'Recorded by' },
        { key: 'Voided', label: 'Voided' },
        { key: 'Amount', label: 'Amount', numeric: true },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} payment(s), ` +
        `Rs ${total.toLocaleString('en-MU', { minimumFractionDigits: 2 })} ` +
        'excluding voided.',
    };
  },
};

const feeComponents: ReportDefinition = {
  code: 'fee-components',
  title: 'Income by fee component',
  category: 'Money',
  summary: 'What the money was for — entrance, takaful, shares, processing.',
  permission: 'payment.view',
  filters: PERIOD,
  async run(filters) {
    // Grouped on the code, not joined to fee_component: that table is
    // per fee VERSION (S-207), so joining on code alone would multiply every
    // payment by the number of versions the Society has ever published. The
    // code is the stable thing; the label belongs on screen.
    const result = await query<Record<string, string | number>>(
      `select l.component_code as "code",
              count(*)::int as "Payments",
              sum(l.amount)::float8 as "Amount"
         from payment_line l
         join payment p on p.id = l.payment_id
        where p.voided_at is null
          and ($1::date is null or p.received_at >= $1::date)
          and ($2::date is null or p.received_at < $2::date + 1)
        group by l.component_code
        order by l.component_code`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    const rows = result.rows.map(r => ({
      Component: COMPONENT_LABELS[String(r.code)] ?? String(r.code),
      Payments: r.Payments,
      Amount: r.Amount,
    }));

    const total = rows.reduce((s, r) => s + Number(r.Amount ?? 0), 0);

    return {
      columns: [
        { key: 'Component', label: 'Component' },
        { key: 'Payments', label: 'Payments', numeric: true },
        { key: 'Amount', label: 'Amount', numeric: true },
      ],
      rows,
      summary: `Rs ${total.toLocaleString('en-MU', { minimumFractionDigits: 2 })} in total.`,
    };
  },
};

const receipts: ReportDefinition = {
  code: 'receipts',
  title: 'Receipts issued',
  category: 'Money',
  summary:
    'Every number allocated and what became of it. Gaps and duplicates are ' +
    'audited on the reconciliation page.',
  permission: 'payment.view',
  filters: PERIOD,
  async run(filters) {
    const result = await query<Record<string, string | number>>(
      `select r.receipt_no as "Receipt",
              r.serial_no::int as "Serial",
              r.state     as "State",
              to_char(r.allocated_at, 'DD Mon YYYY HH24:MI') as "Allocated",
              coalesce(u.display_name, '') as "Allocated by",
              coalesce(r.reason, '') as "Reason"
         from receipt_number r
         left join app_user u on u.id = r.allocated_by
        where ($1::date is null or r.allocated_at >= $1::date)
          and ($2::date is null or r.allocated_at < $2::date + 1)
        order by r.serial_no`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    return {
      columns: [
        { key: 'Receipt', label: 'Receipt' },
        { key: 'Serial', label: 'Serial', numeric: true },
        { key: 'State', label: 'State' },
        { key: 'Allocated', label: 'Allocated' },
        { key: 'Allocated by', label: 'Allocated by' },
        { key: 'Reason', label: 'Reason' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} receipt number(s).`,
    };
  },
};

// ---------------------------------------------------------------------------
// S-907 · Operations and audit
// ---------------------------------------------------------------------------

const accessAndActions: ReportDefinition = {
  code: 'access-and-actions',
  title: 'Access and actions',
  category: 'Operations',
  summary: 'Who did what, how often — and who was refused.',
  permission: 'audit.view',
  filters: [...PERIOD, { name: 'actor', label: 'Actor', kind: 'text' }],
  async run(filters) {
    // Summarised rather than listed. The audit log page already shows every
    // entry; what a report adds is the shape — who is doing the most, and
    // whether anybody is being refused repeatedly. That is the thing the
    // story means by making the trail useful rather than merely present.
    const result = await query<Record<string, string | number>>(
      `select e.actor_description as "Actor",
              e.action            as "Action",
              count(*)::int       as "Times",
              to_char(min(e.occurred_at), 'DD Mon YYYY') as "First",
              to_char(max(e.occurred_at), 'DD Mon YYYY') as "Last"
         from audit_event e
        where ($1::date is null or e.occurred_at >= $1::date)
          and ($2::date is null or e.occurred_at < $2::date + 1)
          and ($3::text is null
               or strpos(lower(e.actor_description), lower($3::text)) > 0)
        group by e.actor_description, e.action
        order by count(*) desc, e.actor_description`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.actor),
      ]
    );

    const refusals = result.rows
      .filter(
        r =>
          String(r.Action).includes('denied') ||
          String(r.Action).includes('refused') ||
          String(r.Action).includes('rejected')
      )
      .reduce((sum, r) => sum + Number(r.Times ?? 0), 0);

    return {
      columns: [
        { key: 'Actor', label: 'Actor' },
        { key: 'Action', label: 'Action' },
        { key: 'Times', label: 'Times', numeric: true },
        { key: 'First', label: 'First' },
        { key: 'Last', label: 'Last' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} actor/action pair(s)` +
        (refusals > 0 ? `, including ${refusals} refusal(s).` : '.'),
    };
  },
};

const jobs: ReportDefinition = {
  code: 'jobs',
  title: 'Scheduled work',
  category: 'Operations',
  summary:
    'Whether the jobs actually ran — document expiry, notification retries, ' +
    'majority transitions.',
  permission: 'audit.view',
  filters: PERIOD,
  async run(filters) {
    const result = await query<Record<string, string | number>>(
      `select j.job_name as "Job",
              j.status    as "Status",
              j.attempt::int as "Attempt",
              j.processed_count::int as "Processed",
              to_char(j.started_at, 'DD Mon YYYY HH24:MI') as "Started",
              coalesce(to_char(j.finished_at, 'DD Mon YYYY HH24:MI'), '')
                as "Finished",
              coalesce(j.error, '') as "Error"
         from job_run j
        where ($1::date is null or j.started_at >= $1::date)
          and ($2::date is null or j.started_at < $2::date + 1)
        order by j.started_at desc
        limit 500`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    // A run still 'running' with an old start is a container that died, which
    // docs/jobs.md notes nothing currently notices. Here it is at least
    // visible to somebody who looks.
    const failed = result.rows.filter(r => r.Status === 'failed').length;

    return {
      columns: [
        { key: 'Job', label: 'Job' },
        { key: 'Status', label: 'Status' },
        { key: 'Started', label: 'Started' },
        { key: 'Finished', label: 'Finished' },
        { key: 'Attempt', label: 'Attempt', numeric: true },
        { key: 'Processed', label: 'Processed', numeric: true },
        { key: 'Error', label: 'Error' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} run(s)` +
        (failed > 0 ? `, ${failed} failed.` : '.'),
    };
  },
};

export const REPORTS: ReportDefinition[] = [
  members,
  applications,
  accounts,
  documentsOutstanding,
  payments,
  feeComponents,
  receipts,
  accessAndActions,
  jobs,
];

export function reportByCode(code: string): ReportDefinition | undefined {
  return REPORTS.find(r => r.code === code);
}

// The reports this person may actually read. Each names an existing data
// permission, so this is the same answer the rest of the system would give.
export function reportsFor(
  permissions: ReadonlySet<string>
): ReportDefinition[] {
  return REPORTS.filter(r => permissions.has(r.permission));
}
