// Officer feedback: a regional officer corrects a phone number or address
// directly, no review or approval — a much narrower write than
// member_details_request's own apply/decline (details-requests.test.ts),
// so its own suite against a real database: the row lock and the jsonb
// merge that leaves untouched fields alone are the database's own
// behaviour.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from '../access/principal';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `contact_test_${Date.now()}`;
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

const contact = await import('./contact');
const pool = await import('../db/pool');

const ORIGINAL = {
  surname: 'Peerally',
  name: 'Fatimah',
  nic: 'B1234567890123',
  address: '12 Royal Road, Rose Hill',
  mobile: '+23057891234',
  telephone: '+2302341234',
};

let applicationId: string;
let memberId: string;
let customerApplicationId: string;
let customerId: string;
let officer: Principal;
let colleague: Principal;

function principalFor(
  userId: string,
  email: string,
  permissions: string[]
): Principal {
  return {
    userId,
    entraSubject: `subject-${email}`,
    email,
    displayName: email,
    roles: [],
    roleNames: [],
    permissions: new Set(permissions),
  };
}

async function currentValues(id: string): Promise<Record<string, string>> {
  const result = await run(
    appUrl,
    `select values from application_party
      where application_id = $1 and subject = 'applicant' and ordinal = 1`,
    [id]
  );
  return result.rows[0].values;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@test', 'Test Officer'),
            ('test-colleague', 'colleague@test', 'Test Colleague')
     returning id, email::text`
  );
  const byEmail = new Map<string, string>(
    users.rows.map((r: { id: string; email: string }) => [r.email, r.id])
  );
  officer = principalFor(byEmail.get('officer@test')!, 'officer@test', [
    'member.view',
    'member.edit_contact',
  ]);
  colleague = principalFor(byEmail.get('colleague@test')!, 'colleague@test', [
    'member.view',
  ]);

  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );

  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [type.rows[0].id, officer.userId]
  );
  applicationId = application.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [applicationId, JSON.stringify(ORIGINAL)]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ('AB0001', $1, $2) returning id`,
    [applicationId, type.rows[0].id]
  );
  memberId = member.rows[0].id;

  // S-614: a non-member customer, so updateContactDetails is proven against
  // both kinds of record officer feedback named.
  const customerApplication = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status, application_kind)
     values ($1, $2, 'approved', 'customer_account') returning id`,
    [type.rows[0].id, officer.userId]
  );
  customerApplicationId = customerApplication.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [customerApplicationId, JSON.stringify(ORIGINAL)]
  );
  const customer = await run(
    appUrl,
    `insert into customer (application_id) values ($1) returning id`,
    [customerApplicationId]
  );
  customerId = customer.rows[0].id;
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

beforeEach(async () => {
  await run(
    appUrl,
    `update application_party set values = $2::jsonb
      where application_id = $1 and subject = 'applicant' and ordinal = 1`,
    [applicationId, JSON.stringify(ORIGINAL)]
  );
});

describe('editableContactFields: what a type actually configures', () => {
  it('returns telephone and address, with their current values', async () => {
    const fields = await contact.editableContactFields(applicationId);
    const byKey = new Map(fields.map(f => [f.fieldKey, f]));
    expect(byKey.get('telephone')?.value).toBe(ORIGINAL.telephone);
    expect(byKey.get('address')?.value).toBe(ORIGINAL.address);
    // mobile is configured too, but officer feedback named only telephone
    // and address — nothing else is offered to edit here.
    expect(byKey.has('mobile')).toBe(false);
  });

  it('is empty for an application that does not exist', async () => {
    const fields = await contact.editableContactFields(
      '00000000-0000-0000-0000-000000000000'
    );
    expect(fields).toEqual([]);
  });
});

describe('updateContactDetails: saved straight through, no approval', () => {
  it('refuses an officer without member.edit_contact', async () => {
    await expect(
      contact.updateContactDetails(
        applicationId,
        { address: '99 New Street' },
        { entityType: 'member', entityId: memberId },
        colleague
      )
    ).rejects.toThrowError(/permission/i);
  });

  it('normalises a telephone number to E.164 and saves the address as typed', async () => {
    const result = await contact.updateContactDetails(
      applicationId,
      { telephone: '5799 4321', address: '99 New Street, Curepipe' },
      { entityType: 'member', entityId: memberId },
      officer
    );
    expect(result.updated.sort()).toEqual(['address', 'telephone']);

    const values = await currentValues(applicationId);
    expect(values.telephone).toBe('+23057994321');
    expect(values.address).toBe('99 New Street, Curepipe');
  });

  it('leaves every other field untouched — a merge, never a replace', async () => {
    await contact.updateContactDetails(
      applicationId,
      { address: '5 Pope Hennessy Street' },
      { entityType: 'member', entityId: memberId },
      officer
    );
    const values = await currentValues(applicationId);
    expect(values.address).toBe('5 Pope Hennessy Street');
    expect(values.name).toBe(ORIGINAL.name);
    expect(values.surname).toBe(ORIGINAL.surname);
    expect(values.nic).toBe(ORIGINAL.nic);
    expect(values.mobile).toBe(ORIGINAL.mobile);
  });

  it('rejects a telephone number that cannot be placed', async () => {
    await expect(
      contact.updateContactDetails(
        applicationId,
        { telephone: 'not a number' },
        { entityType: 'member', entityId: memberId },
        officer
      )
    ).rejects.toThrowError(/Telephone:/);
    // Refused before anything is written.
    const values = await currentValues(applicationId);
    expect(values.telephone).toBe(ORIGINAL.telephone);
  });

  it('clears the telephone number when saved blank', async () => {
    const result = await contact.updateContactDetails(
      applicationId,
      { telephone: '' },
      { entityType: 'member', entityId: memberId },
      officer
    );
    expect(result.updated).toEqual(['telephone']);
    const values = await currentValues(applicationId);
    expect(values.telephone).toBe('');
  });

  it('reports nothing updated, and writes nothing, when nothing actually changed', async () => {
    const result = await contact.updateContactDetails(
      applicationId,
      { telephone: ORIGINAL.telephone, address: ORIGINAL.address },
      { entityType: 'member', entityId: memberId },
      officer
    );
    expect(result.updated).toEqual([]);
  });

  it('ignores a field outside telephone/address even if sent', async () => {
    await contact.updateContactDetails(
      applicationId,
      { name: 'Someone Else', address: '7 Sir William Newton Street' },
      { entityType: 'member', entityId: memberId },
      officer
    );
    const values = await currentValues(applicationId);
    expect(values.name).toBe(ORIGINAL.name);
    expect(values.address).toBe('7 Sir William Newton Street');
  });

  it('saves the same way for a non-member customer', async () => {
    const result = await contact.updateContactDetails(
      customerApplicationId,
      { address: '1 Chaussee Street' },
      { entityType: 'customer', entityId: customerId },
      officer
    );
    expect(result.updated).toEqual(['address']);
    const values = await currentValues(customerApplicationId);
    expect(values.address).toBe('1 Chaussee Street');
  });

  it('records an audit entry naming the officer, the entity and what changed', async () => {
    await contact.updateContactDetails(
      applicationId,
      { address: '10 La Chaussee' },
      { entityType: 'member', entityId: memberId },
      officer
    );
    const events = await run(
      appUrl,
      `select action, entity_type, entity_id, actor_user_id, previous_value, new_value
         from audit_event
        where entity_type = 'member' and entity_id = $1
        order by occurred_at desc limit 1`,
      [memberId]
    );
    expect(events.rows).toHaveLength(1);
    const event = events.rows[0];
    expect(event.action).toBe('member.contact.updated');
    expect(event.actor_user_id).toBe(officer.userId);
    expect(event.new_value).toEqual({ address: '10 La Chaussee' });
    expect(event.previous_value).toEqual({ address: ORIGINAL.address });
  });

  it('errors for an application with no applicant party to edit', async () => {
    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    const bare = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [type.rows[0].id, officer.userId]
    );
    await expect(
      contact.updateContactDetails(
        bare.rows[0].id,
        { address: 'Somewhere' },
        { entityType: 'member', entityId: memberId },
        officer
      )
    ).rejects.toThrowError(/no applicant details/);
  });
});
