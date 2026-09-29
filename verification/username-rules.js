// Security review #14: admin is decided by the username 'whatthefind', and names had no rules, so lookalikes
// ('WhatTheFind', 'WHATTHEFIND', a trailing space, a Cyrillic 'а', markup) all registered and could impersonate the
// host. New names: lowercase a-z 0-9 _, 3-30, nothing containing 'whatthefind' or staff-sounding, unique regardless
// of case (server check + the lower(username) index from migration q). Login accepts any casing.
// OLD is PINNED to 8d21f1e (before the fix). Local servers on the test database; Stripe and email blanked.
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '8d21f1e', PW = 'correct-horse-names';
const tag = 'zzun' + Date.now().toString(36);
const LOOKALIKES = ['WhatTheFind', 'WHATTHEFIND', 'whatthefind ', 'whаtthefind', 'what_the_find', 'whatthefind_official', 'Admin', '<img src=x onerror=1>', 'a b'];
const register = (url, username) => fetch(url + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW, email: 'zz@example.invalid' }) })
  .then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const login = (url, username) => fetch(url + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) }).then(r => r.status);
const created = [];
const track = r => { if (r.j && r.j.user) created.push(r.j.user.id); return r; };

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('names-old', 3481, oldSrc), newSrv = await boot('names-new', 3482, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT}: host lookalikes register ==`);
    const oldOk = [];
    for (const n of LOOKALIKES) { const r = track(await register(oldSrv.url, n)); if (r.s === 200) oldOk.push(n); }
    ok(oldOk.length >= 7, `OLD: ${oldOk.length} of ${LOOKALIKES.length} lookalike/markup names registered: ${oldOk.map(n => JSON.stringify(n)).join(', ')}  <- IMPERSONATION`);
    // clear them so the fixed server's checks aren't answered by these rows
    await s.from('users').delete().in('id', created.splice(0));

    console.log('\n== SAME names on the FIXED code ==');
    for (const n of LOOKALIKES) {
      const r = track(await register(newSrv.url, n));
      ok(r.s === 400, `NEW: ${JSON.stringify(n)} refused (${r.s} "${r.j.error}")`);
    }

    console.log('\n== FIXED code: case and the legitimate path ==');
    let r = track(await register(newSrv.url, (tag + '_Case').toUpperCase()));
    ok(r.s === 200 && r.j.user.username === tag + '_case', `NEW: "${(tag + '_Case').toUpperCase()}" registers, stored as "${r.j.user && r.j.user.username}"`);
    r = track(await register(newSrv.url, tag + '_case'));
    ok(r.s === 409, `NEW: the same name in another case -> ${r.s} "${r.j.error}"`);
    ok(await login(newSrv.url, tag + '_case') === 200 && await login(newSrv.url, (tag + '_case').toUpperCase()) === 200, 'NEW: login works typed lowercase or UPPERCASE');
    // An existing mixed-case account (made before these rules) still logs in with its exact name.
    const bcrypt = require(BE + '/node_modules/bcryptjs');
    const legacy = await s.from('users').insert({ username: tag + '_Legacy', password_hash: await bcrypt.hash(PW, 10) }).select().single();
    if (!legacy.error) created.push(legacy.data.id);
    ok(!legacy.error && await login(newSrv.url, tag + '_Legacy') === 200, 'NEW: an older mixed-case account still logs in with its exact name');
    const dup = await s.from('users').insert({ username: (tag + '_legacy').toUpperCase(), password_hash: 'x' }).select().single();
    if (!dup.error) created.push(dup.data.id);
    ok(dup.error && dup.error.code === '23505' && /users_username_lower_key/.test(dup.error.message), `DB: a raw insert differing only by case is refused (${dup.error && dup.error.code} ${dup.error && (dup.error.message.match(/users_\w+/) || [''])[0]}) - migration q`);
  } finally {
    servers.forEach(x => x.stop());
    if (created.length) await s.from('users').delete().in('id', created);
    const left = (await s.from('users').select('id').ilike('username', tag + '%')).data.length
      + (await s.from('users').select('id').or('username.ilike.*whatthefind*,username.ilike.*what_the_find*,username.eq.Admin,username.like.<img*,username.eq.a b')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
