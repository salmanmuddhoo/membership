// Which chain a transaction falls under, and putting it there (S-1401,
// S-1402, S-1406). Schema: migrations/0070_approval_matrix.sql.
//
// resolveRoute() reads the matrix; submitTransaction() applies the answer —
// posting through the engine at once, or leaving the transaction at the
// first enabled step of its chain for the review screens (S-1403) — and
// writes the transition that says which rule and which chain, so the trail
// can say why it went where it went.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import {
  activeChain,
  listApprovalRules,
  listWorkflows,
  type ApprovalRule,
  type TransactionKind,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../config/reference';
import { formatMoney, fromCents, toCents } from '../payments/money';
import { postTransaction, type LedgerActor } from './ledger';

export interface RouteInput {
  kind: TransactionKind;
  accountTypeId: string;
  amountCents: number;
  // The submitting officer's role codes: a rule may name the initiating
  // role, so a Clerk's withdrawal can escalate where an Account Officer's
  // posts.
  roleCodes: readonly string[];
}

export interface Route {
  // The rule that matched, or null when none did and the fallback applied.
  rule: ApprovalRule | null;
  // The chain, or null to post immediately.
  definition: WorkflowDefinition | null;
  // The first enabled step of that chain, where the transaction waits.
  firstStep: WorkflowStep | null;
}

function matches(rule: ApprovalRule, input: RouteInput): boolean {
  if (rule.accountTypeId && rule.accountTypeId !== input.accountTypeId) {
    return false;
  }
  if (
    rule.initiatingRoleCode &&
    !input.roleCodes.includes(rule.initiatingRoleCode)
  ) {
    return false;
  }
  const from = toCents(rule.amountFrom);
  const to = rule.amountTo === null ? null : toCents(rule.amountTo);
  return input.amountCents >= from && (to === null || input.amountCents <= to);
}

// The chain a transaction of this kind is routed to when no rule says: the
// most demanding one configured for the kind — an administrator who forgot
// a band gets a review, never a silent post. "Configured for the kind" is
// any active chain a rule of that kind names, or the seeded
// transaction_<kind> one; most demanding is most enabled steps.
async function mostDemandingChain(
  kind: TransactionKind,
  rules: ApprovalRule[]
): Promise<WorkflowDefinition | null> {
  const workflows = (await listWorkflows()).filter(
    w => w.entityType === 'transaction' && w.isActive
  );
  const named = new Set(
    rules
      .filter(r => r.kind === kind && r.workflowDefinitionId)
      .map(r => r.workflowDefinitionId!)
  );
  const candidates = workflows.filter(
    w => named.has(w.id) || w.code === `transaction_${kind}`
  );
  return (
    candidates.sort(
      (a, b) =>
        b.steps.filter(s => s.isEnabled).length -
        a.steps.filter(s => s.isEnabled).length
    )[0] ?? null
  );
}

export async function resolveRoute(input: RouteInput): Promise<Route> {
  const rules = (await listApprovalRules()).filter(
    r => r.kind === input.kind && r.isActive
  );
  const rule = rules.find(r => matches(r, input)) ?? null;

  let definition: WorkflowDefinition | null;
  if (rule) {
    definition = rule.workflowDefinitionId
      ? ((await listWorkflows()).find(
          w => w.id === rule.workflowDefinitionId
        ) ?? null)
      : null;
  } else {
    definition = await mostDemandingChain(input.kind, rules);
  }
  if (definition && !definition.isActive) definition = null;

  const firstStep = definition
    ? ((await activeChain(definition.code))[0] ?? null)
    : null;
  // A chain with no enabled step is no chain: nothing could ever act on
  // it, and leaving a transaction there would be a silent shelf.
  return {
    rule,
    definition: firstStep ? definition : null,
    firstStep,
  };
}

// The amounts a kind of transaction routes differently at, for one account
// type and one officer (the timeline experience): every band the matrix
// draws between its rules, each with the chain a transaction in it goes
// through — none for one that posts at once. Read off resolveRoute itself
// at each boundary the rules mention, so this can never say something the
// submit would not do.
export interface RouteBand {
  // Inclusive, in cents; toCents null means "and above".
  fromCents: number;
  toCents: number | null;
  // The enabled steps it waits at, in order; empty when it posts at once.
  chain: WorkflowStep[];
  definitionCode: string | null;
}

export async function routeBands(
  input: Omit<RouteInput, 'amountCents'>
): Promise<RouteBand[]> {
  const rules = (await listApprovalRules()).filter(
    r =>
      r.kind === input.kind &&
      r.isActive &&
      (!r.accountTypeId || r.accountTypeId === input.accountTypeId) &&
      (!r.initiatingRoleCode || input.roleCodes.includes(r.initiatingRoleCode))
  );
  // Every boundary a rule draws, from one cent up: a rule's floor, and the
  // cent above its ceiling.
  const cuts = new Set<number>([1]);
  for (const rule of rules) {
    cuts.add(Math.max(1, toCents(rule.amountFrom)));
    if (rule.amountTo !== null) cuts.add(toCents(rule.amountTo) + 1);
  }
  const starts = [...cuts].sort((a, b) => a - b);

  const bands: RouteBand[] = [];
  for (let i = 0; i < starts.length; i++) {
    const fromCents = starts[i];
    const toCents_ = i + 1 < starts.length ? starts[i + 1] - 1 : null;
    const route = await resolveRoute({ ...input, amountCents: fromCents });
    const definitionCode = route.definition?.code ?? null;
    const last = bands[bands.length - 1];
    if (last && last.definitionCode === definitionCode) {
      // The same chain on both sides of a boundary is one band.
      last.toCents = toCents_;
      continue;
    }
    bands.push({
      fromCents,
      toCents: toCents_,
      chain: definitionCode ? await activeChain(definitionCode) : [],
      definitionCode,
    });
  }
  return bands;
}

// One line an officer reads above the timeline: which amounts, and what
// happens to them. A deposit or a transfer is recorded at once, money paid
// out disbursed (labels.ts).
export function describeBand(band: RouteBand, kind?: string): string {
  const rs = (cents: number) =>
    `Rs ${formatMoney(fromCents(cents)).replace(/^[A-Z]{3}\s*/, '')}`;
  const range =
    band.fromCents <= 1 && band.toCents === null
      ? 'Any amount'
      : band.fromCents <= 1
        ? `Up to ${rs(band.toCents!)}`
        : band.toCents === null
          ? `${rs(band.fromCents)} and above`
          : `${rs(band.fromCents)} to ${rs(band.toCents)}`;
  if (band.chain.length === 0) {
    const done =
      kind === 'deposit' || kind === 'transfer' ? 'recorded' : 'disbursed';
    return `${range}: ${done} at once, no review needed.`;
  }
  const steps = band.chain
    .map(s => (s.roleName ? `${s.name} (${s.roleName})` : s.name))
    .join(', then ');
  return `${range}: ${steps}.`;
}

export interface Submission {
  route: Route;
  posted: boolean;
}

// Apply a route to a transaction, inside the caller's database transaction.
// Immediate: post through the engine now. Chain: leave it at the first step,
// recorded. Either way the transition log says which rule and chain decided,
// and the transaction row carries them. `fromStatus` is null for a first
// submission and 'returned' when a corrected transaction starts over
// (resubmitTransaction).
export async function submitTransaction(
  client: PoolClient,
  transaction: { id: string; reference: string; kind: TransactionKind },
  route: Route,
  principal: Principal,
  fromStatus: string | null = null
): Promise<Submission> {
  const actor: LedgerActor = {
    userId: principal.userId,
    description: principal.email,
  };
  await client.query(
    `update transaction
        set approval_rule_id = $2, workflow_definition_id = $3,
            current_step_code = $4, submitted_at = now(), status = 'submitted'
      where id = $1`,
    [
      transaction.id,
      route.rule?.id ?? null,
      route.definition?.id ?? null,
      route.firstStep?.code ?? null,
    ]
  );
  await client.query(
    `insert into transaction_transition
       (transaction_id, from_status, to_status, step_code, actor_user_id,
        actor_role, comment, approval_rule_id, workflow_definition_id)
     values ($1, $6, 'submitted', null, $2, $3, null, $4, $5)`,
    [
      transaction.id,
      principal.userId,
      principal.roleNames.join(', ') || null,
      route.rule?.id ?? null,
      route.definition?.id ?? null,
      fromStatus,
    ]
  );

  if (!route.definition) {
    await postTransaction(transaction.id, actor, client);
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role, approval_rule_id)
       values ($1, 'submitted', 'posted', null, $2, $3, $4)`,
      [
        transaction.id,
        principal.userId,
        principal.roleNames.join(', ') || null,
        route.rule?.id ?? null,
      ]
    );
    return { route, posted: true };
  }

  await recordAudit(
    {
      actorUserId: principal.userId,
      actorDescription: principal.email,
      action: 'transaction.submitted',
      entityType: 'transaction',
      entityId: transaction.reference,
      newValue: {
        kind: transaction.kind,
        rule_id: route.rule?.id ?? null,
        workflow: route.definition.code,
        step: route.firstStep!.code,
      },
    },
    client
  );
  return { route, posted: false };
}

export interface Resubmission extends Submission {
  // True when it re-entered the chain at the step that returned it; false
  // when the matrix sent it somewhere else and it started over.
  reentered: boolean;
}

// Send a corrected transaction back (S-1404). It re-enters at the step that
// returned it when the matrix still names the same chain and that step is
// still enabled, so an approval already given is not asked for twice.
// Otherwise — the amount crossed a band, the chain was re-shaped — the rule
// that would apply to a first submission applies now (decision 11), and it
// starts over: at the first step of the new chain, or posted at once.
export async function resubmitTransaction(
  client: PoolClient,
  transaction: {
    id: string;
    reference: string;
    kind: TransactionKind;
    workflowDefinitionId: string | null;
    currentStepCode: string | null;
  },
  route: Route,
  principal: Principal
): Promise<Resubmission> {
  const sameChain =
    route.definition !== null &&
    route.definition.id === transaction.workflowDefinitionId;
  const returningStep = sameChain
    ? ((await activeChain(route.definition!.code)).find(
        s => s.code === transaction.currentStepCode
      ) ?? null)
    : null;

  if (!returningStep) {
    const submission = await submitTransaction(
      client,
      transaction,
      route,
      principal,
      'returned'
    );
    return { ...submission, reentered: false };
  }

  // The bridged fromStatus is what the step now acts on: 'submitted' for the
  // first enabled step, the previous step's toStatus after that.
  await client.query(
    `update transaction
        set approval_rule_id = $2, status = $3, submitted_at = now()
      where id = $1`,
    [transaction.id, route.rule?.id ?? null, returningStep.fromStatus]
  );
  await client.query(
    `insert into transaction_transition
       (transaction_id, from_status, to_status, step_code, actor_user_id,
        actor_role, comment, approval_rule_id, workflow_definition_id)
     values ($1, 'returned', $2, null, $3, $4, null, $5, $6)`,
    [
      transaction.id,
      returningStep.fromStatus,
      principal.userId,
      principal.roleNames.join(', ') || null,
      route.rule?.id ?? null,
      route.definition!.id,
    ]
  );
  await recordAudit(
    {
      actorUserId: principal.userId,
      actorDescription: principal.email,
      action: 'transaction.submitted',
      entityType: 'transaction',
      entityId: transaction.reference,
      newValue: {
        kind: transaction.kind,
        rule_id: route.rule?.id ?? null,
        workflow: route.definition!.code,
        step: returningStep.code,
        reentered: true,
      },
    },
    client
  );
  return { route, posted: false, reentered: true };
}
