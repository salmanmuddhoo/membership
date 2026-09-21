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
import { toCents } from '../payments/money';
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

export interface Submission {
  route: Route;
  posted: boolean;
}

// Apply a route to a transaction that is `submitted`, inside the caller's
// database transaction. Immediate: post through the engine now. Chain: leave
// it at the first step, recorded. Either way the transition log says which
// rule and chain decided, and the transaction row carries them.
export async function submitTransaction(
  client: PoolClient,
  transaction: { id: string; reference: string; kind: TransactionKind },
  route: Route,
  principal: Principal
): Promise<Submission> {
  const actor: LedgerActor = {
    userId: principal.userId,
    description: principal.email,
  };
  await client.query(
    `update transaction
        set approval_rule_id = $2, workflow_definition_id = $3,
            current_step_code = $4, submitted_at = now()
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
     values ($1, null, 'submitted', null, $2, $3, null, $4, $5)`,
    [
      transaction.id,
      principal.userId,
      principal.roleNames.join(', ') || null,
      route.rule?.id ?? null,
      route.definition?.id ?? null,
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
