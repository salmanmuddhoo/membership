import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { CodeDelivery } from './otp';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `member_applications_test_${Date.now()}`;
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
process.env.MEMBER_SESSION_SECRET =
  'a-test-secret-that-is-at-least-32-characters-long';
process.env.MEMBER_OTP_DELIVERY = 'log';
process.env.RATE_LIMIT_DISABLED = 'true';

const identity = await import('./identity');
const applications = await import('./applications');
const profile = await import('./profile');
const pool = await import('../db/pool');
const capture = await import('../applications/capture');

const sent: string[] = [];
const delivery: CodeDelivery = {
  async send(_to, message) {
    sent.push(message.slice(0, 6));
  },
};
const origin = { ip: null, correlationId: 'test' };

async function applicantSession(mobile: string) {
  const challenge = await identity.startSignUp({ mobile }, origin, {
    delivery,
  });
  const session = await identity.verifyOtp(
    { challengeId: challenge.challengeId, code: sent.at(-1)! },
    origin
  );
  return (await identity.resolveMemberSession(
    `Bearer ${session.accessToken}`
  ))!;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('an application from the phone', () => {
  it('is captured by the system user, tied to the verified mobile, with it pre-filled', async () => {
    const jane = await applicantSession('5999 0001');
    const app = await applications.startMemberApplication(
      jane,
      'individual',
      origin
    );
    expect(app.status).toBe('draft');
    expect(app.reference).toMatch(/^APP-\d{4}-\d{6}$/);
    expect(
      app.parties.find(p => p.subject === 'applicant')?.values.mobile
    ).toBe('+23059990001');
    expect(app.documents.map(d => d.documentCode)).not.toContain('signed_form');
    expect(app.timeline.map(t => t.label)).toEqual(['Started']);

    const row = await run(
      appUrl,
      `select a.applicant_mobile, u.entra_subject
         from membership_application a join app_user u on u.id = a.captured_by
        where a.id = $1`,
      [app.id]
    );
    expect(row.rows[0]).toEqual({
      applicant_mobile: '+23059990001',
      entra_subject: 'system:member-app',
    });
  });

  it('one in progress at a time', async () => {
    const jane = await applicantSession('5999 0001');
    await expect(
      applications.startMemberApplication(jane, 'individual', origin)
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/APP-/),
    });
  });

  it('is invisible to another session, even one on the same phone number path', async () => {
    const jane = await applicantSession('5999 0001');
    const [mine] = await applications.listMemberApplications(jane);
    const stranger = await applicantSession('5999 0002');
    expect(await applications.listMemberApplications(stranger)).toEqual([]);
    await expect(
      applications.getMemberApplication(stranger, mine.id)
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      applications.saveMemberApplication(stranger, mine.id, [])
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('saves whatever was typed, keeps the mobile, and drops fields the type does not have', async () => {
    const jane = await applicantSession('5999 0001');
    const [mine] = await applications.listMemberApplications(jane);
    const saved = await applications.saveMemberApplication(jane, mine.id, [
      {
        subject: 'applicant',
        ordinal: 1,
        values: {
          surname: 'Doe',
          name: 'Jane',
          mobile: '5111 1111',
          not_a_field: 'x',
        },
      },
      { subject: 'guardian', ordinal: 1, values: { surname: 'Nobody' } },
    ]);
    const applicant = saved.parties.find(p => p.subject === 'applicant')!;
    expect(applicant.values).toMatchObject({
      surname: 'Doe',
      name: 'Jane',
      mobile: '+23059990001',
    });
    expect(applicant.values).not.toHaveProperty('not_a_field');
    expect(saved.parties.some(p => p.subject === 'guardian')).toBe(false);
  });

  it('refuses submission naming every gap at once, then lands on received', async () => {
    const jane = await applicantSession('5999 0001');
    const [mine] = await applications.listMemberApplications(jane);

    await expect(
      applications.submitMemberApplication(jane, mine.id, origin)
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: expect.objectContaining({
        'applicant.1.nic': expect.any(Array),
        'nominee.1.surname': expect.any(Array),
        'document.id_card': expect.any(Array),
      }),
    });

    await applications.saveMemberApplication(jane, mine.id, [
      {
        subject: 'applicant',
        ordinal: 1,
        values: {
          surname: 'Doe',
          name: 'Jane',
          nic: 'D0101901234567',
          gender: 'Female',
          address: '1 Main Road',
        },
      },
      {
        subject: 'nominee',
        ordinal: 1,
        values: {
          surname: 'Doe',
          name: 'John',
          nic: 'D0101881234567',
          address: '1 Main Road',
        },
      },
    ]);

    // Documents: filed straight into the tables, the way commit-upload
    // leaves them — SharePoint is not part of what this tests.
    const items = await run(
      appUrl,
      `select i.document_type_id, i.subject
         from document_checklist_item i
         join document_checklist c on c.id = i.checklist_id
         join document_type d on d.id = i.document_type_id
        where c.code = 'individual_kyc' and i.requirement = 'required'
          and d.code <> 'signed_form'`
    );
    const system = await run(
      appUrl,
      `select id from app_user where entra_subject = 'system:member-app'`
    );
    for (const item of items.rows) {
      const doc = await run(
        appUrl,
        `insert into document (application_id, document_type_id, subject, state)
         values ($1, $2, $3, 'uploaded') returning id`,
        [mine.id, item.document_type_id, item.subject]
      );
      await run(
        appUrl,
        `insert into document_version
           (document_id, version_no, file_name, content_type, size_bytes,
            sharepoint_path, uploaded_by, state, committed_at)
         values ($1, 1, 'scan.jpg', 'image/jpeg', 1024, '/x/scan.jpg', $2,
                 'committed', now())`,
        [doc.rows[0].id, system.rows[0].id]
      );
    }

    const submitted = await applications.submitMemberApplication(
      jane,
      mine.id,
      origin
    );
    expect(submitted.status).toBe('received');
    // The branch works it as a draft from here.
    expect(capture.isEditableStatus('received')).toBe(true);
    expect(submitted.submittedAt).toBeTruthy();
    expect(submitted.timeline.map(t => t.label)).toEqual([
      'Started',
      'Submitted',
    ]);

    // With the branch now: the applicant can no longer change it.
    await expect(
      applications.saveMemberApplication(jane, mine.id, [])
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      applications.deleteMemberDraft(jane, mine.id)
    ).rejects.toMatchObject({ code: 'conflict' });

    const audit = await run(
      appUrl,
      `select action, actor_description from audit_event
        where entity_id = $1 order by id`,
      [mine.id]
    );
    expect(audit.rows.map(r => r.action)).toContain(
      'membership.application.received'
    );
    expect(audit.rows.at(-1)?.actor_description).toBe('member-app:+2305xxx001');
  });

  it('a draft can be deleted by its owner', async () => {
    const sam = await applicantSession('5999 0003');
    const app = await applications.startMemberApplication(
      sam,
      'individual',
      origin
    );
    await applications.deleteMemberDraft(sam, app.id);
    expect(await applications.listMemberApplications(sam)).toEqual([]);
  });
});

describe('the record, for an applicant', () => {
  it('reads as nobody yet, with no accounts or documents', async () => {
    const sam = await applicantSession('5999 0003');
    expect(await profile.memberProfile(sam)).toMatchObject({
      kind: 'applicant',
      parties: [],
    });
    expect(await profile.memberAccounts(sam)).toEqual([]);
    expect(await profile.memberDocuments(sam)).toEqual([]);
    await expect(profile.submitDetails(sam, [], origin)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
