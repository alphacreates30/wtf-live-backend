// Security review #17: a draft auction is hidden (GET /auction/:id is 404 for non-admins), but its bids and chat
// were readable anonymously by id. Now they get the same 404; the admin still sees them; live auctions unchanged.
// OLD is PINNED to a99a549 (before the fix). Local servers on the test database.
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
const OLD_COMMIT = 'a99a549';
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = [];
const tok = u => jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' });
const ADMIN = tok({ id: crypto.randomUUID(), username: 'whatthefind' }), BUYER = tok({ id: crypto.randomUUID(), username: 'zztest_draftreads' });
const get = (url, p, t) => fetch(url + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

async function mkAuction(label, status) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_draftreads ' + label, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind' }).select().single());
  made.push(a.id);
  die(await s.from('chat_messages').insert({ auction_id: a.id, username: 'zztest_draftreads', text: 'ZZTEST secret draft chat', role: 'viewer' }).select().single());
  die(await s.from('bids').insert({ auction_id: a.id, username: 'zztest_draftreads', amount: 7 }).select().single());
  return a.id;
}

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const draft = await mkAuction('draft', 'draft'), live = await mkAuction('live', 'live');
    const oldSrv = await boot('draftreads-old', 3511, oldSrc), newSrv = await boot('draftreads-new', 3512, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let b = await get(oldSrv.url, `/auction/${draft}/bids`), c = await get(oldSrv.url, `/auction/${draft}/chat`);
    ok(b.s === 200 && b.j.length === 1 && c.s === 200 && c.j.length === 1, `OLD: anonymous reads of a DRAFT's bids (${b.s}, ${b.j && b.j.length}) and chat (${c.s}, ${c.j && c.j.length})  <- EXPOSED`);

    console.log('\n== SAME on the FIXED code ==');
    for (const [who, t] of [['anonymous', null], ['a logged-in buyer', BUYER]]) {
      b = await get(newSrv.url, `/auction/${draft}/bids`, t); c = await get(newSrv.url, `/auction/${draft}/chat`, t);
      ok(b.s === 404 && c.s === 404, `NEW: ${who} -> draft bids ${b.s}, draft chat ${c.s}`);
    }
    b = await get(newSrv.url, `/auction/${draft}/bids`, ADMIN); c = await get(newSrv.url, `/auction/${draft}/chat`, ADMIN);
    ok(b.s === 200 && b.j.length === 1 && c.s === 200 && c.j.length === 1, 'NEW: the admin still reads a draft\'s bids and chat');
    b = await get(newSrv.url, `/auction/${live}/bids`); c = await get(newSrv.url, `/auction/${live}/chat`);
    ok(b.s === 200 && b.j.length === 1 && c.s === 200 && c.j.length === 1, 'NEW: a live auction\'s bids and chat are still public');
    b = await get(newSrv.url, `/auction/${crypto.randomUUID()}/bids`);
    ok(b.s === 200 && Array.isArray(b.j) && b.j.length === 0, 'NEW: an unknown auction id still answers an empty list (as before)');
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_draftreads%')).data.length + (await s.from('chat_messages').select('id').eq('username', 'zztest_draftreads')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
