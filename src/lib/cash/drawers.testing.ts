import pg from 'pg';

// Tests only. Cash moves only through an open drawer (migration 0123), so a
// suite that takes or pays out cash opens one — float 0 — for every user who
// has none, as each officer would at the start of the day. Call it once the
// suite's users exist, and again after adding one who handles cash.
export async function openEveryDrawer(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query(
      `insert into cash_session (cashier_user_id, opening_float)
       select u.id, 0
         from app_user u
        where not exists (
          select 1 from cash_session s
           where s.cashier_user_id = u.id and s.closed_at is null
        )`
    );
  } finally {
    await client.end();
  }
}
