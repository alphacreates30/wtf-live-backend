// "As few boxes as possible" (wtf-handoff MULTI_BOX_AND_WORDING_BRIEF.md §1): one buyer's wins from a show, split by
// the host into two boxes. Each box is its own quote, its own postage charge and its own label; the second box never
// overwrites the first; the order group stays together; the packing list counts the lots still to ship; one shipped
// email per box with that box's postage and tracking. The bundle bonus (G2) makes every box free for a buyer with 3+
// lots in the event, even a box holding only 2 of them. One box holds one buyer's lots.
// Needs migration z (promotions). Local server on the test database; Shippo, Stripe and Resend are stubs inside the
// server process: nothing leaves the machine.
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const P = 'ZZTEST_boxes';
const TAG = crypto.randomBytes(3).toString('hex');
const MAIL = BE + '/run.tmp-boxes-mail.log', CALLS = BE + '/run.tmp-boxes-stripe.log';
const SECRET = crypto.randomBytes(32).toString('hex');
// The quote's rate follows the parcel's weight: a heavy box ($9.40) and a light one ($6.15).
const RATES = { [`rate_zzbox_heavy_${TAG}`]: '9.40', [`rate_zzbox_light_${TAG}`]: '6.15' };

const FAKE_STRIPE = `const stripe = {
  paymentIntents: {
    create: async (p) => {
      const id = 'pi_ZZBOX_' + require('crypto').randomUUID().slice(0, 12);
      require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ id, amount: p.amount, md: p.metadata || {} }) + '\\n');
      return { id };
    },
    retrieve: async () => ({}),
  },
};`;
const STUBS = `
const realFetch = global.fetch;
const RATES = ${JSON.stringify(RATES)};
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('https://api.resend.com')) {
    const b = JSON.parse(opts.body || '{}');
    require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject, html: b.html }) + '\\n');
    return json({ id: 'zztest' });
  }
  if (u === 'https://api.goshippo.com/shipments/') {
    const b = JSON.parse(opts.body || '{}');
    const id = Number(b.parcels[0].weight) >= 32 ? 'rate_zzbox_heavy_${TAG}' : 'rate_zzbox_light_${TAG}';
    return json({ rates: [{ object_id: id, amount: RATES[id], currency: 'USD', provider: 'USPS', servicelevel: { name: 'Ground Advantage' } }] });
  }
  if (u.startsWith('https://api.goshippo.com/rates/')) {
    const id = u.split('/')[4];
    return RATES[id] ? json({ object_id: id, amount: RATES[id], currency: 'USD', provider: 'USPS' }) : json({ detail: 'Not found' });
  }
  if (u === 'https://api.goshippo.com/transactions/') {
    const b = JSON.parse(opts.body || '{}');
    const n = 'ZZBOXTRK' + b.rate.replace(/[^A-Za-z0-9]/g, '').toUpperCase() + require('crypto').randomBytes(3).toString('hex').toUpperCase();
    return json({ status: 'SUCCESS', object_id: 'tx_' + n, label_url: 'https://example.invalid/' + n + '.pdf', tracking_number: n, tracking_url_provider: 'https://example.invalid/t/' + n });
  }
  return realFetch(url, opts);
};`;
// The live hammer's own two steps (createOrderOnWin, then joinShowBox), for a lot sold to a buyer.
const TEST_ROUTES = `app.post('/__test/win', async (req, res) => { const id = await createOrderOnWin(req.body.auction_id, req.body.username, req.body.amount, null); if (id) await joinShowBox(id); res.json({ id }); });
const PORT = process.env.PORT || 3001;`;
const PATCH = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;', FAKE_STRIPE], ['const PORT = process.env.PORT || 3001;', TEST_ROUTES]];
const ENV = { POINTS_ENABLED: 'true', RESEND_API_KEY: 're_zztest_stub', SHIPPO_API_KEY: 'shippo_zztest_stub', SHIPPO_WEBHOOK_SECRET: SECRET, ADMIN_EMAIL: 'admin@example.invalid' };
const mails = () => (fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const charges = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const made = { users: [], auctions: [], promos: [] };
const DAY = 864e5;
const HEAVY = { weight_oz: 40, length_in: 14, width_in: 10, height_in: 8 }, LIGHT = { weight_oz: 20, length_in: 10, width_in: 8, height_in: 4 };

async function mkUser(label) {
  const id = crypto.randomUUID(), username = `zztest_box_${label}_${TAG}`, email = `${username}@example.invalid`;
  die(await s.from('users').insert({ id, username, password_hash: 'zztest-not-a-real-hash', email }).select().single());
  made.users.push(id);
  die(await s.from('profiles').insert({ user_id: id, full_name: 'ZZ Box ' + label, email, phone: '5555550100', address_line1: '1 ZZ St', city: 'Testville', state: 'CA', zip: '94000',
    status: 'approved', payment_status: 'ok', stripe_customer_id: 'cus_ZZBOX_' + label, card_verified_at: new Date().toISOString(), stripe_payment_method_id: 'pm_ZZBOX' }).select().single());
  return { id, username, email, tok: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '30m' }) };
}
// An ended live show, and a buyer's paid wins in it as the hammer leaves them: one box group (joinShowBox), shipping.
async function mkShow(label) {
  const a = die(await s.from('auctions').insert({ title: `${P} ${label} ${TAG}`, description: 'x', status: 'ended', mode: 'live', fulfillment_mode: 'shipping', buyers_premium_pct: 0,
    host_username: 'whatthefind', starts_at: new Date(Date.now() - 3600e3).toISOString() }).select().single());
  made.auctions.push(a.id);
  return a.id;
}
async function mkWins(showId, buyer, n) {
  const group = crypto.randomUUID(), out = [];
  for (let i = 1; i <= n; i++) {
    out.push(die(await s.from('orders').insert({ auction_id: showId, buyer_username: buyer.username, buyer_user_id: buyer.id, item_title: `${P} lot ${i} ${TAG}`, final_bid: 10,
      hammer_cents: 1000, premium_cents: 0, total_cents: 1000, status: 'pending', payment_status: 'paid', payment_intent_id: 'pi_ZZBOX_lot', fulfillment_choice: 'shipping', group_id: group,
      ship_name: 'ZZ Box', ship_address1: '1 ZZ St', ship_city: 'Testville', ship_state: 'CA', ship_zip: '94000' }).select().single()));
  }
  return { group, orders: out };
}
const call = (url, method, path, tok, body) => fetch(url + path, {
  method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const rows = async ids => (die(await s.from('orders').select('*').in('id', ids)) || []).sort((a, b) => a.item_title.localeCompare(b.item_title, 'en', { numeric: true }));

(async () => {
  const servers = [];
  try {
    const probe = await s.from('promotions').select('id').limit(1);
    if (probe.error) { console.log('migration z (promotions) is not on this database:', probe.error.message); process.exitCode = 2; return; }
    for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
    const srv = await boot('boxes', 3571, require('./guard').readSource(BE + '/server.js'), { env: ENV, preload: STUBS, patch: PATCH, log: true });
    servers.push(srv);
    const U = srv.url;
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '30m' });
    const ship = async (ids, dims) => {
      const q = await call(U, 'POST', '/admin/orders/shipping-quote', admin, { order_ids: ids, ...dims });
      if (q.s !== 200) return { q, l: null };
      return { q, l: await call(U, 'POST', '/admin/orders/label', admin, { order_ids: ids, rate_id: q.j.rate_id, amount_cents: q.j.amount_cents }) };
    };

    console.log('== One buyer, 4 lots, two boxes (no promo): two quotes, two charges, two labels ==');
    const M = await mkUser('m');
    const SHOW = await mkShow('show1');
    const { group, orders } = await mkWins(SHOW, M, 4);
    const ids = orders.map(o => o.id);
    let pk = await call(U, 'GET', `/admin/live/${SHOW}/packing`, admin);
    ok(pk.s === 200 && pk.j.boxes.length === 1 && pk.j.boxes[0].lots.length === 4 && pk.j.boxes[0].still_to_ship === 4, `packing list by buyer: 1 entry, 4 lots, 4 still to ship (${pk.j && pk.j.boxes[0]?.still_to_ship})`);

    const b1 = await ship(ids.slice(0, 2), HEAVY);
    ok(b1.q.s === 200 && b1.q.j.amount_cents === 940 && b1.q.j.buyer_pays_cents === 940, `box 1 (lots 1+2, 40 oz): quoted ${b1.q.j && b1.q.j.amount_cents} cents, the buyer pays it`);
    ok(b1.l && b1.l.s === 200 && charges().length === 1 && charges()[0].amount === 940, `box 1: charged ${charges().map(c => c.amount).join()} cents, label bought`);
    let r = await rows(ids);
    ok(r[0].status === 'label_created' && r[1].status === 'label_created' && r[2].status === 'pending' && r[3].status === 'pending', 'after box 1: lots 1+2 labelled, lots 3+4 still pending');
    ok(r.every(o => o.group_id === group), 'the order group stays together (all 4 lots keep the show\'s group)');
    pk = await call(U, 'GET', `/admin/live/${SHOW}/packing`, admin);
    const pb = pk.j && pk.j.boxes[0];
    ok(pk.s === 200 && pk.j.boxes.length === 1 && pb.still_to_ship === 2 && pb.lots.filter(l => l.label_made).length === 2, `packing list: still one entry for the buyer, "${pb && pb.still_to_ship} lots still to ship"`);

    const b2 = await ship(ids.slice(2), LIGHT);
    ok(b2.q.s === 200 && b2.q.j.amount_cents === 615, `box 2 (lots 3+4, 20 oz): its own quote, ${b2.q.j && b2.q.j.amount_cents} cents`);
    ok(b2.l && b2.l.s === 200 && charges().length === 2 && charges()[1].amount === 615, `box 2: a second charge, ${charges().map(c => c.amount).join(' + ')} cents`);
    r = await rows(ids);
    const t1 = r[0].tracking_number, t2 = r[2].tracking_number;
    ok(t1 && t2 && t1 !== t2 && r[1].tracking_number === t1 && r[3].tracking_number === t2, 'two labels, two tracking numbers: lots 1+2 on the first, 3+4 on the second');
    ok(r[0].shipping_cost_cents === 940 && r[1].shipping_cost_cents === 940 && r[2].shipping_cost_cents === 615 && r[3].shipping_cost_cents === 615
      && r[0].label_url !== r[2].label_url && r[0].shipping_payment_intent_id !== r[2].shipping_payment_intent_id,
      'box 2 did not overwrite box 1: each keeps its own postage, label and payment');
    ok(r.every(o => o.group_id === group && o.status === 'label_created'), 'every lot labelled, still one group');
    pk = await call(U, 'GET', `/admin/live/${SHOW}/packing`, admin);
    ok(pk.j.boxes[0].still_to_ship === 0, 'packing list: nothing left to ship');
    const again = await call(U, 'POST', '/admin/orders/label', admin, { order_ids: ids.slice(0, 2), rate_id: b1.q.j.rate_id, amount_cents: 940 });
    ok(again.s === 402 && charges().length === 2, 'a second label for box 1: refused, nothing charged');

    const mine = await call(U, 'GET', '/my-orders', M.tok);
    const by = new Map((mine.j || []).map(o => [o.id, o]));
    ok(mine.s === 200 && by.get(ids[0]).tracking_number === t1 && by.get(ids[0]).shipping_cost_cents === 940 && by.get(ids[3]).tracking_number === t2 && by.get(ids[3]).shipping_cost_cents === 615,
      'order page: each lot shows its own box\'s postage and tracking');

    console.log('\n== Shipped emails: one per box, each with its own postage and tracking ==');
    const hook = (trk, status = 'TRANSIT') => fetch(`${U}/webhook/shippo?key=${SECRET}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'track_updated', data: { tracking_number: trk, tracking_status: { status } } }) }).then(x => x.status);
    const shippedTo = () => mails().filter(m => [].concat(m.to).includes(M.email) && /has shipped/.test(m.subject));
    ok(await hook(t1) === 200, 'box 1 in transit');
    for (let i = 0; i < 20 && shippedTo().length < 1; i++) await sleep(250);
    ok(await hook(t2) === 200, 'box 2 in transit');
    for (let i = 0; i < 20 && shippedTo().length < 2; i++) await sleep(250);
    const sm = shippedTo();
    ok(sm.length === 2, `two shipped emails, one per box (${sm.length})`);
    const e1 = sm.find(m => m.html.includes(t1)), e2 = sm.find(m => m.html.includes(t2));
    ok(e1 && /Your box of 2 lots has shipped/.test(e1.subject) && /\$9\.40/.test(e1.html) && !/\$6\.15/.test(e1.html) && e1.html.includes(`lot 1 ${TAG}`) && e1.html.includes(`lot 2 ${TAG}`) && !e1.html.includes(t2),
      'email 1: lots 1+2, postage $9.40, tracking 1 only');
    ok(e2 && /\$6\.15/.test(e2.html) && !/\$9\.40/.test(e2.html) && e2.html.includes(`lot 3 ${TAG}`) && e2.html.includes(`lot 4 ${TAG}`) && !e2.html.includes(t1),
      'email 2: lots 3+4, postage $6.15, tracking 2 only');
    await hook(t1); await sleep(1000);
    ok(shippedTo().length === 2, 'Shippo redelivers box 1\'s event: no third email');

    console.log('\n== Bundle bonus (3+ lots in the show): both boxes free ==');
    const N = await mkUser('n');
    const SHOW2 = await mkShow('show2');
    const w2 = await mkWins(SHOW2, N, 4);
    const now = Date.now();
    made.promos.push(die(await s.from('promotions').insert({ auction_id: SHOW2, kind: 'bundle_free_shipping', starts_at: new Date(now - DAY).toISOString(), ends_at: new Date(now + DAY).toISOString() }).select().single()).id);
    const before = charges().length;
    const f1 = await ship(w2.orders.slice(0, 2).map(o => o.id), HEAVY);
    ok(f1.q.s === 200 && f1.q.j.amount_cents === 940 && f1.q.j.buyer_pays_cents === 0 && f1.q.j.shipping_promo === 'bundle_free_shipping', 'box 1 (2 of the buyer\'s 4 lots): quoted $9.40, the buyer pays $0 (bundle bonus)');
    ok(f1.l && f1.l.s === 200 && f1.l.j.buyer_paid_cents === 0 && charges().length === before, 'box 1: label bought, buyer not charged');
    const f2 = await ship(w2.orders.slice(2).map(o => o.id), LIGHT);
    ok(f2.q.s === 200 && f2.q.j.buyer_pays_cents === 0 && f2.l && f2.l.s === 200 && f2.l.j.shipping_promo === 'bundle_free_shipping' && charges().length === before,
      'box 2 (the other 2 lots): also free - the bonus counts the buyer\'s lots in the show, not the lots in the box');
    r = await rows(w2.orders.map(o => o.id));
    ok(r.every(o => o.shipping_promo === 'bundle_free_shipping' && o.shipping_cost_cents === 0 && o.shipping_payment_status === 'paid' && o.tracking_number && o.group_id === w2.group)
      && r[0].tracking_number !== r[2].tracking_number, 'both boxes: free postage recorded, tracked separately, one group');

    console.log('\n== One box, one buyer ==');
    const O = await mkUser('o');
    const w3 = await mkWins(SHOW2, O, 1);
    // N first: N qualifies for the bundle bonus, and before this check the promo was judged on the first lot's buyer
    // alone, so O's lot would have gone free in N's box (a free box never reaches chargeShipping's buyer check).
    const mixed = [(await mkWins(SHOW2, N, 1)).orders[0].id, w3.orders[0].id];
    const mq = await call(U, 'POST', '/admin/orders/shipping-quote', admin, { order_ids: mixed, ...LIGHT });
    const ml = await call(U, 'POST', '/admin/orders/label', admin, { order_ids: mixed, rate_id: `rate_zzbox_light_${TAG}`, amount_cents: 615 });
    const mr = await rows(mixed);
    ok(mq.s === 400 && ml.s === 400 && charges().length === before && mr.every(o => o.status === 'pending' && !o.tracking_number),
      `two buyers' lots in one box (one of them on a free-postage promo): quote ${mq.s}, label ${ml.s}, nothing bought or charged`);

    console.log('\n== A live show offering pickup (set per show): the choice flows through the live path ==');
    const PU = die(await s.from('auctions').insert({ title: `${P} pickup ${TAG}`, description: 'x', status: 'upcoming', mode: 'live', fulfillment_mode: 'both', buyers_premium_pct: 0,
      host_username: 'whatthefind', starts_at: new Date(now + 3600e3).toISOString(), pickup_address: '9 ZZ Secret St', pickup_town: 'Testville, CA',
      pickup_starts_at: new Date(now + 2 * 3600e3).toISOString(), pickup_ends_at: new Date(now + 8 * DAY).toISOString() }).select().single()).id;
    made.auctions.push(PU);
    const pub = await call(U, 'GET', `/auction/${PU}`);
    ok(pub.s === 200 && pub.j.fulfillment_mode === 'both' && pub.j.pickup_town === 'Testville, CA' && !JSON.stringify(pub.j).includes('Secret St'),
      'the show page: ship or pickup, the pickup town, never the street');
    const Q = await mkUser('q'), R2 = await mkUser('r');
    ok((await call(U, 'POST', `/auction/${PU}/terms-acceptance`, Q.tok, {})).s === 400, 'before the first bid the buyer must choose (no choice: 400)');
    ok((await call(U, 'POST', `/auction/${PU}/terms-acceptance`, Q.tok, { fulfillment_choice: 'pickup' })).s === 200
      && (await call(U, 'POST', `/auction/${PU}/terms-acceptance`, R2.tok, { fulfillment_choice: 'shipping' })).s === 200, 'Q chooses pickup, R shipping');
    const q1 = (await call(U, 'POST', '/__test/win', null, { auction_id: PU, username: Q.username, amount: 12 })).j.id;
    const q2 = (await call(U, 'POST', '/__test/win', null, { auction_id: PU, username: Q.username, amount: 8 })).j.id;
    const r1 = (await call(U, 'POST', '/__test/win', null, { auction_id: PU, username: R2.username, amount: 5 })).j.id;
    const [oq1, oq2, or1] = await Promise.all([q1, q2, r1].map(async id => die(await s.from('orders').select('fulfillment_choice, group_id').eq('id', id).single())));
    ok(oq1.fulfillment_choice === 'pickup' && oq2.fulfillment_choice === 'pickup' && !oq1.group_id && !oq2.group_id && or1.fulfillment_choice === 'shipping' && or1.group_id,
      'the hammer order keeps each buyer\'s choice: Q\'s 2 pickup lots not boxed, R\'s shipping lot in a box group');
    pk = await call(U, 'GET', `/admin/live/${PU}/packing`, admin);
    const pq = pk.j && pk.j.boxes.find(b => b.buyer === Q.username), pr2 = pk.j && pk.j.boxes.find(b => b.buyer === R2.username);
    ok(pk.s === 200 && pq && pq.fulfillment === 'pickup' && pq.lots.length === 2 && pq.still_to_ship === 0 && pr2 && pr2.fulfillment === 'shipping' && pr2.still_to_ship === 1,
      'packing list: Q listed apart as pickup (2 lots, to collect), R to ship');
    ok((await call(U, 'POST', '/admin/orders/shipping-quote', admin, { order_ids: [q1], ...LIGHT })).s === 400, 'no label for a pickup lot');

    ok(srv.alive(), 'server still up');
    if (fails) console.log(srv.log().split('\n').filter(l => /error|fail/i.test(l)).slice(0, 15).join('\n'));
  } catch (e) { console.log('ERR', e); fails++; } finally {
    servers.forEach(x => x.stop());
    if (made.promos.length) await s.from('promotions').delete().in('id', made.promos);
    if (made.auctions.length) await s.from('orders').delete().in('auction_id', made.auctions);
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (made.users.length) {
      await s.from('auction_terms_acceptances').delete().in('user_id', made.users);
      await s.from('profiles').delete().in('user_id', made.users);
      await s.from('users').delete().in('id', made.users);
    }
    await s.from('email_send_log').delete().gte('sent_at', new Date(Date.now() - 30 * 60e3).toISOString()).in('kind', ['shipped', 'admin']);
    for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
    const left = (await s.from('auctions').select('id').like('title', P + '%')).data.length
      + (await s.from('users').select('id').like('username', 'zztest_box_%')).data.length
      + (await s.from('orders').select('id').like('item_title', P + '%')).data.length
      + (made.promos.length ? (await s.from('promotions').select('id').in('id', made.promos)).data.length : 0);
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  if (process.exitCode === 2) return;
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; });
