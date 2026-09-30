// Bidders are never identified publicly (wtf-handoff PRIVACY_BIDDERS_PICKUP_BRIEF.md, B7). Extends secret-max.js
// from "no max" to "no bidder identity at all". THROWAWAY rows only (ZZTEST_bidid*), always cleaned up.
//
// Two bidders, L (leads) and C (outbid), bid on a standard lot; L also pre-bids on a live-mode lot and wins a
// live-mode auction over sockets. Then, as ANONYMOUS and as O (a different buyer who never bid), every public REST
// read and every socket event is searched for L's and C's usernames and user ids, their maxes, and every bidder
// key (leading_bidder, username, buyer_username, leader_username, top_pre_bid, max_amount, winner).
// OLD = PINNED to 905066d (the lot page, before B7): leaks reproduced. NEW = working tree: none.
// Also: each bidder sees only their own standing, max and bids; the admin sees everything.
const crypto = require('crypto');
const path = require('path');
const guard = require('./guard');
guard(__filename);
const boot = require('./local-server');
const BE = boot.BE;
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io: ioc } = require(path.join(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const rules = require(BE + '/lot_rules');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PINNED = '905066d';
const mk = name => ({ id: crypto.randomUUID(), username: 'zztest_bidid_' + name });
const L = mk('lead'), C = mk('chal'), O = mk('other');
const ADMIN = { id: crypto.randomUUID(), username: 'whatthefind' };
const tok = u => jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '15m' });
const L_MAX = 437.13, L_MAX2 = 500.29, C_MAX = 5;
const NEEDLES = [L.username, C.username, L.id, C.id, String(L_MAX), String(L_MAX2)];
const KEYS = ['"leading_bidder"', '"username"', '"buyer_username"', '"leader_username"', '"top_pre_bid"', '"max_amount"', '"winner"', '"reserve_price"'];
const future = m => new Date(Date.now() + m * 60e3).toISOString();
const auctionIds = [];

function leaks(body) {
  const text = JSON.stringify(body) || '';
  return [...KEYS.filter(k => text.includes(k)), ...NEEDLES.filter(v => text.includes(v))];
}

async function fixtures(label) {
  const auction = async f => {
    const r = await s.from('auctions').insert({ description: 'x', status: 'live', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600), current_bid: 0, ...f }).select().single();
    if (r.error) throw new Error('auction: ' + JSON.stringify(r.error));
    auctionIds.push(r.data.id); return r.data;
  };
  const S = await auction({ title: `ZZTEST_bidid_${label} standard`, mode: 'standard' });
  const V = await auction({ title: `ZZTEST_bidid_${label} live`, mode: 'live' });
  const lot = async (a, status, title) => {
    const r = await s.from('auction_items').insert({ auction_id: a, title, starting_bid: 0, current_bid: 0, position: 0, status, ends_at: status === 'open' ? future(120) : null }).select().single();
    if (r.error) throw new Error('lot: ' + JSON.stringify(r.error));
    return r.data.id;
  };
  const SL = await lot(S.id, 'open', 'ZZTEST zzbidid lot');
  const VL = await lot(V.id, 'pending', 'ZZTEST zzbidid live lot');
  for (const u of [L, C, O]) {
    const p = await s.from('profiles').upsert({ user_id: u.id, full_name: 'ZZTEST bidid', email: 'zztest_bidid@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_bidid', stripe_payment_method_id: 'pm_ZZFIXTURE_bidid' }, { onConflict: 'user_id' });
    if (p.error) throw new Error('profile: ' + JSON.stringify(p.error));
    for (const a of [S.id, V.id]) {
      const t = await s.from('auction_terms_acceptances').insert({ auction_id: a, user_id: u.id, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' });
      if (t.error) throw new Error('acceptance: ' + JSON.stringify(t.error));
    }
  }
  return { S, V, SL, VL };
}

const caller = url => (method, p, token, body) => fetch(url + p, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

// Sockets for anonymous, O, L and the admin join V; the admin activates VL (L's pre-bid opens it), L bids, the
// admin ends the auction. Returns every event each socket received.
function socketRun(url, V) {
  return new Promise(resolve => {
    const who = { anon: null, O: tok(O), L: tok(L), admin: tok(ADMIN) };
    const got = Object.fromEntries(Object.keys(who).map(k => [k, []]));
    const socks = Object.fromEntries(Object.keys(who).map(k => [k, ioc(url, { transports: ['websocket'], forceNew: true })]));
    let joined = 0, step = 0;
    const done = () => { Object.values(socks).forEach(x => x.close()); resolve(got); };
    const timer = setTimeout(done, 20000);
    for (const [k, sock] of Object.entries(socks)) {
      sock.onAny((event, payload) => {
        got[k].push({ event, payload });
        if (event === 'auction_state' && ++joined === 4) socks.admin.emit('next_item', { auctionId: V, token: who.admin, timerSeconds: 60 });
        if (k === 'admin' && event === 'item_activated' && step === 0) { step = 1; setTimeout(() => socks.L.emit('place_bid', { auctionId: V, amount: 450, token: who.L }), 300); }
        if (k === 'admin' && event === 'new_bid' && step === 1) { step = 2; setTimeout(() => socks.admin.emit('end_auction', { auctionId: V, token: who.admin }), 300); }
        if (k === 'anon' && event === 'auction_ended') { clearTimeout(timer); setTimeout(done, 800); }
      });
      sock.on('connect', () => sock.emit('join_auction', { auctionId: V, token: who[k] || undefined }));
    }
  });
}

async function scenario(url, label) {
  const call = caller(url);
  const F = await fixtures(label);
  const { S, V, SL, VL } = F;
  const bidOut = {};
  let r = await call('POST', `/auction/${S.id}/items/${SL}/bid`, tok(L), { max_amount: L_MAX });
  if (r.s !== 200) throw new Error('L bid ' + r.s + JSON.stringify(r.j));
  r = await call('POST', `/auction/${S.id}/items/${SL}/bid`, tok(C), { max_amount: C_MAX });
  if (r.s !== 200) throw new Error('C bid ' + r.s + JSON.stringify(r.j));
  bidOut.C = r.j;                                         // the losing challenger's own answer
  r = await call('POST', `/auction/${S.id}/items/${SL}/bid`, tok(L), { max_amount: L_MAX2 });
  bidOut.L = r.j;                                         // the leader raising their own max
  r = await call('POST', `/auction/${V.id}/items/${VL}/prebid`, tok(L), { max_amount: 391.27 });
  if (r.s !== 200) throw new Error('L prebid ' + r.s + JSON.stringify(r.j));

  const slug = rules.auctionSlug(S);
  const PUBLIC = ['/auctions', `/auction/${S.id}`, `/auction/${S.id}/items`, `/auction/${S.id}/items/standard-status`, `/auction/${S.id}/bids`,
    '/home', '/search?q=zzbidid', `/lots/${SL}`, `/lots/by-number/${slug}/1`, `/lots/${SL}/related`, `/auction/${V.id}`, `/auction/${V.id}/items`,
    `/auction/${V.id}/bids`, `/auction/${S.id}/items/${SL}/images`];
  const OWN = [`/lots/${SL}/me`, `/lots/${SL}/bids`, '/my-bids', '/me/watching', `/auction/${S.id}/my-standing`, `/auction/${S.id}/terms-acceptance`, '/my-orders'];
  const seen = [];
  for (const p of PUBLIC) {
    for (const [who, t] of [['anonymous', null], ['O', tok(O)]]) { const x = await call('GET', p, t); seen.push([`${who}: GET ${p} (${x.s})`, x.j]); }
  }
  for (const p of OWN) { const x = await call('GET', p, tok(O)); seen.push([`O: GET ${p} (${x.s})`, x.j]); }

  const events = await socketRun(url, V.id);
  for (const who of ['anon', 'O']) for (const e of events[who]) seen.push([`${who} socket: ${e.event}`, e.payload]);

  const own = {
    Lme: (await call('GET', `/lots/${SL}/me`, tok(L))).j, Cme: (await call('GET', `/lots/${SL}/me`, tok(C))).j,
    Lbids: (await call('GET', `/lots/${SL}/bids`, tok(L))).j, Cbids: (await call('GET', `/lots/${SL}/bids`, tok(C))).j,
    Lstand: (await call('GET', `/auction/${S.id}/my-standing`, tok(L))).j, Cstand: (await call('GET', `/auction/${S.id}/my-standing`, tok(C))).j,
    LmyBids: (await call('GET', '/my-bids', tok(L))).j, CmyBids: (await call('GET', '/my-bids', tok(C))).j,
  };
  const admin = {
    auction: (await call('GET', `/auction/${S.id}`, tok(ADMIN))).j, items: (await call('GET', `/auction/${S.id}/items`, tok(ADMIN))).j,
    bids: (await call('GET', `/auction/${S.id}/bids`, tok(ADMIN))).j, lotBids: (await call('GET', `/lots/${SL}/bids`, tok(ADMIN))).j,
    auctions: (await call('GET', '/auctions', tok(ADMIN))).j,
  };
  await s.from('orders').delete().in('auction_id', [S.id, V.id]);
  return { seen, bidOut, own, admin, events, F };
}

async function cleanup() {
  for (const id of auctionIds.splice(0)) {
    await s.from('orders').delete().eq('auction_id', id);
    const r = await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (r.error) console.log('cleanup error', id, r.error.message);
  }
}

(async () => {
  const servers = [];
  try {
    const oldS = await boot('bidid-old', 3371, guard.sourceAt(PINNED, BE)); servers.push(oldS);
    const newS = await boot('bidid-new', 3372, guard.readSource(BE + '/server.js')); servers.push(newS);

    console.log(`== REPRODUCE on the pinned commit (${PINNED}): bidders named to anonymous callers and other buyers ==`);
    const old = await scenario(oldS.url, 'old');
    const oldLeaks = old.seen.map(([w, b]) => [w, leaks(b)]).filter(([, l]) => l.length);
    for (const [w, l] of oldLeaks) console.log(`  leak: ${w} -> ${[...new Set(l)].join(', ')}`);
    const has = w => oldLeaks.some(([x]) => x.startsWith(w));
    ok(has(`anonymous: GET /auction/${old.F.S.id} `) && has(`anonymous: GET /auction/${old.F.S.id}/bids`) && has(`anonymous: GET /auction/${old.F.S.id}/items/standard-status`)
      && has('anon socket: new_bid') && has('anon socket: auction_ended') && leaks(old.bidOut.C).includes(L.username),
      `OLD names bidders in ${oldLeaks.length} responses (auction, bid list, lot rows, socket new_bid and auction_ended, the losing bid's answer)  <- BUG REPRODUCED`);
    await cleanup();

    console.log('\n== SAME scenario on the NEW code ==');
    const now = await scenario(newS.url, 'new');
    const S = now.F.S.id, SL = now.F.SL;
    const label = w => w.replaceAll(S, 'S').replaceAll(SL, 'SL').replaceAll(now.F.V.id, 'V').replaceAll(now.F.VL, 'VL');
    const clean = now.seen.filter(([, b]) => leaks(b).length === 0).length;
    for (const [w, b] of now.seen) { const l = leaks(b); if (l.length) ok(false, `NEW ${label(w)}: LEAKS ${[...new Set(l)].join(', ')}`); }
    ok(clean === now.seen.length, `NEW: all ${now.seen.length} payloads to anonymous and to another buyer (${new Set(now.seen.map(([w]) => w.split(':')[1])).size} REST reads/socket events) name no bidder and carry no max`);
    const anonEvents = new Set(now.events.anon.map(e => e.event));
    ok(['auction_state', 'item_activated', 'new_bid', 'auction_ended'].every(e => anonEvents.has(e)) && !anonEvents.has('bid_history'),
      `the socket checks saw state, activation, a bid and the end; no bid list for the public (${[...anonEvents].join(', ')})`);
    const home = now.seen.find(([w]) => w === 'anonymous: GET /home (200)')[1];
    ok(Object.values(home.rails).flat().some(l => l.id === SL && l.bid_count === 2), "the public still sees the price and the bid count (/home carries the bid-on lot: 2 bids; L's raise was max-only)");
    ok(!leaks(now.bidOut.C).length && now.bidOut.C.your_status === 'outbid' && now.bidOut.L.your_status === 'winning',
      "each bidder's own bid answer says only where THEY stand (C outbid, L winning), never the other's name or max");

    console.log('\n== The bidders themselves: only their own ==');
    const o = now.own;
    ok(o.Lme.status === 'winning' && o.Lme.my_max === L_MAX2 && o.Cme.status === 'outbid' && o.Cme.my_max === C_MAX, 'status and own max on the lot (L winning at their max, C outbid)');
    ok(o.Lbids.bids.length === 1 && o.Lbids.bids[0].amount === L_MAX && o.Cbids.bids.length === 1 && o.Cbids.bids[0].amount === C_MAX
      && !JSON.stringify(o.Lbids).includes(C.username) && !JSON.stringify(o.Cbids).includes(String(L_MAX)) && !JSON.stringify(o.Cbids).includes(L.username),
      "own bids only: L's one bid (a max-only raise adds none), C's one bid; nobody else's name or max");
    ok(o.Lstand.lots[SL] === 'winning' && o.Cstand.lots[SL] === 'outbid', 'my-standing: L winning, C outbid (the room\'s status line)');
    ok(!leaks(o.CmyBids.map(({ max_bid, ...x }) => x)).length && o.CmyBids[0].leading === false && o.LmyBids[0].leading === true, "/my-bids: whether YOU lead, never the leader's name");
    const lSock = now.events.L, oSock = now.events.O;
    ok(lSock.some(e => e.event === 'new_bid' && e.payload.you_lead === true) && lSock.some(e => e.event === 'auction_ended' && e.payload.you_won === true)
      && oSock.some(e => e.event === 'auction_ended' && e.payload.you_won === false), "sockets: L's own copy says you_lead / you_won; O's says not");

    console.log('\n== The admin: the full picture ==');
    const a = now.admin;
    ok(a.auction.leading_bidder === undefined || a.auction.leading_bidder === null || typeof a.auction.leading_bidder === 'string', 'admin gets the full auction row');
    ok(a.items[0].leading_bidder === L.username && Number(a.items[0].top_pre_bid) === L_MAX2, 'admin lot rows: leader and max');
    ok(Array.isArray(a.bids) && a.bids.some(b => b.username === C.username), 'admin /auction/:id/bids: the rows, with names');
    ok(a.lotBids.scope === 'all' && a.lotBids.bids.length === 2 && a.lotBids.bids.every(b => b.bidder && b.leader === L.username), "admin lot history: every bid, who placed it, who led");
    ok(now.events.admin.some(e => e.event === 'bid_history'), 'admin socket: gets the bid list');
  } catch (e) {
    console.log('ERR', e); fails++;
  } finally {
    servers.forEach(x => x.stop());
    await cleanup();
    const ids = [L, C, O].map(u => u.id), names = [L, C, O].map(u => u.username);
    await s.from('auction_terms_acceptances').delete().in('user_id', ids);
    await s.from('profiles').delete().in('user_id', ids);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_bidid%')).data.length
      + (await s.from('bids').select('id').in('username', names)).data.length
      + (await s.from('pre_bids').select('id').in('buyer_username', names)).data.length
      + (await s.from('profiles').select('id').in('user_id', ids)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
