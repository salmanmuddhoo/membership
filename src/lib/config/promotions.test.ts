// The member app's home-screen cards (migration 0111).
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

const dbName = `promotions_test_${Date.now()}`;
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
  return import('./promotions');
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

const blank = {
  title: '',
  body: '',
  imageUrl: 'https://albarakah.mu/images/card.jpg',
  linkUrl: '',
  linkLabel: '',
  accent: '',
  isActive: true,
  startsOn: '',
  endsOn: '',
  sortOrder: '',
};

describe('the home-screen cards', () => {
  it('shows the live ones in order, and only those', async () => {
    const promotions = await load();
    const hajj = await promotions.createPromotion(
      {
        ...blank,
        title: 'Hajj savings',
        body: 'Save monthly.',
        accent: '#0B443A',
      },
      actor
    );
    await promotions.createPromotion(
      { ...blank, title: 'Retired card', isActive: false },
      actor
    );
    await promotions.createPromotion(
      { ...blank, title: 'Next year', startsOn: '2099-01-01' },
      actor
    );
    await promotions.createPromotion(
      { ...blank, title: 'Last year', endsOn: '2000-01-01' },
      actor
    );
    const agm = await promotions.createPromotion(
      {
        ...blank,
        title: 'AGM',
        linkUrl: 'https://albarakah.mu/agm',
        linkLabel: 'Agenda',
        sortOrder: '5',
      },
      actor
    );

    const live = await promotions.livePromotions();
    expect(live.map(p => p.title)).toEqual(['AGM', 'Hajj savings']);
    expect(live[0].id).toBe(agm);
    expect(live[1].id).toBe(hajj);
    // The colour is stored lower-case, as the app compares it.
    expect(live[1].accent).toBe('#0b443a');
    expect(live[0].linkLabel).toBe('Agenda');

    const all = await promotions.listPromotions();
    expect(all).toHaveLength(5);
    expect(
      all
        .filter(p => !p.isLive)
        .map(p => p.title)
        .sort()
    ).toEqual(['Last year', 'Next year', 'Retired card']);
  });

  it('refuses what the app could not show', async () => {
    const promotions = await load();
    await expect(
      promotions.createPromotion({ ...blank, title: '   ' }, actor)
    ).rejects.toThrow(/title is required/);
    await expect(
      promotions.createPromotion({ ...blank, title: 'x', imageUrl: '' }, actor)
    ).rejects.toThrow(/picture is required/);
    await expect(
      promotions.createPromotion(
        { ...blank, title: 'x', imageUrl: 'http://insecure.example/a.png' },
        actor
      )
    ).rejects.toThrow(/https/);
    await expect(
      promotions.createPromotion(
        { ...blank, title: 'x', linkUrl: 'javascript:alert(1)' },
        actor
      )
    ).rejects.toThrow(/link/);
    await expect(
      promotions.createPromotion(
        { ...blank, title: 'x', accent: 'green' },
        actor
      )
    ).rejects.toThrow(/colour/);
    await expect(
      promotions.createPromotion(
        { ...blank, title: 'x', startsOn: '2030-02-01', endsOn: '2030-01-01' },
        actor
      )
    ).rejects.toThrow(/end before it starts/);
  });

  it('updates and removes a card, and drops a label that has no link', async () => {
    const promotions = await load();
    const id = await promotions.createPromotion(
      {
        ...blank,
        title: 'Refer a friend',
        linkUrl: 'https://albarakah.mu',
        linkLabel: 'More',
      },
      actor
    );
    await promotions.updatePromotion(
      id,
      { ...blank, title: 'Refer a friend', linkLabel: 'More' },
      actor
    );
    const after = (await promotions.listPromotions()).find(p => p.id === id);
    expect(after?.linkUrl).toBeNull();
    expect(after?.linkLabel).toBeNull();

    await promotions.deletePromotion(id, actor);
    expect((await promotions.listPromotions()).some(p => p.id === id)).toBe(
      false
    );
    await expect(promotions.deletePromotion(id, actor)).rejects.toThrow(
      /no longer exists/
    );
  });

  it('is audited like every other piece of configuration', async () => {
    await expect(
      run(appUrl, `insert into app_promotion (title) values ('sneaky')`)
    ).rejects.toThrowError(/has no actor/);
  });
});
