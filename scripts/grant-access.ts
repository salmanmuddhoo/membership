// Provision a staff account and grant it a role.
//
// Accounts are created by EMAIL, not by Entra subject: the OIDC `sub` claim is
// pairwise and not visible in the Azure portal, so there is nothing an
// administrator could look up. The subject is bound automatically the first
// time that person signs in (see src/lib/access/principal.ts).
//
// Connects as the schema owner, like the migration runner, because this is an
// administrative action rather than something the application does.
//
//   pnpm access:grant --email a@b.mu --name "A B" --role system_administrator
//   pnpm access:grant --email a@b.mu --role officer          (existing user)
//   pnpm access:grant --email a@b.mu --list                  (show current)
import process from 'node:process';
import pg from 'pg';
import { normaliseSslMode } from '../src/lib/config';

interface Args {
  email?: string;
  name?: string;
  role?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--list') {
      args.list = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;
    if (flag === '--email') args.email = value;
    if (flag === '--name') args.name = value;
    if (flag === '--role') args.role = value;
    i += 1;
  }
  return args;
}

function connectionString(): string {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_MIGRATION_URL (or DATABASE_URL) must be set to grant access.'
    );
    process.exit(1);
  }
  const insecure = process.env.DATABASE_ALLOW_INSECURE === 'true';
  const appEnv = process.env.PUBLIC_APP_ENV;
  if (insecure && (appEnv === undefined || appEnv === 'production')) {
    console.error(
      'DATABASE_ALLOW_INSECURE must never be enabled outside local development.'
    );
    process.exit(1);
  }
  return normaliseSslMode(url, insecure);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    console.error(
      'Usage: pnpm access:grant --email <address> [--name "Full Name"] ' +
        '[--role <code>] [--list]'
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  try {
    if (args.list) {
      const rows = await client.query(
        `select u.email::text as email, u.display_name, u.is_active,
                u.entra_subject is not null as signed_in_before,
                coalesce(
                  array_agg(r.code) filter (where r.code is not null), '{}'
                ) as roles
           from app_user u
           left join user_role ur on ur.user_id = u.id
           left join role r on r.id = ur.role_id
          where u.email = $1::citext
          group by u.id`,
        [args.email]
      );

      if (rows.rowCount === 0) {
        console.log(`No account for ${args.email}.`);
        return;
      }
      const row = rows.rows[0];
      console.log(`${row.email} — ${row.display_name}`);
      console.log(`  active:      ${row.is_active}`);
      console.log(`  signed in:   ${row.signed_in_before ? 'yes' : 'not yet'}`);
      console.log(`  roles:       ${row.roles.join(', ') || '(none)'}`);
      return;
    }

    // Create the account if it is new. The subject stays null until first
    // sign-in binds it.
    const created = await client.query<{ id: string }>(
      `insert into app_user (email, display_name)
       values ($1::citext, $2)
       on conflict (email) do update set display_name = coalesce(
         excluded.display_name, app_user.display_name
       )
       returning id`,
      [args.email, args.name ?? args.email]
    );
    const userId = created.rows[0].id;
    console.log(`Account ready: ${args.email}`);

    if (args.role) {
      const role = await client.query<{ id: string }>(
        'select id from role where code = $1',
        [args.role]
      );
      if (role.rowCount === 0) {
        console.error(
          `No role with code "${args.role}". Known roles: ` +
            (await client.query('select code from role order by code')).rows
              .map(r => r.code)
              .join(', ')
        );
        process.exit(1);
      }

      await client.query(
        `insert into user_role (user_id, role_id) values ($1, $2)
         on conflict do nothing`,
        [userId, role.rows[0].id]
      );
      console.log(`Granted role: ${args.role}`);
    }

    console.log(
      '\nThey can sign in now — the account binds to their Entra identity on ' +
        'first successful sign-in.'
    );
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
