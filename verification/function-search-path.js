// Security review #27: the 5 public functions resolved their tables through the CALLER's search_path ("function
// search path mutable"). Postgres searches a session's temporary tables before public, so a caller could make a
// function read or write its own table instead of the real one. Migration 2026-09-29s pins search_path to '' and
// names every table public.<table>.
// Two phases, detected from the live schema (like rls-lockdown.js): BEFORE the migration it records the controls
// (including a real shadowing: temp tables named like ours, inside a transaction that is always rolled back) and
// exits 2; AFTER it asserts the fix. Test database only: needs TEST_DB_URL from .env.test.
const fs = require('fs');
require('./guard')(__filename);
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
if (process.argv.some(a => a.startsWith('--yes-'))) { console.log('function-search-path.js runs on the test database only.'); process.exit(2); }
const dbUrl = require(BE + '/node_modules/dotenv').parse(fs.readFileSync(BE + '/.env.test')).TEST_DB_URL;
const ref = new URL(process.env.SUPABASE_URL).host.split('.')[0];
if (!dbUrl || !decodeURIComponent(new URL(dbUrl).username).endsWith('.' + ref)) { console.log('TEST_DB_URL missing or not the same project as SUPABASE_URL - refusing.'); process.exit(2); }
const { Client } = require(BE + '/node_modules/pg');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const FUNCS = ['delete_auction_cascade', 'get_expired_standard_items', 'place_bid', 'place_standard_bid', 'update_standard_leader_max'];
const SHADOW_ID = '00000000-0000-4000-8000-00000000abcd';

// Inside a rolled-back transaction: temp tables named auctions / auction_items holding one expired "lot", then ask
// the real function for expired lots. A mutable search_path finds the temp tables first.
async function shadowed(c) {
  await c.query('begin');
  try {
    await c.query('create temporary table auctions (like public.auctions including defaults)');
    await c.query('create temporary table auction_items (like public.auction_items including defaults)');
    await c.query(`insert into pg_temp.auctions (id, title, status, mode, fulfillment_mode, host_username) values ('${SHADOW_ID}', 'ZZTEST shadow', 'live', 'standard', 'shipping', 'zz')`);
    await c.query(`insert into pg_temp.auction_items (id, auction_id, title, status, ends_at, position, starting_bid) values ('${SHADOW_ID}', '${SHADOW_ID}', 'ZZTEST shadow lot', 'open', now() - interval '1 hour', 0, 0)`);
    const r = await c.query('select id from public.get_expired_standard_items()');
    return r.rows.some(x => x.id === SHADOW_ID);
  } finally {
    await c.query('rollback');
  }
}

(async () => {
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const rows = (await c.query(`select p.proname, p.proconfig, p.oid::regprocedure::text sig,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') sr
      from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
    const pinned = r => (r.proconfig || []).includes('search_path=""');
    const mutable = rows.filter(r => !pinned(r)).map(r => r.proname);
    if (mutable.length) {
      console.log('== BEFORE migration 2026-09-29s: controls ==');
      ok(FUNCS.every(f => mutable.includes(f)), `CONTROL all 5 functions have a mutable search_path: ${mutable.join(', ')}`);
      ok(await shadowed(c), 'CONTROL get_expired_standard_items() returns a lot from a caller\'s TEMP table named auction_items  <- SHADOWED (rolled back)');
      console.log('\nApply migrations/2026-09-29s-function-search-path.sql, then re-run. Exiting 2 (not yet migrated).');
      process.exit(fails ? 1 : 2);
    }

    console.log('== AFTER migration 2026-09-29s ==');
    ok(FUNCS.every(f => rows.some(r => r.proname === f)) && rows.every(pinned), `every public function (${rows.length}) has search_path pinned to ''`);
    ok(!(await shadowed(c)), 'a caller\'s TEMP tables named auctions / auction_items are ignored: the function reads public.* only');
    ok(rows.every(r => !r.anon && !r.auth && r.sr), 'grants unchanged: anon/authenticated cannot EXECUTE, service_role can (migration p holds)');
    // The bodies' logic is exercised end to end by the other suites (bids: terms-gate, secret-max, bid-eligibility;
    // leader max: terms-gate; cascade: delete-atomic, orphan-protection; close: scale-200-close; live: live-socket-scope).
  } finally {
    await c.end();
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
