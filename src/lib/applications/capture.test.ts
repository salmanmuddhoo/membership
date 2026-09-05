// Application capture (M3 Feature 3.1, S-301 to S-303).
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
import type { Principal } from '../access/principal';
import type { PartyValues } from './capture';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `capture_test_${Date.now()}`;
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
// fixture that adds a field directly has to say who it is, exactly as the
// application does through withConfigurationActor.
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

// The pool the last load() built.
//
// Each load() calls vi.resetModules(), which builds a NEW pool on the next
// import. The one it replaces has to be given back: an abandoned pool holds
// its connections until they idle out, and a suite that loads this often then
// exhausts the server's connection slots — which fails as
// "remaining connection slots are reserved", far from the test that caused it.
let openPool: { closePool: () => Promise<void> } | undefined;

async function closeOpenPool() {
  const previous = openPool;
  openPool = undefined;
  await previous?.closePool();
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return {
    capture: await import('./capture'),
    config: await import('../config/reference'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: { userId: string; email: string };
let colleague: { userId: string; email: string };

function principalFor(
  actor: { userId: string; email: string },
  permissions: string[] = ['application.capture']
): Principal {
  return {
    userId: actor.userId,
    entraSubject: `sub-${actor.email}`,
    email: actor.email,
    displayName: actor.email,
    roles: [],
    roleNames: [],
    permissions: new Set(permissions),
  };
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer') returning id`
  );
  officer = { userId: user.rows[0].id, email: 'officer@albarakah.mu' };

  const other = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('colleague@albarakah.mu', 'Colleague') returning id`
  );
  colleague = { userId: other.rows[0].id, email: 'colleague@albarakah.mu' };
}, 60_000);

afterAll(async () => {
  // Before the drop, so the last pool's connections are handed back rather
  // than terminated out from under it.
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('S-303: a unique reference per application', () => {
  it('allocates one on creation, and never the same twice', async () => {
    const { capture } = await load();

    const a = await capture.startApplication('individual', officer);
    const b = await capture.startApplication('individual', officer);

    expect(a.reference).toMatch(/^APP-\d{4}-\d{6}$/);
    expect(b.reference).not.toBe(a.reference);

    const clash = await run(
      appUrl,
      `select count(*) - count(distinct reference) as duplicates
         from membership_application`
    );
    expect(clash.rows[0].duplicates).toBe('0');
  });
});

describe('an application exists once a detail does, and not before', () => {
  // Opening the capture form is not starting an application. An officer who
  // taps Capture, sees it is the wrong applicant and closes the tab must leave
  // nothing behind — no reference spent, no row in the list, no draft for
  // somebody to delete.
  const blank = (): PartyValues[] => [
    {
      subject: 'applicant' as const,
      ordinal: 1,
      values: { surname: '', name: '', nic: '' },
    },
    { subject: 'nominee' as const, ordinal: 1, values: { name: '' } },
  ];

  it('creates nothing at all from an empty form', async () => {
    const { capture } = await load();

    const before = await run(
      appUrl,
      'select count(*)::int as n from membership_application'
    );

    const created = await capture.startApplicationWithValues(
      'individual',
      blank(),
      officer
    );
    expect(created).toBeNull();

    const after = await run(
      appUrl,
      'select count(*)::int as n from membership_application'
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // And no reference was spent, which is the part a later audit would ask
    // about: a gap in APP-2026-xxxxxx that nothing explains.
    const audited = await run(
      appUrl,
      `select count(*)::int as n from audit_event
        where action = 'membership.application.started'`
    );
    expect(audited.rows[0].n).toBe(before.rows[0].n);
  });

  it('treats whitespace as nothing typed', async () => {
    const { capture } = await load();
    const parties = blank();
    parties[0].values.surname = '   ';

    expect(
      await capture.startApplicationWithValues('individual', parties, officer)
    ).toBeNull();
  });

  it('creates it, with the value, from the first thing typed', async () => {
    const { capture } = await load();
    const parties = blank();
    parties[0].values.surname = 'Beebee';

    const created = await capture.startApplicationWithValues(
      'individual',
      parties,
      officer
    );

    expect(created).not.toBeNull();
    expect(created!.reference).toMatch(/^APP-\d{4}-\d{6}$/);

    // The value is there, not lost in the round trip that created the row.
    const application = await capture.loadApplication(created!.id);
    expect(application!.status).toBe('draft');
    expect(
      application!.parties.find(p => p.subject === 'applicant')!.values.surname
    ).toBe('Beebee');

    // Every subject the type configures still has its row, so the form the
    // officer carries on typing into is the same form.
    expect(application!.parties.map(p => p.subject).sort()).toEqual([
      'applicant',
      'employment',
      'nominee',
    ]);
  });

  it('refuses a type that is not being accepted, before creating anything', async () => {
    const { capture } = await load();
    const parties = blank();
    parties[0].values.surname = 'Someone';

    await expect(
      capture.startApplicationWithValues('no_such_type', parties, officer)
    ).rejects.toThrow(/Unknown membership type/);
  });
});

describe('S-301: the form comes from the configuration, not from code', () => {
  it('creates a party for every subject the type configures', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('minor', officer);

    const application = await capture.loadApplication(id);
    // A minor's application collects four people (FRD 7.10). Nothing in the
    // capture code knows that — membership_type_field does.
    expect(application!.parties.map(p => p.subject).sort()).toEqual([
      'applicant',
      'beneficiary',
      'guardian',
      'nominee',
    ]);
  });

  it('renders Corporate differently from Individual because the config differs', async () => {
    const { capture, config } = await load();
    const types = await config.listMembershipTypes();

    const individual = capture.visibleFields(
      types.find(t => t.code === 'individual')!
    );
    const corporate = capture.visibleFields(
      types.find(t => t.code === 'corporate')!
    );

    const keys = (m: Map<string, { fieldKey: string }[]>, s: string) =>
      (m.get(s) ?? []).map(f => f.fieldKey);

    expect(keys(individual, 'applicant')).toContain('nic');
    expect(keys(corporate, 'applicant')).not.toContain('nic');
    expect(keys(corporate, 'applicant')).toContain('registration_no');
  });

  it('drops a field an administrator has hidden', async () => {
    const { capture, config } = await load();
    const types = await config.listMembershipTypes();
    const individual = types.find(t => t.code === 'individual')!;
    const telephone = individual.fields.find(
      f => f.subject === 'applicant' && f.fieldKey === 'telephone'
    )!;

    await config.setFieldRule(
      telephone.id,
      { isVisible: false, isMandatory: false },
      officer
    );

    const after = (await config.listMembershipTypes()).find(
      t => t.code === 'individual'
    )!;
    const shown = capture
      .visibleFields(after)
      .get('applicant')!
      .map(f => f.fieldKey);
    expect(shown).not.toContain('telephone');

    await config.setFieldRule(
      telephone.id,
      { isVisible: true, isMandatory: false },
      officer
    );
  });

  it('names every missing mandatory field, not just the first', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);

    // FRD 5.1 makes surname, name, NIC, gender, address and mobile mandatory
    // for the applicant, plus the nominee block.
    const applicantKeys = problems
      .filter(p => p.subject === 'applicant')
      .map(p => p.fieldKey)
      .sort();
    expect(applicantKeys).toEqual([
      'address',
      'gender',
      'mobile',
      'name',
      'nic',
      'surname',
    ]);
    expect(problems.some(p => p.subject === 'nominee')).toBe(true);

    // Every one carries the label the form shows, so the message can name the
    // box rather than the column.
    expect(problems.every(p => p.label.length > 0)).toBe(true);
  });

  it('reports nothing once the mandatory fields are filled in', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: {
            surname: 'Beebeejaun',
            name: 'Aisha',
            nic: 'B1234567890123',
            gender: 'Female',
            address: '12 Royal Road, Curepipe',
            mobile: '5789 1234',
          },
        },
        {
          subject: 'nominee',
          ordinal: 1,
          values: {
            surname: 'Beebeejaun',
            name: 'Yusuf',
            nic: 'B9876543210987',
            address: '12 Royal Road, Curepipe',
          },
        },
      ],
      officer
    );

    const application = await capture.loadApplication(id);
    expect(await capture.problemsBlockingSubmission(application!)).toEqual([]);
  });
});

// A member row this test can point a guardian at, with a real applicant NIC
// behind it — findGuardianMember() joins back to that party, since NIC is
// not a column on `member` itself (FRD 7.10.2: found by Member No. or NIC).
async function seedMember(
  nic: string,
  status: 'active' | 'inactive' = 'active',
  applicant: { surname?: string; name?: string } = {}
): Promise<{ memberNo: string; applicationId: string }> {
  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by)
     values ($1, $2) returning id`,
    [type.rows[0].id, officer.userId]
  );
  const applicationId = application.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [
      applicationId,
      JSON.stringify({
        nic,
        surname: applicant.surname ?? 'Ramdin',
        name: applicant.name ?? 'Farah',
      }),
    ]
  );
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id, status)
     values ($1, $2, $3) returning member_no`,
    [applicationId, type.rows[0].id, status]
  );
  return { memberNo: member.rows[0].member_no, applicationId };
}

describe('S-604/S-605: a minor’s guardian must be a real, findable person', () => {
  const minorParties = (
    guardian: Record<string, string> = {}
  ): PartyValues[] => [
    {
      subject: 'applicant',
      ordinal: 1,
      values: {
        surname: 'Ramdin',
        name: 'Zaid',
        date_of_birth: '2015-01-01',
        gender: 'Male',
        address: '4 Pope Hennessy Street, Port Louis',
      },
    },
    {
      subject: 'guardian' as const,
      ordinal: 1,
      values: {
        surname: 'Ramdin',
        name: 'Farah',
        nic: 'G0000000000000',
        relationship: 'Mother',
        mobile: '5789 1234',
        ...guardian,
      },
    },
    {
      subject: 'nominee' as const,
      ordinal: 1,
      values: { surname: 'Peerthum', name: 'Ismail', nic: 'H1111111111111' },
    },
    {
      subject: 'beneficiary' as const,
      ordinal: 1,
      values: { surname: 'Ramdin', name: 'Zaid' },
    },
  ];

  it('blocks submission when the named guardian matches nobody', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('minor', officer);
    await capture.saveDraft(
      id,
      minorParties({ member_id: 'AB9999', nic: 'X0000000000000' }),
      officer
    );

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);

    const guardianProblem = problems.find(
      p => p.subject === 'guardian' && p.fieldKey === 'member_id'
    );
    expect(guardianProblem?.label).toMatch(/must join as a member first/);
  });

  it('passes once the Member No. resolves to an active member', async () => {
    const { capture } = await load();
    const { memberNo } = await seedMember('S2222222222222');

    const { id } = await capture.startApplication('minor', officer);
    await capture.saveDraft(
      id,
      minorParties({ member_id: memberNo, nic: 'not-the-lookup' }),
      officer
    );

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);
    expect(
      problems.some(p => p.subject === 'guardian' && p.fieldKey === 'member_id')
    ).toBe(false);
  });

  it('resolves by NIC when the Member No. given does not match', async () => {
    const { capture } = await load();
    await seedMember('S3333333333333');

    const { id } = await capture.startApplication('minor', officer);
    await capture.saveDraft(
      id,
      // Member No. is mandatory on its own (any blank is already reported as
      // a missing field), so this is the case the "or NIC" wording actually
      // covers: a wrong or unknown Member No., correct NIC.
      minorParties({ member_id: 'AB0000', nic: 'S3333333333333' }),
      officer
    );

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);
    expect(
      problems.some(p => p.subject === 'guardian' && p.fieldKey === 'member_id')
    ).toBe(false);
  });

  it('still blocks when the matched member is not active', async () => {
    const { capture } = await load();
    const { memberNo } = await seedMember('S4444444444444', 'inactive');

    const { id } = await capture.startApplication('minor', officer);
    await capture.saveDraft(id, minorParties({ member_id: memberNo }), officer);

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);
    const guardianProblem = problems.find(
      p => p.subject === 'guardian' && p.fieldKey === 'member_id'
    );
    expect(guardianProblem?.label).toMatch(/not an active member/);
  });

  // The whole point of the relaxation: a parent and their minor can join at
  // the same visit, the parent's own application not yet anywhere near a
  // decision — the minor's should not have to wait for that.
  it('passes when the guardian is an Individual application still in progress', async () => {
    const { capture } = await load();
    const parentActor = { userId: officer.userId, email: officer.email };
    const { id: parentApplicationId } = await capture.startApplication(
      'individual',
      parentActor
    );
    await capture.saveDraft(
      parentApplicationId,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Ramdin', name: 'Farah', nic: 'G1231231231230' },
        },
      ],
      parentActor
    );
    const parentApplication =
      await capture.loadApplication(parentApplicationId);

    const { id } = await capture.startApplication('minor', officer);
    await capture.saveDraft(
      id,
      minorParties({
        member_id: parentApplication!.reference,
        nic: 'not-the-lookup',
      }),
      officer
    );

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);
    expect(
      problems.some(p => p.subject === 'guardian' && p.fieldKey === 'member_id')
    ).toBe(false);
  });

  it('still blocks when the guardian’s own application was rejected', async () => {
    const { capture } = await load();
    const parentActor = { userId: officer.userId, email: officer.email };
    const { id: parentApplicationId } = await capture.startApplication(
      'individual',
      parentActor
    );
    await capture.saveDraft(
      parentApplicationId,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Auckbur', name: 'Imran', nic: 'G4564564564560' },
        },
      ],
      parentActor
    );
    await run(
      appUrl,
      `update membership_application set status = 'rejected' where id = $1`,
      [parentApplicationId]
    );
    const parentApplication =
      await capture.loadApplication(parentApplicationId);

    const { id } = await capture.startApplication('minor', officer);
    await capture.saveDraft(
      id,
      minorParties({ member_id: parentApplication!.reference }),
      officer
    );

    const application = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(application!);
    const guardianProblem = problems.find(
      p => p.subject === 'guardian' && p.fieldKey === 'member_id'
    );
    expect(guardianProblem?.label).toMatch(/must join as a member first/);
  });
});

describe('finding a parent to link, before or after they are a member', () => {
  it('finds an active member by name, NIC or Member No.', async () => {
    const { capture } = await load();
    const { memberNo } = await seedMember('S6666666666666', 'active', {
      surname: 'Peerthum',
      name: 'Devendra',
    });

    for (const term of ['peerthum', 'S6666666666666', memberNo]) {
      const candidates = await capture.searchGuardianCandidates(term);
      expect(
        candidates.some(c => c.kind === 'member' && c.reference === memberNo),
        term
      ).toBe(true);
    }
  });

  // The point of the whole feature: a parent registering alongside their
  // minor has no Member No. yet, and has to be findable anyway.
  it('finds an Individual application still in progress, by name or NIC', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Joomun', name: 'Nadia', nic: 'S7777777777777' },
        },
      ],
      officer
    );
    const application = await capture.loadApplication(id);

    const candidates = await capture.searchGuardianCandidates('joomun');
    const found = candidates.find(c => c.reference === application!.reference);
    expect(found).toMatchObject({
      kind: 'application',
      surname: 'Joomun',
      name: 'Nadia',
      nic: 'S7777777777777',
    });
  });

  // S-604 follow-up: picking a result fills in the guardian's mobile too,
  // so this is the one field left for the officer to type by hand otherwise.
  it('carries the mobile number through, for the guardian block to fill in', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: {
            surname: 'Domun',
            name: 'Kavi',
            nic: 'S1112223334440',
            mobile: '5789 4321',
          },
        },
      ],
      officer
    );
    const application = await capture.loadApplication(id);

    const candidates = await capture.searchGuardianCandidates('domun');
    const found = candidates.find(c => c.reference === application!.reference);
    // Stored in E.164 (S-301) by the time it is saved, which is what a pick
    // fills the guardian's own mobile field in with.
    expect(found?.mobile).toBe('+23057894321');
  });

  it('does not offer a rejected application — it will never become a member', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Auckbur', name: 'Imran', nic: 'S8888888888888' },
        },
      ],
      officer
    );
    await run(
      appUrl,
      `update membership_application set status = 'rejected' where id = $1`,
      [id]
    );

    const candidates = await capture.searchGuardianCandidates('auckbur');
    expect(candidates).toEqual([]);
  });

  it('does not offer an approved application twice — the member row already covers it', async () => {
    const { capture } = await load();
    const { memberNo, applicationId } = await seedMember(
      'S9999999999999',
      'active',
      { surname: 'Ah-Kong', name: 'Li' }
    );
    await run(
      appUrl,
      `update membership_application set status = 'approved' where id = $1`,
      [applicationId]
    );

    try {
      const candidates = await capture.searchGuardianCandidates('ah-kong');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: 'member',
        reference: memberNo,
      });
    } finally {
      // Other tests in this file (the application list) assume theirs is the
      // only 'approved' row in the shared database — put this one back.
      await run(
        appUrl,
        `update membership_application set status = 'draft' where id = $1`,
        [applicationId]
      );
    }
  });

  it('returns nothing for a blank search rather than the whole register', async () => {
    const { capture } = await load();
    expect(await capture.searchGuardianCandidates('  ')).toEqual([]);
  });
});

describe('S-602: as many nominee rows as the type configures', () => {
  it('creates one application_party row per nominee ordinal', async () => {
    const { capture, config } = await load();
    const individual = (await config.listMembershipTypes()).find(
      t => t.code === 'individual'
    )!;

    await config.setNomineeCount(individual.id, 3, officer);
    try {
      const { id } = await capture.startApplication('individual', officer);
      const application = await capture.loadApplication(id);
      const nominees = application!.parties
        .filter(p => p.subject === 'nominee')
        .map(p => p.ordinal)
        .sort();
      expect(nominees).toEqual([1, 2, 3]);
    } finally {
      await config.setNomineeCount(individual.id, 1, officer);
    }
  });

  it('names a missing mandatory field left blank on the first nominee', async () => {
    const { capture, config } = await load();
    const individual = (await config.listMembershipTypes()).find(
      t => t.code === 'individual'
    )!;

    await config.setNomineeCount(individual.id, 2, officer);
    try {
      const { id } = await capture.startApplication('individual', officer);
      await capture.saveDraft(
        id,
        [
          {
            subject: 'nominee',
            ordinal: 1,
            values: {
              surname: 'Ramtohul',
              name: 'Devi',
              nic: 'S1231231231231',
              address: '4 Pope Hennessy Street, Curepipe',
            },
          },
          // Ordinal 2 is left entirely blank.
        ],
        officer
      );
      const application = await capture.loadApplication(id);
      const problems = await capture.problemsBlockingSubmission(application!);

      expect(
        problems.some(p => p.subject === 'nominee' && p.ordinal === 1)
      ).toBe(false);
      // The second nominee is optional (below) — leaving it blank is not
      // reported here at all.
      expect(
        problems.some(p => p.subject === 'nominee' && p.ordinal === 2)
      ).toBe(false);
    } finally {
      await config.setNomineeCount(individual.id, 1, officer);
    }
  });

  it('only the first nominee is mandatory — the rest may be left blank', async () => {
    const { capture, config } = await load();
    const individual = (await config.listMembershipTypes()).find(
      t => t.code === 'individual'
    )!;

    await config.setNomineeCount(individual.id, 3, officer);
    try {
      // Nothing typed at all — every nominee row starts empty.
      const { id } = await capture.startApplication('individual', officer);
      const application = await capture.loadApplication(id);
      const problems = await capture.problemsBlockingSubmission(application!);

      // FRD 5.3's "one or more Nominees where configured" reads as at least
      // one — the first nominee's mandatory fields still block submission.
      expect(
        problems.some(p => p.subject === 'nominee' && p.ordinal === 1)
      ).toBe(true);
      // The second and third are optional: blank is not a problem.
      expect(
        problems.some(p => p.subject === 'nominee' && p.ordinal === 2)
      ).toBe(false);
      expect(
        problems.some(p => p.subject === 'nominee' && p.ordinal === 3)
      ).toBe(false);
    } finally {
      await config.setNomineeCount(individual.id, 1, officer);
    }
  });
});

describe('S-602: nominee percentages, only where the type asks for them', () => {
  let typeId: string;

  beforeAll(async () => {
    const { config } = await load();
    typeId = (await config.listMembershipTypes()).find(
      t => t.code === 'individual'
    )!.id;

    // Adding a mandatory 'percentage' field is what turns the rule on — no
    // separate flag, per capture.ts.
    await runAsConfigurator(
      ownerUrl,
      `insert into membership_type_field
         (membership_type_id, field_key, label, data_type, subject,
          is_visible, is_mandatory, sort_order)
       select '${typeId}', 'percentage', 'Percentage', 'number', 'nominee',
              true, true, 99`
    );
    const { config: cfg } = await load();
    await cfg.setNomineeCount(typeId, 2, officer);
  });

  afterAll(async () => {
    const { config } = await load();
    await config.setNomineeCount(typeId, 1, officer);
    await runAsConfigurator(
      ownerUrl,
      `delete from membership_type_field
        where membership_type_id = '${typeId}' and field_key = 'percentage'`
    );
  });

  async function draftWithPercentages(
    percentages: (string | undefined)[]
  ): Promise<import('./capture').Application> {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await capture.saveDraft(
      id,
      percentages.map((percentage, i) => ({
        subject: 'nominee' as const,
        ordinal: i + 1,
        values: {
          surname: `Nominee${i + 1}`,
          name: 'Test',
          nic: `S000000000000${i}`,
          address: 'Curepipe',
          ...(percentage === undefined ? {} : { percentage }),
        },
      })),
      officer
    );
    return (await capture.loadApplication(id))!;
  }

  it('blocks submission when the split does not add up to 100', async () => {
    const { capture } = await load();
    const application = await draftWithPercentages(['40', '40']);

    const problems = await capture.problemsBlockingSubmission(application);
    expect(
      problems.some(p => p.subject === 'nominee' && p.fieldKey === 'percentage')
    ).toBe(true);
  });

  it('lets it through once the split is exactly 100', async () => {
    const { capture } = await load();
    const application = await draftWithPercentages(['60', '40']);

    const problems = await capture.problemsBlockingSubmission(application);
    expect(
      problems.some(p => p.subject === 'nominee' && p.fieldKey === 'percentage')
    ).toBe(false);
  });

  it('says nothing about the total while the second nominee has not entered one yet', async () => {
    const { capture } = await load();
    // The second nominee is optional (S-602 relaxed) — leaving its
    // percentage blank is not a missing-field problem of its own, and with
    // the split still incomplete there is nothing to total either.
    const application = await draftWithPercentages(['60', undefined]);

    const problems = await capture.problemsBlockingSubmission(application);
    const percentageProblems = problems.filter(
      p => p.subject === 'nominee' && p.fieldKey === 'percentage'
    );
    expect(percentageProblems).toHaveLength(0);
  });

  it('is inert for a type that never configured the field', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('minor', officer);

    // The minor type's own nominee fields, filled in without a percentage —
    // untouched by a rule that lives on a different type entirely.
    await capture.saveDraft(
      id,
      [
        {
          subject: 'nominee',
          ordinal: 1,
          values: {
            surname: 'Beebeejaun',
            name: 'Yusuf',
            nic: 'S4564564564564',
            address: 'Curepipe',
          },
        },
      ],
      officer
    );
    const after = await capture.loadApplication(id);
    const problems = await capture.problemsBlockingSubmission(after!);
    expect(
      problems.some(p => p.subject === 'nominee' && p.fieldKey === 'percentage')
    ).toBe(false);
  });
});

describe('S-301: mobile numbers are stored in full international form', () => {
  it('converts on save, so what is stored is what M9 can send to', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await capture.saveDraft(
      id,
      [{ subject: 'applicant', ordinal: 1, values: { mobile: '5789 1234' } }],
      officer
    );

    const stored = await run(
      appUrl,
      `select values->>'mobile' as mobile from application_party
        where application_id = $1 and subject = 'applicant'`,
      [id]
    );
    expect(stored.rows[0].mobile).toBe('+23057891234');
  });

  it('reports a number it cannot place without discarding what was typed', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    const { problems } = await capture.saveDraft(
      id,
      [{ subject: 'applicant', ordinal: 1, values: { mobile: '12345' } }],
      officer
    );

    expect(problems.map(p => p.fieldKey)).toContain('mobile');

    // The officer's own input survives, so they can see and correct it. Saving
    // an empty box would lose what they typed and tell them nothing.
    const stored = await run(
      appUrl,
      `select values->>'mobile' as mobile from application_party
        where application_id = $1 and subject = 'applicant'`,
      [id]
    );
    expect(stored.rows[0].mobile).toBe('12345');
  });
});

describe('S-302: a draft survives whatever happens to the browser', () => {
  it('keeps a half-filled form, missing mandatory fields and all', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    // The officer types two fields and the tablet loses its connection.
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Ramjaun', name: 'Idris' },
        },
      ],
      officer
    );

    // They come back later. Nothing about the save required the form to be
    // complete — that check belongs at submission.
    const reopened = await capture.loadApplication(id);
    const applicant = reopened!.parties.find(p => p.subject === 'applicant')!;
    expect(applicant.values.surname).toBe('Ramjaun');
    expect(applicant.values.name).toBe('Idris');
    expect(reopened!.status).toBe('draft');
  });

  it('replaces values rather than accumulating them', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Typo', name: 'Idris' },
        },
      ],
      officer
    );
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Ramjaun', name: 'Idris' },
        },
      ],
      officer
    );

    const applicant = (await capture.loadApplication(id))!.parties.find(
      p => p.subject === 'applicant'
    )!;
    expect(applicant.values.surname).toBe('Ramjaun');
  });

  it('clears a field the officer emptied', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await capture.saveDraft(
      id,
      [{ subject: 'applicant', ordinal: 1, values: { nic: 'B1111111111111' } }],
      officer
    );
    // Deleting the contents of a box must delete the value. Merging instead of
    // replacing would make a wrong NIC impossible to remove.
    await capture.saveDraft(
      id,
      [{ subject: 'applicant', ordinal: 1, values: { nic: '' } }],
      officer
    );

    const applicant = (await capture.loadApplication(id))!.parties.find(
      p => p.subject === 'applicant'
    )!;
    expect(applicant.values.nic).toBeUndefined();
  });

  it('saves a normalised number idempotently across repeated autosaves', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    for (let i = 0; i < 3; i += 1) {
      const current = (await capture.loadApplication(id))!.parties.find(
        p => p.subject === 'applicant'
      )!;
      // Autosave posts back whatever is in the form, which after the first
      // save is the already-normalised value.
      await capture.saveDraft(
        id,
        [
          {
            subject: 'applicant',
            ordinal: 1,
            values: { mobile: current.values.mobile ?? '5789 1234' },
          },
        ],
        officer
      );
    }

    const applicant = (await capture.loadApplication(id))!.parties.find(
      p => p.subject === 'applicant'
    )!;
    expect(applicant.values.mobile).toBe('+23057891234');
  });

  it('refuses to edit an application that has left regional hands (S-304)', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await run(
      appUrl,
      `update membership_application set status = 'new' where id = $1`,
      [id]
    );

    await expect(
      capture.saveDraft(
        id,
        [{ subject: 'applicant', ordinal: 1, values: { name: 'Late edit' } }],
        officer
      )
    ).rejects.toThrowError(/no longer be edited/);
  });

  it('allows editing again once it has been returned for correction', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await run(
      appUrl,
      `update membership_application set status = 'returned' where id = $1`,
      [id]
    );

    await expect(
      capture.saveDraft(
        id,
        [{ subject: 'applicant', ordinal: 1, values: { name: 'Corrected' } }],
        officer
      )
    ).resolves.toBeDefined();
  });
});

describe('the application list staff work from', () => {
  it('shows the applicant by name once one has been typed', async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startApplication(
      'individual',
      officer
    );
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { name: 'Fatimah', surname: 'Joomun' },
        },
      ],
      officer
    );

    const listed = (
      await capture.listApplications({ capturedBy: officer.userId })
    ).find(a => a.reference === reference)!;
    expect(listed.applicantName).toBe('Fatimah Joomun');
  });

  // Officer feedback: finding one applicant among many by scrolling and
  // sorting was the only way to do it.
  it('searches by applicant name or reference', async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startApplication(
      'individual',
      officer
    );
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { name: 'Zahra', surname: 'Ramtoola' },
        },
      ],
      officer
    );

    const byName = await capture.listApplications({ search: 'ramtoola' });
    expect(byName.some(a => a.id === id)).toBe(true);

    const byReference = await capture.listApplications({
      search: reference,
    });
    expect(byReference.map(a => a.id)).toEqual([id]);

    const noMatch = await capture.listApplications({
      search: 'no such applicant',
    });
    expect(noMatch.some(a => a.id === id)).toBe(false);
  });

  it('says so rather than showing a blank when nothing is typed yet', async () => {
    const { capture } = await load();
    const { reference } = await capture.startApplication('corporate', officer);

    const listed = (await capture.listApplications({})).find(
      a => a.reference === reference
    )!;
    expect(listed.applicantName).toBe('(no name yet)');
  });

  it('filters by status', async () => {
    const { capture } = await load();
    const drafts = await capture.listApplications({ statuses: ['draft'] });
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every(a => a.status === 'draft')).toBe(true);

    expect(await capture.listApplications({ statuses: ['approved'] })).toEqual(
      []
    );
  });

  // Officer feedback: "if an application is of status Approved, it
  // shouldn't be displayed anymore in the application page — it's already
  // visible in the member page." Unconditional, not just the default view:
  // even asking for it by name finds nothing.
  it('never shows an approved application, even when asked for by status', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await run(
      appUrl,
      `update membership_application set status = 'approved' where id = $1`,
      [id]
    );

    expect(
      (await capture.listApplications({})).find(a => a.id === id)
    ).toBeUndefined();
    expect(
      (await capture.listApplications({ statuses: ['approved'] })).find(
        a => a.id === id
      )
    ).toBeUndefined();
  });

  // Officer feedback: "only the officer that filled in that form should see
  // those draft status applications" — every other status stays visible to
  // whoever already holds application.view, this narrows drafts alone.
  it("hides another officer's draft from a viewer, but shows the officer their own", async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startApplication(
      'individual',
      officer
    );

    const forColleague = await capture.listApplications({
      viewerUserId: colleague.userId,
    });
    expect(forColleague.find(a => a.id === id)).toBeUndefined();

    const forOfficer = await capture.listApplications({
      viewerUserId: officer.userId,
    });
    expect(forOfficer.find(a => a.id === id)?.reference).toBe(reference);

    // No viewer named at all (the option omitted) is the old, unnarrowed
    // behaviour — still available to a caller that means to see every draft.
    const unfiltered = await capture.listApplications({});
    expect(unfiltered.find(a => a.id === id)?.reference).toBe(reference);
  });

  it('does not hide a non-draft application from another officer', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await run(
      appUrl,
      `update membership_application set status = 'submitted_for_review'
        where id = $1`,
      [id]
    );

    const forColleague = await capture.listApplications({
      viewerUserId: colleague.userId,
    });
    expect(forColleague.find(a => a.id === id)).toBeDefined();
  });

  // Officer feedback: the Applications page's own count of "how many
  // applications there is" — draft and approved both excluded, the same
  // universe listApplications itself shows (drafts are the capturing
  // officer's own work in progress; approved ones already live on the
  // Members page).
  describe('countApplications: how many, once drafts and approvals are set aside', () => {
    it('excludes drafts and approved applications from the count', async () => {
      const { capture } = await load();
      const before = await capture.countApplications({});

      const draft = await capture.startApplication('individual', officer);
      expect(await capture.countApplications({})).toBe(before);

      await run(
        appUrl,
        `update membership_application set status = 'submitted_for_review'
          where id = $1`,
        [draft.id]
      );
      expect(await capture.countApplications({})).toBe(before + 1);

      await run(
        appUrl,
        `update membership_application set status = 'approved' where id = $1`,
        [draft.id]
      );
      expect(await capture.countApplications({})).toBe(before);
    });

    it('respects a status filter, still excluding drafts and approvals', async () => {
      const { capture } = await load();
      const { id } = await capture.startApplication('individual', officer);
      await run(
        appUrl,
        `update membership_application set status = 'rejected' where id = $1`,
        [id]
      );

      const rejectedCount = await capture.countApplications({
        statuses: ['rejected'],
      });
      const rejectedRows = await capture.listApplications({
        statuses: ['rejected'],
        limit: 1000,
      });
      expect(rejectedCount).toBe(rejectedRows.length);
      expect(rejectedRows.some(a => a.id === id)).toBe(true);

      // Asked for by name, draft and approved still count as zero.
      expect(await capture.countApplications({ statuses: ['draft'] })).toBe(0);
      expect(await capture.countApplications({ statuses: ['approved'] })).toBe(
        0
      );
    });
  });
});

describe('deleting a draft that is no longer needed', () => {
  const noFiles = async () => {
    throw new Error('SharePoint should not have been asked to delete anything');
  };

  it("removes the officer's own draft, and everything hanging off it", async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startApplication(
      'individual',
      officer
    );
    await capture.saveDraft(
      id,
      [{ subject: 'applicant', ordinal: 1, values: { name: 'Fatima' } }],
      officer
    );

    const result = await capture.deleteDraftApplication(
      id,
      principalFor(officer),
      noFiles
    );
    expect(result.reference).toBe(reference);

    expect(await capture.loadApplication(id)).toBeNull();
    const parties = await run(
      appUrl,
      'select count(*)::int as n from application_party where application_id = $1',
      [id]
    );
    expect(parties.rows[0].n).toBe(0);
  });

  it('leaves a record of the deletion without keeping what was captured', async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startApplication(
      'individual',
      officer
    );
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { name: 'Yusuf', nic: 'Y1234567890123' },
        },
      ],
      officer
    );

    await capture.deleteDraftApplication(id, principalFor(officer), noFiles);

    const audit = await run(
      appUrl,
      `select actor_user_id, previous_value
         from audit_event
        where action = 'membership.application.deleted' and entity_id = $1`,
      [id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBe(officer.userId);
    expect(audit.rows[0].previous_value).toMatchObject({
      reference,
      membershipType: 'individual',
      status: 'draft',
    });
    // The reason for deleting an abandoned draft is not to go on holding the
    // applicant's details in a log that cannot be edited afterwards.
    expect(JSON.stringify(audit.rows[0].previous_value)).not.toContain(
      'Y1234567890123'
    );
  });

  // Any capture-holder may discard any draft, whoever began it. What is
  // recorded is who did it.
  it('lets a colleague delete a draft they did not start', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await capture.deleteDraftApplication(id, principalFor(colleague), noFiles);

    expect(await capture.loadApplication(id)).toBeNull();
    const audit = await run(
      appUrl,
      `select actor_user_id from audit_event
        where action = 'membership.application.deleted' and entity_id = $1`,
      [id]
    );
    expect(audit.rows[0].actor_user_id).toBe(colleague.userId);
  });

  it('refuses someone who may not capture applications at all', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);

    await expect(
      capture.deleteDraftApplication(id, principalFor(officer, []), noFiles)
    ).rejects.toThrow(/permission/i);
    expect(await capture.loadApplication(id)).not.toBeNull();
  });

  it('refuses an application that has been submitted', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await run(
      appUrl,
      `update membership_application set status = 'new' where id = $1`,
      [id]
    );

    await expect(
      capture.deleteDraftApplication(id, principalFor(officer), noFiles)
    ).rejects.toThrow(/only a draft/i);
    expect(await capture.loadApplication(id)).not.toBeNull();
  });

  // A returned application is editable, exactly like a draft, so this is the
  // distinction most likely to be got wrong: it has been through the Secretary
  // and that history is not the officer's to throw away.
  it('refuses a returned application even though it can still be edited', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await run(
      appUrl,
      `update membership_application set status = 'returned' where id = $1`,
      [id]
    );

    await expect(
      capture.deleteDraftApplication(id, principalFor(officer), noFiles)
    ).rejects.toThrow(/only a draft/i);
    expect(await capture.loadApplication(id)).not.toBeNull();
  });

  it('refuses anything that already has a transition behind it', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await run(
      appUrl,
      `insert into application_transition
         (application_id, from_status, to_status, actor_user_id)
       values ($1, 'draft', 'draft', $2)`,
      [id, officer.userId]
    );

    await expect(
      capture.deleteDraftApplication(id, principalFor(officer), noFiles)
    ).rejects.toThrow(/already been acted on/i);
  });

  // The service check above is a courteous message. This is the guarantee:
  // history cannot be laundered by deleting the record it hangs off, whatever
  // code asks for it.
  it('cannot be talked into it by going round the service', async () => {
    const { capture } = await load();
    const { id } = await capture.startApplication('individual', officer);
    await run(
      appUrl,
      `insert into application_transition
         (application_id, from_status, to_status, actor_user_id)
       values ($1, 'draft', 'new', $2)`,
      [id, officer.userId]
    );

    await expect(
      run(appUrl, 'delete from membership_application where id = $1', [id])
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  describe('the files that were filed against it', () => {
    async function draftWithADocument() {
      const { capture } = await load();
      const { id, reference } = await capture.startApplication(
        'individual',
        officer
      );
      const document = await run(
        appUrl,
        `insert into document (document_type_id, subject, application_id, state)
         select id, 'applicant', $1, 'uploaded' from document_type
          where code = 'id_card' returning id`,
        [id]
      );
      await run(
        appUrl,
        `insert into document_version
           (document_id, version_no, state, file_name, content_type,
            size_bytes, sharepoint_path, uploaded_by)
         values ($1, 1, 'committed', 'nic.jpg', 'image/jpeg', 1024, $2, $3)`,
        [
          document.rows[0].id,
          `Applications/${reference}/nic.jpg`,
          officer.userId,
        ]
      );
      return { capture, id, reference };
    }

    it('are removed too, so no scan is left behind unaccounted for', async () => {
      const { capture, id, reference } = await draftWithADocument();

      const discarded: string[] = [];
      await capture.deleteDraftApplication(
        id,
        principalFor(officer),
        async r => {
          discarded.push(r);
        }
      );

      expect(discarded).toEqual([reference]);
      expect(await capture.loadApplication(id)).toBeNull();
    });

    it('keep the application alive if they cannot be removed', async () => {
      const { capture, id } = await draftWithADocument();

      await expect(
        capture.deleteDraftApplication(id, principalFor(officer), async () => {
          throw new Error('Graph delete failed for the folder (503)');
        })
      ).rejects.toThrow(/503/);

      // Nothing half-done: the row, its parties and the audit entry are all
      // still as they were, so the officer can try again.
      expect(await capture.loadApplication(id)).not.toBeNull();
      const audit = await run(
        appUrl,
        `select count(*)::int as n from audit_event
          where action = 'membership.application.deleted' and entity_id = $1`,
        [id]
      );
      expect(audit.rows[0].n).toBe(0);
    });
  });
});

describe('S-612: additional-account applications share the table, not the type', () => {
  // Phase 1 of the additional-account feature (migration 0025) is schema
  // only — no code yet creates one of these rows, so this exercises the
  // database's own constraint directly rather than through capture.ts.
  it('accepts a typeless application once it names an existing member', async () => {
    const { memberNo } = await seedMember('S9999999999999');
    const member = await run(
      appUrl,
      `select id from member where member_no = $1`,
      [memberNo]
    );

    const application = await run(
      appUrl,
      `insert into membership_application
         (application_kind, existing_member_id, captured_by)
       values ('additional_account', $1, $2)
       returning id, membership_type_id`,
      [member.rows[0].id, officer.userId]
    );
    expect(application.rows[0].membership_type_id).toBeNull();
  });

  it('refuses an additional_account row with no member named', async () => {
    await expect(
      run(
        appUrl,
        `insert into membership_application (application_kind, captured_by)
         values ('additional_account', $1)`,
        [officer.userId]
      )
    ).rejects.toThrowError(/membership_application_kind_shape/);
  });

  it('refuses a membership row with no type, same as it always has', async () => {
    await expect(
      run(
        appUrl,
        `insert into membership_application (captured_by) values ($1)`,
        [officer.userId]
      )
    ).rejects.toThrowError(/membership_application_kind_shape/);
  });

  it('refuses a membership row that also names an existing member', async () => {
    const { memberNo } = await seedMember('S8888888888888');
    const member = await run(
      appUrl,
      `select id from member where member_no = $1`,
      [memberNo]
    );
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );

    await expect(
      run(
        appUrl,
        `insert into membership_application
           (membership_type_id, existing_member_id, captured_by)
         values ($1, $2, $3)`,
        [type.rows[0].id, member.rows[0].id, officer.userId]
      )
    ).rejects.toThrowError(/membership_application_kind_shape/);
  });

  it('records which account type(s) an additional_account application opens', async () => {
    const { memberNo } = await seedMember('S7777777777777');
    const member = await run(
      appUrl,
      `select id from member where member_no = $1`,
      [memberNo]
    );
    const application = await run(
      appUrl,
      `insert into membership_application
         (application_kind, existing_member_id, captured_by)
       values ('additional_account', $1, $2)
       returning id`,
      [member.rows[0].id, officer.userId]
    );
    // Any active account type is a valid selection — nothing here is
    // seeded as "HSA" or "Investment" by name, only Shares and MSA exist
    // out of the box, and either stands in fine for this constraint check.
    const accountType = await run(
      appUrl,
      `select id from account_type where code = 'shares'`
    );

    await run(
      appUrl,
      `insert into application_account_selection (application_id, account_type_id)
       values ($1, $2)`,
      [application.rows[0].id, accountType.rows[0].id]
    );

    const selected = await run(
      appUrl,
      `select count(*)::int as n from application_account_selection
        where application_id = $1`,
      [application.rows[0].id]
    );
    expect(selected.rows[0].n).toBe(1);
  });
});

describe('S-614: a non-member opening an account of their own — schema', () => {
  // Phase 1 (migration 0027) is schema only, the same way S-612's own first
  // phase was — no code yet creates a customer_account row, so this
  // exercises the database's own constraints directly.
  it('accepts a customer_account row that captures an applicant, no existing member', async () => {
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const application = await run(
      appUrl,
      `insert into membership_application
         (application_kind, membership_type_id, captured_by)
       values ('customer_account', $1, $2)
       returning id, existing_member_id`,
      [type.rows[0].id, officer.userId]
    );
    expect(application.rows[0].existing_member_id).toBeNull();
  });

  it('refuses a customer_account row with no membership type to capture against', async () => {
    await expect(
      run(
        appUrl,
        `insert into membership_application (application_kind, captured_by)
         values ('customer_account', $1)`,
        [officer.userId]
      )
    ).rejects.toThrowError(/membership_application_kind_shape/);
  });

  it('refuses a customer_account row that also names an existing member', async () => {
    const { memberNo } = await seedMember('S6666666666660');
    const member = await run(
      appUrl,
      `select id from member where member_no = $1`,
      [memberNo]
    );
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );

    await expect(
      run(
        appUrl,
        `insert into membership_application
           (application_kind, membership_type_id, existing_member_id, captured_by)
         values ('customer_account', $1, $2, $3)`,
        [type.rows[0].id, member.rows[0].id, officer.userId]
      )
    ).rejects.toThrowError(/membership_application_kind_shape/);
  });

  it('is as bare as member — no name or NIC of its own', async () => {
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const application = await run(
      appUrl,
      `insert into membership_application
         (application_kind, membership_type_id, captured_by)
       values ('customer_account', $1, $2)
       returning id`,
      [type.rows[0].id, officer.userId]
    );
    const customer = await run(
      appUrl,
      `insert into customer (application_id) values ($1) returning id, status`,
      [application.rows[0].id]
    );
    expect(customer.rows[0].status).toBe('active');

    // One customer per application, the same way member.application_id is
    // unique.
    await expect(
      run(appUrl, `insert into customer (application_id) values ($1)`, [
        application.rows[0].id,
      ])
    ).rejects.toThrowError(/duplicate key/);
  });

  describe('a customer-owned account, beside a member-owned one', () => {
    let hsaTypeId: string;

    beforeAll(async () => {
      const hsa = await runAsConfigurator(
        appUrl,
        `insert into account_type (code, name, category, number_prefix, is_membership_default)
         values ('hsa_schema_test', 'HSA (schema test)', 'savings', 'HSA', false)
         returning id`
      );
      hsaTypeId = hsa.rows[0].id;
    });

    async function newCustomer(): Promise<string> {
      const type = await run(
        appUrl,
        `select id from membership_type where code = 'individual'`
      );
      const application = await run(
        appUrl,
        `insert into membership_application
           (application_kind, membership_type_id, captured_by)
         values ('customer_account', $1, $2)
         returning id`,
        [type.rows[0].id, officer.userId]
      );
      const customer = await run(
        appUrl,
        `insert into customer (application_id) values ($1) returning id`,
        [application.rows[0].id]
      );
      return customer.rows[0].id;
    }

    it('accepts a customer-owned account with a number, no member', async () => {
      const customerId = await newCustomer();
      const number = await run(
        appUrl,
        `select next_customer_account_number($1) as n`,
        [hsaTypeId]
      );
      const account = await run(
        appUrl,
        `insert into account (customer_id, account_type_id, account_no)
         values ($1, $2, $3)
         returning member_id`,
        [customerId, hsaTypeId, number.rows[0].n]
      );
      expect(account.rows[0].member_id).toBeNull();
      expect(number.rows[0].n).toMatch(/^HSA\d{4}$/);
    });

    it('refuses a customer-owned account with no number', async () => {
      const customerId = await newCustomer();
      await expect(
        run(
          appUrl,
          `insert into account (customer_id, account_type_id) values ($1, $2)`,
          [customerId, hsaTypeId]
        )
      ).rejects.toThrowError(/account_owner_shape/);
    });

    it('refuses an account with both a member and a customer', async () => {
      const { memberNo } = await seedMember('S6666666666661');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );
      const customerId = await newCustomer();
      const number = await run(
        appUrl,
        `select next_customer_account_number($1) as n`,
        [hsaTypeId]
      );

      await expect(
        run(
          appUrl,
          `insert into account (member_id, customer_id, account_type_id, account_no)
           values ($1, $2, $3, $4)`,
          [member.rows[0].id, customerId, hsaTypeId, number.rows[0].n]
        )
      ).rejects.toThrowError(/account_owner_shape/);
    });

    it('numbers each account sequentially, per account type', async () => {
      const a = await run(
        appUrl,
        `select next_customer_account_number($1) as n`,
        [hsaTypeId]
      );
      const b = await run(
        appUrl,
        `select next_customer_account_number($1) as n`,
        [hsaTypeId]
      );
      expect(b.rows[0].n > a.rows[0].n).toBe(true);
    });

    it('refuses to number an account type with no prefix configured', async () => {
      const noPrefix = await runAsConfigurator(
        appUrl,
        `insert into account_type (code, name, category, is_membership_default)
         values ('no_prefix_schema_test', 'No prefix (test)', 'savings', false)
         returning id`
      );
      await expect(
        run(appUrl, `select next_customer_account_number($1) as n`, [
          noPrefix.rows[0].id,
        ])
      ).rejects.toThrowError(/has no number_prefix set/);
    });

    it('lets a customer hold at most one account of each type', async () => {
      const customerId = await newCustomer();
      const first = await run(
        appUrl,
        `select next_customer_account_number($1) as n`,
        [hsaTypeId]
      );
      await run(
        appUrl,
        `insert into account (customer_id, account_type_id, account_no)
         values ($1, $2, $3)`,
        [customerId, hsaTypeId, first.rows[0].n]
      );
      const second = await run(
        appUrl,
        `select next_customer_account_number($1) as n`,
        [hsaTypeId]
      );

      await expect(
        run(
          appUrl,
          `insert into account (customer_id, account_type_id, account_no)
           values ($1, $2, $3)`,
          [customerId, hsaTypeId, second.rows[0].n]
        )
      ).rejects.toThrowError(/account_one_per_type_per_customer_idx/);
    });
  });
});

describe('S-614, phase 2: starting an application for someone not yet on the system', () => {
  let selectableTypeId: string;
  let membershipDefaultTypeId: string;

  beforeAll(async () => {
    const selectable = await runAsConfigurator(
      appUrl,
      `insert into account_type (code, name, category, is_membership_default)
       values ('hsa_customer_test', 'Hajj Savings (customer test)', 'savings', false)
       returning id`
    );
    selectableTypeId = selectable.rows[0].id;
    const membershipDefault = await run(
      appUrl,
      `select id from account_type where is_membership_default limit 1`
    );
    membershipDefaultTypeId = membershipDefault.rows[0].id;
  });

  it('creates it against the Individual membership type, with an empty applicant to fill in', async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startCustomerAccountApplication(
      [selectableTypeId],
      officer
    );
    expect(reference).toMatch(/^APP-\d{4}-\d{6}$/);

    const application = await capture.loadApplication(id);
    expect(application!.applicationKind).toBe('customer_account');
    if (application!.applicationKind !== 'customer_account') throw new Error();
    expect(application!.membershipTypeCode).toBe('individual');
    expect(application!.selectedAccountTypes.map(t => t.id)).toEqual([
      selectableTypeId,
    ]);
    // An empty applicant row, the same as starting a membership application
    // gives capture something to render into from the first load.
    expect(
      application!.parties.find(
        p => p.subject === 'applicant' && p.ordinal === 1
      )
    ).toBeDefined();
  });

  it('refuses with no account type selected', async () => {
    const { capture } = await load();
    await expect(
      capture.startCustomerAccountApplication([], officer)
    ).rejects.toThrowError(/at least one account type/);
  });

  it('refuses a membership-default account type — Shares and the MSA open only on approval', async () => {
    const { capture } = await load();
    await expect(
      capture.startCustomerAccountApplication(
        [membershipDefaultTypeId],
        officer
      )
    ).rejects.toThrowError(/no longer available to open this way/);
  });

  it('records the same audit action a membership application uses', async () => {
    const { capture } = await load();
    const { id } = await capture.startCustomerAccountApplication(
      [selectableTypeId],
      officer
    );
    const audit = await run(
      appUrl,
      `select action, actor_user_id from audit_event
        where entity_type = 'membership_application' and entity_id = $1`,
      [id]
    );
    expect(audit.rows[0].action).toBe('membership.application.started');
    expect(audit.rows[0].actor_user_id).toBe(officer.userId);
  });

  it('saves a draft the same way a membership application does', async () => {
    const { capture } = await load();
    const { id } = await capture.startCustomerAccountApplication(
      [selectableTypeId],
      officer
    );

    const { problems } = await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Ramtohul', name: 'Priya', nic: 'P1234567890123' },
        },
      ],
      officer
    );
    expect(problems).toEqual([]);

    const reloaded = await capture.loadApplication(id);
    expect(
      reloaded!.parties.find(p => p.subject === 'applicant')!.values.surname
    ).toBe('Ramtohul');
  });

  it('reports missing mandatory fields, the same way a membership application does', async () => {
    const { capture } = await load();
    const { id } = await capture.startCustomerAccountApplication(
      [selectableTypeId],
      officer
    );
    const application = await capture.loadApplication(id);

    const blocking = await capture.problemsBlockingSubmission(application!);
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.some(p => p.subject === 'applicant')).toBe(true);
  });

  it('can be deleted while still a draft', async () => {
    const { capture } = await load();
    const { id, reference } = await capture.startCustomerAccountApplication(
      [selectableTypeId],
      officer
    );

    const noFiles = async () => {
      throw new Error(
        'SharePoint should not have been asked to delete anything'
      );
    };
    const deleted = await capture.deleteDraftApplication(
      id,
      principalFor(officer),
      noFiles
    );
    expect(deleted.reference).toBe(reference);
    expect(await capture.loadApplication(id)).toBeNull();
  });

  it('appears on the officer-facing list, named by the applicant just typed', async () => {
    const { capture } = await load();
    const { id } = await capture.startCustomerAccountApplication(
      [selectableTypeId],
      officer
    );
    await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: { surname: 'Bundhoo', name: 'Vikash' },
        },
      ],
      officer
    );

    const listed = (await capture.listApplications({})).find(a => a.id === id)!;
    expect(listed.applicationKind).toBe('customer_account');
    expect(listed.applicantName).toBe('Vikash Bundhoo');
  });
});

describe('S-613: starting an additional-account application for an existing member', () => {
  // Out of the box every account_type ships is_membership_default (Shares,
  // MSA) — none of them a valid selection for this flow (S-613 refuses
  // exactly that). A selectable one has to exist for these tests the same
  // way an administrator would create HSA or Investment from Configuration.
  let selectableTypeId: string;
  let membershipDefaultTypeId: string;

  beforeAll(async () => {
    const selectable = await runAsConfigurator(
      appUrl,
      `insert into account_type (code, name, category, is_membership_default)
       values ('hsa_test', 'Hajj Savings (test)', 'savings', false)
       returning id`
    );
    selectableTypeId = selectable.rows[0].id;
    const membershipDefault = await run(
      appUrl,
      `select id from account_type where is_membership_default limit 1`
    );
    membershipDefaultTypeId = membershipDefault.rows[0].id;
  });

  // No afterAll cleanup: the applications this describe block creates
  // reference hsa_test via a foreign key, and the whole database — this
  // file's own throwaway one — is dropped once every test here has run.

  describe('searchExistingMembers', () => {
    it('finds an active member by name, NIC or Member No.', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S6666666666666', 'active', {
        surname: 'Aumjaud',
        name: 'Kavish',
      });

      const bySurname = await capture.searchExistingMembers('Aumjaud');
      expect(bySurname.some(m => m.memberNo === memberNo)).toBe(true);

      const byNic = await capture.searchExistingMembers('S6666666666666');
      expect(byNic.some(m => m.memberNo === memberNo)).toBe(true);

      const byMemberNo = await capture.searchExistingMembers(memberNo);
      expect(byMemberNo.some(m => m.memberNo === memberNo)).toBe(true);
    });

    it('does not offer an inactive member', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S5555555555555', 'inactive', {
        surname: 'Ramgoolam',
        name: 'Devesh',
      });

      const results = await capture.searchExistingMembers('Ramgoolam');
      expect(results.some(m => m.memberNo === memberNo)).toBe(false);
    });
  });

  describe('startAdditionalAccountApplication', () => {
    it('creates the application and records the selected account type(s)', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S4444444444444', 'active');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      const { id } = await capture.startAdditionalAccountApplication(
        member.rows[0].id,
        [selectableTypeId],
        officer
      );

      const application = await run(
        appUrl,
        `select application_kind, existing_member_id, membership_type_id
           from membership_application where id = $1`,
        [id]
      );
      expect(application.rows[0].application_kind).toBe('additional_account');
      expect(application.rows[0].existing_member_id).toBe(member.rows[0].id);
      expect(application.rows[0].membership_type_id).toBeNull();

      const selected = await run(
        appUrl,
        `select account_type_id from application_account_selection
          where application_id = $1`,
        [id]
      );
      expect(selected.rows.map(r => r.account_type_id)).toEqual([
        selectableTypeId,
      ]);
    });

    it('refuses with no account type selected', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S3333333333333', 'active');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      await expect(
        capture.startAdditionalAccountApplication(
          member.rows[0].id,
          [],
          officer
        )
      ).rejects.toThrowError(/at least one account type/);
    });

    it('refuses an inactive member', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S2222222222222', 'inactive');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      await expect(
        capture.startAdditionalAccountApplication(
          member.rows[0].id,
          [selectableTypeId],
          officer
        )
      ).rejects.toThrowError(/active member/);
    });

    it('refuses a membership-default account type — Shares and the MSA open only on approval', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S1111111111111', 'active');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      await expect(
        capture.startAdditionalAccountApplication(
          member.rows[0].id,
          [membershipDefaultTypeId],
          officer
        )
      ).rejects.toThrowError(/no longer available to open this way/);
    });

    it('records who started it, the same audit action a membership application uses', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S0000000000001', 'active');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      const { id } = await capture.startAdditionalAccountApplication(
        member.rows[0].id,
        [selectableTypeId],
        officer
      );

      const audit = await run(
        appUrl,
        `select action, actor_user_id from audit_event
          where entity_type = 'membership_application' and entity_id = $1`,
        [id]
      );
      expect(audit.rows[0].action).toBe('membership.application.started');
      expect(audit.rows[0].actor_user_id).toBe(officer.userId);
    });
  });

  // S-613 phase 5: listApplications and deleteDraftApplication both used to
  // inner-join membership_type — the same bug just closed in documents.ts's
  // resolveOwner (docs/backlog.md, phase 4) for a different reader. An
  // additional_account row has no membership_type_id, so that join silently
  // dropped it from the list and reported "no longer exists" to a delete.
  describe('an additional-account application on the officer-facing list', () => {
    it('is named by the member it is for and the account type(s) selected', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S0000000000002', 'active', {
        surname: 'Bhugun',
        name: 'Ashish',
      });
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      const { id, reference } = await capture.startAdditionalAccountApplication(
        member.rows[0].id,
        [selectableTypeId],
        officer
      );

      const listed = (await capture.listApplications({})).find(
        a => a.id === id
      )!;
      expect(listed.reference).toBe(reference);
      expect(listed.applicationKind).toBe('additional_account');
      expect(listed.applicantName).toBe('Ashish Bhugun');
      expect(listed.membershipTypeName).toContain('Hajj Savings (test)');
    });

    it('can be deleted while still a draft, the same as a membership one', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S0000000000003', 'active');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );
      const { id, reference } = await capture.startAdditionalAccountApplication(
        member.rows[0].id,
        [selectableTypeId],
        officer
      );

      const noFiles = async () => {
        throw new Error(
          'SharePoint should not have been asked to delete anything'
        );
      };
      const deleted = await capture.deleteDraftApplication(
        id,
        principalFor(officer),
        noFiles
      );
      expect(deleted.reference).toBe(reference);

      const gone = await run(
        appUrl,
        `select 1 from membership_application where id = $1`,
        [id]
      );
      expect(gone.rowCount).toBe(0);
    });
  });

  describe('loadApplication', () => {
    it('reads an additional-account application back with no membership type and its selection', async () => {
      const { capture } = await load();
      const { memberNo } = await seedMember('S0000000000002', 'active');
      const member = await run(
        appUrl,
        `select id from member where member_no = $1`,
        [memberNo]
      );

      const { id } = await capture.startAdditionalAccountApplication(
        member.rows[0].id,
        [selectableTypeId],
        officer
      );

      const application = await capture.loadApplication(id);
      expect(application).not.toBeNull();
      if (
        !application ||
        application.applicationKind !== 'additional_account'
      ) {
        throw new Error('expected an additional_account application');
      }
      expect(application.applicationKind).toBe('additional_account');
      expect(application.existingMemberId).toBe(member.rows[0].id);
      expect(application.existingMemberNo).toBe(memberNo);
      expect(application.selectedAccountTypes).toEqual([
        expect.objectContaining({ id: selectableTypeId, code: 'hsa_test' }),
      ]);
      // No applicant to capture — this kind has no fields.
      expect(application.parties).toEqual([]);
    });

    it('still reads a membership application exactly as before', async () => {
      const { capture } = await load();
      const { id } = await capture.startApplication('individual', officer);

      const application = await capture.loadApplication(id);
      expect(application).not.toBeNull();
      if (!application || application.applicationKind !== 'membership') {
        throw new Error('expected a membership application');
      }
      expect(application.membershipTypeCode).toBe('individual');
    });
  });

  it('refuses saveDraft and reports no missing fields — nothing here is a form', async () => {
    const { capture } = await load();
    const { memberNo } = await seedMember('S0000000000003', 'active');
    const member = await run(
      appUrl,
      `select id from member where member_no = $1`,
      [memberNo]
    );
    const { id } = await capture.startAdditionalAccountApplication(
      member.rows[0].id,
      [selectableTypeId],
      officer
    );
    const application = await capture.loadApplication(id);

    await expect(capture.saveDraft(id, [], officer)).rejects.toThrowError(
      /no fields to save/
    );
    expect(await capture.problemsBlockingSubmission(application!)).toEqual([]);
  });

  it('refuses createMemberFromApplication — this application already has its member', async () => {
    const { capture } = await load();
    const { memberNo } = await seedMember('S0000000000004', 'active');
    const member = await run(
      appUrl,
      `select id from member where member_no = $1`,
      [memberNo]
    );
    const { id } = await capture.startAdditionalAccountApplication(
      member.rows[0].id,
      [selectableTypeId],
      officer
    );
    const application = await capture.loadApplication(id);

    const { withTransaction } = await import('../db/pool');
    const members = await import('../members/create');
    await withTransaction(async client => {
      await expect(
        members.createMemberFromApplication(client, application!, officer)
      ).rejects.toThrowError(/does not create a member/);
    });
  });
});

describe('S-614: a non-member applying to become one', () => {
  // Not the full approval chain — customer_account applications open into a
  // `customer` row only once approved (openAccountsForCustomerApplication,
  // members/create.ts, exercised in workflow.test.ts's own end-to-end test).
  // What this describes is capture-only, so a customer row is created
  // directly, pointing at an application already carrying real values —
  // exactly what an approved one looks like from this function's own read.
  async function seedCustomer(values: {
    surname: string;
    name: string;
    nic: string;
  }) {
    const { capture } = await load();
    const { id: applicationId } = await capture.startCustomerAccountApplication(
      [
        (
          await run(
            appUrl,
            `select id from account_type where not is_membership_default limit 1`
          )
        ).rows[0].id,
      ],
      officer
    );
    await capture.saveDraft(
      applicationId,
      [{ subject: 'applicant', ordinal: 1, values }],
      officer
    );
    const customer = await run(
      appUrl,
      `insert into customer (application_id) values ($1) returning id, status`,
      [applicationId]
    );
    return { customerId: customer.rows[0].id as string, applicationId };
  }

  it('starts an Individual membership application prefilled from what the customer already gave', async () => {
    const { capture } = await load();
    const { customerId } = await seedCustomer({
      surname: 'Peerthum',
      name: 'Devi',
      nic: 'D1234567890123',
    });

    const { id, reference } =
      await capture.startMembershipApplicationFromCustomer(customerId, officer);
    expect(reference).toMatch(/^APP-\d{4}-\d{6}$/);

    const application = await capture.loadApplication(id);
    expect(application!.applicationKind).toBe('membership');
    if (application!.applicationKind !== 'membership') throw new Error();
    expect(application!.membershipTypeCode).toBe('individual');
    expect(
      application!.parties.find(
        p => p.subject === 'applicant' && p.ordinal === 1
      )!.values
    ).toMatchObject({
      surname: 'Peerthum',
      name: 'Devi',
      nic: 'D1234567890123',
    });
    // Named on the application itself (migration 0029), so approval knows
    // whose account(s) to transfer without reading the audit trail.
    expect(application!.sourceCustomerId).toBe(customerId);
  });

  it('is an ordinary draft from here — editable, saveable, the same as any other', async () => {
    const { capture } = await load();
    const { customerId } = await seedCustomer({
      surname: 'Ah-Kong',
      name: 'Li',
      nic: 'L1234567890123',
    });

    const { id } = await capture.startMembershipApplicationFromCustomer(
      customerId,
      officer
    );
    const { problems } = await capture.saveDraft(
      id,
      [
        {
          subject: 'applicant',
          ordinal: 1,
          values: {
            surname: 'Ah-Kong',
            name: 'Li',
            nic: 'L1234567890123',
            address: '4 Cascade Street, Port Louis',
          },
        },
      ],
      officer
    );
    expect(problems).toEqual([]);

    const reloaded = await capture.loadApplication(id);
    expect(
      reloaded!.parties.find(p => p.subject === 'applicant')!.values.address
    ).toBe('4 Cascade Street, Port Louis');
  });

  it('records its own audit action, naming the customer it came from', async () => {
    const { capture } = await load();
    const { customerId } = await seedCustomer({
      surname: 'Bissessur',
      name: 'Kavi',
      nic: 'K1234567890123',
    });

    const { id } = await capture.startMembershipApplicationFromCustomer(
      customerId,
      officer
    );
    const audit = await run(
      appUrl,
      `select action, new_value from audit_event
        where entity_type = 'membership_application' and entity_id = $1
          and action = 'membership.application.started_from_customer'`,
      [id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].new_value.fromCustomerId).toBe(customerId);
  });

  it('refuses a customer id that does not exist', async () => {
    const { capture } = await load();
    await expect(
      capture.startMembershipApplicationFromCustomer(
        '00000000-0000-0000-0000-000000000000',
        officer
      )
    ).rejects.toThrowError(/no longer exists/);
  });

  it('refuses a customer who is not active', async () => {
    const { capture } = await load();
    const { customerId } = await seedCustomer({
      surname: 'Gopal',
      name: 'Nita',
      nic: 'N1234567890123',
    });
    await run(appUrl, `update customer set status = 'closed' where id = $1`, [
      customerId,
    ]);

    await expect(
      capture.startMembershipApplicationFromCustomer(customerId, officer)
    ).rejects.toThrowError(/Only an active customer/);
  });
});
