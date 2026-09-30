// Secret max bids must not leave the server. THROWAWAY rows only (ZZTEST_secretmax*), always cleaned up.
// Extended 2026-09-30 (F2): the lot page's /lots/:id, /bids, /related and the challenger's /me.
// OLD = PINNED to 18b79c5 (before the fix): auction_items.top_pre_bid - on a standard lot the leader's hidden proxy
// ceiling - went out on the public items list, standard-status, the bid response a losing challenger gets back, and
// the item_activated socket broadcast. NEW = working tree.
//
// Two buyers: L (the leader) sets distinctive maxes, C (a challenger) bids under them. Every response an anonymous
// caller or C can get is searched for L's max values and for a top_pre_bid key. Controls: the admin still sees
// top_pre_bid; L still sees their own max (GET .../prebid, /my-bids).
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io: ioc } = require(require('path').join(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}

const PINNED = '18b79c5';
const L = { id: crypto.randomUUID(), username: 'zztest_secretmax_l' };
const C = { id: crypto.randomUUID(), username: 'zztest_secretmax_c' };
const tokL = jwt.sign(L, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokC = jwt.sign(C, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokAdmin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
// Distinctive so a plain substring search can't match anything else in a response.
const STD_MAX = 437.13;   // L's max on the standard lot
const PRE_MAX = 391.27;   // L's pre-bid max on the live-mode lot
const SECRETS = [String(STD_MAX), String(PRE_MAX)];
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const auctionIds = [];

const call = (port, method, path, token, body) => fetch('http://localhost:' + port + path, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

// What in this payload gives away L's max: the key, or either value anywhere.
function leaks(body) {
  const text = JSON.stringify(body) || '';
  const found = [];
  if (text.includes('"top_pre_bid"')) found.push('top_pre_bid');
  for (const v of SECRETS) if (text.includes(v)) found.push(v);
  return found;
}

async function fixtures(label) {
  const mk = async (mode, title) => {
    const r = await s.from('auctions').insert({ title: 'ZZTEST_secretmax_' + label + '_' + title, description: 'x', status: 'live', mode, fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind', ends_at: future(48) }).select().single();
    if (r.error) throw new Error('auction: ' + JSON.stringify(r.error));
    auctionIds.push(r.data.id); return r.data.id;
  };
  const S = await mk('standard', 'std');
  const V = await mk('live', 'live');
  const lot = async (auctionId, status) => {
    const r = await s.from('auction_items').insert({ auction_id: auctionId, title: 'ZZTEST secretmax lot', starting_bid: 0, current_bid: 0, position: 0, status, ends_at: status === 'open' ? future(24) : null }).select().single();
    if (r.error) throw new Error('lot: ' + JSON.stringify(r.error));
    return r.data.id;
  };
  const SL = await lot(S, 'open');
  const VL = await lot(V, 'pending');
  // Bidders must be approved with a saved card (review #3): placeholder ids, nothing reaches Stripe.
  for (const u of [L, C]) {
    const p = await s.from('profiles').upsert({ user_id: u.id, full_name: 'ZZTEST secretmax', email: 'zztest_secretmax@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_secretmax', stripe_payment_method_id: 'pm_ZZFIXTURE_secretmax' }, { onConflict: 'user_id' });
    if (p.error) throw new Error('profile: ' + JSON.stringify(p.error));
  }
  for (const u of [L, C]) for (const a of [S, V]) {
    const t = await s.from('auction_terms_acceptances').insert({ auction_id: a, user_id: u.id, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' });
    if (t.error) throw new Error('acceptance: ' + JSON.stringify(t.error));
  }
  return { S, V, SL, VL };
}

// Joins V's room anonymously, has the admin activate VL, and returns every payload the anonymous socket received.
function socketRun(port, V) {
  return new Promise(resolve => {
    const got = [];
    const anon = ioc('http://localhost:' + port, { transports: ['websocket'], forceNew: true });
    const admin = ioc('http://localhost:' + port, { transports: ['websocket'], forceNew: true });
    const done = () => { anon.close(); admin.close(); resolve(got); };
    const timer = setTimeout(done, 15000);
    anon.onAny((event, payload) => {
      got.push({ event, payload });
      if (event === 'auction_state') admin.emit('next_item', { auctionId: V, token: tokAdmin, timerSeconds: 60 });
      if (event === 'item_activated') { clearTimeout(timer); setTimeout(done, 300); }
    });
    anon.on('connect', () => anon.emit('join_auction', { auctionId: V }));
  });
}

async function scenario(port, label) {
  const { S, V, SL, VL } = await fixtures(label);
  const seen = [];   // [where, payload]
  let r = await call(port, 'POST', `/auction/${S}/items/${SL}/bid`, tokL, { max_amount: STD_MAX });
  if (r.s !== 200) throw new Error('leader bid: ' + r.s + ' ' + JSON.stringify(r.j));
  r = await call(port, 'POST', `/auction/${S}/items/${SL}/bid`, tokC, { max_amount: 5 });
  if (r.s !== 200) throw new Error('challenger bid: ' + r.s + ' ' + JSON.stringify(r.j));
  seen.push(['C: bid response (lost to the leader)', r.j]);
  r = await call(port, 'POST', `/auction/${V}/items/${VL}/prebid`, tokL, { max_amount: PRE_MAX });
  if (r.s !== 200) throw new Error('leader prebid: ' + r.s + ' ' + JSON.stringify(r.j));
  r = await call(port, 'POST', `/auction/${V}/items/${VL}/prebid`, tokC, { max_amount: 7 });
  if (r.s !== 200) throw new Error('challenger prebid: ' + r.s + ' ' + JSON.stringify(r.j));
  seen.push(['C: pre-bid response', r.j]);

  const reads = [`/auction/${S}/items`, `/auction/${S}/items/standard-status`, `/auction/${S}`, `/auction/${S}/bids`,
    `/auction/${V}/items`, `/auction/${V}`, `/auction/${V}/items/standard-status`, `/auction/${V}/items/${VL}/images`, `/auctions`,
    // Homepage (2026-09-30): the rails and search send lots to everyone. Not on the pinned commit (404 there).
    '/home', '/search?q=secretmax',
    // Lot page (F2, 2026-09-30): the lot, its anonymised history and related lots. 404 on the pinned commit.
    `/lots/${SL}`, `/lots/${SL}/bids`, `/lots/${SL}/related`];
  for (const [who, tok] of [['anonymous', null], ['C', tokC]]) {
    for (const p of reads) { const x = await call(port, 'GET', p, tok); seen.push([`${who}: GET ${p.replace(SL, 'SL').replace(S, 'S').replace(V, 'V').replace(VL, 'VL')} (${x.s})`, x.j]); }
  }
  for (const [a, lot] of [[S, SL], [V, VL]]) { const x = await call(port, 'GET', `/auction/${a}/items/${lot}/prebid`, tokC); seen.push([`C: GET own pre-bid (${x.s})`, x.j]); }
  { const x = await call(port, 'GET', `/lots/${SL}/me`, tokC); seen.push([`C: GET /lots/SL/me (${x.s})`, x.j]); }
  { const x = await call(port, 'GET', '/my-bids', tokC); seen.push([`C: GET /my-bids (${x.s})`, x.j]); }

  // Socket: live-mode activation broadcasts the lot row to the whole room.
  const events = await socketRun(port, V);
  const activated = events.find(e => e.event === 'item_activated');
  if (!activated) throw new Error('no item_activated received');
  // Live mode (gated off in v2) opens the lot AT the top pre-bid max, so current_bid equals it by design of that
  // flow. That is the live-mode price, reported below, not searched for here; the row's top_pre_bid key is.
  const { current_bid: openingPrice, leading_bidder: _lb, ...activatedRest } = activated.payload.item || {};
  for (const e of events) {
    seen.push([`anonymous socket: ${e.event}`, e === activated ? { ...activated.payload, item: activatedRest } : e.payload]);
  }

  const controls = {
    adminItems: (await call(port, 'GET', `/auction/${S}/items`, tokAdmin)).j,
    leaderPrebid: (await call(port, 'GET', `/auction/${V}/items/${VL}/prebid`, tokL)).j,
    leaderMyBids: (await call(port, 'GET', '/my-bids', tokL)).j,
    // So the /home and /search 'no max' checks aren't vacuous: S's lot must actually be in them.
    home: (await call(port, 'GET', '/home')).j,
    search: (await call(port, 'GET', '/search?q=secretmax')).j,
    // The lot page's history must name nobody: L and C appear only as letters (or "You" to themselves).
    lotBids: { anonymous: (await call(port, 'GET', `/lots/${SL}/bids`)).j, C: (await call(port, 'GET', `/lots/${SL}/bids`, tokC)).j },
    lotPage: (await call(port, 'GET', `/lots/${SL}`)).j,
    leaderMe: (await call(port, 'GET', `/lots/${SL}/me`, tokL)).j,
  };
  return { seen, openingPrice, controls };
}

async function cleanup() {
  for (const id of auctionIds.splice(0)) {
    const r = await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (r.error) console.log('cleanup error', id, r.error.message);
  }
}

(async () => {
  const oldSrc = require('./guard').sourceAt(PINNED, BE);
  const newSrc = require('./guard').readSource(BE + '/server.js');
  const servers = [];
  try {
    const oldS = await boot('old', 3351, oldSrc); servers.push(oldS);
    const newS = await boot('new', 3352, newSrc); servers.push(newS);

    console.log(`\n== REPRODUCE on the pinned commit (${PINNED}): L's max reaches anonymous callers and the challenger ==`);
    const old = await scenario(3351, 'old');
    const oldLeaks = old.seen.map(([w, b]) => [w, leaks(b)]).filter(([, l]) => l.length);
    for (const [w, l] of oldLeaks) console.log(`  leak: ${w} -> ${l.join(', ')}`);
    const has = w => oldLeaks.some(([x]) => x.startsWith(w));
    ok(has('anonymous: GET /auction/S/items') && has('anonymous: GET /auction/S/items/standard-status') && has('C: bid response') && has('anonymous socket: item_activated'),
      `OLD leaks L's max on the public items list, standard-status, the challenger's bid response and the item_activated broadcast (${oldLeaks.length} leaking responses)  <- BUG REPRODUCED`);
    await cleanup();

    console.log('\n== SAME scenario on the FIXED code ==');
    const now = await scenario(3352, 'new');
    for (const [w, b] of now.seen) {
      const l = leaks(b);
      ok(l.length === 0, `NEW ${w}: ${l.length ? 'LEAKS ' + l.join(', ') : 'no max'}`);
    }
    const adminLot = (now.controls.adminItems || [])[0] || {};
    ok(Number(adminLot.top_pre_bid) === STD_MAX, `NEW admin/host still sees top_pre_bid on the items list (${adminLot.top_pre_bid})`);
    ok(now.controls.leaderPrebid && Number(now.controls.leaderPrebid.max_amount) === PRE_MAX, `NEW L still sees their OWN pre-bid max (${now.controls.leaderPrebid && now.controls.leaderPrebid.max_amount})`);
    const homeLots = Object.values((now.controls.home || {}).rails || {}).flat();
    ok(homeLots.some(l => l.bid_count > 0 && /secretmax/.test(l.title)) && ((now.controls.search || {}).lots || []).some(l => /secretmax/.test(l.title)),
      `NEW /home rails and /search do carry S's bid-on lot (so their no-max checks above mean something)`);
    const mine = (now.controls.leaderMyBids || []).find(i => Number(i.max_bid) === STD_MAX);
    ok(!!mine, `NEW L's /my-bids still shows their OWN max on the standard lot (${mine && mine.max_bid})`);
    const lb = now.controls.lotBids;
    ok(lb.anonymous && lb.anonymous.bids.length === 2 && lb.C && lb.C.bids.length === 2, 'NEW /lots/SL/bids carries both bids (so its no-max checks above mean something)');
    for (const [who, body] of [['anonymous', lb.anonymous], ['C', lb.C], ['anonymous lot page', now.controls.lotPage]]) {
      const text = JSON.stringify(body);
      ok(!text.includes(L.username) && !text.includes(C.username) && !text.includes('"username"'), `NEW ${who}: no username on the lot page or in its history`);
    }
    ok(now.controls.leaderMe && now.controls.leaderMe.my_max === STD_MAX && now.controls.leaderMe.status === 'winning', `NEW L's own /lots/SL/me shows their OWN max (${now.controls.leaderMe && now.controls.leaderMe.my_max})`);
    console.log(`\nNOTE live mode (gated off in v2) opens a lot at the top pre-bid max: item_activated current_bid = ${now.openingPrice} (L's pre-bid max ${PRE_MAX}). Not fixed here; see README.`);
  } finally {
    servers.forEach(x => x.cleanup());
    await cleanup();
    await s.from('auction_terms_acceptances').delete().in('user_id', [L.id, C.id]);
    await s.from('profiles').delete().in('user_id', [L.id, C.id]);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_secretmax%')).data.length
      + (await s.from('pre_bids').select('id').in('buyer_username', [L.username, C.username])).data.length
      + (await s.from('bids').select('id').in('username', [L.username, C.username])).data.length
      + (await s.from('auction_terms_acceptances').select('user_id').in('user_id', [L.id, C.id])).data.length
      + (await s.from('profiles').select('id').in('user_id', [L.id, C.id])).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
