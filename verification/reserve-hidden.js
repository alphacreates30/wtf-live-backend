// Security review #8: a lot's reserve_price is undisclosed (the terms say so) but went to everyone on the public
// lot endpoints and in bid responses. Now it goes only to the admin/host, like top_pre_bid.
// OLD is PINNED to 6db2e29 (before the fix). Local servers on the test database; Stripe and email blanked.
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
const OLD_COMMIT = '6db2e29', RESERVE = 777.77;
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };
const call = (url, method, path, tok, body) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ s: r.status, text: await r.text() }));
const shows = text => text.includes('reserve_price') || text.includes(String(RESERVE));

async function setup(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_reserve ' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  made.auctions.push(a.id);
  const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_reserve lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', reserve_price: RESERVE, ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  const u = { id: crypto.randomUUID(), username: 'zztest_reserve_' + label };
  made.users.push(u.id);
  die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZTEST reserve', email: 'zz@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_reserve', stripe_payment_method_id: 'pm_ZZFIXTURE_reserve' }).select().single());
  die(await s.from('auction_terms_acceptances').insert({ auction_id: a.id, user_id: u.id, buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' }).select().single());
  return { a: a.id, lot: lot.id, tok: jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}
async function look(url, f) {
  const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  return {
    anonItems: await call(url, 'GET', `/auction/${f.a}/items`),
    anonStatus: await call(url, 'GET', `/auction/${f.a}/items/standard-status`),
    buyerItems: await call(url, 'GET', `/auction/${f.a}/items`, f.tok),
    bid: await call(url, 'POST', `/auction/${f.a}/items/${f.lot}/bid`, f.tok, { max_amount: 5 }),
    adminItems: await call(url, 'GET', `/auction/${f.a}/items`, admin),
  };
}

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('reserve-old', 3421, oldSrc), newSrv = await boot('reserve-new', 3422, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await look(oldSrv.url, await setup('old'));
    ok(shows(r.anonItems.text) && shows(r.anonStatus.text) && shows(r.bid.text), `OLD: reserve $${RESERVE} in the anonymous lot list, standard-status and a buyer's bid response  <- EXPOSED`);

    console.log('\n== SAME on the FIXED code ==');
    r = await look(newSrv.url, await setup('new'));
    ok(r.anonItems.s === 200 && !shows(r.anonItems.text), 'NEW: anonymous GET /items - no reserve');
    ok(r.anonStatus.s === 200 && !shows(r.anonStatus.text), 'NEW: anonymous GET /items/standard-status - no reserve');
    ok(r.buyerItems.s === 200 && !shows(r.buyerItems.text), 'NEW: logged-in buyer GET /items - no reserve');
    ok(r.bid.s === 200 && !shows(r.bid.text), `NEW: the buyer's own bid response (${r.bid.s}) - no reserve`);
    ok(r.adminItems.s === 200 && r.adminItems.text.includes('"reserve_price":' + RESERVE), 'NEW: the admin still sees the reserve');
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('profiles').delete().in('user_id', made.users);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_reserve %')).data.length
      + (await s.from('profiles').select('id').in('user_id', made.users)).data.length
      + (await s.from('auction_terms_acceptances').select('user_id').in('user_id', made.users)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
