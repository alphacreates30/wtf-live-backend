// A5: the backend goes live before (or without) migration 2026-09-30t on a database. It must stay safe: registration,
// login and the admin screens work as before, and the delete route says "not available yet" (503), changing nothing.
// The missing migration is simulated by pointing this server's copy of the code at column/table/function names
// that don't exist (the same PostgREST errors a database without t gives). Local server on the test database.
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const crypto = require('crypto');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const PW = 'correct-horse-premig', tag = Date.now().toString(36);
const ABSENT = [
  ["rpc('account_deletion_blockers'", "rpc('account_deletion_blockers_zz_absent'"],
  ["rpc('delete_account'", "rpc('delete_account_zz_absent'"],
  ["from('reserved_usernames')", "from('reserved_usernames_zz_absent')"],
  ["'deleted_at'", "'deleted_at_zz_absent'"],
];
const made = [];
const call = (url, method, p, tok, body) => fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ s: r.status, text: await r.text() }));

(async () => {
  let srv;
  try {
    let src = require('./guard').readSource(BE + '/server.js');
    for (const [a, b] of ABSENT) { if (!src.includes(a)) throw new Error('marker not found: ' + a); src = src.split(a).join(b); }
    srv = await boot('premig', 3581, src);
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });

    console.log('== new code, database WITHOUT migration t ==');
    let r = await call(srv.url, 'POST', '/auth/register', null, { username: `zzpremig_${tag}`, password: PW, email: 'zz@example.invalid' });
    const reg = r.s === 200 ? JSON.parse(r.text) : null;
    if (reg) made.push(reg.user.id);
    ok(r.s === 200, `registration still works (${r.s})`);
    ok((await call(srv.url, 'POST', '/auth/login', null, { username: `zzpremig_${tag}`, password: PW })).s === 200, 'login still works');
    const p = await s.from('profiles').insert({ user_id: String(reg.user.id), full_name: 'ZZ Premig', email: 'zz@example.invalid', phone: '0', address_line1: '1', city: 'X', state: 'CA', zip: '1', status: 'pending' }).select().single();
    ok(!p.error, 'fixture profile');
    r = await call(srv.url, 'POST', '/account/delete', reg.token, { password: PW, confirm: 'DELETE' });
    const u = (await s.from('users').select('username, email, deleted_at').eq('id', reg.user.id).single()).data;
    ok(r.s === 503 && /not available yet/.test(r.text) && u.username === `zzpremig_${tag}` && u.email === 'zz@example.invalid' && !u.deleted_at, `delete route -> ${r.s} ${r.text}; nothing changed`);
    r = await call(srv.url, 'GET', '/admin/buyers', admin);
    ok(r.s === 200 && JSON.parse(r.text).some(b => b.user_id === String(reg.user.id) && !b.deleted), `admin buyers list still loads (${r.s})`);
    ok((await call(srv.url, 'PATCH', `/admin/buyers/${reg.user.id}`, admin, { status: 'approved' })).s === 200, 'admin can still approve a buyer');
    ok((await call(srv.url, 'POST', `/admin/users/${reg.user.id}/password`, admin, { new_password: 'temporary-pass-1' })).s === 200, 'admin can still set a temporary password');
  } finally {
    if (srv) srv.stop();
    await s.from('profiles').delete().in('user_id', made.map(String));
    await s.from('users').delete().in('id', made);
    const left = (await s.from('users').select('id').like('username', 'zzpremig_%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
