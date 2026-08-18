// Creates (or provisions) a staff/admin user in Supabase.
// There is no public sign-up, so accounts are created here or in the
// Supabase dashboard (Authentication -> Users -> Add user).
//
// Requires (never commit these):
//   SUPABASE_URL                  your project URL (or PUBLIC_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY     service role key (Project Settings -> API)
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/create-user.mjs admin@albarakah.mu 'StrongPassw0rd!'
//   # or pass credentials via ADMIN_EMAIL / ADMIN_PASSWORD env vars.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.argv[2] || process.env.ADMIN_EMAIL;
const password = process.argv[3] || process.env.ADMIN_PASSWORD;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!url || !serviceKey) {
  fail(
    'Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY environment variables.'
  );
}
if (!email || !password) {
  fail(
    'Usage: node scripts/create-user.mjs <email> <password> ' +
      '(or set ADMIN_EMAIL / ADMIN_PASSWORD).'
  );
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true, // no confirmation email needed for staff accounts
  user_metadata: { role: 'admin' },
  app_metadata: { role: 'admin' },
});

if (error) {
  fail(`Could not create user: ${error.message}`);
}

console.log(`\n✔ Admin user ready: ${data.user.email} (${data.user.id})\n`);
