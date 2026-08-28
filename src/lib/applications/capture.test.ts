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
