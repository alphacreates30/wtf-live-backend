// Security review #20: /admin/orders/label charged the buyer whatever amount_cents the browser sent, not the rate
// Shippo quoted. Now it re-reads the rate from Shippo before charging, charges that, and refuses (409, nothing
// charged) if the client's amount no longer matches.
// OLD is PINNED to 18002ac (before the fix). Local servers on the test database. Shippo is a stub inside the server
// process (global.fetch for api.goshippo.com) and Stripe an in-process fake that records the amounts it is asked to
// charge: nothing leaves the machine. Borrows zztest_paid_ok (placeholder card ids) read-only.
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '18002ac', RATE = 'rate_zztest_1', RATE_CENTS = 750;
const CHARGES = BE + '/run.tmp-label-charges.log';
const STRIPE_LINE = 'const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;';
const FAKE_STRIPE = `const stripe = { paymentIntents: { create: async (p) => { require('fs').appendFileSync(${JSON.stringify(CHARGES)}, p.amount + '\\n'); return { id: 'pi_ZZTEST_label_' + require('crypto').randomUUID().slice(0, 8) }; }, retrieve: async () => ({}) } };`;
const SHIPPO_STUB = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.goshippo.com')) return realFetch(url, opts);
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/rates/${RATE}/')) return json({ object_id: '${RATE}', amount: '${(RATE_CENTS / 100).toFixed(2)}', currency: 'USD', provider: 'USPS' });
  if (u.includes('/rates/')) return json({ detail: 'Not found' });
  if (u.endsWith('/transactions/')) return json({ status: 'SUCCESS', object_id: 'tx_zztest', label_url: 'https://example.invalid/label.pdf', tracking_number: 'ZZTESTTRK', tracking_url_provider: 'https://example.invalid/track' });
  return json({});
};`;
const OPTS = { env: { SHIPPO_API_KEY: 'zztest_shippo_stub' }, preload: SHIPPO_STUB, patch: [[STRIPE_LINE, FAKE_STRIPE]] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = [];
const charges = () => fs.existsSync(CHARGES) ? fs.readFileSync(CHARGES, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];

async function mkOrder(label, buyerId) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_label ' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind' }).select().single());
  made.push(a.id);
  return die(await s.from('orders').insert({ auction_id: a.id, buyer_username: 'zztest_paid_ok', buyer_user_id: buyerId, item_title: 'ZZTEST_label order', final_bid: 10, status: 'pending', payment_status: 'paid', ship_name: 'ZZ', ship_address1: '1 ZZ St', ship_city: 'X', ship_state: 'CA', ship_zip: '94000' }).select().single()).id;
}
const label = (url, tok, body) => fetch(url + '/admin/orders/label', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) })
  .then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));

(async () => {
  const servers = [];
  try {
    try { fs.unlinkSync(CHARGES); } catch {}
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const buyerId = String(die(await s.from('users').select('id').eq('username', 'zztest_paid_ok').single()).id);
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const oldSrv = await boot('label-old', 3541, oldSrc, OPTS), newSrv = await boot('label-new', 3542, newSrc, OPTS);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT}: Shippo's rate is $7.50, the request says 1 cent ==`);
    let r = await label(oldSrv.url, admin, { order_ids: [await mkOrder('old', buyerId)], rate_id: RATE, amount_cents: 1 });
    ok(r.s === 200 && charges().join() === '1', `OLD: ${r.s}, the buyer was charged ${charges().join()} cent(s) - not the $7.50 rate  <- CLIENT DECIDES THE AMOUNT`);

    console.log('\n== SAME on the FIXED code ==');
    fs.unlinkSync(CHARGES);
    const o = await mkOrder('new', buyerId);
    r = await label(newSrv.url, admin, { order_ids: [o], rate_id: RATE, amount_cents: 1 });
    ok(r.s === 409 && charges().length === 0, `NEW: mismatched amount -> ${r.s} "${r.j.error}", nothing charged`);
    r = await label(newSrv.url, admin, { order_ids: [o], rate_id: 'rate_zztest_gone', amount_cents: RATE_CENTS });
    ok(r.s === 400 && charges().length === 0, `NEW: a rate Shippo doesn't know -> ${r.s} "${r.j.error}", nothing charged`);
    r = await label(newSrv.url, admin, { order_ids: [o], rate_id: '../../x', amount_cents: RATE_CENTS });
    ok(r.s === 400 && charges().length === 0, `NEW: a malformed rate_id -> ${r.s}, nothing charged`);
    r = await label(newSrv.url, admin, { order_ids: [o], rate_id: RATE, amount_cents: RATE_CENTS });
    const row = die(await s.from('orders').select('shipping_cost_cents, shipping_payment_status, status, tracking_number').eq('id', o).single());
    ok(r.s === 200 && charges().join() === String(RATE_CENTS) && row.shipping_cost_cents === RATE_CENTS && row.status === 'label_created', `NEW: the matching quote -> ${r.s}, charged ${charges().join()} cents (Shippo's rate), label bought (${row.status}, ${row.tracking_number})`);
  } finally {
    servers.forEach(x => x.stop());
    try { fs.unlinkSync(CHARGES); } catch {}
    for (const id of made) { await s.from('orders').delete().eq('auction_id', id); await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_label %')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_label%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
