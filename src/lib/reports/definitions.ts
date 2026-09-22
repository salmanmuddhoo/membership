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
import { dormancyMonths, nearFloorMargin } from '../config/reference';
import { LAST_ACTIVITY_SQL } from '../members/dormancy';
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

const paymentMethodChoices = async () => {
  const result = await query<{ code: string; name: string }>(
    'select code, name from payment_method where is_active order by sort_order, name'
  );
  return result.rows.map(r => ({ value: r.code, label: r.name }));
};

// A transaction's kind as the officer says it. A transfer is one thing
// with two legs (S-1504); the reports show its debit leg and call it a
// transfer.
const KIND_WORDS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  reversal: 'Reversal',
  closure: 'Account closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
};
const kindChoices = async () =>
  Object.entries(KIND_WORDS).map(([value, label]) => ({
    value: value === 'transfer_leg' ? 'transfer' : value,
    label,
  }));

// The states an account can be in (migration 0077).
const ACCOUNT_STATUSES = [
  'pending',
  'active',
  'inactive',
  'dormant',
  'frozen',
  'closing',
  'closed',
] as const;
const accountStatusChoices = async () =>
  ACCOUNT_STATUSES.map(value => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  }));

// A money bound typed into a filter, or nothing: anything that is not an
// amount reads as no bound rather than as a refusal.
function amountOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/,/g, '');
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? trimmed : null;
}

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

// S-1806: the balance and status filters, and the balance itself, so the
// same report answers "which accounts hold over Rs 100,000" and "which are
// closing" without a second definition.
const accounts: ReportDefinition = {
  code: 'accounts',
  title: 'Accounts',
  category: 'Membership',
  summary: 'Accounts open, by product, holder, status and balance.',
  permission: 'member.view',
  filters: [
    ...PERIOD,
    {
      name: 'type',
      label: 'Account type',
      kind: 'choice',
      choices: accountTypeChoices,
    },
    {
      name: 'status',
      label: 'Status',
      kind: 'choice',
      choices: accountStatusChoices,
    },
    { name: 'balanceFrom', label: 'Balance from', kind: 'text' },
    { name: 'balanceTo', label: 'Balance to', kind: 'text' },
  ],
  async run(filters) {
    const result = await query<Record<string, string>>(
      `select coalesce(a.account_no, m.member_no, '') as "Account no",
              t.name                     as "Type",
              a.status                   as "Status",
              coalesce(b.balance, 0)::text as "Balance",
              to_char(a.opened_at, 'DD Mon YYYY') as "Opened",
              coalesce(m.member_no, '')  as "Member no",
              case when a.opened_via_migration then 'Migration' else 'Application' end
                as "Opened by",
              case when a.is_membership_default then 'Yes' else 'No' end
                as "Default"
         from account a
         join account_type t on t.id = a.account_type_id
         left join member m on m.id = a.member_id
         left join account_balance b on b.account_id = a.id
        where ($1::date is null or a.opened_at >= $1::date)
          and ($2::date is null or a.opened_at < $2::date + 1)
          and ($3::text is null or t.code = $3::text)
          and ($4::text is null or a.status = $4::text)
          and ($5::numeric is null or coalesce(b.balance, 0) >= $5::numeric)
          and ($6::numeric is null or coalesce(b.balance, 0) <= $6::numeric)
        order by a.opened_at desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.type),
        textOrNull(filters.status),
        amountOrNull(filters.balanceFrom),
        amountOrNull(filters.balanceTo),
      ]
    );

    const total = result.rows.reduce(
      (sum, row) => sum + Number(row.Balance ?? 0),
      0
    );
    return {
      columns: [
        { key: 'Account no', label: 'Account no' },
        { key: 'Type', label: 'Type' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Status', label: 'Status' },
        { key: 'Balance', label: 'Balance', numeric: true },
        { key: 'Opened', label: 'Opened' },
        { key: 'Opened by', label: 'Opened by' },
        { key: 'Default', label: 'Default' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} account(s), Rs ${total.toFixed(2)} held.`,
    };
  },
};

// S-1806 · Accounts at or near their floor: the holders the near-floor
// advisory (S-1803) writes to, as a list — with the margin as a filter so a
// manager can widen it without changing the setting members are told at.
const accountsNearFloor: ReportDefinition = {
  code: 'accounts-near-floor',
  title: 'Accounts near their minimum',
  category: 'Money',
  summary:
    'Open accounts standing at, below or within a margin of the minimum ' +
    'balance their type sets.',
  permission: 'account.view',
  filters: [
    {
      name: 'type',
      label: 'Account type',
      kind: 'choice',
      choices: accountTypeChoices,
    },
    { name: 'margin', label: 'Within (Rs)', kind: 'text' },
  ],
  async run(filters) {
    // The setting the advisory uses is the default margin; a figure typed
    // here is for this run only.
    const margin = amountOrNull(filters.margin) ?? (await nearFloorMargin());
    const result = await query<Record<string, string | number>>(
      `select coalesce(a.account_no, m.member_no, '') as "Account no",
              t.name as "Type",
              coalesce(m.member_no, '') as "Member no",
              trim(coalesce(p.values->>'name', '') || ' '
                   || coalesce(p.values->>'surname', '')) as "Holder",
              a.status as "Status",
              coalesce(b.balance, 0)::text as "Balance",
              t.minimum_balance::text as "Minimum",
              (coalesce(b.balance, 0) - t.minimum_balance)::text as "Headroom",
              case when coalesce(b.balance, 0) <= t.minimum_balance
                   then 'Yes' else 'No' end as "At minimum"
         from account a
         join account_type t on t.id = a.account_type_id
         left join account_balance b on b.account_id = a.id
         left join member m on m.id = a.member_id
         left join customer c on c.id = a.customer_id
         left join application_party p
           on p.application_id = coalesce(m.application_id, c.application_id)
          and p.subject = 'applicant' and p.ordinal = 1
        where a.status not in ('closed', 'pending')
          and coalesce(b.balance, 0) - t.minimum_balance <= $1::numeric
          and ($2::text is null or t.code = $2::text)
        order by coalesce(b.balance, 0) - t.minimum_balance, a.account_no`,
      [margin, textOrNull(filters.type)]
    );
    const atFloor = result.rows.filter(r => r['At minimum'] === 'Yes').length;
    return {
      columns: [
        { key: 'Account no', label: 'Account no' },
        { key: 'Type', label: 'Type' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Holder', label: 'Holder' },
        { key: 'Status', label: 'Status' },
        { key: 'Balance', label: 'Balance', numeric: true },
        { key: 'Minimum', label: 'Minimum', numeric: true },
        { key: 'Headroom', label: 'Headroom', numeric: true },
        { key: 'At minimum', label: 'At minimum' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} account(s) within Rs ${Number(margin).toFixed(2)} ` +
        `of their minimum, ${atFloor} at or below it.`,
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

// S-806 · Dormancy (and the dormancy report S-906 named): who is dormant,
// and who is approaching it — active members whose last activity, by the
// same expression the nightly job uses, is within a chosen number of
// months of the threshold. "Last activity" is a posted entry or a fee
// payment on any of the member's accounts, or the day they joined.
const DORMANCY_VIEWS = [
  { value: 'approaching', label: 'Approaching dormancy' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'active', label: 'All active, by last activity' },
] as const;
const dormancyViewChoices = async () => [...DORMANCY_VIEWS];

// A whole number of months typed into a filter, or the default.
function monthsOr(value: string | undefined, fallback: number): number {
  const trimmed = (value ?? '').trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : fallback;
}

const dormancy: ReportDefinition = {
  code: 'dormancy',
  title: 'Dormancy',
  category: 'Membership',
  summary:
    'Who is dormant, and who is close to it: active members by their last ' +
    'activity against the dormancy threshold.',
  permission: 'member.view',
  filters: [
    {
      name: 'view',
      label: 'Show',
      kind: 'choice',
      choices: dormancyViewChoices,
    },
    { name: 'within', label: 'Within (months)', kind: 'text' },
    {
      name: 'type',
      label: 'Membership type',
      kind: 'choice',
      choices: membershipTypeChoices,
    },
  ],
  async run(filters) {
    const threshold = await dormancyMonths();
    const view = textOrNull(filters.view) ?? 'approaching';
    const within = monthsOr(filters.within, 3);
    const result = await query<Record<string, string | number | null>>(
      `with activity as (
         select m.id, m.member_no, m.status, m.status_changed_at,
                t.name as type_name, t.code as type_code,
                trim(coalesce(p.values->>'name', '') || ' ' ||
                     coalesce(p.values->>'surname', '')) as holder,
                ${LAST_ACTIVITY_SQL} as last_activity
           from member m
           join membership_type t on t.id = m.membership_type_id
           left join application_party p
             on p.application_id = m.application_id
            and p.subject = 'applicant' and p.ordinal = 1
          where m.status in ('active', 'dormant')
       )
       select member_no as "Member no", holder as "Name", type_name as "Type",
              status as "Status",
              to_char(last_activity, 'DD Mon YYYY') as "Last activity",
              (extract(year from age(now(), last_activity)) * 12
               + extract(month from age(now(), last_activity)))::int
                as "Months since",
              case when status = 'dormant'
                   then to_char(status_changed_at, 'DD Mon YYYY')
                   else to_char(last_activity
                                + make_interval(months => $1::int),
                                'DD Mon YYYY') end
                as "Dormant on"
         from activity
        where ($2::text is null or type_code = $2::text)
          and case $3::text
                when 'dormant' then status = 'dormant'
                when 'active' then status = 'active'
                else status = 'active'
                     and $1::int > 0
                     and last_activity + make_interval(months => $1::int)
                         <= now() + make_interval(months => $4::int)
              end
        order by last_activity, member_no`,
      [threshold, textOrNull(filters.type), view, within]
    );

    const label =
      view === 'dormant'
        ? 'dormant member(s)'
        : view === 'active'
          ? 'active member(s)'
          : `active member(s) within ${within} month(s) of dormancy`;
    return {
      columns: [
        { key: 'Member no', label: 'Member no' },
        { key: 'Name', label: 'Name' },
        { key: 'Type', label: 'Type' },
        { key: 'Status', label: 'Status' },
        { key: 'Last activity', label: 'Last activity' },
        { key: 'Months since', label: 'Months since', numeric: true },
        { key: 'Dormant on', label: 'Dormant on' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} ${label}` +
        (threshold > 0
          ? `; dormant after ${threshold} month(s) without activity.`
          : '; dormancy detection is off.'),
    };
  },
};

// ---------------------------------------------------------------------------
// S-906 · Payments and receipts
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
    // S-1603: a payment's receipt and a transaction's side by side, with what
    // each was for, how much, by what method and whose hand — and the void
    // reason where there is one.
    const result = await query<Record<string, string | number>>(
      `select r.receipt_no as "Receipt",
              r.serial_no::int as "Serial",
              r.state     as "State",
              case when p.id is not null then p.kind
                   when t.id is not null then replace(t.kind, '_leg', '')
                   else '' end as "Kind",
              coalesce(a.reference, t.reference, '') as "Reference",
              coalesce(pm.name, tm.name, '') as "Method",
              coalesce(p.total_amount, t.amount)::text as "Amount",
              to_char(r.allocated_at, 'DD Mon YYYY HH24:MI') as "Allocated",
              coalesce(u.display_name, '') as "Allocated by",
              coalesce(r.reason, '') as "Reason"
         from receipt_number r
         left join app_user u on u.id = r.allocated_by
         left join payment p on p.receipt_number_id = r.id
         left join membership_application a on a.id = p.application_id
         left join payment_method pm on pm.code = p.method
         left join transaction t on t.receipt_number_id = r.id
         left join payment_method tm on tm.code = t.method
        where ($1::date is null or r.allocated_at >= $1::date)
          and ($2::date is null or r.allocated_at < $2::date + 1)
        order by r.serial_no`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    // Totals of what was issued, by method: the figure a cash box, a bank
    // slip or a cheque book is checked against.
    const byMethod = new Map<string, number>();
    let issued = 0;
    for (const row of result.rows) {
      if (row.State !== 'issued') continue;
      issued += 1;
      const method = String(row.Method || '—');
      byMethod.set(
        method,
        (byMethod.get(method) ?? 0) + Number(row.Amount ?? 0)
      );
    }
    const totals = [...byMethod.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, amount]) => `${method} ${amount.toFixed(2)}`)
      .join(', ');

    return {
      columns: [
        { key: 'Receipt', label: 'Receipt' },
        { key: 'Serial', label: 'Serial', numeric: true },
        { key: 'State', label: 'State' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Reference', label: 'Reference' },
        { key: 'Method', label: 'Method' },
        { key: 'Amount', label: 'Amount', numeric: true },
        { key: 'Allocated', label: 'Allocated' },
        { key: 'Allocated by', label: 'Allocated by' },
        { key: 'Reason', label: 'Reason' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} receipt number(s), ${issued} issued` +
        (totals ? ` — ${totals}.` : '.'),
    };
  },
};

// S-1806 · Transactions: everything recorded in a period, by kind, method
// and officer. A transfer shows once, as its debit leg; a draft is not a
// transaction yet. The period is the day it was recorded, since a pending
// one has no other date.
const transactions: ReportDefinition = {
  code: 'transactions',
  title: 'Transactions',
  category: 'Money',
  summary:
    'Every deposit, withdrawal, transfer, reversal and exit recorded in a ' +
    'period: by kind, method and officer, with what became of each.',
  permission: 'transaction.view',
  filters: [
    ...PERIOD,
    { name: 'kind', label: 'Kind', kind: 'choice', choices: kindChoices },
    {
      name: 'method',
      label: 'Method',
      kind: 'choice',
      choices: paymentMethodChoices,
    },
    { name: 'officer', label: 'Officer', kind: 'text' },
  ],
  async run(filters) {
    const kind = textOrNull(filters.kind);
    const result = await query<Record<string, string | number>>(
      `select t.reference as "Reference",
              case t.kind when 'deposit' then 'Deposit'
                          when 'withdrawal' then 'Withdrawal'
                          when 'transfer_leg' then 'Transfer'
                          when 'reversal' then 'Reversal'
                          when 'closure' then 'Account closure'
                          when 'resignation' then 'Resignation'
                          else 'Demised claim' end as "Kind",
              coalesce(m.member_no, '') as "Member no",
              trim(coalesce(p.values->>'name', '') || ' '
                   || coalesce(p.values->>'surname', '')) as "Holder",
              coalesce(a.account_no, m.member_no, '') || ' · ' || at.name
                as "Account",
              pm.name as "Method",
              t.amount::text as "Amount",
              t.status as "Status",
              to_char(t.created_at, 'DD Mon YYYY HH24:MI') as "Recorded",
              u.display_name as "Officer",
              to_char(t.posted_at, 'DD Mon YYYY') as "Posted",
              coalesce(rn.receipt_no, '') as "Receipt"
         from transaction t
         join account a on a.id = t.account_id
         join account_type at on at.id = a.account_type_id
         join payment_method pm on pm.code = t.method
         join app_user u on u.id = t.captured_by
         left join member m on m.id = t.member_id
         left join customer c on c.id = t.customer_id
         left join application_party p
           on p.application_id = coalesce(m.application_id, c.application_id)
          and p.subject = 'applicant' and p.ordinal = 1
         left join receipt_number rn on rn.id = t.receipt_number_id
        where t.status <> 'draft'
          and t.leg_direction is distinct from 'credit'
          and ($1::date is null or t.created_at >= $1::date)
          and ($2::date is null or t.created_at < $2::date + 1)
          and ($3::text is null
               or t.kind = $3::text
               or ($3::text = 'transfer' and t.kind = 'transfer_leg'))
          and ($4::text is null or t.method = $4::text)
          and ($5::text is null or u.display_name ilike '%' || $5::text || '%')
        order by t.created_at desc, t.serial_no desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        kind,
        textOrNull(filters.method),
        textOrNull(filters.officer),
      ]
    );

    // What was actually posted, by kind: the figures a period is closed on.
    const byKind = new Map<string, number>();
    for (const row of result.rows) {
      if (row.Status !== 'posted') continue;
      const k = String(row.Kind);
      byKind.set(k, (byKind.get(k) ?? 0) + Number(row.Amount ?? 0));
    }
    const posted = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, amount]) => `${k} Rs ${amount.toFixed(2)}`)
      .join(', ');

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Holder', label: 'Holder' },
        { key: 'Account', label: 'Account' },
        { key: 'Method', label: 'Method' },
        { key: 'Amount', label: 'Amount', numeric: true },
        { key: 'Status', label: 'Status' },
        { key: 'Recorded', label: 'Recorded' },
        { key: 'Officer', label: 'Officer' },
        { key: 'Posted', label: 'Posted' },
        { key: 'Receipt', label: 'Receipt' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} transaction(s)` +
        (posted ? ` — posted: ${posted}.` : '.'),
    };
  },
};

// S-1806 · Approvals: what is waiting on a step and for how long, and how
// long the decided ones took. Age is submission to now for one still on
// its chain, submission to decision for one decided; the step named is
// the one it was left at (positionOf reads the chain as it is now, but a
// report is about the record).
const pendingApprovals: ReportDefinition = {
  code: 'pending-approvals',
  title: 'Approvals',
  category: 'Operations',
  summary:
    'Transactions on an approval chain: which step each waits at and for ' +
    'how many days, and the turnaround of those already decided.',
  permission: 'transaction.view',
  filters: [
    ...PERIOD,
    { name: 'kind', label: 'Kind', kind: 'choice', choices: kindChoices },
  ],
  async run(filters) {
    const kind = textOrNull(filters.kind);
    const result = await query<Record<string, string | number | null>>(
      `select t.reference as "Reference",
              case t.kind when 'deposit' then 'Deposit'
                          when 'withdrawal' then 'Withdrawal'
                          when 'transfer_leg' then 'Transfer'
                          when 'closure' then 'Account closure'
                          when 'resignation' then 'Resignation'
                          else 'Demised claim' end as "Kind",
              coalesce(m.member_no, '') as "Member no",
              trim(coalesce(p.values->>'name', '') || ' '
                   || coalesce(p.values->>'surname', '')) as "Holder",
              t.amount::text as "Amount",
              t.status as "Status",
              case when t.status in ('submitted', 'under_review', 'returned')
                   then coalesce(ws.name || ' · ' || r.name, '')
                   when t.status = 'approved' then 'Payout'
                   else '' end as "Waiting at",
              u.display_name as "Officer",
              to_char(t.submitted_at, 'DD Mon YYYY') as "Submitted",
              to_char(d.occurred_at, 'DD Mon YYYY') as "Decided",
              case when t.submitted_at is null then null
                   else extract(day from
                     coalesce(d.occurred_at, now()) - t.submitted_at)::int
                   end as "Days"
         from transaction t
         join app_user u on u.id = t.captured_by
         left join member m on m.id = t.member_id
         left join customer c on c.id = t.customer_id
         left join application_party p
           on p.application_id = coalesce(m.application_id, c.application_id)
          and p.subject = 'applicant' and p.ordinal = 1
         left join workflow_step ws
           on ws.definition_id = t.workflow_definition_id
          and ws.code = t.current_step_code
         left join role r on r.id = ws.role_id
         left join lateral (
           select tt.occurred_at from transaction_transition tt
            where tt.transaction_id = t.id
              and tt.to_status in ('approved', 'rejected')
            order by tt.id desc limit 1
         ) d on true
        where t.workflow_definition_id is not null
          and t.status <> 'draft'
          and t.leg_direction is distinct from 'credit'
          and ($1::date is null or t.submitted_at >= $1::date)
          and ($2::date is null or t.submitted_at < $2::date + 1)
          and ($3::text is null
               or t.kind = $3::text
               or ($3::text = 'transfer' and t.kind = 'transfer_leg'))
        order by (t.status in ('submitted', 'under_review', 'returned')) desc,
                 t.submitted_at asc nulls last`,
      [dateOrNull(filters.from), dateOrNull(filters.to), kind]
    );

    const pending = result.rows.filter(r =>
      ['submitted', 'under_review', 'returned', 'approved'].includes(
        String(r.Status)
      )
    );
    const decided = result.rows.filter(r => r.Decided !== null);
    const oldest = pending.reduce(
      (max, r) => Math.max(max, Number(r.Days ?? 0)),
      0
    );
    const average =
      decided.length === 0
        ? null
        : decided.reduce((sum, r) => sum + Number(r.Days ?? 0), 0) /
          decided.length;

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Holder', label: 'Holder' },
        { key: 'Amount', label: 'Amount', numeric: true },
        { key: 'Status', label: 'Status' },
        { key: 'Waiting at', label: 'Waiting at' },
        { key: 'Officer', label: 'Officer' },
        { key: 'Submitted', label: 'Submitted' },
        { key: 'Decided', label: 'Decided' },
        { key: 'Days', label: 'Days', numeric: true },
      ],
      rows: result.rows,
      summary:
        `${pending.length} waiting` +
        (pending.length ? ` (oldest ${oldest} day(s))` : '') +
        `; ${decided.length} decided` +
        (average === null
          ? '.'
          : `, ${average.toFixed(1)} day(s) from submission to decision on average.`),
    };
  },
};

// S-2003 · Daily cash reconciliation: every drawer in a period — float,
// cash in, cash out, what it should have held, what was counted and the
// difference — and the cash that moved with no drawer open, by day and by
// whoever moved it, so that nothing that went through the till is missing
// from the day. A closed drawer's expected figure is the one fixed at
// closing (the record); the movements beside it are what the database
// attributes to it now, and the only way the two can disagree is a fee
// receipt voided after the drawer closed, which the row says.
const cashReconciliation: ReportDefinition = {
  code: 'cash-reconciliation',
  title: 'Daily cash reconciliation',
  category: 'Money',
  summary:
    'Every cash drawer in a period with its float, cash in and out, ' +
    'expected, count and over or short, and any cash moved with no drawer ' +
    'open.',
  permission: 'cash.view',
  filters: [...PERIOD, { name: 'cashier', label: 'Cashier', kind: 'text' }],
  async run(filters) {
    const result = await query<Record<string, string | number | null>>(
      `with movement as (
         select t.cash_session_id as session_id, t.posted_by as user_id,
                t.posted_at as at,
                case when fe.payload->>'direction' = 'credit'
                     then t.amount else 0 end as cash_in,
                case when fe.payload->>'direction' = 'credit'
                     then 0 else t.amount end as cash_out
           from transaction t
           join financial_event fe
             on fe.transaction_id = t.id
            and fe.event_type = 'transaction.posted'
           join payment_method pm on pm.code = t.method
          where t.status = 'posted' and pm.is_cash
         union all
         select p.cash_session_id, p.recorded_by, p.received_at,
                case p.kind when 'refund' then 0 else p.total_amount end,
                case p.kind when 'refund' then p.total_amount else 0 end
           from payment p
           join payment_method pm on pm.code = p.method
          where p.voided_at is null and pm.is_cash
       ),
       drawer as (
         select s.opened_at::date as day, u.display_name as cashier,
                s.opened_at, s.closed_at, s.opening_float, s.closing_count,
                s.expected_at_close, s.over_short, s.note,
                coalesce(sum(m.cash_in), 0)::numeric(14, 2) as cash_in,
                coalesce(sum(m.cash_out), 0)::numeric(14, 2) as cash_out,
                count(m.at)::int as movements
           from cash_session s
           join app_user u on u.id = s.cashier_user_id
           left join movement m on m.session_id = s.id
          group by s.id, u.display_name
       ),
       outside as (
         select m.at::date as day, u.display_name as cashier,
                sum(m.cash_in)::numeric(14, 2) as cash_in,
                sum(m.cash_out)::numeric(14, 2) as cash_out,
                count(*)::int as movements
           from movement m
           join app_user u on u.id = m.user_id
          where m.session_id is null
          group by m.at::date, u.display_name
       ),
       row_set as (
         select day, 0 as sort, opened_at, cashier,
                case when closed_at is null then 'Open'
                     when opening_float + cash_in - cash_out
                          <> expected_at_close
                     then 'Closed · receipt voided since'
                     else 'Closed' end as status,
                to_char(opened_at, 'HH24:MI') as opened,
                coalesce(to_char(closed_at, 'HH24:MI'), '') as closed,
                opening_float::text as opening_float, cash_in::text as cash_in,
                cash_out::text as cash_out,
                coalesce(expected_at_close,
                         opening_float + cash_in - cash_out)::text as expected,
                closing_count::text as counted, over_short::text as over_short,
                movements, note
           from drawer
         union all
         select day, 1, null, cashier, 'No drawer', '', '', null,
                cash_in::text, cash_out::text, null, null, null, movements, ''
           from outside
       )
       select to_char(day, 'DD Mon YYYY') as "Day",
              cashier as "Cashier", status as "Status", opened as "Opened",
              closed as "Closed", opening_float as "Float", cash_in as "Cash in",
              cash_out as "Cash out", expected as "Expected",
              counted as "Counted", over_short as "Over/short",
              movements as "Movements", note as "Note"
         from row_set
        where ($1::date is null or day >= $1::date)
          and ($2::date is null or day <= $2::date)
          and ($3::text is null or cashier ilike '%' || $3::text || '%')
        order by day desc, sort, opened_at, cashier`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.cashier),
      ]
    );

    const drawers = result.rows.filter(r => r.Status !== 'No drawer');
    const closed = drawers.filter(r => r.Counted !== null);
    const outside = result.rows.filter(r => r.Status === 'No drawer');
    const sum = (rows: typeof result.rows, key: string) =>
      rows.reduce((total, r) => total + Number(r[key] ?? 0), 0);
    const overShort = sum(closed, 'Over/short');

    return {
      columns: [
        { key: 'Day', label: 'Day' },
        { key: 'Cashier', label: 'Cashier' },
        { key: 'Status', label: 'Status' },
        { key: 'Opened', label: 'Opened' },
        { key: 'Closed', label: 'Closed' },
        { key: 'Float', label: 'Float', numeric: true },
        { key: 'Cash in', label: 'Cash in', numeric: true },
        { key: 'Cash out', label: 'Cash out', numeric: true },
        { key: 'Expected', label: 'Expected', numeric: true },
        { key: 'Counted', label: 'Counted', numeric: true },
        { key: 'Over/short', label: 'Over/short', numeric: true },
        { key: 'Movements', label: 'Movements', numeric: true },
        { key: 'Note', label: 'Note' },
      ],
      rows: result.rows,
      summary:
        `${drawers.length} drawer(s): ${closed.length} closed, ` +
        `${drawers.length - closed.length} open; cash in Rs ` +
        `${sum(drawers, 'Cash in').toFixed(2)}, out Rs ` +
        `${sum(drawers, 'Cash out').toFixed(2)}` +
        (closed.length
          ? `; counted Rs ${sum(closed, 'Counted').toFixed(2)} against Rs ` +
            `${sum(closed, 'Expected').toFixed(2)} expected, ` +
            (overShort === 0
              ? 'no difference'
              : overShort > 0
                ? `over by Rs ${overShort.toFixed(2)}`
                : `short by Rs ${(-overShort).toFixed(2)}`)
          : '') +
        (outside.length
          ? `. ${sum(outside, 'Movements')} cash movement(s) with no drawer ` +
            `open: Rs ${sum(outside, 'Cash in').toFixed(2)} in, Rs ` +
            `${sum(outside, 'Cash out').toFixed(2)} out.`
          : '.'),
    };
  },
};

// S-1706 · Exits: closures, resignations and demised claims by period, with
// what each paid out and how long it took. Turnaround is submission to
// payout — the whole of what the member or claimant waited for — and, for
// one not paid out, submission to decision or to today.
const exits: ReportDefinition = {
  code: 'exits',
  title: 'Exits',
  category: 'Money',
  summary:
    'Account closures, resignations and demised claims: what was paid out, ' +
    'to whom, and how long each took from submission to payout.',
  permission: 'transaction.view',
  filters: [
    ...PERIOD,
    {
      name: 'kind',
      label: 'Kind',
      kind: 'choice',
      choices: async () => [
        { value: 'closure', label: 'Account closure' },
        { value: 'resignation', label: 'Resignation' },
        { value: 'demise', label: 'Demised claim' },
      ],
    },
  ],
  async run(filters) {
    const result = await query<Record<string, string | number>>(
      `select t.reference as "Reference",
              case t.kind when 'closure' then 'Account closure'
                          when 'resignation' then 'Resignation'
                          else 'Demised claim' end as "Kind",
              coalesce(m.member_no, '') as "Member no",
              trim(coalesce(p.values->>'name', '') || ' '
                   || coalesce(p.values->>'surname', '')) as "Member",
              case t.kind when 'closure'
                   then coalesce(a.account_no, m.member_no) || ' · ' || at.name
                   else 'All' end as "Accounts",
              coalesce(t.payee_name, '') as "Paid to",
              t.amount::text as "Amount",
              t.takaful_benefit::text as "Takaful benefit",
              t.status as "Status",
              to_char(t.submitted_at, 'DD Mon YYYY') as "Submitted",
              to_char(d.occurred_at, 'DD Mon YYYY') as "Decided",
              to_char(t.posted_at, 'DD Mon YYYY') as "Paid out",
              case when t.submitted_at is null then null
                   else extract(day from
                     coalesce(t.posted_at, d.occurred_at, now()) - t.submitted_at)::int
                   end as "Days",
              coalesce(rn.receipt_no, '') as "Receipt"
         from transaction t
         join account a on a.id = t.account_id
         join account_type at on at.id = a.account_type_id
         left join member m on m.id = t.member_id
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
         left join receipt_number rn on rn.id = t.receipt_number_id
         left join lateral (
           select tt.occurred_at from transaction_transition tt
            where tt.transaction_id = t.id
              and tt.to_status in ('approved', 'rejected')
            order by tt.id desc limit 1
         ) d on true
        where t.kind in ('closure', 'resignation', 'demise')
          and t.status <> 'draft'
          and ($1::date is null or t.submitted_at >= $1::date)
          and ($2::date is null or t.submitted_at < $2::date + 1)
          and ($3::text is null or t.kind = $3::text)
        order by t.submitted_at desc nulls last, t.serial_no desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.kind),
      ]
    );

    const byKind = new Map<string, { n: number; paid: number }>();
    for (const row of result.rows) {
      const kind = String(row.Kind);
      const entry = byKind.get(kind) ?? { n: 0, paid: 0 };
      entry.n += 1;
      if (row.Status === 'posted') entry.paid += Number(row.Amount ?? 0);
      byKind.set(kind, entry);
    }
    const parts = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([kind, e]) =>
          `${e.n} ${kind.toLowerCase()}(s), Rs ${e.paid.toFixed(2)} paid out`
      )
      .join('; ');

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Member', label: 'Member' },
        { key: 'Accounts', label: 'Accounts' },
        { key: 'Paid to', label: 'Paid to' },
        { key: 'Amount', label: 'Amount', numeric: true },
        { key: 'Takaful benefit', label: 'Takaful benefit', numeric: true },
        { key: 'Status', label: 'Status' },
        { key: 'Submitted', label: 'Submitted' },
        { key: 'Decided', label: 'Decided' },
        { key: 'Paid out', label: 'Paid out' },
        { key: 'Days', label: 'Days', numeric: true },
        { key: 'Receipt', label: 'Receipt' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} exit(s)` + (parts ? ` — ${parts}.` : '.'),
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
  dormancy,
  applications,
  accounts,
  documentsOutstanding,
  payments,
  feeComponents,
  transactions,
  exits,
  receipts,
  accountsNearFloor,
  pendingApprovals,
  cashReconciliation,
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
