// Partner outlets for the membership card (migration 0116).
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

const dbName = `outlets_test_${Date.now()}`;
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
  return import('./outlets');
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
  name: '',
  logoUrl: 'https://albarakah.mu/images/outlets/x.png',
  category: '',
  discountPercent: '10',
  description: '',
  address: '',
  linkUrl: '',
  isActive: true,
  sortOrder: '',
};

describe('partner outlets', () => {
  it('lists the active ones in order, with the tag normalised', async () => {
    const outlets = await load();
    const grocer = await outlets.createOutlet(
      {
        ...blank,
        name: 'Winners',
        category: ' Groceries ',
        discountPercent: '5',
      },
      actor
    );
    await outlets.createOutlet(
      { ...blank, name: 'Closed Shop', category: 'food', isActive: false },
      actor
    );
    const tuition = await outlets.createOutlet(
      {
        ...blank,
        name: 'Bright Minds',
        category: 'Education',
        discountPercent: '12.5',
        sortOrder: '5',
      },
      actor
    );

    const active = await outlets.activeOutlets();
    expect(active.map(o => o.name)).toEqual(['Bright Minds', 'Winners']);
    expect(active[0].id).toBe(tuition);
    expect(active[0].discountPercent).toBe('12.50');
    expect(active[1].id).toBe(grocer);
    expect(active[1].category).toBe('groceries');
    expect(await outlets.outletCategories()).toEqual([
      'education',
      'food',
      'groceries',
    ]);
    expect(await outlets.listOutlets()).toHaveLength(3);
  });

  it('refuses what the app could not show', async () => {
    const outlets = await load();
    await expect(
      outlets.createOutlet(
        { ...blank, name: 'x', category: 'food', logoUrl: '' },
        actor
      )
    ).rejects.toThrow(/logo is required/);
    await expect(
      outlets.createOutlet(
        { ...blank, name: 'x', category: 'food', logoUrl: 'http://x/l.png' },
        actor
      )
    ).rejects.toThrow(/https/);
    await expect(
      outlets.createOutlet({ ...blank, name: 'x', category: '' }, actor)
    ).rejects.toThrow(/category is required/);
    for (const bad of ['0', '101', 'ten', '12.345']) {
      await expect(
        outlets.createOutlet(
          { ...blank, name: 'x', category: 'food', discountPercent: bad },
          actor
        )
      ).rejects.toThrow(/percentage/);
    }
    await expect(
      outlets.createOutlet(
        {
          ...blank,
          name: 'x',
          category: 'food',
          linkUrl: 'javascript:alert(1)',
        },
        actor
      )
    ).rejects.toThrow(/link/);
  });

  it('updates and removes an outlet', async () => {
    const outlets = await load();
    const id = await outlets.createOutlet(
      { ...blank, name: 'Al Noor', category: 'food' },
      actor
    );
    await outlets.updateOutlet(
      id,
      {
        ...blank,
        name: 'Al Noor Restaurant',
        category: 'food',
        address: 'Port Louis',
      },
      actor
    );
    const after = (await outlets.listOutlets()).find(o => o.id === id);
    expect(after?.name).toBe('Al Noor Restaurant');
    expect(after?.address).toBe('Port Louis');
    await outlets.deleteOutlet(id, actor);
    expect((await outlets.listOutlets()).some(o => o.id === id)).toBe(false);
    await expect(outlets.deleteOutlet(id, actor)).rejects.toThrow(
      /no longer exists/
    );
  });

  it('is audited like every other piece of configuration', async () => {
    await expect(
      run(
        appUrl,
        `insert into card_outlet (name, logo_url, category, discount_percent)
         values ('sneaky', 'https://x/l.png', 'food', 5)`
      )
    ).rejects.toThrowError(/has no actor/);
  });
});
