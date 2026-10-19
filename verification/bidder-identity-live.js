// Bidder identity in LIVE shows (wtf-handoff LIVE_SHOWS_PHASE5_BRIEF.md §1 "Names"; audit finding 25): split from
// bidder-identity.js, which keeps proving timed auctions name nobody anywhere. In a live show the room shows
// usernames on bids, wins and chat, and NOTHING else about a bidder: no user id, no email, no max, no top_pre_bid.
// Scenario: L pre-bids a distinctive max on lot 1, C bids in the room, L wins (the hammer); both chat; lot 2 is
// passed. Every socket event a guest and another buyer (O) receive, and every public live read (the show, its lots,
// show-state, lineup, chat, /home), is searched for L's and C's ids, emails and L's max, and for the bidder keys
// (max_amount, top_pre_bid, user_id, buyer_user_id, email, leading_bidder). Usernames: only in username / leader /
// winner fields. The winner's own copy says you_won; nobody else's does.
// THROWAWAY rows only (live-kit, ZZTEST_live_bidlive*), cleaned up.
require('./guard')(__filename);
const K = require('./live-kit')('bidlive');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, prebid, client, ask, call, boot, BE, sleep } = K;
process.chdir(BE);
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];
const HA = ['host_ok', 'host_error'];
const L_MAX = 437.13;
const KEYS = ['"max_amount"', '"top_pre_bid"', '"user_id"', '"buyer_user_id"', '"email"', '"leading_bidder"', '"my_max"', '"reserve_price"'];
const NAME_FIELDS = ['username', 'leader', 'winner'];

(async () => {
  const servers = [];
  try {
    const srv = await boot('live-bidlive', 3702, require('./guard').readSource(BE + '/server.js'), { env: { LIVE_ENABLED: 'true' }, timers: 'real', patch: OK_STRIPE });
    servers.push(srv);
    const u = srv.url;
    const L = await mkUser('lead'), C = await mkUser('chal'), O = await mkUser('other');
    const show = await mkShow('names', { lots: 2 });
    for (const x of [L, C, O]) await terms(x, show.id);
    await prebid(L, show.id, show.lots[0], L_MAX);
    const emails = [L, C].map(x => `${x.username}@example.invalid`);
    const NEEDLES = [L.id, C.id, ...emails, String(L_MAX)];
    // Everything a payload says about bidders: the needles and keys anywhere; a username outside the name fields.
    function leaks(body) {
      const found = [];
      const text = JSON.stringify(body) || '';
      for (const k of KEYS) if (text.includes(k)) found.push(k);
      for (const n of NEEDLES) if (text.includes(n)) found.push(n === String(L_MAX) ? 'L max' : n.includes('@') ? 'email' : 'user id');
      (function walk(v, key) {
        if (Array.isArray(v)) return v.forEach(x => walk(x, key));
        if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k));
        if (typeof v === 'string' && [L.username, C.username].some(n => v.includes(n)) && !(NAME_FIELDS.includes(key) && (v === L.username || v === C.username)))
          found.push(`username in "${key}"`);
      })(body, null);
      return found;
    }

    const H = await client(u, show.id, ADMIN), anon = await client(u, show.id), co = await client(u, show.id, O);
    const cl = await client(u, show.id, L), cc = await client(u, show.id, C);
    await ask(H, 'go_live', {}, HA);
    await ask(H, 'show_lot', {}, HA);
    await ask(H, 'start_clock', { seconds: 5 }, HA);
    await anon.waitFor('item_activated', () => true, 5000);
    cl.emit('send_chat', { text: 'L says hi' });
    cc.emit('send_chat', { text: 'C asks: is it real?' });
    await sleep(300);
    const bid = await ask(cc, 'place_bid', { max_amount: 20 }, ['bid_ok', 'bid_error']);
    ok(bid && bid.event === 'bid_ok', `C bids in the room (${bid && bid.event})`);
    const closed = await anon.waitFor('lot_closed', p => p.status === 'sold', 15000);
    ok(closed && closed.payload.username === L.username, `lot 1 sells to L on the pre-bid (${closed && closed.payload.username})`);
    await sleep(500);
    await ask(H, 'show_lot', {}, HA);
    await ask(H, 'pass', {}, HA);
    await sleep(800);

    const seen = [];
    for (const [who, c] of [['guest', anon], ['O', co]]) for (const e of c.events) seen.push([`${who} socket: ${e.event}`, e.payload]);
    const PUBLIC = [`/auction/${show.id}`, `/auction/${show.id}/items`, `/auction/${show.id}/show-state`, `/auction/${show.id}/lineup`, `/auction/${show.id}/chat`,
      `/auction/${show.id}/bids`, '/home', `/lots/${show.lots[0]}`];
    for (const p of PUBLIC) for (const [who, t] of [['guest', null], ['O', O]]) { const r = await call(u, 'GET', p, t); seen.push([`${who}: GET ${p.replace(show.id, 'SHOW').replace(show.lots[0], 'LOT1')} (${r.s})`, r.j]); }

    console.log('== Nothing about a bidder but the username ==');
    const bad = seen.map(([w, b]) => [w, leaks(b)]).filter(([, l]) => l.length);
    for (const [w, l] of bad) ok(false, `${w.replace(show.id, 'SHOW')}: ${[...new Set(l)].join(', ')}`);
    const events = new Set(seen.filter(([w]) => w.includes('socket')).map(([w]) => w.split(': ')[1]));
    ok(bad.length === 0, `${seen.length} payloads to a guest and another buyer (${events.size} socket events: ${[...events].sort().join(', ')}; ${PUBLIC.length} public reads each): no id, email, max or top_pre_bid; usernames only in username / leader / winner`);
    ok(['new_bid', 'lot_closed', 'show_state', 'item_activated', 'new_chat', 'chat_history'].every(e => events.has(e)), 'the run covered bids, the hammer, show_state, activation and chat');

    console.log('\n== Where the username shows ==');
    const evs = co.events;
    const nb = evs.find(e => e.event === 'new_bid');
    ok(nb && nb.payload.username === L.username && !('user_id' in nb.payload), `new_bid: the leader's username (@${nb && nb.payload.username}; C's bid ran into L's pre-bid)`);
    ok(evs.some(e => e.event === 'lot_closed' && e.payload.username === L.username && e.payload.you_won === false), 'lot_closed: "Sold to @L"; O did not win');
    ok(cl.events.some(e => e.event === 'lot_closed' && e.payload.you_won === true) && !cc.events.some(e => e.event === 'lot_closed' && e.payload.you_won === true),
      "the winner banner: only L's own copy says you_won");
    ok(evs.some(e => e.event === 'show_state' && e.payload.last && e.payload.last.winner === L.username), 'show_state.last.winner: the username');
    ok(evs.some(e => e.event === 'new_chat' && e.payload.username === C.username && e.payload.text === 'C asks: is it real?'), 'chat: the username');
    const ia = anon.events.find(e => e.event === 'item_activated');
    ok(ia && ia.payload.leader === L.username && !JSON.stringify(ia.payload).includes(String(L_MAX)), 'item_activated: the pre-bid leader by username, never the max');

    console.log('\n== Each bidder sees only their own ==');
    const mine = cl.events.filter(e => e.event === 'show_state' || e.event === 'new_bid').map(e => e.payload);
    ok(mine.every(p => !JSON.stringify(p).includes(C.id) && !JSON.stringify(p).includes(emails[1])), "L's own copies say nothing of C beyond the username");
    const ownBid = cc.events.find(e => e.event === 'bid_ok');
    ok(ownBid && !JSON.stringify(ownBid.payload).includes(String(L_MAX)) && !JSON.stringify(ownBid.payload).includes(L.id), "C's bid answer: where C stands, never L's max or id");
    for (const c of [H, anon, co, cl, cc]) c.close();
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
