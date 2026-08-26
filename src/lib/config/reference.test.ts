// Reference configuration (M2 Feature 2.2, S-205 to S-210).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `config_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function load() {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return {
    config: await import('./reference'),
    pool: await import('../db/pool'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let actor: { userId: string; email: string };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator') returning id`
  );
  actor = { userId: user.rows[0].id, email: 'admin@albarakah.mu' };
}, 60_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('S-210: every configuration change is audited', () => {
  it('refuses a change the session cannot attribute', async () => {
    // Not a matter of the service layer remembering to audit: a write that
    // reaches the table by any route fails without a declared actor.
    await expect(
      run(
        appUrl,
        `update account_type set category = 'sneaky' where code = 'msa'`
      )
    ).rejects.toThrowError(/has no actor/);

    const after = await run(
      appUrl,
      `select category from account_type where code = 'msa'`
    );
    expect(after.rows[0].category).toBe('savings');
  });

  it('records the before and after of a change made through the service', async () => {
    const { config } = await load();
    const [type] = await config.listAccountTypes();

    await config.updateAccountType(
      type.id,
      {
        name: type.name,
        category: 'savings',
        minimumOpeningAmount: '7500.00',
        checklistId: type.checklistId,
        requiresApproval: type.requiresApproval,
        defaultStatus: type.defaultStatus,
        isActive: true,
      },
      actor
    );

    const audited = await run(
      appUrl,
      `select actor_user_id, actor_description,
              previous_value->>'minimum_opening_amount' as before,
              new_value->>'minimum_opening_amount' as after
         from audit_event
        where action = 'config.account_type.update' and entity_id = $1
        order by occurred_at desc limit 1`,
      [type.id]
    );

    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0].actor_user_id).toBe(actor.userId);
    expect(audited.rows[0].actor_description).toBe(actor.email);
    expect(audited.rows[0].before).toBe('5000.00');
    expect(audited.rows[0].after).toBe('7500.00');
  });

  it('does not record an update that changed nothing', async () => {
    const { config } = await load();
    const [type] = await config.listAccountTypes();

    const before = await run(
      appUrl,
      `select count(*) as n from audit_event where entity_id = $1`,
      [type.id]
    );

    // Same values back again. set_updated_at() still fires, so without the
    // trigger's own check this would leave a row saying nothing changed.
    await config.updateAccountType(
      type.id,
      {
        name: type.name,
        category: type.category,
        minimumOpeningAmount: type.minimumOpeningAmount,
        checklistId: type.checklistId,
        requiresApproval: type.requiresApproval,
        defaultStatus: type.defaultStatus,
        isActive: type.isActive,
      },
      actor
    );

    const after = await run(
      appUrl,
      `select count(*) as n from audit_event where entity_id = $1`,
      [type.id]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('leaves no actor behind on the connection after the transaction', async () => {
    const { config, pool } = await load();
    const [type] = await config.listAccountTypes();

    await config.setMembershipDefault(type.id, actor);

    // Same pool, a plain query afterwards: if set_config had not been scoped
    // to the transaction, this write would inherit the previous actor and
    // succeed. Asserting that it *threw* would prove little — pool.query
    // turns every driver failure into the same DatabaseUnavailableError — so
    // the assertion is on the row itself.
    await expect(
      pool.query(`update account_type set category = 'leaked' where id = $1`, [
        type.id,
      ])
    ).rejects.toThrow();

    const after = await run(
      appUrl,
      'select category from account_type where id = $1',
      [type.id]
    );
    expect(after.rows[0].category).not.toBe('leaked');

    await pool.closePool();
  });
});

describe('S-205: membership types and their field rules', () => {
  it('ships Individual and Corporate with the fields FRD Section 5 lists', async () => {
    const { config } = await load();
    const types = await config.listMembershipTypes();

    const individual = types.find(t => t.code === 'individual');
    const corporate = types.find(t => t.code === 'corporate');
    expect(individual).toBeDefined();
    expect(corporate).toBeDefined();

    const applicantKeys = (t: typeof individual) =>
      t!.fields.filter(f => f.subject === 'applicant').map(f => f.fieldKey);

    // FRD 5.1 vs 5.2: the corporate form has no NIC and no gender, and gains a
    // registration number and a contact person. That difference is the whole
    // point of the story.
    expect(applicantKeys(individual)).toContain('nic');
    expect(applicantKeys(individual)).toContain('gender');
    expect(applicantKeys(corporate)).not.toContain('nic');
    expect(applicantKeys(corporate)).not.toContain('gender');
    expect(applicantKeys(corporate)).toContain('registration_no');
    expect(applicantKeys(corporate)).toContain('contact_person');
  });

  it('carries a nominee block on every type (FRD 5.3)', async () => {
    const { config } = await load();
    const types = await config.listMembershipTypes();

    for (const type of types) {
      const nominee = type.fields.filter(f => f.subject === 'nominee');
      expect(nominee.length).toBeGreaterThan(0);
    }
  });

  it('links each type to a checklist and a fee schedule', async () => {
    const { config } = await load();
    for (const type of await config.listMembershipTypes()) {
      expect(type.checklistId).not.toBeNull();
      expect(type.feeScheduleId).not.toBeNull();
    }
  });

  it('changes which fields are mandatory without a release', async () => {
    const { config } = await load();
    const types = await config.listMembershipTypes();
    const email = types
      .find(t => t.code === 'individual')!
      .fields.find(f => f.subject === 'applicant' && f.fieldKey === 'email')!;

    expect(email.isMandatory).toBe(false);
    await config.setFieldRule(
      email.id,
      { isVisible: true, isMandatory: true },
      actor
    );

    const after = (await config.listMembershipTypes())
      .find(t => t.code === 'individual')!
      .fields.find(f => f.id === email.id)!;
    expect(after.isMandatory).toBe(true);

    await config.setFieldRule(
      email.id,
      { isVisible: true, isMandatory: false },
      actor
    );
  });

  it('refuses a field that is hidden and mandatory', async () => {
    const { config } = await load();
    const field = (await config.listMembershipTypes())[0].fields[0];

    await expect(
      config.setFieldRule(
        field.id,
        { isVisible: false, isMandatory: true },
        actor
      )
    ).rejects.toThrowError(/hidden cannot be mandatory/);
  });
});

describe('S-206: account types and the default product', () => {
  it('ships the MSA as the membership default', async () => {
    const { config } = await load();
    const dflt = await config.getMembershipDefaultAccountType();
    expect(dflt?.code).toBe('msa');
  });

  it('opens the new type once the default is changed', async () => {
    const { config } = await load();

    const newId = await config.createAccountType(
      {
        code: 'premium_savings',
        name: 'Premium Savings',
        category: 'savings',
        minimumOpeningAmount: '10000.00',
        checklistId: null,
        requiresApproval: true,
        defaultStatus: 'pending',
      },
      actor
    );

    await config.setMembershipDefault(newId, actor);

    // What an approval will read.
    const dflt = await config.getMembershipDefaultAccountType();
    expect(dflt?.code).toBe('premium_savings');

    // And exactly one, not two.
    const defaults = (await config.listAccountTypes()).filter(
      a => a.isMembershipDefault
    );
    expect(defaults).toHaveLength(1);

    const msa = (await config.listAccountTypes()).find(a => a.code === 'msa')!;
    await config.setMembershipDefault(msa.id, actor);
  });

  it('refuses to deactivate the default product', async () => {
    const { config } = await load();
    const msa = (await config.listAccountTypes()).find(a => a.code === 'msa')!;

    await expect(
      config.updateAccountType(
        msa.id,
        {
          name: msa.name,
          category: msa.category,
          minimumOpeningAmount: msa.minimumOpeningAmount,
          checklistId: msa.checklistId,
          requiresApproval: msa.requiresApproval,
          defaultStatus: msa.defaultStatus,
          isActive: false,
        },
        actor
      )
    ).rejects.toThrowError(/membership default product/);
  });

  it('refuses a code that is not a code', async () => {
    const { config } = await load();
    await expect(
      config.createAccountType(
        {
          code: 'Not A Code',
          name: 'x',
          category: 'savings',
          minimumOpeningAmount: '0',
          checklistId: null,
          requiresApproval: false,
          defaultStatus: 'active',
        },
        actor
      )
    ).rejects.toThrowError(/lowercase letters/);
  });
});

describe('S-207: fee schedules', () => {
  it('ships the amounts FRD 7.8.1 confirms, totalling Rs 13,500', async () => {
    const { config } = await load();
    const fees = await config.getCurrentFees('individual_membership');

    const amounts = Object.fromEntries(fees.map(f => [f.code, f.amount]));
    expect(amounts.entrance).toBe('1500.00');
    expect(amounts.takaful).toBe('2000.00');
    expect(amounts.shares).toBe('5000.00');
    expect(amounts.msa_deposit).toBe('5000.00');

    const charged = fees
      .filter(f => f.requirement === 'required')
      .reduce((sum, f) => sum + Number(f.amount), 0);
    expect(charged).toBe(13500);
  });

  it('distinguishes not-applicable from unconfigured', async () => {
    const { config } = await load();

    // FRD 7.8.3 names a processing fee but confirms no amount, and FRD 7.10.6
    // omits the MSA deposit for minors. Both must read as decisions, not gaps.
    const individual = await config.getCurrentFees('individual_membership');
    expect(individual.find(f => f.code === 'processing')?.requirement).toBe(
      'not_applicable'
    );

    const minor = await config.getCurrentFees('minor_membership');
    expect(minor.find(f => f.code === 'msa_deposit')?.requirement).toBe(
      'not_applicable'
    );
    const minorTotal = minor
      .filter(f => f.requirement === 'required')
      .reduce((sum, f) => sum + Number(f.amount), 0);
    expect(minorTotal).toBe(8500);
  });

  it('leaves the amounts an existing receipt charged untouched', async () => {
    const { config } = await load();
    const schedule = (await config.listFeeSchedules()).find(
      s => s.code === 'individual_membership'
    )!;

    // Stand in for a receipt: the version id an application recorded when it
    // charged, and the amount it charged for the entrance fee.
    const chargedVersionId = schedule.current!.id;
    const chargedEntrance = schedule.current!.components.find(
      c => c.code === 'entrance'
    )!.amount;
    expect(chargedEntrance).toBe('1500.00');

    await config.publishFeeVersion(
      schedule.id,
      [
        { code: 'entrance', amount: '2500.00', requirement: 'required' },
        { code: 'takaful', amount: '2000.00', requirement: 'required' },
        { code: 'shares', amount: '5000.00', requirement: 'required' },
        { code: 'msa_deposit', amount: '5000.00', requirement: 'required' },
        { code: 'processing', amount: '0', requirement: 'not_applicable' },
      ],
      actor
    );

    // New applications see the new amount.
    const now = await config.getCurrentFees('individual_membership');
    expect(now.find(f => f.code === 'entrance')?.amount).toBe('2500.00');

    // The row the old receipt points at still says what it charged.
    const stillCharged = await run(
      appUrl,
      `select amount from fee_component where version_id = $1 and code = 'entrance'`,
      [chargedVersionId]
    );
    expect(stillCharged.rows[0].amount).toBe('1500.00');

    // And the old version is closed rather than deleted, so the window during
    // which Rs 1,500 applied is still readable.
    const reread = (await config.listFeeSchedules()).find(
      s => s.code === 'individual_membership'
    )!;
    expect(reread.current!.versionNo).toBe(2);
    expect(reread.history.map(v => v.versionNo)).toContain(1);
    expect(
      reread.history.find(v => v.versionNo === 1)!.supersededAt
    ).not.toBeNull();
  });

  it('keeps exactly one version live per schedule', async () => {
    const { config } = await load();
    const schedule = (await config.listFeeSchedules()).find(
      s => s.code === 'corporate_membership'
    )!;

    await config.publishFeeVersion(
      schedule.id,
      [{ code: 'entrance', amount: '1800.00', requirement: 'required' }],
      actor
    );
    await config.publishFeeVersion(
      schedule.id,
      [{ code: 'entrance', amount: '1900.00', requirement: 'required' }],
      actor
    );

    const live = await run(
      appUrl,
      `select count(*) as n from fee_schedule_version
        where schedule_id = $1 and superseded_at is null`,
      [schedule.id]
    );
    expect(live.rows[0].n).toBe('1');
  });

  it('refuses a required component with no amount', async () => {
    const { config } = await load();
    const schedule = (await config.listFeeSchedules())[0];

    await expect(
      config.publishFeeVersion(
        schedule.id,
        [{ code: 'entrance', amount: '0', requirement: 'required' }],
        actor
      )
    ).rejects.toThrowError(/marked required but its amount is zero/);
  });
});

describe('S-208: document types and dynamic checklists', () => {
  it('gives each applicant type the documents FRD 8.4.1 lists', async () => {
    const { config } = await load();

    const individual = await config.checklistForMembershipType('individual');
    const applicant = individual.get('applicant')!.map(i => i.documentCode);
    expect(applicant).toEqual(
      expect.arrayContaining(['id_card', 'utility_bill', 'signed_form'])
    );

    const corporate = await config.checklistForMembershipType('corporate');
    const corporateApplicant = corporate
      .get('applicant')!
      .map(i => i.documentCode);
    expect(corporateApplicant).toEqual(
      expect.arrayContaining([
        'cert_registration',
        'utility_bill',
        'memorandum',
        'written_resolution',
      ])
    );
    // A corporate entity has no ID card; requiring one would block capture.
    expect(corporateApplicant).not.toContain('id_card');
  });

  it('requires the signed form for every applicant type (FRD 8.5)', async () => {
    const { config } = await load();

    for (const code of ['individual', 'corporate', 'minor']) {
      const checklist = await config.checklistForMembershipType(code);
      const applicant = checklist.get('applicant') ?? [];
      const signed = applicant.find(i => i.documentCode === 'signed_form');
      expect(signed, `${code} has no signed form item`).toBeDefined();
      expect(signed!.requirement).toBe('required');
    }
  });

  it('separates the subjects a minor application involves (FRD 7.10.5)', async () => {
    const { config } = await load();
    const minor = await config.checklistForMembershipType('minor');

    expect([...minor.keys()].sort()).toEqual([
      'applicant',
      'beneficiary',
      'guardian',
      'nominee',
    ]);
    expect(
      minor.get('applicant')!.find(i => i.documentCode === 'birth_certificate')
        ?.requirement
    ).toBe('required');
  });

  it('adds and removes a requirement without a release', async () => {
    const { config } = await load();
    const checklist = (await config.listChecklists()).find(
      c => c.code === 'individual_kyc'
    )!;
    const birthCert = (await config.listDocumentTypes()).find(
      d => d.code === 'birth_certificate'
    )!;

    const itemId = await config.addChecklistItem(
      checklist.id,
      {
        documentTypeId: birthCert.id,
        subject: 'applicant',
        requirement: 'optional',
      },
      actor
    );

    let items = (await config.checklistForMembershipType('individual')).get(
      'applicant'
    )!;
    expect(items.map(i => i.documentCode)).toContain('birth_certificate');

    await config.setChecklistItemRequirement(itemId, 'required', actor);
    items = (await config.checklistForMembershipType('individual')).get(
      'applicant'
    )!;
    expect(
      items.find(i => i.documentCode === 'birth_certificate')!.requirement
    ).toBe('required');

    await config.removeChecklistItem(itemId, actor);
    items = (await config.checklistForMembershipType('individual')).get(
      'applicant'
    )!;
    expect(items.map(i => i.documentCode)).not.toContain('birth_certificate');
  });

  it('refuses the same document twice for one subject', async () => {
    const { config } = await load();
    const checklist = (await config.listChecklists()).find(
      c => c.code === 'individual_kyc'
    )!;
    const idCard = (await config.listDocumentTypes()).find(
      d => d.code === 'id_card'
    )!;

    await expect(
      config.addChecklistItem(
        checklist.id,
        {
          documentTypeId: idCard.id,
          subject: 'applicant',
          requirement: 'required',
        },
        actor
      )
    ).rejects.toThrowError(/already on this checklist/);
  });

  it('carries expiry on the document types that have one', async () => {
    const { config } = await load();
    const types = await config.listDocumentTypes();
    expect(types.find(d => d.code === 'id_card')!.tracksExpiry).toBe(true);
    expect(types.find(d => d.code === 'birth_certificate')!.tracksExpiry).toBe(
      false
    );
  });
});

describe('S-209: workflow definitions', () => {
  it('ships the confirmed chain: Staff, then Secretary, then President', async () => {
    const { config } = await load();
    const chain = await config.activeChain('membership_application_approval');

    expect(chain.map(s => s.code)).toEqual([
      'capture',
      'secretary_review',
      'president_decision',
    ]);
  });

  it('carries the Regional Manager step, present but disabled (decision 2)', async () => {
    const { config } = await load();
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;

    const regional = definition.steps.find(s => s.code === 'regional_review');
    expect(
      regional,
      'the step should exist so it can be switched on'
    ).toBeDefined();
    expect(regional!.isEnabled).toBe(false);
    expect(regional!.roleName).toBe('Regional Manager');

    // It is configuration, not a stage the chain waits at.
    const chain = await config.activeChain('membership_application_approval');
    expect(chain.map(s => s.code)).not.toContain('regional_review');

    // Enabling it puts it in the chain, in order, with no code change.
    await config.setStepEnabled(regional!.id, true, actor);
    const enabled = await config.activeChain('membership_application_approval');
    expect(enabled.map(s => s.code)).toEqual([
      'capture',
      'regional_review',
      'secretary_review',
      'president_decision',
    ]);

    await config.setStepEnabled(regional!.id, false, actor);
  });

  it('assigns steps to a role, not a person (decision 4)', async () => {
    const { config } = await load();
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;

    for (const step of definition.steps) {
      expect(step.roleId).toBeTruthy();
      expect(step.roleName).toBeTruthy();
    }
    expect(
      definition.steps.find(s => s.code === 'secretary_review')!.roleName
    ).toBe('Secretary');
  });

  it('supports a quorum, set to one everywhere today', async () => {
    const { config } = await load();
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;
    expect(definition.steps.every(s => s.quorumCount === 1)).toBe(true);

    const president = definition.steps.find(
      s => s.code === 'president_decision'
    )!;
    await config.setStepQuorum(president.id, 3, actor);

    const after = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;
    expect(
      after.steps.find(s => s.code === 'president_decision')!.quorumCount
    ).toBe(3);

    await config.setStepQuorum(president.id, 1, actor);
  });

  it('refuses to disable the last enabled step', async () => {
    const { config } = await load();
    const definition = (await config.listWorkflows()).find(
      d => d.code === 'membership_application_approval'
    )!;
    const enabled = definition.steps.filter(s => s.isEnabled);

    // Disable all but one, then try the last.
    for (const step of enabled.slice(0, -1)) {
      await config.setStepEnabled(step.id, false, actor);
    }
    const last = enabled[enabled.length - 1];
    await expect(
      config.setStepEnabled(last.id, false, actor)
    ).rejects.toThrowError(/last enabled step/);

    for (const step of enabled.slice(0, -1)) {
      await config.setStepEnabled(step.id, true, actor);
    }
  });

  it('holds statuses as configuration, with Abeyance ready to enable (decision 8)', async () => {
    const { config } = await load();
    const statuses = await config.listWorkflowStatuses(
      'membership_application'
    );

    expect(statuses.map(s => s.code)).toEqual([
      'new',
      'submitted_for_review',
      'submitted_for_approval',
      'approved',
      'rejected',
      'abeyance',
    ]);

    const abeyance = statuses.find(s => s.code === 'abeyance')!;
    expect(abeyance.isActive).toBe(false);

    await config.setStatusActive(abeyance.id, true, actor);
    const after = await config.listWorkflowStatuses('membership_application');
    expect(after.find(s => s.code === 'abeyance')!.isActive).toBe(true);

    await config.setStatusActive(abeyance.id, false, actor);
  });

  it('refuses to deactivate a status an enabled step depends on', async () => {
    const { config } = await load();
    const statuses = await config.listWorkflowStatuses(
      'membership_application'
    );
    const approved = statuses.find(s => s.code === 'approved')!;

    await expect(
      config.setStatusActive(approved.id, false, actor)
    ).rejects.toThrowError(/uses this status/);
  });
});
