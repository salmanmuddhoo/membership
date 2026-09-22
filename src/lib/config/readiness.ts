// Is the platform ready to transact? (S-1801, S-1802; CFG-US-001/004/005/
// 006; FRD 9.)
//
// FRD 9's rule is that no officer is ever blocked by a value nobody set.
// Every milestone's migration seeds its own defaults, so on a fresh
// database the rule holds — and this module is how that is proved, on a
// page (Configuration → Readiness) and in a test (readiness.test.ts):
// one list of every Phase 2 setting, what it stands at, and whether a
// person has ever changed it since it was seeded.
//
// "Still at default" is information, not an error. A seeded value is a
// working value; the Society may well keep it. What the list is for is
// the go-live walk-through: an administrator reads down it and confirms
// each figure is the Society's, not the FRD's placeholder. "Missing" is
// the one state that is a problem — a setting that reads as nothing —
// and on a migrated database it should never appear.
//
// Who last changed a setting comes from two trails: config_entry_history
// for the plain values (its changed_by is null on a seed, a user id on a
// change through the application), and audit_event for the configuration
// tables, whose trigger records a migration with no actor_user_id and a
// person with one (S-210).
import { query } from '../db/pool';
import {
  EXIT_HAPPENINGS,
  EXIT_SUBJECTS,
  RECEIPT_ISSUED,
  TRANSACTION_PLACEHOLDERS,
} from '../notifications/event-codes';
import { listNotificationTemplates } from '../notifications/templates';
import { formatMoney } from '../payments/money';
import { listRetentionPolicies } from '../retention/policy';
import {
  listAccountTypes,
  listApprovalRules,
  listPaymentMethods,
  listWorkflows,
  TRANSACTION_KINDS,
} from './reference';

export type ReadinessState = 'default' | 'changed' | 'missing';

export interface ReadinessItem {
  group: string;
  label: string;
  // What it stands at, in the words the page shows.
  value: string;
  // Where it is changed.
  href: string;
  state: ReadinessState;
  changedAt: Date | null;
  changedBy: string | null;
  // Something the reader should know beside the value: a placeholder to
  // replace, what is missing.
  note: string | null;
}

interface Change {
  at: Date;
  by: string;
}

const KIND_LABELS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer: 'Transfer',
  closure: 'Account closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
};

const FEES = '/admin/configuration/fees';

// The plain values: key, how it reads, where it lives.
const VALUES: {
  key: string;
  label: string;
  group: string;
  href: string;
  render: (value: unknown) => string;
}[] = [
  {
    key: 'payment.cash_maximum',
    label: 'Cash maximum',
    group: 'Amounts',
    href: FEES,
    render: money,
  },
  {
    key: 'payment.cash_source_of_fund_threshold',
    label: 'Source of Fund threshold',
    group: 'Amounts',
    href: FEES,
    render: money,
  },
  {
    key: 'payment.cash_source_of_fund_checklist',
    label: 'Source of Fund checklist',
    group: 'Amounts',
    href: FEES,
    render: value =>
      Array.isArray(value)
        ? `${value.length} item${value.length === 1 ? '' : 's'}`
        : '—',
  },
  {
    key: 'demised.takaful_benefit',
    label: 'Takaful benefit',
    group: 'Amounts',
    href: FEES,
    render: money,
  },
  {
    key: 'balance.near_floor_margin',
    label: 'Near-floor notice margin',
    group: 'Amounts',
    href: FEES,
    render: value => (Number(value) === 0 ? 'Off' : money(value)),
  },
  {
    key: 'resignation.check_pending_transactions',
    label: 'Resignation check: pending transactions',
    group: 'Amounts',
    href: FEES,
    render: onOff,
  },
  {
    key: 'resignation.check_unpaid_fees',
    label: 'Resignation check: unpaid fees',
    group: 'Amounts',
    href: FEES,
    render: onOff,
  },
  {
    key: 'resignation.check_financing',
    label: 'Resignation check: financing',
    group: 'Amounts',
    href: FEES,
    render: onOff,
  },
];

// Last on the page: what the member app may start (S-2102), read the same
// way as the amounts but shown after everything the branch itself relies
// on.
const MEMBER_APP: typeof VALUES = [
  {
    key: 'member_api.enabled_operations',
    label: 'Transactions from the member app',
    group: 'Member app',
    href: '/admin/configuration/member-app',
    render: value =>
      Array.isArray(value) && value.length > 0
        ? value.map(v => KIND_LABELS[String(v)] ?? String(v)).join(', ')
        : 'None',
  },
];

function money(value: unknown): string {
  return formatMoney(String(value)).replace(/^MUR\s*/, 'Rs ');
}

function onOff(value: unknown): string {
  return value === true ? 'On' : 'Off';
}

// The latest change a person made to one of these tables — a migration's
// row has no actor_user_id, so it does not count. `match` narrows to the
// rows about one thing: by entity id, or by a field of the row as
// recorded.
async function lastChange(
  entityTypes: string[],
  match?: { field: string; value: string }
): Promise<Change | null> {
  const result = await query<{ occurred_at: Date; by: string }>(
    `select a.occurred_at, coalesce(u.display_name, a.actor_description) as by
       from audit_event a
       left join app_user u on u.id = a.actor_user_id
      where a.entity_type = any($1::text[])
        and a.actor_user_id is not null
        and ($2::text is null
             or a.entity_id = $2
             or coalesce(a.new_value->>$3, a.previous_value->>$3) = $2)
      order by a.occurred_at desc
      limit 1`,
    [entityTypes, match?.value ?? null, match?.field ?? 'id']
  );
  const row = result.rows[0];
  return row ? { at: row.occurred_at, by: row.by } : null;
}

function item(
  base: Pick<ReadinessItem, 'group' | 'label' | 'value' | 'href'>,
  change: Change | null,
  options: { missing?: boolean; note?: string | null } = {}
): ReadinessItem {
  return {
    ...base,
    state: options.missing ? 'missing' : change ? 'changed' : 'default',
    changedAt: change?.at ?? null,
    changedBy: change?.by ?? null,
    note: options.note ?? null,
  };
}

async function plainValues(
  definitions: typeof VALUES = VALUES
): Promise<ReadinessItem[]> {
  const rows = await query<{
    key: string;
    value: unknown;
    changed_at: Date | null;
    changed_by: string | null;
  }>(
    `select e.key, e.value, h.effective_at as changed_at, u.display_name as changed_by
       from config_entry e
       left join lateral (
         select effective_at, changed_by
           from config_entry_history
          where config_key = e.key and changed_by is not null
          order by effective_at desc
          limit 1
       ) h on true
       left join app_user u on u.id = h.changed_by
      where e.key = any($1::text[])`,
    [definitions.map(v => v.key)]
  );
  const byKey = new Map(rows.rows.map(r => [r.key, r]));
  return definitions.map(definition => {
    const row = byKey.get(definition.key);
    if (!row) {
      return item({ ...definition, value: '—' }, null, {
        missing: true,
        note: 'Not set.',
      });
    }
    const change =
      row.changed_at && row.changed_by
        ? { at: row.changed_at, by: row.changed_by }
        : null;
    const placeholder =
      Array.isArray(row.value) &&
      row.value.some(v => String(v).startsWith('Placeholder'));
    return item(
      { ...definition, value: definition.render(row.value) },
      change,
      {
        note: placeholder
          ? 'Placeholder wording — replace before go-live.'
          : null,
      }
    );
  });
}

async function matrix(): Promise<ReadinessItem[]> {
  const rules = (await listApprovalRules()).filter(r => r.isActive);
  const items: ReadinessItem[] = [];
  for (const kind of TRANSACTION_KINDS) {
    const own = rules
      .filter(r => r.kind === kind)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const value = own
      .map(r => {
        const band = r.amountTo
          ? `${money(r.amountFrom)} to ${money(r.amountTo)}`
          : `${money(r.amountFrom)} and above`;
        const scope = [
          r.accountTypeName,
          r.initiatingRoleName ? `by ${r.initiatingRoleName}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        return `${band}${scope ? ` (${scope})` : ''}: ${r.workflowName ?? 'posts at once'}`;
      })
      .join(' · ');
    items.push(
      item(
        {
          group: 'Approval matrix',
          label: KIND_LABELS[kind],
          value: own.length ? value : '—',
          href: '/admin/configuration/approval-matrix',
        },
        await lastChange(['approval_rule'], { field: 'kind', value: kind }),
        {
          missing: own.length === 0,
          note:
            own.length === 0
              ? 'No rule; every one goes to the most demanding chain.'
              : null,
        }
      )
    );
  }
  return items;
}

async function chains(): Promise<ReadinessItem[]> {
  const definitions = await listWorkflows();
  const items: ReadinessItem[] = [];
  for (const kind of TRANSACTION_KINDS) {
    const definition = definitions.find(d => d.code === `transaction_${kind}`);
    const enabled =
      definition?.isActive === false
        ? []
        : (definition?.steps ?? []).filter(s => s.isEnabled);
    const change = definition
      ? await lastChange(['workflow_definition', 'workflow_step'], {
          field: 'definition_id',
          value: definition.id,
        })
      : null;
    items.push(
      item(
        {
          group: 'Approval chains',
          label: definition?.name ?? `${KIND_LABELS[kind]} approval`,
          value: enabled.length
            ? enabled.map(s => `${s.name} (${s.roleName})`).join(' → ')
            : '—',
          href: '/admin/configuration/workflows',
        },
        change,
        {
          missing: enabled.length === 0,
          note: !definition
            ? 'No chain.'
            : enabled.length === 0
              ? 'No enabled step; nothing routed here can be decided.'
              : null,
        }
      )
    );
  }
  return items;
}

async function accountTypes(): Promise<ReadinessItem[]> {
  const types = (await listAccountTypes()).filter(t => t.isActive);
  const items: ReadinessItem[] = [];
  for (const type of types) {
    const allowed = [
      type.allowsDeposit ? 'deposits' : null,
      type.allowsWithdrawal ? 'withdrawals' : null,
      type.allowsTransfer ? 'transfers' : null,
    ].filter(Boolean);
    items.push(
      item(
        {
          group: 'Account types',
          label: type.name,
          value: [
            `Floor ${money(type.minimumBalance)}`,
            type.maximumTransactionAmount
              ? `cap ${money(type.maximumTransactionAmount)}`
              : 'no cap',
            allowed.length ? allowed.join(', ') : 'nothing allowed',
          ].join(' · '),
          href: '/admin/configuration/account-types',
        },
        await lastChange(['account_type'], { field: 'id', value: type.id }),
        {
          note: allowed.length ? null : 'No operation is allowed on it.',
        }
      )
    );
  }
  return items;
}

async function paymentMethods(): Promise<ReadinessItem[]> {
  const offered = (await listPaymentMethods()).filter(
    m => m.isActive && !m.isSystem
  );
  return [
    item(
      {
        group: 'Payment methods',
        label: 'Offered on a form',
        value: offered.length ? offered.map(m => m.name).join(', ') : '—',
        href: '/admin/configuration/payment-methods',
      },
      await lastChange(['payment_method']),
      {
        missing: offered.length === 0,
        note: offered.length === 0 ? 'No method is offered.' : null,
      }
    ),
  ];
}

// The Phase 2 events, by the thing they are about.
const WORDING_GROUPS: { label: string; events: string[] }[] = [
  { label: 'Receipt', events: [RECEIPT_ISSUED] },
  ...EXIT_SUBJECTS.map(subject => ({
    label: {
      closure: 'Account closure',
      resignation: 'Resignation',
      demised: 'Demised claim',
    }[subject],
    events: EXIT_HAPPENINGS.map(h => `${subject}.${h}`),
  })),
  {
    label: "A member's transactions",
    events: Object.keys(TRANSACTION_PLACEHOLDERS).filter(
      e => !e.startsWith('transaction.') && e !== 'receipt.voided'
    ),
  },
  {
    label: 'Staff',
    events: ['transaction.awaiting', 'transaction.returned', 'receipt.voided'],
  },
];

async function wording(): Promise<ReadinessItem[]> {
  const templates = (await listNotificationTemplates()).filter(t => t.isActive);
  const items: ReadinessItem[] = [];
  for (const group of WORDING_GROUPS) {
    const silent = group.events.filter(
      e => !templates.some(t => t.eventCode === e)
    );
    const channels = new Set(
      templates
        .filter(t => group.events.includes(t.eventCode))
        .map(t => (t.channel === 'whatsapp' ? 'WhatsApp' : 'email'))
    );
    let change: Change | null = null;
    for (const event of group.events) {
      const own = await lastChange(['notification_template'], {
        field: 'event_code',
        value: event,
      });
      if (own && (!change || own.at > change.at)) change = own;
    }
    items.push(
      item(
        {
          group: 'Notification wording',
          label: group.label,
          value:
            silent.length === group.events.length
              ? '—'
              : `${group.events.length - silent.length} of ${group.events.length} event${group.events.length === 1 ? '' : 's'} · ${[...channels].sort().join(' and ')}`,
          href: '/admin/configuration/notification-templates',
        },
        change,
        {
          missing: silent.length > 0,
          note: silent.length
            ? `No active wording for ${silent.join(', ')}.`
            : null,
        }
      )
    );
  }
  return items;
}

async function retention(): Promise<ReadinessItem[]> {
  const policies = await listRetentionPolicies();
  const items: ReadinessItem[] = [];
  for (const policy of policies) {
    items.push(
      item(
        {
          group: 'Retention',
          label: policy.label,
          value:
            policy.periodMonths === null
              ? 'Kept indefinitely'
              : `${policy.periodMonths} months`,
          href: '/admin/configuration/retention',
        },
        await lastChange(['retention_policy'], {
          field: 'code',
          value: policy.code,
        })
      )
    );
  }
  return items;
}

/** Every Phase 2 setting, in the order the page shows them. */
export async function readiness(): Promise<ReadinessItem[]> {
  return [
    ...(await plainValues()),
    ...(await matrix()),
    ...(await chains()),
    ...(await accountTypes()),
    ...(await paymentMethods()),
    ...(await wording()),
    ...(await retention()),
    ...(await plainValues(MEMBER_APP)),
  ];
}

export interface ReadinessSummary {
  total: number;
  changed: number;
  atDefault: number;
  missing: number;
}

export function summarise(items: ReadinessItem[]): ReadinessSummary {
  return {
    total: items.length,
    changed: items.filter(i => i.state === 'changed').length,
    atDefault: items.filter(i => i.state === 'default').length,
    missing: items.filter(i => i.state === 'missing').length,
  };
}
