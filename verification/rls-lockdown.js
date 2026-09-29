// Security review #1: the Supabase API roles (anon, authenticated) must have no access to the public schema.
// Before migration 2026-09-29p they held ALL privileges on every public table (RLS off on 9, no policies anywhere)
// and could EXECUTE place_bid / place_standard_bid, so anyone with the anon key could read password hashes and
// addresses, rewrite orders, or bid as anyone through the REST API. This suite acts as those roles exactly the way
// PostgREST does (SET ROLE inside a transaction, always rolled back) and checks what they can reach.
// Two phases, detected from the live schema (like orphan-protection.js): BEFORE the migration it records the
// controls and exits 2; AFTER it asserts everything is refused and the backend's service_role still works.
// Test database only: needs TEST_DB_URL from .env.test, and refuses unless it is the same project as SUPABASE_URL.
const fs = require('fs');
require('./guard')(__filename);
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
if (process.argv.some(a => a.startsWith('--yes-'))) { console.log('rls-lockdown.js runs on the test database only.'); process.exit(2); }
const dbUrl = require(BE + '/node_modules/dotenv').parse(fs.readFileSync(BE + '/.env.test')).TEST_DB_URL;
const ref = new URL(process.env.SUPABASE_URL).host.split('.')[0];
if (!dbUrl || !decodeURIComponent(new URL(dbUrl).username).endsWith('.' + ref)) { console.log('TEST_DB_URL missing or not the same project as SUPABASE_URL - refusing.'); process.exit(2); }
const { Client } = require(BE + '/node_modules/pg');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const TABLES = ['users', 'profiles', 'orders', 'invoices', 'bids', 'pre_bids', 'auctions', 'auction_items', 'item_images', 'chat_messages', 'auction_terms_acceptances', 'password_resets', 'email_send_log', 'outbid_email_log', 'ai_usage'];

// Runs one statement as `role`, the way PostgREST does, and always rolls back. Returns the Postgres error code
// ('42501' = permission denied) or 'ok'.
async function as(c, role, sql, params = []) {
  await c.query('begin');
  try {
    await c.query(`set local role ${role}`);
    await c.query(sql, params);
    return 'ok';
  } catch (e) {
    return e.code || e.message;
  } finally {
    await c.query('rollback');
  }
}
// Would a table/sequence/function created later by postgres be open to anon? Created and rolled back.
async function defaultsOpen(c) {
  await c.query('begin');
  try {
    await c.query('create table public.zz_rls_probe (x int)');
    await c.query('create sequence public.zz_rls_probe_seq');
    await c.query('create function public.zz_rls_probe_fn() returns int language sql as $$ select 1 $$');
    const r = await c.query(`select has_table_privilege('anon', 'public.zz_rls_probe', 'SELECT') t,
      has_sequence_privilege('anon', 'public.zz_rls_probe_seq', 'USAGE') s,
      has_function_privilege('anon', 'public.zz_rls_probe_fn()', 'EXECUTE') f`);
    return r.rows[0];
  } finally {
    await c.query('rollback');
  }
}
const PROBE_BID = `select public.place_standard_bid('00000000-0000-4000-8000-000000000000'::uuid, 'x', 'zz', 1::numeric, 1::numeric, 2)`;

(async () => {
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const before = (await as(c, 'anon', 'select 1 from public.users limit 1')) === 'ok';
    if (before) {
      console.log('== BEFORE migration 2026-09-29p: recording what the API roles can reach (controls) ==');
      ok((await as(c, 'anon', 'select password_hash from public.users limit 1')) === 'ok', 'CONTROL anon can SELECT users.password_hash  <- OPEN');
      ok((await as(c, 'anon', 'select address_line1, stripe_customer_id from public.profiles limit 1')) === 'ok', 'CONTROL anon can SELECT profiles addresses and Stripe ids  <- OPEN');
      ok((await as(c, 'anon', `insert into public.users (username, password_hash) values ('zz_rls_probe', 'x')`)) === 'ok', 'CONTROL anon can INSERT into users (rolled back)  <- OPEN');
      ok((await as(c, 'anon', PROBE_BID)) !== '42501', 'CONTROL anon can EXECUTE place_standard_bid  <- OPEN');
      const d = await defaultsOpen(c);
      ok(d.t && d.s && d.f, `CONTROL a table/sequence/function created later would be open to anon (${JSON.stringify(d)})`);
      console.log('\nApply migrations/2026-09-29p-rls-lockdown.sql, then re-run. Exiting 2 (not yet migrated).');
      process.exit(fails ? 1 : 2);
    }

    console.log('== AFTER migration 2026-09-29p: the API roles reach nothing ==');
    for (const role of ['anon', 'authenticated']) {
      const open = [];
      for (const t of TABLES) if ((await as(c, role, `select 1 from public.${t} limit 1`)) !== '42501') open.push(t);
      ok(!open.length, `${role}: SELECT refused on all ${TABLES.length} tables${open.length ? ' - still open: ' + open.join(', ') : ''}`);
      ok((await as(c, role, `insert into public.users (username, password_hash) values ('zz_rls_probe', 'x')`)) === '42501', `${role}: INSERT into users refused`);
      ok((await as(c, role, `update public.orders set payment_status = 'paid'`)) === '42501', `${role}: UPDATE orders refused`);
      ok((await as(c, role, `delete from public.invoices`)) === '42501', `${role}: DELETE from invoices refused`);
      ok((await as(c, role, PROBE_BID)) === '42501', `${role}: EXECUTE place_standard_bid refused`);
      ok((await as(c, role, `select public.place_bid('00000000-0000-4000-8000-000000000000'::uuid, 'zz', 1)`)) === '42501', `${role}: EXECUTE place_bid refused`);
      ok((await as(c, role, `select nextval('public.ai_usage_id_seq')`)) === '42501', `${role}: sequence use refused`);
    }
    const noRls = (await c.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`)).rows.map(r => r.relname);
    ok(!noRls.length, `RLS on for every public table${noRls.length ? ' - missing: ' + noRls.join(', ') : ''}`);
    const d = await defaultsOpen(c);
    ok(!d.t && !d.s && !d.f, `objects created later by postgres start closed to anon (${JSON.stringify(d)})`);

    console.log('\n== The backend (service_role) is unaffected ==');
    const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const u = await s.from('users').select('id', { count: 'exact', head: true });
    ok(!u.error && u.count >= 1, `service_role REST read of users: ${u.error ? u.error.message : u.count + ' row(s)'}`);
    const f = await s.rpc('get_expired_standard_items');
    ok(!f.error, `service_role can still EXECUTE functions (get_expired_standard_items): ${f.error ? f.error.message : 'ok'}`);
  } finally {
    await c.end();
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
