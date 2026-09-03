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

// Configuration tables refuse a write that cannot be attributed (S-210), so a
// fixture that touches one has to say who it is, exactly as the application
// does through withConfigurationActor.
async function runAsConfigurator(url: string, sql: string) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    const result = await client.query(sql);
    await client.query('commit');
    return result;
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

    await config.setOpensOnApproval(type.id, true, actor);

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

  describe('S-602: how many nominees a type captures', () => {
    it('defaults to 1, and can be changed without a release', async () => {
      const { config } = await load();
      const individual = (await config.listMembershipTypes()).find(
        t => t.code === 'individual'
      )!;
      expect(individual.nomineeCount).toBe(1);

      await config.setNomineeCount(individual.id, 3, actor);
      const after = (await config.listMembershipTypes()).find(
        t => t.code === 'individual'
      )!;
      expect(after.nomineeCount).toBe(3);

      await config.setNomineeCount(individual.id, 1, actor);
    });

    it('refuses anything outside 1 to 10, or not a whole number', async () => {
      const { config } = await load();
      const individual = (await config.listMembershipTypes()).find(
        t => t.code === 'individual'
      )!;

      for (const count of [0, -1, 11, 2.5, NaN]) {
        await expect(
          config.setNomineeCount(individual.id, count, actor)
        ).rejects.toThrowError(/whole number from 1 to 10/);
      }
    });

    it('refuses a membership type that does not exist', async () => {
      const { config } = await load();
      await expect(
        config.setNomineeCount('00000000-0000-0000-0000-000000000000', 2, actor)
      ).rejects.toThrowError(/no longer exists/);
    });
  });

  describe('S-610: the majority transition a type configures', () => {
    it('defaults to none, and can be turned on without a release', async () => {
      const { config } = await load();
      const types = await config.listMembershipTypes();
      const minor = types.find(t => t.code === 'minor')!;
      const individual = types.find(t => t.code === 'individual')!;

      expect(minor.majorityAge).toBeNull();
      expect(minor.majorityTransitionTypeId).toBeNull();

      await config.setMajorityTransition(
        minor.id,
        { age: 18, transitionTypeId: individual.id },
        actor
      );

      const after = (await config.listMembershipTypes()).find(
        t => t.code === 'minor'
      )!;
      expect(after.majorityAge).toBe(18);
      expect(after.majorityTransitionTypeId).toBe(individual.id);
      expect(after.majorityTransitionTypeName).toBe(individual.name);

      await config.setMajorityTransition(
        minor.id,
        { age: null, transitionTypeId: null },
        actor
      );
    });

    it('refuses an age with no target, or a target with no age', async () => {
      const { config } = await load();
      const types = await config.listMembershipTypes();
      const minor = types.find(t => t.code === 'minor')!;
      const individual = types.find(t => t.code === 'individual')!;

      await expect(
        config.setMajorityTransition(
          minor.id,
          { age: 18, transitionTypeId: null },
          actor
        )
      ).rejects.toThrowError(/one without the other/);

      await expect(
        config.setMajorityTransition(
          minor.id,
          { age: null, transitionTypeId: individual.id },
          actor
        )
      ).rejects.toThrowError(/one without the other/);
    });

    it('refuses an age outside 1 to 100', async () => {
      const { config } = await load();
      const types = await config.listMembershipTypes();
      const minor = types.find(t => t.code === 'minor')!;
      const individual = types.find(t => t.code === 'individual')!;

      for (const age of [0, -1, 101, 17.5]) {
        await expect(
          config.setMajorityTransition(
            minor.id,
            { age, transitionTypeId: individual.id },
            actor
          )
        ).rejects.toThrowError(/whole number from 1 to 100/);
      }
    });

    it('refuses a type transitioning into itself', async () => {
      const { config } = await load();
      const minor = (await config.listMembershipTypes()).find(
        t => t.code === 'minor'
      )!;

      await expect(
        config.setMajorityTransition(
          minor.id,
          { age: 18, transitionTypeId: minor.id },
          actor
        )
      ).rejects.toThrowError(/cannot transition into itself/);
    });

    it('refuses a target membership type that does not exist', async () => {
      const { config } = await load();
      const minor = (await config.listMembershipTypes()).find(
        t => t.code === 'minor'
      )!;

      await expect(
        config.setMajorityTransition(
          minor.id,
          { age: 18, transitionTypeId: '00000000-0000-0000-0000-000000000000' },
          actor
        )
      ).rejects.toThrowError(/no longer exists/);
    });
  });
});

describe('S-206: the accounts a membership opens', () => {
  // A membership opens Shares and an MSA together, both carrying the member's
  // number. More than one, which is why this is a set rather than "the
  // default".
  it('ships Shares and the MSA as the accounts an approval opens', async () => {
    const { config } = await load();
    const opened = await config.getAccountTypesOpenedOnApproval();
    expect(opened.map(t => t.code)).toEqual(['shares', 'msa']);
  });

  it('opens a further type once one is added', async () => {
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

    await config.setOpensOnApproval(newId, true, actor);

    // Added to what an approval opens, not swapped for it. Marking one used to
    // clear the others, which would silently stop opening the MSA.
    const opened = await config.getAccountTypesOpenedOnApproval();
    expect(opened.map(t => t.code).sort()).toEqual([
      'msa',
      'premium_savings',
      'shares',
    ]);

    // And it can be taken off again.
    await config.setOpensOnApproval(newId, false, actor);
    expect(
      (await config.getAccountTypesOpenedOnApproval()).map(t => t.code)
    ).toEqual(['shares', 'msa']);
  });

  // An approval that opens nothing is the half-created member S-308 exists to
  // prevent, and it would not be discovered until someone approved.
  it('refuses to clear the last account an approval opens', async () => {
    const { config } = await load();
    const types = await config.listAccountTypes();
    const shares = types.find(a => a.code === 'shares')!;
    const msa = types.find(a => a.code === 'msa')!;

    await config.setOpensOnApproval(shares.id, false, actor);

    await expect(
      config.setOpensOnApproval(msa.id, false, actor)
    ).rejects.toThrowError(/at least one account/);

    await config.setOpensOnApproval(shares.id, true, actor);
  });

  // Deactivating one of several is fine — the others still open. Deactivating
  // the last one would leave an approval with nothing to open.
  it('refuses to deactivate the last account an approval opens', async () => {
    const { config } = await load();
    const deactivate = async (code: string) => {
      const type = (await config.listAccountTypes()).find(
        a => a.code === code
      )!;
      return config.updateAccountType(
        type.id,
        {
          name: type.name,
          category: type.category,
          minimumOpeningAmount: type.minimumOpeningAmount,
          checklistId: type.checklistId,
          requiresApproval: type.requiresApproval,
          defaultStatus: type.defaultStatus,
          isActive: false,
        },
        actor
      );
    };

    // Shares goes: the MSA still opens, so nothing is left half-configured.
    await deactivate('shares');

    // The MSA cannot, because now it is the only one left.
    await expect(deactivate('msa')).rejects.toThrowError(
      /only product a membership approval opens/
    );

    // Put Shares back for the tests that follow.
    const shares = (await config.listAccountTypes()).find(
      a => a.code === 'shares'
    )!;
    await config.updateAccountType(
      shares.id,
      {
        name: shares.name,
        category: shares.category,
        minimumOpeningAmount: shares.minimumOpeningAmount,
        checklistId: shares.checklistId,
        requiresApproval: shares.requiresApproval,
        defaultStatus: shares.defaultStatus,
        isActive: true,
      },
      actor
    );
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

  // S-614: what a non-member's account of this type is numbered with —
  // read back through listAccountTypes and settable through both create and
  // update, the same as every other fact about an account type.
  it('persists the number prefix a non-member’s account is numbered with', async () => {
    const { config } = await load();

    const id = await config.createAccountType(
      {
        code: 's614_prefix_test',
        name: 'S-614 prefix test',
        category: 'savings',
        minimumOpeningAmount: '0',
        checklistId: null,
        requiresApproval: false,
        defaultStatus: 'active',
        numberPrefix: 'HSA',
      },
      actor
    );

    let type = (await config.listAccountTypes()).find(t => t.id === id)!;
    expect(type.numberPrefix).toBe('HSA');

    await config.updateAccountType(
      id,
      {
        name: type.name,
        category: type.category,
        minimumOpeningAmount: type.minimumOpeningAmount,
        checklistId: type.checklistId,
        requiresApproval: type.requiresApproval,
        defaultStatus: type.defaultStatus,
        isActive: type.isActive,
        numberPrefix: null,
      },
      actor
    );
    type = (await config.listAccountTypes()).find(t => t.id === id)!;
    expect(type.numberPrefix).toBeNull();
  });
});

describe('S-207: fee schedules', () => {
  // Shares is what makes someone a member and is mandatory. The MSA deposit is
  // optional: the account opens either way, and whether money goes into it at
  // joining is configuration.
  it('requires Rs 8,500, with the MSA deposit optional on top', async () => {
    const { config } = await load();
    const fees = await config.getCurrentFees('individual_membership');

    const amounts = Object.fromEntries(fees.map(f => [f.code, f.amount]));
    expect(amounts.entrance).toBe('1500.00');
    expect(amounts.takaful).toBe('2000.00');
    expect(amounts.shares).toBe('5000.00');
    expect(amounts.msa_deposit).toBe('5000.00');

    const required = Object.fromEntries(fees.map(f => [f.code, f.requirement]));
    expect(required.shares).toBe('required');
    expect(required.msa_deposit).toBe('optional');

    const charged = fees
      .filter(f => f.requirement === 'required')
      .reduce((sum, f) => sum + Number(f.amount), 0);
    expect(charged).toBe(8500);
  });

  it('distinguishes not-applicable from unconfigured', async () => {
    const { config } = await load();

    // FRD 7.8.3 names a processing fee but confirms no amount, so it ships
    // configured and switched off — a decision, not a gap. Three states, and
    // the middle one matters: optional is offered and may be declined, not
    // applicable cannot be charged at all.
    const individual = await config.getCurrentFees('individual_membership');
    expect(individual.find(f => f.code === 'processing')?.requirement).toBe(
      'not_applicable'
    );
    expect(individual.find(f => f.code === 'msa_deposit')?.requirement).toBe(
      'optional'
    );

    const minor = await config.getCurrentFees('minor_membership');
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
    const chargedVersionNo = schedule.current!.versionNo;
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
    // Relative to whatever was live, not a fixed number: a migration that
    // publishes a version is a normal thing to happen, and this test is about
    // supersession rather than about how many versions exist.
    expect(reread.current!.versionNo).toBe(chargedVersionNo + 1);
    expect(reread.history.map(v => v.versionNo)).toContain(chargedVersionNo);
    expect(
      reread.history.find(v => v.versionNo === chargedVersionNo)!.supersededAt
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

  // No document the Society currently accepts carries an expiry date — a
  // Mauritian NIC does not, and nor does a birth certificate. So the type is
  // created here rather than asserted against a seed: this is about the flag
  // being carried through the configuration, and it must not start failing the
  // day the Society decides a document does or does not expire.
  it('carries expiry on a document type configured to have one', async () => {
    const { config } = await load();
    await runAsConfigurator(
      appUrl,
      `insert into document_type (code, name, description, tracks_expiry)
       values ('passport', 'Passport', 'Expires, unlike the NIC', true)
       on conflict (code) do update set tracks_expiry = excluded.tracks_expiry`
    );

    const types = await config.listDocumentTypes();
    expect(types.find(d => d.code === 'passport')!.tracksExpiry).toBe(true);
    expect(types.find(d => d.code === 'id_card')!.tracksExpiry).toBe(false);
    expect(types.find(d => d.code === 'birth_certificate')!.tracksExpiry).toBe(
      false
    );
  });

  // S-612: an additional-account application has no membership type, so its
  // checklist is the union of what each selected account type asks for —
  // required wins if either account type requires it, and a document both
  // ask for is not listed twice.
  describe('S-612: the checklist for a set of selected account types', () => {
    it('unions two account types, required winning over optional', async () => {
      const { config } = await load();

      const idCard = (await config.listDocumentTypes()).find(
        d => d.code === 'id_card'
      )!;
      const utilityBill = (await config.listDocumentTypes()).find(
        d => d.code === 'utility_bill'
      )!;

      const listA = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s612_test_a', 'S-612 test A', '') returning id`
      );
      const listB = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s612_test_b', 'S-612 test B', '') returning id`
      );
      await runAsConfigurator(
        appUrl,
        `insert into document_checklist_item
           (checklist_id, document_type_id, subject, requirement, sort_order)
         values
           ('${listA.rows[0].id}', '${idCard.id}', 'applicant', 'optional', 1),
           ('${listB.rows[0].id}', '${idCard.id}', 'applicant', 'required', 1),
           ('${listB.rows[0].id}', '${utilityBill.id}', 'applicant', 'optional', 2)`
      );
      const typeA = await runAsConfigurator(
        appUrl,
        `insert into account_type
           (code, name, category, checklist_id, is_membership_default)
         values ('s612_type_a', 'S-612 type A', 'savings',
                 '${listA.rows[0].id}', false)
         returning code`
      );
      const typeB = await runAsConfigurator(
        appUrl,
        `insert into account_type
           (code, name, category, checklist_id, is_membership_default)
         values ('s612_type_b', 'S-612 type B', 'savings',
                 '${listB.rows[0].id}', false)
         returning code`
      );

      const union = await config.checklistForAccountTypes([
        typeA.rows[0].code,
        typeB.rows[0].code,
      ]);
      const applicant = union.get('applicant')!;

      // id_card appears once, required — type A left it optional but type B
      // requires it, and the stricter selection wins.
      const idCardItems = applicant.filter(i => i.documentCode === 'id_card');
      expect(idCardItems).toHaveLength(1);
      expect(idCardItems[0].requirement).toBe('required');

      expect(
        applicant.find(i => i.documentCode === 'utility_bill')?.requirement
      ).toBe('optional');
    });

    it('is empty for no selection', async () => {
      const { config } = await load();
      expect(await config.checklistForAccountTypes([])).toEqual(new Map());
    });
  });

  describe('S-614: what a non-member applicant must provide', () => {
    // Its own type throughout — never 'individual' — so these tests do not
    // depend on, and cannot disturb, what migration 0028 actually seeds for
    // it.
    async function typeWithChecklists(options: {
      memberChecklistId?: string;
      nonMemberChecklistId?: string;
    }) {
      const code = `s614_type_${Math.random().toString(36).slice(2, 8)}`;
      const type = await runAsConfigurator(
        appUrl,
        `insert into membership_type
           (code, name, checklist_id, non_member_checklist_id)
         values ('${code}', 'S-614 test type',
                 ${options.memberChecklistId ? `'${options.memberChecklistId}'` : 'null'},
                 ${options.nonMemberChecklistId ? `'${options.nonMemberChecklistId}'` : 'null'})
         returning code`
      );
      return type.rows[0].code as string;
    }

    it('reads non_member_checklist_id, never checklist_id — a member’s own pack does not leak in', async () => {
      const { config } = await load();

      const idCard = (await config.listDocumentTypes()).find(
        d => d.code === 'id_card'
      )!;
      const utilityBill = (await config.listDocumentTypes()).find(
        d => d.code === 'utility_bill'
      )!;
      const memberList = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s614_member_test', 'S-614 member test', '') returning id`
      );
      const nonMemberList = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s614_nonmember_test', 'S-614 non-member test', '')
         returning id`
      );
      await runAsConfigurator(
        appUrl,
        `insert into document_checklist_item
           (checklist_id, document_type_id, subject, requirement, sort_order)
         values
           ('${memberList.rows[0].id}', '${idCard.id}', 'nominee',
            'required', 1),
           ('${nonMemberList.rows[0].id}', '${utilityBill.id}', 'applicant',
            'required', 1)`
      );
      const code = await typeWithChecklists({
        memberChecklistId: memberList.rows[0].id,
        nonMemberChecklistId: nonMemberList.rows[0].id,
      });

      const applicant = await config.checklistForNonMemberApplicant(code);
      expect(
        [...(applicant.get('applicant') ?? [])].map(i => i.documentCode)
      ).toEqual(['utility_bill']);
      // The member's own checklist (nominee's id_card) never appears — the
      // two are read from different columns entirely.
      expect(applicant.get('nominee')).toBeUndefined();
    });

    it('is empty when no non-member checklist is configured', async () => {
      const { config } = await load();
      const code = await typeWithChecklists({});
      expect(await config.checklistForNonMemberApplicant(code)).toEqual(
        new Map()
      );
    });

    it('unions with the selected account types, required winning', async () => {
      const { config } = await load();

      const certRegistration = (await config.listDocumentTypes()).find(
        d => d.code === 'cert_registration'
      )!;
      const idCard = (await config.listDocumentTypes()).find(
        d => d.code === 'id_card'
      )!;
      const nonMemberList = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s614_union_nonmember_test', 'S-614 union non-member test', '')
         returning id`
      );
      const accountList = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s614_union_account_test', 'S-614 union account test', '')
         returning id`
      );
      await runAsConfigurator(
        appUrl,
        `insert into document_checklist_item
           (checklist_id, document_type_id, subject, requirement, sort_order)
         values
           ('${nonMemberList.rows[0].id}', '${idCard.id}', 'applicant',
            'required', 1),
           ('${accountList.rows[0].id}', '${certRegistration.id}',
            'applicant', 'optional', 1),
           ('${accountList.rows[0].id}', '${idCard.id}', 'applicant',
            'optional', 2)`
      );
      const membershipCode = await typeWithChecklists({
        nonMemberChecklistId: nonMemberList.rows[0].id,
      });
      const accountType = await runAsConfigurator(
        appUrl,
        `insert into account_type
           (code, name, category, checklist_id, is_membership_default)
         values ('s614_account_test', 'S-614 account test', 'savings',
                 '${accountList.rows[0].id}', false)
         returning code`
      );

      const union = await config.checklistForNonMemberAccount(membershipCode, [
        accountType.rows[0].code,
      ]);
      const applicant = union.get('applicant')!;

      // cert_registration comes only from the account type's own checklist.
      expect(
        applicant.find(i => i.documentCode === 'cert_registration')?.requirement
      ).toBe('optional');

      // id_card is required on the non-member checklist; the account type
      // here leaves it optional, and the stricter side still wins.
      const idCardItems = applicant.filter(i => i.documentCode === 'id_card');
      expect(idCardItems).toHaveLength(1);
      expect(idCardItems[0].requirement).toBe('required');
    });

    it('is just the non-member checklist with no account types selected', async () => {
      const { config } = await load();
      const nonMemberList = await runAsConfigurator(
        appUrl,
        `insert into document_checklist (code, name, description)
         values ('s614_solo_test', 'S-614 solo test', '') returning id`
      );
      const code = await typeWithChecklists({
        nonMemberChecklistId: nonMemberList.rows[0].id,
      });

      const applicantOnly = await config.checklistForNonMemberApplicant(code);
      const union = await config.checklistForNonMemberAccount(code, []);
      expect(union).toEqual(applicantOnly);
    });
  });

  // S-614: the non-member checklist is set the same way checklistId and
  // feeScheduleId already are — one function, one form, both persisted or
  // both cleared.
  it('persists the non-member checklist a type uses', async () => {
    const { config } = await load();

    const nonMemberList = await runAsConfigurator(
      appUrl,
      `insert into document_checklist (code, name, description)
       values ('s614_persist_test', 'S-614 persist test', '') returning id`
    );
    const type = (await config.listMembershipTypes()).find(
      t => t.code === 'individual'
    )!;

    await config.setMembershipTypeReferences(
      type.id,
      {
        checklistId: type.checklistId,
        nonMemberChecklistId: nonMemberList.rows[0].id,
        feeScheduleId: type.feeScheduleId,
      },
      actor
    );
    let reloaded = (await config.listMembershipTypes()).find(
      t => t.id === type.id
    )!;
    expect(reloaded.nonMemberChecklistId).toBe(nonMemberList.rows[0].id);

    await config.setMembershipTypeReferences(
      type.id,
      {
        checklistId: type.checklistId,
        nonMemberChecklistId: null,
        feeScheduleId: type.feeScheduleId,
      },
      actor
    );
    reloaded = (await config.listMembershipTypes()).find(
      t => t.id === type.id
    )!;
    expect(reloaded.nonMemberChecklistId).toBeNull();

    // Restore what migration 0028 actually seeds, for whatever runs after
    // this in the same database.
    await config.setMembershipTypeReferences(
      type.id,
      {
        checklistId: type.checklistId,
        nonMemberChecklistId: type.nonMemberChecklistId,
        feeScheduleId: type.feeScheduleId,
      },
      actor
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
    expect(regional!.roleCode).toBe('regional_manager');

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
      expect(step.roleCode).toBeTruthy();
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

    // Containment and order, not an exact list: later milestones legitimately
    // add statuses — M3 adds Draft and Returned for Correction, which FRD
    // 7.4.3 explicitly anticipates — and an exact-list assertion would fail
    // for that rather than for anything being wrong.
    const confirmed = [
      'new',
      'submitted_for_review',
      'submitted_for_approval',
      'approved',
      'rejected',
      'abeyance',
    ];
    const codes = statuses.map(s => s.code);
    expect(codes).toEqual(expect.arrayContaining(confirmed));
    expect(
      confirmed.map(c => codes.indexOf(c)),
      'the FRD 7.4.3 statuses should still read in their documented order'
    ).toEqual([...confirmed.map(c => codes.indexOf(c))].sort((a, b) => a - b));

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
