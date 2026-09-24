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
import {
  activeChain,
  dormancyMonths,
  listBankAccounts,
  nearFloorMargin,
  type WorkflowStep,
} from '../config/reference';
import { LAST_ACTIVITY_SQL } from '../members/dormancy';
import {
  bankAccountMovements,
  bankAccountPeriods,
} from '../ledger/bank-accounts';
import { query } from '../db/pool';
import { formatMoney } from '../payments/money';
import { APPLICATION_STATUS_LABELS } from '../applications/status-labels';
import {
  returnedByLabelsFor,
  reviewStageLabelsFor,
  WORKFLOW_CODE as APPLICATION_WORKFLOW_CODE,
} from '../applications/workflow';

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
  // Right-aligned, sorted as a number and exported as one. Money and counts.
  numeric?: boolean;
  // Money: shown with thousands separated and two decimals, whatever the
  // column is called (the page otherwise guesses from the label).
  money?: boolean;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  // Parallel to rows: where a row leads when clicked, or null for a row that
  // does not. Only the bank accounts summary sets this today (S-1901 officer
  // feedback) — a way into a row's own detail, not a link to somewhere else.
  // The export ignores it: a spreadsheet has nowhere for a click to go.
  rowHrefs?: (string | null)[];
  // Shown above the table: the answer in one line, where there is one.
  summary?: string;
}

export interface ReportDefinition {
  code: string;
  title: string;
  category: 'Membership' | 'Finance' | 'Operations';
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

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// A 'YYYY-MM-DD' filter value, read the way every other date on a report
// does ("DD Mon YYYY") — for the one date that never goes through SQL's own
// to_char, because it names the filter rather than a row (S-1901 officer
// feedback: the brought-forward row had an amount and no date, so nobody
// could tell which day it was struck on).
function periodStartLabel(from: string | null): string {
  if (!from) return '';
  const [year, month, day] = from.split('-').map(Number);
  return `${String(day).padStart(2, '0')} ${MONTH_ABBREVIATIONS[month - 1]} ${year}`;
}

// A running total (built from Number addition, so it can carry more than two
// decimal places) as it reads everywhere else on screen — MUR 41,700.00,
// never the bare "41700.00" a summary line used to read.
function rs(total: number): string {
  return formatMoney(total.toFixed(2));
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
              initcap(m.status)  as "Status",
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

// The list page's own map, plus 'approved' — an approved application drops
// off that list (it lives on the Members page from then on) but a report
// covering "every application" has no such reason to hide it.
const APPLICATION_REPORT_STATUS_LABELS: Record<string, string> = {
  ...APPLICATION_STATUS_LABELS,
  approved: 'Approved',
};

// Officer feedback: the filter offers where an application stands, not the
// raw status. 'new' is with the Regional Manager or with the Secretary, and
// 'submitted_for_approval' is with the President — the same "With the X"
// the report's own column says — so a stage is offered per enabled step of
// the configured chain (`with:<step code>`) in place of those statuses.
// The statuses that stand on their own (draft, received, returned, and the
// decided ones) are offered as themselves.
const WITH_PREFIX = 'with:';
const STANDALONE_STATUSES = [
  'draft',
  'received',
  'returned',
  'abeyance',
  'approved',
  'rejected',
];
async function applicationStageSteps(): Promise<WorkflowStep[]> {
  return (await activeChain(APPLICATION_WORKFLOW_CODE)).filter(
    s => s.code !== 'capture'
  );
}
const applicationStatusChoices = async () => {
  const steps = await applicationStageSteps();
  return [
    ...STANDALONE_STATUSES.filter(
      code => code === 'draft' || code === 'received'
    ).map(code => ({
      value: code,
      label: APPLICATION_REPORT_STATUS_LABELS[code],
    })),
    ...steps.map(step => ({
      value: `${WITH_PREFIX}${step.code}`,
      label: `With the ${step.roleName}`,
    })),
    ...STANDALONE_STATUSES.filter(
      code => code !== 'draft' && code !== 'received'
    ).map(code => ({
      value: code,
      label: APPLICATION_REPORT_STATUS_LABELS[code],
    })),
  ];
};

const applications: ReportDefinition = {
  code: 'applications',
  title: 'Applications',
  category: 'Membership',
  summary: 'Every application, who it is for, and where it has got to.',
  permission: 'application.view',
  filters: [
    ...PERIOD,
    {
      name: 'status',
      label: 'Status',
      kind: 'choice',
      choices: applicationStatusChoices,
    },
  ],
  async run(filters) {
    // A stage narrows the SQL to the status that stage sits on, then the
    // rows to the ones the chain says are actually with that role.
    const chosen = textOrNull(filters.status);
    const stage = chosen?.startsWith(WITH_PREFIX)
      ? ((await applicationStageSteps()).find(
          s => s.code === chosen.slice(WITH_PREFIX.length)
        ) ?? null)
      : null;
    const status = stage ? stage.fromStatus : chosen;
    const result = await query<Record<string, string>>(
      `select a.id           as "Id",
              a.reference    as "Reference",
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as "Applicant",
              case a.application_kind
                when 'membership' then 'Membership'
                when 'additional_account' then 'Additional account'
                when 'customer_account' then 'Customer account'
                else initcap(replace(a.application_kind, '_', ' ')) end
                as "Kind",
              coalesce(t.name, '') as "Type",
              a.status       as "StatusCode",
              to_char(a.created_at, 'DD Mon YYYY') as "Started",
              coalesce(to_char(a.submitted_at, 'DD Mon YYYY'), '') as "Submitted",
              coalesce(to_char(a.decided_at, 'DD Mon YYYY'), '')   as "Decided",
              u.display_name as "Captured by"
         from membership_application a
         left join membership_type t on t.id = a.membership_type_id
         left join application_party p
           on p.application_id = a.id
          and p.subject = 'applicant' and p.ordinal = 1
         join app_user u on u.id = a.captured_by
        where ($1::date is null or a.created_at >= $1::date)
          and ($2::date is null or a.created_at < $2::date + 1)
          and ($3::text is null or a.status = $3::text)
        order by a.created_at desc`,
      [dateOrNull(filters.from), dateOrNull(filters.to), status]
    );

    // "Where it has got to" (S-611 follow-up) — the same batched reads the
    // Applications list page uses, run here on the report's own rows rather
    // than duplicating the chain-walking logic.
    const withLabels = await reviewStageLabelsFor(
      result.rows.map(r => ({ id: r.Id, status: r.StatusCode }))
    );
    const returnedLabels = await returnedByLabelsFor(
      result.rows.filter(r => r.StatusCode === 'returned').map(r => r.Id)
    );

    const rows = result.rows
      .map(({ Id, StatusCode, ...rest }) => ({
        ...rest,
        Status: APPLICATION_REPORT_STATUS_LABELS[StatusCode] ?? StatusCode,
        With: withLabels.get(Id) ?? returnedLabels.get(Id) ?? '',
      }))
      .filter(row => !stage || row.With === `With the ${stage.roleName}`);

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Applicant', label: 'Applicant' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Type', label: 'Type' },
        { key: 'Status', label: 'Status' },
        { key: 'With', label: 'With' },
        { key: 'Started', label: 'Started' },
        { key: 'Submitted', label: 'Submitted' },
        { key: 'Decided', label: 'Decided' },
        { key: 'Captured by', label: 'Captured by' },
      ],
      rows,
      summary: `${rows.length} application(s).`,
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
              initcap(a.status)          as "Status",
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
      summary: `${result.rows.length} account(s), ${rs(total)} held.`,
    };
  },
};

// S-1806 · Accounts at or near their floor: the holders the near-floor
// advisory (S-1803) writes to, as a list — with the margin as a filter so a
// manager can widen it without changing the setting members are told at.
const accountsNearFloor: ReportDefinition = {
  code: 'accounts-near-floor',
  title: 'Accounts near their minimum',
  category: 'Finance',
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
              initcap(a.status) as "Status",
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
        `${result.rows.length} account(s) within ${rs(Number(margin))} ` +
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
              case d.state when 'under_review' then 'Under review'
                           when 'rejected' then 'Rejected'
                           when 'expired' then 'Expired'
                           when 'verified' then 'Verified'
                           when 'uploaded' then 'Uploaded'
                           else initcap(replace(d.state, '_', ' ')) end
                as "State",
              coalesce(a.reference, '') as "Application",
              -- A closure, resignation or claim files its papers against
              -- the transaction, not an application: named by it and by
              -- its member, so the row can be chased (QA-09).
              coalesce(tx.reference, '') as "Transaction",
              coalesce(m.member_no, tm.member_no, '') as "Member no",
              coalesce(to_char(d.expires_at, 'DD Mon YYYY'), '') as "Expires",
              coalesce(d.rejection_reason, '') as "Reason"
         from document d
         join document_type t on t.id = d.document_type_id
         left join membership_application a on a.id = d.application_id
         left join member m on m.id = d.member_id
         left join transaction tx on tx.id = d.transaction_id
         left join member tm on tm.id = tx.member_id
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
        { key: 'Transaction', label: 'Transaction' },
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
    // Show = All (no choice) is every member the report covers, dormant
    // ones included; it used to fall back to "approaching", so All showed
    // "Nothing matches" beside a dormant member (QA-30).
    const view = textOrNull(filters.view) ?? 'all';
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
              initcap(status) as "Status",
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
                when 'all' then true
                else status = 'active'
                     and $1::int > 0
                     and last_activity + make_interval(months => $1::int)
                         <= now() + make_interval(months => $4::int)
              end
        order by last_activity, member_no`,
      [threshold, textOrNull(filters.type), view, within]
    );

    const label =
      view === 'all'
        ? 'member(s), active and dormant'
        : view === 'dormant'
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
  category: 'Finance',
  summary: 'What was taken, by whom, and against which application.',
  permission: 'payment.view',
  filters: [...PERIOD, { name: 'method', label: 'Method', kind: 'text' }],
  async run(filters) {
    const result = await query<Record<string, string | number>>(
      `select coalesce(r.receipt_no, '') as "Receipt",
              to_char(p.received_at, 'DD Mon YYYY') as "Received",
              initcap(p.kind) as "Kind",
              pm.name     as "Method",
              p.total_amount::float8 as "Amount",
              coalesce(a.reference, '') as "Application",
              u.display_name as "Recorded by",
              case when p.voided_at is null then '' else 'Voided' end as "Voided"
         from payment p
         left join receipt_number r on r.id = p.receipt_number_id
         left join membership_application a on a.id = p.application_id
         join payment_method pm on pm.code = p.method
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
      summary: `${result.rows.length} payment(s), ${rs(total)} excluding voided.`,
    };
  },
};

const feeComponents: ReportDefinition = {
  code: 'fee-components',
  title: 'Income by fee component',
  category: 'Finance',
  summary: 'What the money was for — entrance, takaful, shares, processing.',
  permission: 'payment.view',
  filters: PERIOD,
  async run(filters) {
    // Grouped on the code, not joined to fee_component: that table is
    // per fee VERSION (S-207), so joining on code alone would multiply every
    // payment by the number of versions the Society has ever published. The
    // code is the stable thing; the label belongs on screen.
    const result = await query<Record<string, string | number>>(
      //
      // A payment's account lines too — the opening deposit of an account
      // opened on an application (an HSA, say), under its account type's
      // name. Without them this report came to less than Payments received
      // for the same period by exactly those amounts (QA-08).
      `select l.component_code as "code", null::text as "account",
              count(*)::int as "Payments",
              sum(l.amount)::float8 as "Amount"
         from payment_line l
         join payment p on p.id = l.payment_id
        where p.voided_at is null
          and ($1::date is null or p.received_at >= $1::date)
          and ($2::date is null or p.received_at < $2::date + 1)
        group by l.component_code
       union all
       select null, ty.name, count(*)::int, sum(al.amount)::float8
         from payment_account_line al
         join payment p on p.id = al.payment_id
         join account_type ty on ty.id = al.account_type_id
        where p.voided_at is null
          and ($1::date is null or p.received_at >= $1::date)
          and ($2::date is null or p.received_at < $2::date + 1)
        group by ty.name
        order by 1 nulls last, 2`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    const rows = result.rows.map(r => ({
      Component:
        r.account !== null
          ? String(r.account)
          : (COMPONENT_LABELS[String(r.code)] ?? String(r.code)),
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
      summary: `${rs(total)} in total.`,
    };
  },
};

const receipts: ReportDefinition = {
  code: 'receipts',
  title: 'Receipts issued',
  category: 'Finance',
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
              initcap(r.state) as "State",
              initcap(replace(
                case when p.id is not null then p.kind
                     when t.id is not null then replace(t.kind, '_leg', '')
                     else '' end,
                '_', ' ')) as "Kind",
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
         -- Not a new member's opening deposits: they are the fee receipt
         -- under its own number, already the row above (QA-03).
         left join transaction t
           on t.receipt_number_id = r.id
          and t.payment_line_id is null
          and t.payment_account_line_id is null
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
      if (row.State !== 'Issued') continue;
      issued += 1;
      const method = String(row.Method || '—');
      byMethod.set(
        method,
        (byMethod.get(method) ?? 0) + Number(row.Amount ?? 0)
      );
    }
    const totals = [...byMethod.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, amount]) => `${method} ${rs(amount)}`)
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

// Where a transaction stands, for the Status filter: one choice per role
// that sits on a transaction chain (an officer looking for a demised claim
// asks for it "at the Secretary" or "at the President"), plus the states
// off any chain. Resolved when the page loads, same as any other choice
// list, so a chain reconfigured in Workflows is reflected without a code
// change.
const transactionStatusChoices = async () => {
  const result = await query<{ code: string; name: string }>(
    `select distinct r.code, r.name
       from workflow_step ws
       join workflow_definition wd on wd.id = ws.definition_id
       join role r on r.id = ws.role_id
      where wd.entity_type = 'transaction'
      order by r.name`
  );
  return [
    ...result.rows.map(r => ({
      value: `with:${r.code}`,
      label: `With ${r.name}`,
    })),
    { value: 'approved', label: 'To disburse' },
    { value: 'returned', label: 'Returned' },
    { value: 'done', label: 'Disbursed' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'cancelled', label: 'Cancelled' },
  ];
};

// The simpler three-state Status filter the exit-and-movement reports below
// offer (resignations, withdrawals): where a chain's own roles do not
// matter to the question being asked, only whether it is still moving,
// already paid, or refused.
const inProgressOrDoneChoices = async () => [
  { value: 'in_progress', label: 'On its way' },
  { value: 'done', label: 'Disbursed' },
  { value: 'rejected', label: 'Rejected' },
];

// S-1806 · Transactions: everything recorded in a period, by kind, method
// and officer. A transfer shows once, as its debit leg; a draft is not a
// transaction yet. The period is the day it was recorded, since a pending
// one has no other date.
const transactions: ReportDefinition = {
  code: 'transactions',
  title: 'Transactions',
  category: 'Finance',
  summary:
    'Every deposit, withdrawal, transfer, reversal and exit recorded in a ' +
    'period: by kind, method and officer, with what became of each.',
  permission: 'transaction.view',
  filters: [
    ...PERIOD,
    { name: 'kind', label: 'Kind', kind: 'choice', choices: kindChoices },
    {
      name: 'status',
      label: 'Status',
      kind: 'choice',
      choices: transactionStatusChoices,
    },
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
      `select coalesce(tr.reference, t.reference) as "Reference",
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
              -- Money out is paid how the Treasurer says at Disburse;
              -- before that the method on record is only a placeholder.
              case when t.status <> 'posted'
                        and (t.kind in
                               ('withdrawal', 'closure', 'resignation', 'demise')
                             or (t.kind = 'transfer_leg'
                                 and t.payee_name is not null))
                   then '' else pm.name end as "Method",
              t.amount::text as "Amount",
              -- Where it is now, not merely its bare status: on a chain,
              -- who holds it; approved, that it is waiting to be disbursed;
              -- posted reads Disbursed, same as elsewhere on screen
              -- (business decision, every kind).
              case when t.status in ('submitted', 'under_review')
                        then coalesce('With ' || r.name,
                                       initcap(replace(t.status, '_', ' ')))
                   when t.status = 'approved' then 'To disburse'
                   when t.status = 'returned' then 'Returned'
                   when t.status = 'posted' then 'Disbursed'
                   when t.status = 'rejected' then 'Rejected'
                   when t.status = 'cancelled' then 'Cancelled'
                   else initcap(replace(t.status, '_', ' ')) end as "Status",
              to_char(t.created_at, 'DD Mon YYYY HH24:MI') as "Recorded",
              u.display_name as "Officer",
              to_char(t.posted_at, 'DD Mon YYYY') as "Disbursed",
              coalesce(rn.receipt_no, '') as "Receipt"
         from transaction t
         left join transfer tr on tr.id = t.transfer_id
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
         left join workflow_step ws
           on ws.definition_id = t.workflow_definition_id
          and ws.code = t.current_step_code
         left join role r on r.id = ws.role_id
        where t.status <> 'draft'
          and t.leg_direction is distinct from 'credit'
          and ($1::date is null or t.created_at >= $1::date)
          and ($2::date is null or t.created_at < $2::date + 1)
          and ($3::text is null
               or t.kind = $3::text
               or ($3::text = 'transfer' and t.kind = 'transfer_leg'))
          -- Money out not yet paid has only a placeholder method; it is
          -- found under the method the Treasurer pays it by, once paid.
          and ($4::text is null
               or (t.method = $4::text
                   and not (t.status <> 'posted'
                            and (t.kind in ('withdrawal', 'closure',
                                            'resignation', 'demise')
                                 or (t.kind = 'transfer_leg'
                                     and t.payee_name is not null)))))
          and ($5::text is null or u.display_name ilike '%' || $5::text || '%')
          and ($6::text is null
               or (t.status in ('submitted', 'under_review')
                   and $6::text = 'with:' || r.code)
               or (t.status = 'approved' and $6::text = 'approved')
               or (t.status = 'returned' and $6::text = 'returned')
               or (t.status = 'posted' and $6::text = 'done')
               or (t.status = 'rejected' and $6::text = 'rejected')
               or (t.status = 'cancelled' and $6::text = 'cancelled'))
        order by t.created_at desc, t.serial_no desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        kind,
        textOrNull(filters.method),
        textOrNull(filters.officer),
        textOrNull(filters.status),
      ]
    );

    // What was actually disbursed, by kind: the figures a period is closed
    // on.
    const byKind = new Map<string, number>();
    for (const row of result.rows) {
      if (row.Status !== 'Disbursed') continue;
      const k = String(row.Kind);
      byKind.set(k, (byKind.get(k) ?? 0) + Number(row.Amount ?? 0));
    }
    const disbursed = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, amount]) => `${k} ${rs(amount)}`)
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
        { key: 'Disbursed', label: 'Disbursed' },
        { key: 'Receipt', label: 'Receipt' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} transaction(s)` +
        (disbursed ? ` — disbursed: ${disbursed}.` : '.'),
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
      `select coalesce(tr.reference, t.reference) as "Reference",
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
              case when t.status = 'posted' then 'Disbursed'
                   else initcap(replace(t.status, '_', ' ')) end as "Status",
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
         left join transfer tr on tr.id = t.transfer_id
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
      ['Submitted', 'Under review', 'Returned', 'Approved'].includes(
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
  category: 'Finance',
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
            -- A new member's opening deposits are their fee receipt,
            -- counted below as the receipt itself (QA-02, 0096).
            and t.payment_line_id is null
            and t.payment_account_line_id is null
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
        `${drawers.length - closed.length} open; cash in ` +
        `${rs(sum(drawers, 'Cash in'))}, out ` +
        `${rs(sum(drawers, 'Cash out'))}` +
        (closed.length
          ? `; counted ${rs(sum(closed, 'Counted'))} against ` +
            `${rs(sum(closed, 'Expected'))} expected, ` +
            (overShort === 0
              ? 'no difference'
              : overShort > 0
                ? `over by ${rs(overShort)}`
                : `short by ${rs(-overShort)}`)
          : '') +
        (outside.length
          ? `. ${sum(outside, 'Movements')} cash movement(s) with no drawer ` +
            `open: ${rs(sum(outside, 'Cash in'))} in, ` +
            `${rs(sum(outside, 'Cash out'))} out.`
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
  category: 'Finance',
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
              case when t.status = 'posted' then 'Disbursed'
                   else initcap(replace(t.status, '_', ' ')) end as "Status",
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
      if (row.Status === 'Disbursed') entry.paid += Number(row.Amount ?? 0);
      byKind.set(kind, entry);
    }
    const parts = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([kind, e]) => `${e.n} ${kind.toLowerCase()}(s), ${rs(e.paid)} paid out`
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

// Officer request: the movements of membership itself, one report per kind,
// sitting beside Transactions and Exits since that is where the money and
// the paperwork behind each of them already live.

const admissions: ReportDefinition = {
  code: 'admissions',
  title: 'New members',
  category: 'Membership',
  summary:
    'Who was admitted in a period — first time or on a rejoin — the ' +
    'application it came from, and whether they are still a member.',
  permission: 'member.view',
  filters: [
    ...PERIOD,
    {
      name: 'type',
      label: 'Membership type',
      kind: 'choice',
      choices: membershipTypeChoices,
    },
  ],
  async run(filters) {
    // A rejoin (0090) is a second admission on the same member row: the
    // member the report shows is dated by whichever is later, and a
    // period asks about that date, not the founding joined_at underneath
    // it.
    const result = await query<Record<string, string>>(
      `select m.member_no        as "Member no",
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as "Name",
              t.name             as "Type",
              to_char(coalesce(m.rejoined_at, m.joined_at), 'DD Mon YYYY')
                as "Admitted",
              case when m.rejoined_at is not null then 'Yes' else '' end
                as "Rejoin",
              coalesce(ma.reference, '')   as "Application reference",
              initcap(m.status)            as "Status now"
         from member m
         join membership_type t on t.id = m.membership_type_id
         left join membership_application ma on ma.id = m.application_id
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
        where ($1::date is null
               or coalesce(m.rejoined_at, m.joined_at) >= $1::date)
          and ($2::date is null
               or coalesce(m.rejoined_at, m.joined_at) < $2::date + 1)
          and ($3::text is null or t.code = $3::text)
        order by coalesce(m.rejoined_at, m.joined_at) desc`,
      [
        dateOrNull(filters.from),
        dateOrNull(filters.to),
        textOrNull(filters.type),
      ]
    );

    const rejoins = result.rows.filter(r => r.Rejoin === 'Yes').length;
    return {
      columns: [
        { key: 'Member no', label: 'Member no' },
        { key: 'Name', label: 'Name' },
        { key: 'Type', label: 'Type' },
        { key: 'Admitted', label: 'Admitted' },
        { key: 'Rejoin', label: 'Rejoin' },
        { key: 'Application reference', label: 'Application reference' },
        { key: 'Status now', label: 'Status now' },
      ],
      rows: result.rows,
      summary:
        `${result.rows.length} admission(s)` +
        (rejoins > 0 ? `, ${rejoins} rejoin(s).` : '.'),
    };
  },
};

const resignations: ReportDefinition = {
  code: 'resignations',
  title: 'Resignations',
  category: 'Finance',
  summary:
    'Who asked to leave the Society, why, what was paid out, and where ' +
    'the request stands.',
  permission: 'transaction.view',
  filters: [
    ...PERIOD,
    {
      name: 'status',
      label: 'Status',
      kind: 'choice',
      choices: inProgressOrDoneChoices,
    },
  ],
  async run(filters) {
    const status = textOrNull(filters.status);
    const result = await query<Record<string, string | number>>(
      `select t.reference         as "Reference",
              coalesce(m.member_no, '') as "Member no",
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as "Name",
              coalesce(t.reason, '')    as "Reason",
              t.amount::text            as "Amount paid out",
              case when t.status in ('submitted', 'under_review')
                        then coalesce('With ' || r.name,
                                       initcap(replace(t.status, '_', ' ')))
                   when t.status = 'approved' then 'To disburse'
                   when t.status = 'returned' then 'Returned'
                   when t.status = 'posted' then 'Disbursed'
                   when t.status = 'rejected' then 'Rejected'
                   when t.status = 'cancelled' then 'Cancelled'
                   else initcap(replace(t.status, '_', ' ')) end as "Status",
              to_char(t.submitted_at, 'DD Mon YYYY') as "Requested",
              coalesce(to_char(t.posted_at, 'DD Mon YYYY'), '') as "Disbursed"
         from transaction t
         left join member m on m.id = t.member_id
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
         left join workflow_step ws
           on ws.definition_id = t.workflow_definition_id
          and ws.code = t.current_step_code
         left join role r on r.id = ws.role_id
        where t.kind = 'resignation'
          and t.status <> 'draft'
          and ($1::date is null or t.submitted_at >= $1::date)
          and ($2::date is null or t.submitted_at < $2::date + 1)
          and ($3::text is null
               or ($3::text = 'in_progress'
                   and t.status in ('submitted', 'under_review', 'approved',
                                     'returned'))
               or ($3::text = 'done' and t.status = 'posted')
               or ($3::text = 'rejected'
                   and t.status in ('rejected', 'cancelled')))
        order by t.submitted_at desc nulls last, t.serial_no desc`,
      [dateOrNull(filters.from), dateOrNull(filters.to), status]
    );

    const paidOut = result.rows
      .filter(r => r.Status === 'Disbursed')
      .reduce((sum, r) => sum + Number(r['Amount paid out'] ?? 0), 0);

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Name', label: 'Name' },
        { key: 'Reason', label: 'Reason' },
        { key: 'Amount paid out', label: 'Amount paid out', numeric: true },
        { key: 'Status', label: 'Status' },
        { key: 'Requested', label: 'Requested' },
        { key: 'Disbursed', label: 'Disbursed' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} resignation(s), ${rs(paidOut)} paid out.`,
    };
  },
};

const withdrawals: ReportDefinition = {
  code: 'withdrawals',
  title: 'Withdrawals',
  category: 'Finance',
  summary: 'Money drawn from an account, by whom, how, and to what receipt.',
  permission: 'transaction.view',
  filters: [
    ...PERIOD,
    {
      name: 'status',
      label: 'Status',
      kind: 'choice',
      choices: inProgressOrDoneChoices,
    },
  ],
  async run(filters) {
    const status = textOrNull(filters.status);
    const result = await query<Record<string, string | number>>(
      `select t.reference as "Reference",
              to_char(t.created_at, 'DD Mon YYYY') as "Date",
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as "Name",
              coalesce(m.member_no, '') as "Member no",
              coalesce(a.account_no, m.member_no, '') || ' · ' || at.name
                as "Account",
              t.amount::text as "Amount",
              -- Money out is paid how the Treasurer says at Disburse; before
              -- that the method on record is only a placeholder (same rule
              -- the transactions report reads by).
              case when t.status <> 'posted' then '' else pm.name end
                as "Method",
              case when t.status in ('submitted', 'under_review')
                        then coalesce('With ' || r.name,
                                       initcap(replace(t.status, '_', ' ')))
                   when t.status = 'approved' then 'To disburse'
                   when t.status = 'returned' then 'Returned'
                   when t.status = 'posted' then 'Disbursed'
                   when t.status = 'rejected' then 'Rejected'
                   when t.status = 'cancelled' then 'Cancelled'
                   else initcap(replace(t.status, '_', ' ')) end as "Status",
              coalesce(rn.receipt_no, '') as "Receipt no"
         from transaction t
         join account a on a.id = t.account_id
         join account_type at on at.id = a.account_type_id
         join payment_method pm on pm.code = t.method
         left join member m on m.id = t.member_id
         left join customer c on c.id = t.customer_id
         left join application_party p
           on p.application_id = coalesce(m.application_id, c.application_id)
          and p.subject = 'applicant' and p.ordinal = 1
         left join receipt_number rn on rn.id = t.receipt_number_id
         left join workflow_step ws
           on ws.definition_id = t.workflow_definition_id
          and ws.code = t.current_step_code
         left join role r on r.id = ws.role_id
        where t.kind = 'withdrawal'
          and t.status <> 'draft'
          and ($1::date is null or t.created_at >= $1::date)
          and ($2::date is null or t.created_at < $2::date + 1)
          and ($3::text is null
               or ($3::text = 'in_progress'
                   and t.status in ('submitted', 'under_review', 'approved',
                                     'returned'))
               or ($3::text = 'done' and t.status = 'posted')
               or ($3::text = 'rejected'
                   and t.status in ('rejected', 'cancelled')))
        order by t.created_at desc, t.serial_no desc`,
      [dateOrNull(filters.from), dateOrNull(filters.to), status]
    );

    const paidOut = result.rows
      .filter(r => r.Status === 'Disbursed')
      .reduce((sum, r) => sum + Number(r.Amount ?? 0), 0);

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Date', label: 'Date' },
        { key: 'Name', label: 'Name' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Account', label: 'Account' },
        { key: 'Amount', label: 'Amount', numeric: true },
        { key: 'Method', label: 'Method' },
        { key: 'Status', label: 'Status' },
        { key: 'Receipt no', label: 'Receipt no' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} withdrawal(s), ${rs(paidOut)} paid out.`,
    };
  },
};

const transfers: ReportDefinition = {
  code: 'transfers',
  title: 'Transfers',
  category: 'Finance',
  summary:
    'Every transfer: from whom, to whom or to which payee, and where it ' +
    'stands.',
  permission: 'transaction.view',
  filters: PERIOD,
  async run(filters) {
    // A transfer is two legs sharing a transfer id (0073): the debit leg
    // is the one the chain, the receipt and the transfer's own status
    // belong to, so it drives Reference/Date/Status/Amount here; the
    // credit leg, when there is one, is only read for To. A destination
    // off the system has no credit leg, and reads by its payee_name
    // instead (open point 5's default).
    const result = await query<Record<string, string | number>>(
      `select tr.reference as "Reference",
              to_char(tr.created_at, 'DD Mon YYYY') as "Date",
              trim(coalesce(dp.values->>'name', '') || ' ' ||
                   coalesce(dp.values->>'surname', '')) || ' · ' ||
                coalesce(da.account_no, dm.member_no, '') || ' · ' || dat.name
                as "From",
              case when c.id is not null
                   then trim(coalesce(cp.values->>'name', '') || ' ' ||
                             coalesce(cp.values->>'surname', '')) || ' · ' ||
                        coalesce(ca.account_no, cm.member_no, '') || ' · ' ||
                        cat.name
                   else coalesce(d.payee_name, '') end as "To",
              d.amount::text as "Amount",
              case when d.status in ('submitted', 'under_review')
                        then coalesce('With ' || r.name,
                                       initcap(replace(d.status, '_', ' ')))
                   when d.status = 'approved' then 'To disburse'
                   when d.status = 'returned' then 'Returned'
                   when d.status = 'posted' then 'Disbursed'
                   when d.status = 'rejected' then 'Rejected'
                   when d.status = 'cancelled' then 'Cancelled'
                   else initcap(replace(d.status, '_', ' ')) end as "Status"
         from transfer tr
         join transaction d
           on d.transfer_id = tr.id and d.leg_direction = 'debit'
         left join transaction c
           on c.transfer_id = tr.id and c.leg_direction = 'credit'
         join account da on da.id = d.account_id
         join account_type dat on dat.id = da.account_type_id
         left join member dm on dm.id = d.member_id
         left join customer dc on dc.id = d.customer_id
         left join application_party dp
           on dp.application_id = coalesce(dm.application_id, dc.application_id)
          and dp.subject = 'applicant' and dp.ordinal = 1
         left join account ca on ca.id = c.account_id
         left join account_type cat on cat.id = ca.account_type_id
         left join member cm on cm.id = c.member_id
         left join customer cc on cc.id = c.customer_id
         left join application_party cp
           on cp.application_id = coalesce(cm.application_id, cc.application_id)
          and cp.subject = 'applicant' and cp.ordinal = 1
         left join workflow_step ws
           on ws.definition_id = d.workflow_definition_id
          and ws.code = d.current_step_code
         left join role r on r.id = ws.role_id
        where d.status <> 'draft'
          and ($1::date is null or tr.created_at >= $1::date)
          and ($2::date is null or tr.created_at < $2::date + 1)
        order by tr.created_at desc, tr.serial_no desc`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Date', label: 'Date' },
        { key: 'From', label: 'From' },
        { key: 'To', label: 'To' },
        { key: 'Amount', label: 'Amount', numeric: true },
        { key: 'Status', label: 'Status' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} transfer(s).`,
    };
  },
};

const demised: ReportDefinition = {
  code: 'demised',
  title: 'Demised',
  category: 'Finance',
  summary:
    "Every death settled or on its way: a member's claim with the Takaful " +
    "benefit, or a non-member's account closed to their claimant.",
  permission: 'transaction.view',
  filters: PERIOD,
  async run(filters) {
    // A demised claim (kind = 'demise') is a member's; a closure on death
    // (kind = 'closure' with claimant_kind set, 0098) is a non-member's,
    // which has no Takaful benefit. An ordinary closure has no claimant and
    // is excluded by the same test.
    const result = await query<Record<string, string | number>>(
      `select t.reference as "Reference",
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as "Name",
              coalesce(m.member_no, '') as "Member no",
              case when m.id is not null then 'Member' else 'Non-member' end
                as "Member / Non-member",
              coalesce(t.claimant->>'name', '') as "Claimant",
              t.amount::text as "Total paid",
              case when t.status = 'posted' then 'Disbursed'
                   else initcap(replace(t.status, '_', ' ')) end as "Status",
              to_char(t.submitted_at, 'DD Mon YYYY') as "Requested",
              coalesce(to_char(t.posted_at, 'DD Mon YYYY'), '') as "Disbursed"
         from transaction t
         left join member m on m.id = t.member_id
         left join customer c on c.id = t.customer_id
         left join application_party p
           on p.application_id = coalesce(m.application_id, c.application_id)
          and p.subject = 'applicant' and p.ordinal = 1
        where (t.kind = 'demise'
               or (t.kind = 'closure' and t.claimant_kind is not null))
          and t.status <> 'draft'
          and ($1::date is null or t.submitted_at >= $1::date)
          and ($2::date is null or t.submitted_at < $2::date + 1)
        order by t.submitted_at desc nulls last, t.serial_no desc`,
      [dateOrNull(filters.from), dateOrNull(filters.to)]
    );

    const paidOut = result.rows
      .filter(r => r.Status === 'Disbursed')
      .reduce((sum, r) => sum + Number(r['Total paid'] ?? 0), 0);

    return {
      columns: [
        { key: 'Reference', label: 'Reference' },
        { key: 'Name', label: 'Name' },
        { key: 'Member no', label: 'Member no' },
        { key: 'Member / Non-member', label: 'Member / Non-member' },
        { key: 'Claimant', label: 'Claimant' },
        { key: 'Total paid', label: 'Total paid', numeric: true },
        { key: 'Status', label: 'Status' },
        { key: 'Requested', label: 'Requested' },
        { key: 'Disbursed', label: 'Disbursed' },
      ],
      rows: result.rows,
      summary: `${result.rows.length} claim(s), ${rs(paidOut)} paid out.`,
    };
  },
};

const bankAccountChoices = async () => {
  const accounts = await listBankAccounts();
  return accounts.map(a => ({ value: a.id, label: a.name }));
};

// S-1901 · Bank accounts: what each holds, and what moved through it. No
// account chosen answers "how much do we have, and where" one row per
// account; one chosen is that account's own statement, oldest first, with
// a running balance. Movements are dated by when they posted — the day
// the bank itself saw them — the same posted transactions
// bankAccountBalances stands on (src/lib/ledger/bank-accounts.ts).
const bankAccounts: ReportDefinition = {
  code: 'bank-accounts',
  title: 'Bank accounts',
  category: 'Finance',
  summary:
    "What each of the Society's bank accounts holds, and every payment " +
    'in and out of it.',
  permission: 'bank_account.view',
  filters: [
    ...PERIOD,
    {
      name: 'bank',
      label: 'Bank account',
      kind: 'choice',
      choices: bankAccountChoices,
    },
  ],
  async run(filters) {
    const from = dateOrNull(filters.from);
    const to = dateOrNull(filters.to);
    const bankAccountId = textOrNull(filters.bank);
    const periods = await bankAccountPeriods({ from, to });

    if (!bankAccountId) {
      const rows = periods.map(p => ({
        'Bank account': p.account.name,
        Bank: p.account.bankName,
        Opening: p.opening,
        In: p.in,
        Out: p.out,
        Closing: p.closing,
      }));
      const totalClosing = periods.reduce(
        (sum, p) => sum + Number(p.closing),
        0
      );
      // A row opens that account's own ins and outs, for the same period —
      // the same report, the account chosen (S-1901 officer feedback).
      const rowHrefs = periods.map(p => {
        const query = new URLSearchParams({ bank: p.account.id });
        if (from) query.set('from', from);
        if (to) query.set('to', to);
        return `/reports/bank-accounts?${query.toString()}`;
      });
      return {
        columns: [
          { key: 'Bank account', label: 'Bank account' },
          { key: 'Bank', label: 'Bank' },
          { key: 'Opening', label: 'Opening', numeric: true, money: true },
          { key: 'In', label: 'In', numeric: true, money: true },
          { key: 'Out', label: 'Out', numeric: true, money: true },
          { key: 'Closing', label: 'Closing', numeric: true, money: true },
        ],
        rows,
        rowHrefs,
        summary:
          `${periods.length} bank account(s) — ${rs(totalClosing)} in ` +
          'total at the end of the period.',
      };
    }

    const period = periods.find(p => p.account.id === bankAccountId);
    const opening = period?.opening ?? '0.00';
    const movements = await bankAccountMovements({
      bankAccountId,
      from,
      to,
    });

    let runningCents = Math.round(Number(opening) * 100);
    const rows: Record<string, string | number | null>[] = [
      {
        Date: periodStartLabel(from),
        Reference: '',
        Kind: 'Balance brought forward',
        Holder: '',
        'Paid to / from': '',
        Method: '',
        'Method reference': '',
        In: null,
        Out: null,
        Balance: opening,
      },
    ];
    let totalIn = 0;
    let totalOut = 0;
    for (const m of movements) {
      const cents = Math.round(Number(m.amount) * 100);
      if (m.direction === 'credit') {
        runningCents += cents;
        totalIn += Number(m.amount);
      } else {
        runningCents -= cents;
        totalOut += Number(m.amount);
      }
      rows.push({
        Date: m.date,
        Reference: m.reference,
        Kind: KIND_WORDS[m.kind] ?? m.kind,
        Holder: m.holder,
        'Paid to / from': m.paidToFrom,
        Method: m.method,
        'Method reference': m.methodReference,
        In: m.direction === 'credit' ? m.amount : null,
        Out: m.direction === 'credit' ? null : m.amount,
        Balance: (runningCents / 100).toFixed(2),
      });
    }
    const closing = period?.closing ?? opening;

    return {
      columns: [
        { key: 'Date', label: 'Date' },
        { key: 'Reference', label: 'Reference' },
        { key: 'Kind', label: 'Kind' },
        { key: 'Holder', label: 'Holder' },
        { key: 'Paid to / from', label: 'Paid to / from' },
        { key: 'Method', label: 'Method' },
        { key: 'Method reference', label: 'Method reference' },
        { key: 'In', label: 'In', numeric: true, money: true },
        { key: 'Out', label: 'Out', numeric: true, money: true },
        { key: 'Balance', label: 'Balance', numeric: true, money: true },
      ],
      rows,
      summary:
        `Opening ${rs(Number(opening))} · in ${rs(totalIn)} · ` +
        `out ${rs(totalOut)} · closing ${rs(Number(closing))}.`,
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
              initcap(j.status) as "Status",
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
    const failed = result.rows.filter(r => r.Status === 'Failed').length;

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
  admissions,
  resignations,
  withdrawals,
  transfers,
  demised,
  bankAccounts,
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
