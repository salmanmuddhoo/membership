// Retention and disposal, against a real database (S-1003).
//
// Mocking would prove nothing here. Every claim worth making is about what is
// actually left in the database afterwards — that the applicant's details are
// gone, that the row saying an application was refused is not, that a second
// run does not repeat the first — and the interesting failures are exactly the
// ones a stub would paper over.
//
// The most important test in this file is the first one: with no period set,
// nothing happens. That is the state this ships in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
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

const dbName = `retention_test_${Date.now()}`;
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

process.env.DATABASE_URL = appUrl;
process.env.DATABASE_ALLOW_INSECURE = 'true';
process.env.PUBLIC_APP_ENV = 'test';

const { previewDisposal, disposeDueRecords, disposedAnything } =
  await import('./disposal');
const {
  listRetentionPolicies,
  retentionPeriod,
  setRetentionPeriod,
  MINIMUM_PERIOD_MONTHS,
  MAXIMUM_PERIOD_MONTHS,
} = await import('./policy');
const { applicationFolderPath } = await import('../documents/documents');
const { ConfigError } = await import('../config/reference');
const { clearReferenceCache } = await import('../config/cache');
const pool = await import('../db/pool');

// SharePoint itself is the one thing here that cannot be real. Everything
// between disposal and Graph is, though — which matters, because the mistake
// worth catching is disposal asking Graph to delete the WRONG path, and a
// stub standing in for the code that decides the path would hide exactly that.
const deletedFromDrive: string[] = [];
vi.mock('../documents/graph', async () => {
  const actual =
    await vi.importActual<typeof import('../documents/graph')>(
      '../documents/graph'
    );
  return {
    ...actual,
    deleteItemByPath: async (itemPath: string) => {
      deletedFromDrive.push(itemPath);
    },
  };
});

let officerId = '';
let individualTypeId = '';
let idCardTypeId = '';

// An actor the configuration trigger will accept, for writes the tests make
// directly rather than through setRetentionPeriod.
async function setPeriodDirectly(
  code: string,
  months: number | null
): Promise<void> {
  const client = new pg.Client({ connectionString: appUrl, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    await client.query(
      'update retention_policy set period_months = $2 where code = $1',
      [code, months]
    );
    await client.query('commit');
  } finally {
    await client.end();
  }
}

async function clearAllPeriods(): Promise<void> {
  for (const code of [
    'notification_log',
    'rejected_application',
    'abandoned_draft',
    'former_member_documents',
  ]) {
    await setPeriodDirectly(code, null);
  }
}

interface ApplicationFixture {
  status: 'draft' | 'rejected';
  ageMonths: number;
  surname?: string;
  withDocument?: boolean;
  // Where the file actually sits, when that is not this application's own
  // folder — the migration 0043 case an existing member's second application
  // creates.
  filePath?: string;
  itemId?: string;
}

// The real rule, not a copy of it: a fixture's file has to be exactly where
// the code under test will look for it, and a second spelling of the naming
// convention here would drift from the first and pass anyway.
function folderFor(reference: string, surname = 'Ramjaun'): string {
  return applicationFolderPath(reference, surname, 'Aisha');
}

async function makeApplication(
  fixture: ApplicationFixture
): Promise<{ id: string; reference: string }> {
  const ago = `now() - interval '${fixture.ageMonths} months'`;
  const decided = fixture.status === 'rejected' ? ago : 'null';
  const submitted = fixture.status === 'rejected' ? ago : 'null';

  const inserted = await run(
    appUrl,
    `insert into membership_application
       (membership_type_id, status, captured_by, submitted_at, decided_at,
        created_at, updated_at)
     values ($1, $2, $3, ${submitted}, ${decided}, ${ago}, ${ago})
     returning id, reference`,
    [individualTypeId, fixture.status, officerId]
  );
  const { id, reference } = inserted.rows[0] as {
    id: string;
    reference: string;
  };

  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [
      id,
      JSON.stringify({ surname: fixture.surname ?? 'Ramjaun', name: 'Aisha' }),
    ]
  );

  if (fixture.withDocument) {
    const document = await run(
      appUrl,
      `insert into document (document_type_id, subject, application_id, state)
       values ($1, 'applicant', $2, 'uploaded')
       returning id`,
      [idCardTypeId, id]
    );
    await run(
      appUrl,
      `insert into document_version
         (document_id, version_no, state, file_name, content_type, size_bytes,
          sharepoint_item_id, sharepoint_path, uploaded_by, committed_at)
       values ($1, 1, 'committed', 'id.pdf', 'application/pdf', 1024,
               $2, $3, $4, now())`,
      [
        document.rows[0].id,
        fixture.itemId ?? `item-${reference}`,
        fixture.filePath ?? `${folderFor(reference, fixture.surname)}/id.pdf`,
        officerId,
      ]
    );
  }

  return { id, reference };
}

async function makeNotification(ageMonths: number): Promise<void> {
  await run(
    appUrl,
    `insert into notification
       (event_code, channel, recipient, subject, body, status, created_at)
     values ('application.approved', 'email', 'someone@example.com',
             'Approved', 'Assalamoualaikoum Aisha', 'sent',
             now() - interval '${ageMonths} months')`
  );
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const officer = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test:officer', 'officer@example.com', 'Officer')
     returning id`
  );
  officerId = officer.rows[0].id;

  const types = await run(
    appUrl,
    `select
       (select id from membership_type where code = 'individual') as mt,
       (select id from document_type where code = 'id_card') as dt`
  );
  individualTypeId = types.rows[0].mt;
  idCardTypeId = types.rows[0].dt;
});

beforeEach(async () => {
  deletedFromDrive.length = 0;
  await clearAllPeriods();
  clearReferenceCache();
  // Applications cascade their parties and documents away — except one with
  // an application_transition behind it, which is append-only (0011) and
  // restricts the delete. Those are aged forward instead, so they fall out of
  // every later test's window rather than being disposed of by it.
  await run(
    appUrl,
    `delete from membership_application a
      where not exists (
        select 1 from application_transition t where t.application_id = a.id
      )`
  );
  await run(
    appUrl,
    `update membership_application
        set decided_at = case when decided_at is null then null else now() end`
  );
  await run(appUrl, 'delete from notification');
});

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('with no period set', () => {
  // The state this ships in, and the reason it is safe to merge before the
  // Society has decided anything.
  it('disposes of nothing at all', async () => {
    await makeNotification(240);
    await makeApplication({ status: 'rejected', ageMonths: 240 });
    await makeApplication({ status: 'draft', ageMonths: 240 });

    const outcome = await disposeDueRecords({});

    expect(outcome).toEqual({
      notificationsDeleted: 0,
      applicationsRedacted: 0,
      formerMembersDisposed: 0,
      draftsDeleted: 0,
      draftsRefused: 0,
      filesFailed: 0,
    });
    expect(disposedAnything(outcome)).toBe(false);

    const left = await run(
      appUrl,
      'select count(*)::int as n from notification'
    );
    expect(left.rows[0].n).toBe(1);
  });

  it('reads as kept indefinitely, with no count and no cutoff', async () => {
    await makeNotification(240);

    const preview = await previewDisposal();
    for (const item of preview) {
      expect(item.periodMonths).toBeNull();
      expect(item.cutoff).toBeNull();
      expect(item.dueCount).toBe(0);
    }
  });

  it('lists every class the migration seeded', async () => {
    const policies = await listRetentionPolicies();
    expect(policies.map(p => p.code)).toEqual([
      'notification_log',
      'rejected_application',
      'abandoned_draft',
      'former_member_documents',
    ]);
  });
});

describe('the preview', () => {
  it('counts what a period would dispose of, before anything is disposed', async () => {
    await makeNotification(30);
    await makeNotification(30);
    await makeNotification(1);
    await setPeriodDirectly('notification_log', 12);

    const preview = await previewDisposal();
    const notifications = preview.find(p => p.code === 'notification_log')!;

    expect(notifications.periodMonths).toBe(12);
    expect(notifications.dueCount).toBe(2);
    expect(notifications.cutoff).toBeInstanceOf(Date);

    // Counting is not doing.
    const still = await run(
      appUrl,
      'select count(*)::int as n from notification'
    );
    expect(still.rows[0].n).toBe(3);
  });

  it('agrees with what the job then actually disposes of', async () => {
    for (const age of [40, 36, 25, 13, 11, 2]) await makeNotification(age);
    await setPeriodDirectly('notification_log', 12);

    const predicted = (await previewDisposal()).find(
      p => p.code === 'notification_log'
    )!.dueCount;

    const outcome = await disposeDueRecords({});

    expect(predicted).toBe(4);
    expect(outcome.notificationsDeleted).toBe(predicted);
  });
});

describe('the notification log', () => {
  it('deletes what is past the period and keeps what is not', async () => {
    await makeNotification(30);
    await makeNotification(6);
    await setPeriodDirectly('notification_log', 12);

    await disposeDueRecords({});

    const left = await run(appUrl, 'select body from notification');
    expect(left.rowCount).toBe(1);
    expect(left.rows[0].body).toContain('Aisha');
  });

  it('records the disposal once for the run, not once per row', async () => {
    for (const age of [30, 31, 32, 33]) await makeNotification(age);
    await setPeriodDirectly('notification_log', 12);

    // The trail cannot be emptied between tests — that is the whole point of
    // it — so this reads only what is written from here on.
    const mark = await run(
      appUrl,
      'select coalesce(max(id), 0) as id from audit_event'
    );

    await disposeDueRecords({});

    const audit = await run(
      appUrl,
      `select actor_user_id, actor_description, new_value
         from audit_event
        where action = 'retention.disposed' and entity_type = 'notification'
          and id > $1`,
      [mark.rows[0].id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].actor_description).toContain('retention');
    expect(audit.rows[0].new_value.disposed).toBe(4);
  });

  it('is bounded by the limit, and finishes over further passes', async () => {
    for (let i = 0; i < 5; i += 1) await makeNotification(30);
    await setPeriodDirectly('notification_log', 12);

    const first = await disposeDueRecords({ limit: 2 });
    expect(first.notificationsDeleted).toBe(2);

    const second = await disposeDueRecords({ limit: 2 });
    expect(second.notificationsDeleted).toBe(2);

    const third = await disposeDueRecords({ limit: 2 });
    expect(third.notificationsDeleted).toBe(1);

    const fourth = await disposeDueRecords({ limit: 2 });
    expect(disposedAnything(fourth)).toBe(false);
  });
});

describe('an application that was not approved', () => {
  it('loses the applicant’s details and its documents, and keeps the fact', async () => {
    const { id, reference } = await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      withDocument: true,
    });
    await setPeriodDirectly('rejected_application', 60);

    const outcome = await disposeDueRecords({});
    expect(outcome.applicationsRedacted).toBe(1);

    const party = await run(
      appUrl,
      'select values from application_party where application_id = $1',
      [id]
    );
    expect(party.rows[0].values).toEqual({});

    const documents = await run(
      appUrl,
      'select count(*)::int as n from document where application_id = $1',
      [id]
    );
    expect(documents.rows[0].n).toBe(0);

    // The row itself stays: its reference and the date it was refused say
    // nothing about anybody.
    const application = await run(
      appUrl,
      `select reference, status, disposed_at
         from membership_application where id = $1`,
      [id]
    );
    expect(application.rows[0].reference).toBe(reference);
    expect(application.rows[0].status).toBe('rejected');
    expect(application.rows[0].disposed_at).toBeInstanceOf(Date);
  });

  it('deletes the file it filed, and its own folder', async () => {
    const { reference } = await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      surname: 'Bhugaloo',
      withDocument: true,
    });
    await setPeriodDirectly('rejected_application', 60);

    await disposeDueRecords({});

    expect(deletedFromDrive).toContain(
      `${folderFor(reference, 'Bhugaloo')}/id.pdf`
    );
    // The folder too — this application owns it, so leaving it behind would
    // leave an empty folder named after the applicant.
    expect(deletedFromDrive).toContain(folderFor(reference, 'Bhugaloo'));
  });

  it('never deletes a folder this application only borrows', async () => {
    // Since migration 0043 an application captured for someone who already
    // had one files into THAT application's folder. A path derived from the
    // refused application's own reference therefore names a folder that never
    // existed: disposal would delete nothing and leave the papers in the
    // shared folder. What must happen is the opposite of both — its own file
    // goes, the folder and everything else in it stays.
    const root = await makeApplication({
      status: 'rejected',
      ageMonths: 1,
      surname: 'Elahee',
      withDocument: true,
    });
    const sharedFolder = folderFor(root.reference, 'Elahee');

    const second = await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      surname: 'Elahee',
      withDocument: true,
      filePath: `${sharedFolder}/passport.pdf`,
    });
    await run(
      appUrl,
      `update membership_application set folder_application_id = $2
        where id = $1`,
      [second.id, root.id]
    );

    await setPeriodDirectly('rejected_application', 60);
    await disposeDueRecords({});

    // Its own file goes.
    expect(deletedFromDrive).toContain(`${sharedFolder}/passport.pdf`);
    // The folder does not, nor the other application's file in it.
    expect(deletedFromDrive).not.toContain(sharedFolder);
    expect(deletedFromDrive).not.toContain(`${sharedFolder}/id.pdf`);
  });

  it('never deletes a file another document still holds', async () => {
    // A document carried forward reuses the source's file in place rather
    // than copying it, so two document rows point at one Graph item. Disposing
    // of one must not delete the file the other still shows.
    const carried = await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      withDocument: true,
      itemId: 'shared-item',
      filePath: 'Al Barakah/AB0001 Aisha/id.pdf',
    });
    const live = await makeApplication({
      status: 'draft',
      ageMonths: 1,
      withDocument: true,
      itemId: 'shared-item',
      filePath: 'Al Barakah/AB0001 Aisha/id.pdf',
    });
    expect(live.id).not.toBe(carried.id);

    await setPeriodDirectly('rejected_application', 60);
    await disposeDueRecords({});

    expect(deletedFromDrive).not.toContain('Al Barakah/AB0001 Aisha/id.pdf');
  });

  it('leaves an approved application alone, however old', async () => {
    await run(
      appUrl,
      `insert into membership_application
         (membership_type_id, status, captured_by, submitted_at, decided_at,
          created_at, updated_at)
       values ($1, 'approved', $2, now() - interval '200 months',
               now() - interval '200 months', now() - interval '200 months',
               now() - interval '200 months')`,
      [individualTypeId, officerId]
    );
    await setPeriodDirectly('rejected_application', 6);

    const outcome = await disposeDueRecords({});
    expect(outcome.applicationsRedacted).toBe(0);
  });

  it('does not dispose of the same application twice', async () => {
    await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      withDocument: true,
    });
    await setPeriodDirectly('rejected_application', 60);

    const first = await disposeDueRecords({});
    const second = await disposeDueRecords({});

    expect(first.applicationsRedacted).toBe(1);
    expect(second.applicationsRedacted).toBe(0);
    expect(deletedFromDrive.filter(p => p.endsWith('id.pdf'))).toHaveLength(1);
  });

  it('is left undisposed when its files cannot be removed', async () => {
    // Redacting anyway would leave an applicant's identity papers in
    // SharePoint with nothing in this system able to name them.
    const { id } = await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      withDocument: true,
    });
    await setPeriodDirectly('rejected_application', 60);

    const outcome = await disposeDueRecords({
      disposeFiles: async () => {
        throw new Error('Graph is unreachable');
      },
    });

    expect(outcome.filesFailed).toBe(1);
    expect(outcome.applicationsRedacted).toBe(0);
    expect(disposedAnything(outcome)).toBe(false);

    const row = await run(
      appUrl,
      `select a.disposed_at, p.values,
              (select count(*)::int from document where application_id = a.id) as documents
         from membership_application a
         join application_party p on p.application_id = a.id
        where a.id = $1`,
      [id]
    );
    expect(row.rows[0].disposed_at).toBeNull();
    expect(row.rows[0].values.surname).toBe('Ramjaun');
    expect(row.rows[0].documents).toBe(1);

    // And it is offered again, rather than being silently skipped forever.
    const second = await disposeDueRecords({});
    expect(second.applicationsRedacted).toBe(1);
  });

  it('records the reference but never what was in the fields', async () => {
    const { id } = await makeApplication({
      status: 'rejected',
      ageMonths: 90,
      surname: 'Jhugroo',
    });
    await setPeriodDirectly('rejected_application', 60);

    await disposeDueRecords({});

    const audit = await run(
      appUrl,
      `select new_value from audit_event
        where action = 'retention.disposed'
          and entity_type = 'membership_application' and entity_id = $1`,
      [id]
    );
    expect(audit.rowCount).toBe(1);
    // Disposal that kept a copy in a table nobody can edit afterwards would
    // be no disposal at all.
    expect(JSON.stringify(audit.rows[0].new_value)).not.toContain('Jhugroo');
  });
});

describe('a draft nobody submitted', () => {
  it('goes entirely', async () => {
    const { id } = await makeApplication({ status: 'draft', ageMonths: 30 });
    await setPeriodDirectly('abandoned_draft', 12);

    const outcome = await disposeDueRecords({});
    expect(outcome.draftsDeleted).toBe(1);

    const left = await run(
      appUrl,
      'select count(*)::int as n from membership_application where id = $1',
      [id]
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('leaves a recent draft alone', async () => {
    await makeApplication({ status: 'draft', ageMonths: 2 });
    await setPeriodDirectly('abandoned_draft', 12);

    const outcome = await disposeDueRecords({});
    expect(outcome.draftsDeleted).toBe(0);
  });

  it('refuses one that has been paid against, and does not fail the run', async () => {
    // A receipt is in an applicant's hands. deleteDraftApplication refuses
    // it; the run must count that and carry on rather than stopping, or one
    // stuck draft blocks every disposal after it forever.
    const { id } = await makeApplication({ status: 'draft', ageMonths: 30 });
    await run(
      appUrl,
      `insert into application_transition
         (application_id, from_status, to_status, actor_user_id, step_code)
       values ($1, 'draft', 'draft', $2, 'capture')`,
      [id, officerId]
    );
    await makeApplication({ status: 'draft', ageMonths: 30 });
    await setPeriodDirectly('abandoned_draft', 12);

    const outcome = await disposeDueRecords({});

    expect(outcome.draftsRefused).toBe(1);
    expect(outcome.draftsDeleted).toBe(1);

    const left = await run(
      appUrl,
      'select count(*)::int as n from membership_application where id = $1',
      [id]
    );
    expect(left.rows[0].n).toBe(1);
  });

  it('is not counted as progress, so a job looping on passes terminates', async () => {
    const { id } = await makeApplication({ status: 'draft', ageMonths: 30 });
    await run(
      appUrl,
      `insert into application_transition
         (application_id, from_status, to_status, actor_user_id, step_code)
       values ($1, 'draft', 'draft', $2, 'capture')`,
      [id, officerId]
    );
    await setPeriodDirectly('abandoned_draft', 12);

    const outcome = await disposeDueRecords({});
    expect(outcome.draftsRefused).toBe(1);
    expect(disposedAnything(outcome)).toBe(false);
  });
});

describe('setting a period', () => {
  it('is audited, naming who set it', async () => {
    await setRetentionPeriod('notification_log', 24, {
      userId: officerId,
      email: 'officer@example.com',
    });

    expect(await retentionPeriod('notification_log')).toBe(24);

    const audit = await run(
      appUrl,
      `select actor_user_id, actor_description, new_value
         from audit_event
        where entity_type = 'retention_policy'
        order by occurred_at desc limit 1`
    );
    expect(audit.rows[0].actor_user_id).toBe(officerId);
    expect(audit.rows[0].actor_description).toBe('officer@example.com');
    expect(audit.rows[0].new_value.period_months).toBe(24);
  });

  it('refuses a period shorter than the floor', async () => {
    await expect(
      setRetentionPeriod('notification_log', MINIMUM_PERIOD_MONTHS - 1, {
        userId: officerId,
        email: 'officer@example.com',
      })
    ).rejects.toBeInstanceOf(ConfigError);

    expect(await retentionPeriod('notification_log')).toBeNull();
  });

  it('refuses a period longer than the ceiling', async () => {
    await expect(
      setRetentionPeriod('notification_log', MAXIMUM_PERIOD_MONTHS + 1, {
        userId: officerId,
        email: 'officer@example.com',
      })
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('refuses a fraction', async () => {
    await expect(
      setRetentionPeriod('notification_log', 12.5, {
        userId: officerId,
        email: 'officer@example.com',
      })
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('can always be cleared, whatever it was', async () => {
    await setRetentionPeriod('notification_log', 24, {
      userId: officerId,
      email: 'officer@example.com',
    });
    await setRetentionPeriod('notification_log', null, {
      userId: officerId,
      email: 'officer@example.com',
    });

    expect(await retentionPeriod('notification_log')).toBeNull();
  });
});

describe('the audit trail itself', () => {
  // The control this deliberately does not work around. Migration 0004
  // refuses the mutation and 0005 revokes the privilege; if either were ever
  // relaxed, this test says so before anything else does.
  it('cannot be disposed of, by anyone, through the application', async () => {
    await makeNotification(30);
    await setPeriodDirectly('notification_log', 12);
    await disposeDueRecords({});

    await expect(
      run(appUrl, `delete from audit_event where occurred_at < now()`)
    ).rejects.toThrow();

    await expect(
      run(appUrl, `update audit_event set action = 'changed'`)
    ).rejects.toThrow();
  });
});

// A member who left (S-1703): their documents go once the period after the
// day the membership ended has passed — the anchor the first release of
// this module said it did not have.
describe('a member who resigned', () => {
  async function makeFormerMember(fixture: {
    status: 'resigned' | 'demised' | 'active';
    ageMonths: number;
    surname: string;
  }): Promise<{ memberId: string; applicationId: string; paths: string[] }> {
    const ago = `now() - interval '${fixture.ageMonths} months'`;
    const application = await run(
      appUrl,
      `insert into membership_application
         (membership_type_id, status, captured_by, submitted_at, decided_at,
          created_at, updated_at)
       values ($1, 'approved', $2, ${ago}, ${ago}, ${ago}, ${ago})
       returning id, reference`,
      [individualTypeId, officerId]
    );
    const { id: applicationId, reference } = application.rows[0];
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2::jsonb)`,
      [
        applicationId,
        JSON.stringify({ surname: fixture.surname, name: 'Aisha' }),
      ]
    );
    const member = await run(
      appUrl,
      `insert into member
         (application_id, membership_type_id, status, status_changed_at)
       values ($1, $2, $3, case when $3 = 'active' then null else ${ago} end)
       returning id, member_no`,
      [applicationId, individualTypeId, fixture.status]
    );
    const { id: memberId, member_no: memberNo } = member.rows[0];
    const paths = [
      `${folderFor(reference, fixture.surname)}/id.pdf`,
      `${folderFor(reference, fixture.surname)}/${memberNo}-utility.pdf`,
    ];
    // One document on the founding application, one filed against them
    // as a member later.
    const onApplication = await run(
      appUrl,
      `insert into document (document_type_id, subject, application_id, state)
       values ($1, 'applicant', $2, 'verified') returning id`,
      [idCardTypeId, applicationId]
    );
    const onMember = await run(
      appUrl,
      `insert into document (document_type_id, subject, member_id, state)
       values ((select id from document_type where code = 'utility_bill'),
               'applicant', $1, 'verified') returning id`,
      [memberId]
    );
    for (const [documentId, path, item] of [
      [onApplication.rows[0].id, paths[0], `item-${reference}-id`],
      [onMember.rows[0].id, paths[1], `item-${reference}-utility`],
    ] as const) {
      await run(
        appUrl,
        `insert into document_version
           (document_id, version_no, state, file_name, content_type, size_bytes,
            sharepoint_item_id, sharepoint_path, uploaded_by, committed_at)
         values ($1, 1, 'committed', 'x.pdf', 'application/pdf', 1024,
                 $2, $3, $4, now())`,
        [documentId, item, path, officerId]
      );
    }
    return { memberId, applicationId, paths };
  }

  it('loses their documents and files once the period after leaving has passed, and keeps the member, the ledger and the facts', async () => {
    const gone = await makeFormerMember({
      status: 'resigned',
      ageMonths: 90,
      surname: 'Gone',
    });
    const recent = await makeFormerMember({
      status: 'resigned',
      ageMonths: 2,
      surname: 'Recent',
    });
    const staying = await makeFormerMember({
      status: 'active',
      ageMonths: 90,
      surname: 'Staying',
    });
    await setPeriodDirectly('former_member_documents', 60);

    const preview = await previewDisposal();
    expect(
      preview.find(p => p.code === 'former_member_documents')?.dueCount
    ).toBe(1);

    deletedFromDrive.length = 0;
    const outcome = await disposeDueRecords({});
    expect(outcome.formerMembersDisposed).toBe(1);
    expect(disposedAnything(outcome)).toBe(true);
    for (const path of gone.paths) expect(deletedFromDrive).toContain(path);
    for (const other of [recent, staying]) {
      for (const path of other.paths) {
        expect(deletedFromDrive).not.toContain(path);
      }
    }

    const documentsLeft = async (memberId: string, applicationId: string) =>
      (
        await run(
          appUrl,
          `select count(*)::int as n from document
            where member_id = $1 or application_id = $2`,
          [memberId, applicationId]
        )
      ).rows[0].n;
    expect(await documentsLeft(gone.memberId, gone.applicationId)).toBe(0);
    expect(await documentsLeft(recent.memberId, recent.applicationId)).toBe(2);
    expect(await documentsLeft(staying.memberId, staying.applicationId)).toBe(
      2
    );

    const member = await run(
      appUrl,
      `select status, documents_disposed_at from member where id = $1`,
      [gone.memberId]
    );
    expect(member.rows[0].status).toBe('resigned');
    expect(member.rows[0].documents_disposed_at).toBeInstanceOf(Date);
    const party = await run(
      appUrl,
      `select values from application_party where application_id = $1`,
      [gone.applicationId]
    );
    expect(party.rows[0].values).toEqual({ surname: 'Gone', name: 'Aisha' });

    // Not twice.
    const again = await disposeDueRecords({});
    expect(again.formerMembersDisposed).toBe(0);
    await setPeriodDirectly('former_member_documents', null);
  });
});
