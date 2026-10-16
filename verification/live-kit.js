// Shared fixtures for the live-show suites (G1, wtf-handoff LIVE_SHOWS_BRIEF.md). Not a suite itself.
// THROWAWAY rows only: auctions titled ZZTEST_live_<suite>..., users zztest_live_<suite>_..., cleaned up by cleanup().
// Stripe and Resend stubs are in the suites that need them (in the server process: nothing is charged or sent).
const crypto = require('crypto');
const path = require('path');
const boot = require('./local-server');
const { BE, sleep } = boot;
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io: ioc } = require(path.resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));

module.exports = function kit(name) {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const TAG = crypto.randomBytes(3).toString('hex');
  const P = `ZZTEST_live_${name}`;
  const made = { users: [], auctions: [] };
  const state = { fails: 0 };
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) state.fails++; };
  const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
  const ADMIN = { id: crypto.randomUUID(), username: 'whatthefind' };
  const tok = u => jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: '30m' });
  ADMIN.tok = tok(ADMIN);

  // A buyer. Defaults: approved, a saved AND verified card. customer: the fake Stripe customer id (suites decide).
  async function mkUser(label, { status = 'approved', card = true, verified = true, profile = true, customer } = {}) {
    const id = crypto.randomUUID(), username = `zztest_live_${name}_${label}_${TAG}`.slice(0, 40).toLowerCase();
    die(await s.from('users').insert({ id, username, password_hash: 'zztest-not-a-real-hash', email: `${username}@example.invalid` }).select().single());
    made.users.push(id);
    if (profile) {
      die(await s.from('profiles').insert({ user_id: id, full_name: 'ZZ Live ' + label, email: `${username}@example.invalid`, phone: '5555550100',
        address_line1: '1 ZZ St', city: 'Testville', state: 'CA', zip: '94000', status, payment_status: 'ok',
        ...(card ? { stripe_customer_id: customer || `cus_ZZLIVE_${label}`, stripe_payment_method_id: 'pm_ZZLIVE' } : {}),
        ...(card && verified ? { card_verified_at: new Date().toISOString() } : {}) }).select().single());
    }
    const u = { id, username };
    u.tok = tok(u);
    return u;
  }

  // A live show (mode 'live') with `lots` lots waiting to be offered. status 'live' = on air.
  async function mkShow(label, { status = 'live', lots = 1, starting_bid = 0, fields = {} } = {}) {
    const a = die(await s.from('auctions').insert({ title: `${P} ${label} ${TAG}`, description: 'x', status, mode: 'live', fulfillment_mode: 'shipping',
      host_username: 'whatthefind', starting_bid: 0, current_bid: 0, starts_at: new Date(Date.now() - 60e3).toISOString(), ...fields }).select().single());
    made.auctions.push(a.id);
    const ids = [];
    for (let i = 0; i < lots; i++) {
      ids.push(die(await s.from('auction_items').insert({ auction_id: a.id, title: `${P} lot ${i + 1} ${TAG}`, starting_bid, position: i, status: 'pending' }).select().single()).id);
    }
    return { id: a.id, lots: ids };
  }
  async function mkStandard(label, { status = 'live', fields = {} } = {}) {
    const a = die(await s.from('auctions').insert({ title: `${P} ${label} ${TAG}`, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping',
      host_username: 'whatthefind', buyers_premium_pct: 15, ends_at: new Date(Date.now() + 3600e3).toISOString(), ...fields }).select().single());
    made.auctions.push(a.id);
    return a.id;
  }
  const terms = async (u, auctionId, pct = 0) => die(await s.from('auction_terms_acceptances').insert({ auction_id: auctionId, user_id: u.id, buyers_premium_pct: pct,
    fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' }).select());
  // A pre-bid as POST .../prebid stores it (the route itself is exercised by the suites separately).
  async function prebid(u, auctionId, lotId, max) {
    die(await s.from('pre_bids').insert({ item_id: lotId, auction_id: auctionId, buyer_username: u.username, buyer_user_id: u.id, max_amount: max }).select());
    await sleep(15);   // distinct created_at: ties go to the earlier max
  }
  const lot = async id => die(await s.from('auction_items').select('*').eq('id', id).single());
  // The database clock (lots are timed by it; this machine's clock can be seconds off). dbAt(ms) = an ISO time ms
  // from the database's now; dbNow() = the database's now in ms.
  const clock = { offset: 0 };
  async function syncClock() {
    const t0 = Date.now(); const r = await s.rpc('live_db_now'); const t1 = Date.now();
    if (!r.error) clock.offset = Date.parse(r.data) - Math.round((t0 + t1) / 2);
    return clock.offset;
  }
  const dbNow = () => Date.now() + clock.offset;
  const dbAt = ms => new Date(dbNow() + ms).toISOString();

  // A socket that joined the show. Every event is recorded with the time it arrived.
  function client(url, auctionId, user = null) {
    return new Promise((resolve, reject) => {
      const c = ioc(url, { transports: ['websocket'], forceNew: true });
      const events = [];
      const api = {
        events, sock: c,
        emit: (event, payload) => c.emit(event, { auctionId, ...(user ? { token: user.tok } : {}), ...payload }),
        mark: () => events.length,
        // The first `event` after index `from` that matches pred, or null after ms.
        waitFor: async (event, pred = () => true, ms = 8000, from = 0) => {
          const end = Date.now() + ms;
          while (Date.now() < end) {
            const hit = events.slice(from).find(e => e.event === event && pred(e.payload));
            if (hit) return hit;
            await sleep(25);
          }
          return null;
        },
        close: () => c.close(),
      };
      c.onAny((event, payload) => events.push({ event, payload, at: Date.now() }));
      const t = setTimeout(() => reject(new Error('socket join timed out')), 10000);
      c.on('connect', () => c.emit('join_auction', { auctionId, ...(user ? { token: user.tok } : {}) }));
      c.on('auction_state', () => { clearTimeout(t); resolve(api); });
      c.on('auction_error', e => { clearTimeout(t); reject(new Error('join refused: ' + JSON.stringify(e))); });
    });
  }
  // One request/answer over a socket: emit, collect what comes back for a moment.
  async function ask(c, event, payload, answers, ms = 4000) {
    const from = c.mark();
    c.emit(event, payload);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = c.events.slice(from).find(e => answers.includes(e.event));
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }

  const call = (url, method, p, user, body) => fetch(url + p, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: 'Bearer ' + user.tok } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

  async function cleanup() {
    const ids = made.auctions;
    if (ids.length) {
      const orders = (await s.from('orders').select('id').in('auction_id', ids)).data || [];
      if (orders.length) await s.from('points_ledger').delete().in('order_id', orders.map(o => o.id));
      await s.from('orders').delete().in('auction_id', ids);
      await s.from('invoices').delete().in('auction_id', ids);
      for (const id of ids) { const d = await s.rpc('delete_auction_cascade', { p_auction_id: id }); if (d.error) console.log('cleanup error', id, d.error.message); }
    }
    if (made.users.length) {
      await s.from('points_ledger').delete().in('user_id', made.users);
      await s.from('points_accounts').delete().in('user_id', made.users);
      await s.from('promotion_uses').delete().in('user_id', made.users);
      await s.from('auction_terms_acceptances').delete().in('user_id', made.users);
      await s.from('profiles').delete().in('user_id', made.users);
      await s.from('users').delete().in('id', made.users);
    }
    const left = (await s.from('auctions').select('id').like('title', P + '%')).data.length
      + (await s.from('users').select('id').like('username', `zztest_live_${name}_%`)).data.length
      + (ids.length ? (await s.from('orders').select('id').in('auction_id', ids)).data.length : 0)
      + (ids.length ? (await s.from('bids').select('id').in('auction_id', ids)).data.length : 0)
      + (ids.length ? (await s.from('pre_bids').select('id').in('auction_id', ids)).data.length : 0);
    console.log('\nleftover throwaway rows:', left);
    if (left) state.fails++;
  }
  const finish = () => { console.log(state.fails ? `\n${state.fails} FAILED` : '\nALL PASS'); process.exit(state.fails ? 1 : 0); };

  return { s, TAG, P, made, ok, die, ADMIN, tok, mkUser, mkShow, mkStandard, terms, prebid, lot, client, ask, call, cleanup, finish, state, sleep, boot, BE, syncClock, dbNow, dbAt };
};
