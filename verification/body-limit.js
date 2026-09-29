// Security review #12: every route parsed JSON bodies up to 60MB, anonymous ones included, so repeated huge POSTs
// to /auth/login could exhaust memory. Now 100kb, except the three admin routes that take photo batches / bulk
// lots, which parse their own body only after checking the caller is the admin.
// OLD is PINNED to 6ff4d7d (before the fix). Local servers on the test database; Stripe and email blanked.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '6ff4d7d';
const made = [];
const post = (url, path, body, tok) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body })
  .then(async r => ({ s: r.status, type: r.headers.get('content-type') || '', text: await r.text() }));
const big = mb => JSON.stringify({ username: 'zztest_bodylimit', password: 'x', pad: 'a'.repeat(mb * 1024 * 1024) });

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const a = await s.from('auctions').insert({ title: 'ZZTEST_bodylimit', description: 'x', status: 'draft', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind' }).select().single();
    if (a.error) throw new Error(JSON.stringify(a.error));
    made.push(a.data.id);
    const oldSrv = await boot('body-old', 3441, oldSrc), newSrv = await boot('body-new', 3442, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await post(oldSrv.url, '/auth/login', big(20));
    ok(r.s === 401, `OLD: an anonymous 20MB login body is read and parsed in full (${r.s} "Invalid credentials")  <- NO LIMIT`);

    console.log('\n== SAME on the FIXED code ==');
    r = await post(newSrv.url, '/auth/login', big(20));
    ok(r.s === 413 && r.type.includes('json') && !/at .*\.js:\d+/.test(r.text), `NEW: 20MB anonymous login body -> ${r.s} ${r.text} (JSON, no stack trace)`);
    r = await post(newSrv.url, '/auth/login', JSON.stringify({ username: 'x', password: 'x', pad: 'a'.repeat(150 * 1024) }));
    ok(r.s === 413, `NEW: 150kb login body -> ${r.s}`);
    r = await post(newSrv.url, '/auth/login', '{"username": broken');
    ok(r.s === 400 && r.type.includes('json') && !/at .*\.js:\d+/.test(r.text), `NEW: malformed JSON -> ${r.s} ${r.text} (JSON, no stack trace)`);
    r = await post(newSrv.url, '/auth/login', JSON.stringify({ username: 'zztest_bodylimit_nobody', password: 'x' }));
    ok(r.s === 401, `NEW: a normal login body still works (${r.s})`);
    r = await post(newSrv.url, '/ai/analyze-lot', JSON.stringify({ images: ['a'.repeat(2 * 1024 * 1024)] }));
    ok(r.s === 401, `NEW: anonymous 2MB to an AI route -> ${r.s} (refused before the body is read)`);
    r = await post(newSrv.url, `/auction/${a.data.id}/items/bulk`, JSON.stringify({ lots: [{ pad: 'a'.repeat(2 * 1024 * 1024) }] }), admin);
    ok(r.s === 400 && r.text.includes('title is required'), `NEW: the admin's 2MB bulk-create body is still accepted and read (${r.s}: its lot has no title)`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_bodylimit%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
