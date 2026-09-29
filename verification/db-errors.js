// Security review #16: when the database failed, several routes (public ones included) sent the raw error object
// back - table, column and constraint names, Postgres detail. Now the client gets a short generic message and the
// detail is logged; the bid function's own readable messages (P0001) still reach the bidder.
// OLD is PINNED to be6509e (before the fix). To make the database fail on demand, both servers are pointed at an
// address that refuses connections (SUPABASE_URL for that server only); the second part uses the test database.
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
const OLD_COMMIT = 'be6509e';
const DEAD_DB = { SUPABASE_URL: 'http://127.0.0.1:9' };
const ID = crypto.randomUUID();
const PUBLIC_READS = ['/auctions', `/auction/${ID}/bids`, `/auction/${ID}/chat`, `/auction/${ID}/items`, `/auction/${ID}/items/${ID}/images`];
const get = (url, p) => fetch(url + p).then(async r => ({ s: r.status, text: await r.text() }));
const leaky = t => /fetch failed|details|hint|code|TypeError|ECONNREFUSED/i.test(t);
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');

    console.log(`== REPRODUCE on ${OLD_COMMIT}: the database is unreachable ==`);
    const oldDead = await boot('dberr-old', 3501, oldSrc, { env: DEAD_DB }); servers.push(oldDead);
    const oldLeaks = [];
    for (const p of PUBLIC_READS) { const r = await get(oldDead.url, p); if (r.s === 500 && leaky(r.text)) oldLeaks.push(`${p} -> ${r.text.slice(0, 70)}`); }
    ok(oldLeaks.length >= 4, `OLD: ${oldLeaks.length} of ${PUBLIC_READS.length} public reads send the raw error, e.g. ${oldLeaks[0]}  <- LEAKS`);
    oldDead.stop();

    console.log('\n== SAME on the FIXED code ==');
    const newDead = await boot('dberr-new', 3502, newSrc, { env: DEAD_DB, log: true }); servers.push(newDead);
    for (const p of PUBLIC_READS) {
      const r = await get(newDead.url, p);
      ok(r.s === 500 && !leaky(r.text) && r.text.includes('Something went wrong'), `NEW: ${p} -> ${r.s} ${r.text}`);
    }
    ok(/GET \/auctions failed:/.test(newDead.log()), 'NEW: the detail is in the server log instead');
    newDead.stop();

    console.log('\n== FIXED code, working database: the bid function\'s own messages still reach the bidder ==');
    const srv = await boot('dberr-bid', 3503, newSrc); servers.push(srv);
    const a = die(await s.from('auctions').insert({ title: 'ZZTEST_dberr', description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
    made.auctions.push(a.id);
    const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_dberr lot', starting_bid: 0, current_bid: 0, position: 0, status: 'pending', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
    const u = { id: crypto.randomUUID(), username: 'zztest_dberr' }; made.users.push(u.id);
    die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZ', email: 'zz@example.invalid', phone: '0', address_line1: '1', city: 'X', state: 'CA', zip: '1', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_dberr', stripe_payment_method_id: 'pm_ZZFIXTURE_dberr' }).select().single());
    die(await s.from('auction_terms_acceptances').insert({ auction_id: a.id, user_id: u.id, buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' }).select().single());
    const r = await fetch(`${srv.url}/auction/${a.id}/items/${lot.id}/bid`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' }) }, body: JSON.stringify({ max_amount: 5 }) });
    const j = await r.json();
    ok(r.status === 400 && j.error === 'Item is not open for bidding', `NEW: bid on a lot that isn't open -> ${r.status} "${j.error}" (the function's own message)`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('profiles').delete().in('user_id', made.users);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_dberr%')).data.length + (await s.from('profiles').select('id').in('user_id', made.users.length ? made.users : ['x'])).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
