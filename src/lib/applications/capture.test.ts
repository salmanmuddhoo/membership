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

async function load() {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
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
}, 60_000);

afterAll(async () => {
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
});
