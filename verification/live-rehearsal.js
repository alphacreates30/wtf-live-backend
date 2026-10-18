// Live shows phase 2a (G1, wtf-handoff LIVE_SHOWS_PHASE2_BRIEF.md step 2a): the private rehearsal link. Needs migrations
// za, zb and zd. Local server on the test database with LIVE_ENABLED=true and throwaway LiveKit keys (tokens are signed
// locally and decoded here; LiveKit is never contacted). Stripe is an in-process fake; Resend is blanked.
//   hidden     a draft live show is invisible without the key: REST reads, the room, the video token, the lists
//              (/auctions, /home, /search) never show it, a wrong key or no login gets 404 like any draft.
//   key        only the admin makes or rotates it; never in a public response; rotating shuts the old link (old-key
//              sockets are sent out, old-key reads 404).
//   run        with the key a logged-in test account reads the show, accepts its terms, joins the room, chats and
//              bids; the host goes on air as a REHEARSAL (it stays a draft); a socket without the key can't bid;
//              End leaves it a draft with ended_at; a rehearsed draft can't be published.
const crypto = require('crypto');
require('./guard')(__filename);
const K = require('./live-kit')('rehears');
const { s, ok, die, ADMIN, mkUser, mkShow, client, ask, call, sleep, boot, BE } = K;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const ENV = { LIVE_ENABLED: 'true', LIVEKIT_API_KEY: 'zztest_key', LIVEKIT_API_SECRET: crypto.randomBytes(24).toString('hex'), LIVEKIT_URL: 'wss://zztest.invalid' };
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];
const HOST_ANSWERS = ['host_ok', 'host_error'];
const show = async id => die(await s.from('auctions').select('*').eq('id', id).single());
// A socket that tries to join; resolves with the first answer (auction_state or auction_error).
function tryJoin(url, auctionId, user, rehearsal) {
  const { io: ioc } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
  return new Promise(resolve => {
    const c = ioc(url, { transports: ['websocket'], forceNew: true });
    const t = setTimeout(() => { c.close(); resolve('timeout'); }, 8000);
    c.on('connect', () => c.emit('join_auction', { auctionId, ...(user ? { token: user.tok } : {}), ...(rehearsal ? { rehearsal } : {}) }));
    c.on('auction_state', () => { clearTimeout(t); c.close(); resolve('joined'); });
    c.on('auction_error', e => { clearTimeout(t); c.close(); resolve(e.code); });
  });
}

(async () => {
  const probe = await s.from('auctions').select('rehearsal_key').limit(1);
  if (probe.error) { console.log('auctions.rehearsal_key is missing: apply migration zd (2026-10-18zd-live-show-lifecycle.sql) first.'); process.exit(2); }
  const servers = [];
  try {
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('live-rehears', 3671, src, { env: ENV, timers: 'real', patch: OK_STRIPE });
    servers.push(srv);
    const T = await mkUser('tester'), O = await mkUser('outsider');
    const sh = await mkShow('draft', { status: 'draft', lots: 2 });
    const ID = sh.id, u = srv.url;
    const reads = key => ['', '/items', '/show-state', '/lineup', '/chat', '/bids'].map(p => `/auction/${ID}${p}${key ? `?rehearsal=${encodeURIComponent(key)}` : ''}`);

    console.log('== A draft is hidden; no key yet ==');
    for (const p of reads('anything')) ok((await call(u, 'GET', p, T)).s === 404, `GET ${p.replace(ID, 'ID')} as a buyer -> 404`);
    ok(await tryJoin(u, ID, T, 'anything') === 'not_found', 'the room: not_found');
    let r = await call(u, 'POST', `/admin/live/${ID}/rehearsal-key`, T);
    ok(r.s === 401 || r.s === 403, `a buyer can't make the key (${r.s})`);

    console.log('\n== The admin makes the link ==');
    r = await call(u, 'POST', `/admin/live/${ID}/rehearsal-key`, ADMIN);
    const KEY = r.j && r.j.rehearsal_key;
    ok(r.s === 200 && KEY && KEY.length >= 20 && r.j.path === `/auction/${ID}?rehearsal=${KEY}`, `key made (${KEY && KEY.length} chars) with its link`);
    ok((await show(ID)).rehearsal_key === KEY, 'stored on the show');
    for (const p of reads(KEY)) {
      const x = await call(u, 'GET', p, T);
      ok(x.s === 200 && !JSON.stringify(x.j).includes(KEY), `with the key, logged in: GET ${p.replace(ID, 'ID').replace(KEY, 'KEY')} -> ${x.s}, the key is not in it`);
    }
    for (const p of reads(KEY).slice(0, 3)) ok((await call(u, 'GET', p)).s === 404, `with the key but logged out: GET ${p.replace(ID, 'ID').replace(KEY, 'KEY')} -> 404 (invited accounts only)`);
    ok((await call(u, 'GET', reads(KEY + 'x')[0], T)).s === 404, 'a wrong key -> 404');
    const lists = [['/auctions', T], ['/auctions', null], ['/home', null], ['/search?q=' + encodeURIComponent(K.P), null]];
    for (const [p, who] of lists) ok(!JSON.stringify((await call(u, 'GET', p, who)).j).includes(ID), `never listed: GET ${p} ${who ? '(buyer)' : '(anonymous)'}`);
    ok(await tryJoin(u, ID, T) === 'not_found' && await tryJoin(u, ID, null, KEY) === 'not_found', 'the room: no key -> refused; the key but logged out -> refused');
    const tok = await call(u, 'GET', `/auction/${ID}/token?rehearsal=${KEY}`, T), tokNo = await call(u, 'GET', `/auction/${ID}/token`, T);
    ok(tok.s === 200 && jwt.decode(tok.j.token).video.canPublish === false && tokNo.s === 404, `video token: with the key ${tok.s} (watch only), without ${tokNo.s}`);

    console.log('\n== The rehearsal runs ==');
    r = await call(u, 'POST', `/auction/${ID}/terms-acceptance`, T, {});
    ok(r.s === 404, `terms without the key -> ${r.s}`);
    r = await call(u, 'POST', `/auction/${ID}/terms-acceptance?rehearsal=${KEY}`, T, {});
    ok(r.s === 200 && r.j.accepted, `terms with the key -> ${r.s}`);
    await K.terms(O, ID);   // the outsider has terms too: only the missing key stops them
    const host = await client(u, ID, ADMIN);
    const tc = await new Promise((resolve, reject) => {   // the tester joins with the key
      const { io: ioc } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
      const c = ioc(u, { transports: ['websocket'], forceNew: true });
      const events = [];
      c.onAny((event, payload) => events.push({ event, payload, at: Date.now() }));
      c.on('connect', () => c.emit('join_auction', { auctionId: ID, token: T.tok, rehearsal: KEY }));
      c.on('auction_state', () => resolve({ sock: c, events, emit: (ev, p) => c.emit(ev, { auctionId: ID, token: T.tok, ...p }), mark: () => events.length,
        waitFor: async (ev, pred = () => true, ms = 5000, from = 0) => { const end = Date.now() + ms; while (Date.now() < end) { const h = events.slice(from).find(e => e.event === ev && pred(e.payload)); if (h) return h; await sleep(25); } return null; } }));
      c.on('auction_error', e => reject(new Error(JSON.stringify(e))));
    });
    ok(!!tc, 'the tester joins the room with the key');
    let from = tc.mark();
    let e = await ask(host, 'go_live', {}, HOST_ANSWERS);
    let a = await show(ID);
    const started = await tc.waitFor('auction_started', () => true, 3000, from);
    ok(e && e.event === 'host_ok' && a.status === 'draft' && a.on_air_at && started && started.payload.rehearsal === true, `Go live on a draft: a rehearsal on air (status '${a.status}', on_air_at set)`);
    ok(!JSON.stringify((await call(u, 'GET', '/auctions', T)).j).includes(ID) && !JSON.stringify((await call(u, 'GET', '/home')).j).includes(ID), 'on air, still never listed');
    await ask(host, 'show_lot', {}, HOST_ANSWERS);
    e = await ask(host, 'start_clock', { seconds: 30 }, HOST_ANSWERS);
    ok(e && e.event === 'host_ok' && (await K.lot(sh.lots[0])).status === 'open', 'lot 1 open in the rehearsal');
    from = tc.mark();
    tc.emit('place_bid', { max_amount: 5 });
    const bid = await tc.waitFor('bid_ok', () => true, 4000, from);
    ok(bid && bid.payload.your_status === 'winning', 'the tester (with the key) bids');
    tc.emit('send_chat', { text: 'hello from the rehearsal' });
    ok(!!await tc.waitFor('new_chat', p => p.text === 'hello from the rehearsal', 3000, from), 'the tester chats');
    const { io: ioc } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
    const out = ioc(u, { transports: ['websocket'], forceNew: true });
    const outEv = [];
    out.onAny((event, payload) => outEv.push({ event, payload }));
    await new Promise(res => out.on('connect', res));
    out.emit('place_bid', { auctionId: ID, token: O.tok, max_amount: 50 });
    out.emit('send_chat', { auctionId: ID, token: O.tok, text: 'sneaking in' });
    await sleep(1500);
    out.close();
    const ob = outEv.find(x => x.event === 'bid_error'), och = outEv.find(x => x.event === 'chat_error');
    ok(ob && ob.payload.code === 'not_found' && och, `a socket without the key: bid refused (${ob && ob.payload.code}), chat refused`);
    ok((await K.lot(sh.lots[0])).leading_bidder === T.username, 'the outsider\'s $50 never landed');

    ok(!JSON.stringify(tc.events).includes(KEY) && !/rehearsal_key/.test(JSON.stringify(tc.events)),
      `the tester's socket (${tc.events.length} events: auction_state, show_state, chat, bids…) never carried the key`);

    console.log('\n== rehearsal_key never leaves the server except to the host/admin ==');
    // A PUBLISHED live show whose row carries a key (only possible by a direct write: the route refuses a published
    // show), so every public route that reads the auction row has one to leak: the lot page, /home, lists, terms...
    const PUBKEY = 'ZZKEY_' + crypto.randomBytes(12).toString('hex');
    const pub = await mkShow('published', { status: 'upcoming', lots: 1, fields: { rehearsal_key: PUBKEY, starts_at: new Date(Date.now() + 3600e3).toISOString() } });
    const pubLot = pub.lots[0];
    const slug = require(BE + '/lot_rules').auctionSlug(await show(pub.id));
    const leak = body => { const t = JSON.stringify(body) || ''; return t.includes(PUBKEY) || t.includes(KEY) || /"rehearsal_key"/.test(t); };
    ok((await call(u, 'POST', `/auction/${pub.id}/terms-acceptance`, O, {})).s === 200, 'the outsider accepts the published show\'s terms');
    const routes = [`/auction/${pub.id}`, `/auction/${pub.id}/items`, `/auction/${pub.id}/bids`, `/auction/${pub.id}/chat`, `/auction/${pub.id}/show-state`,
      `/auction/${pub.id}/lineup`, `/auction/${pub.id}/terms-acceptance`, '/home', '/auctions', `/search?q=${encodeURIComponent(K.P)}`, `/lots/${pubLot}`,
      `/lots/by-number/${slug}/1`, `/lots/${pubLot}/related`, '/my-bids', '/my-orders', '/me/watching', '/config'];
    let seen = 0, leaked = [];
    for (const p of routes) for (const [who, user] of [['anonymous', null], ['buyer', O], ['tester', T]]) {
      const x = await call(u, 'GET', p, user);
      if (x.s === 401) continue;   // a login-only route, for the anonymous visitor
      seen++;
      if (leak(x.j)) leaked.push(`${who} GET ${p.replace(pub.id, 'PUB').replace(pubLot, 'LOT')}`);
    }
    // The draft's own routes, with the key, as the tester (logged in) - the key itself is the only way in.
    for (const p of reads(KEY)) { seen++; const x = await call(u, 'GET', p, T); if (leak(x.j)) leaked.push('tester GET ' + p.replace(ID, 'DRAFT').replace(KEY, 'KEY')); }
    const tr = await call(u, 'POST', `/auction/${ID}/terms-acceptance?rehearsal=${KEY}`, T, {}); seen++; if (leak(tr.j)) leaked.push('tester POST terms (draft)');
    ok(leaked.length === 0, `${seen} responses to an anonymous visitor, a buyer and the tester (auction, lots, bids, chat, show-state, lineup, terms, home, lists, search, lot page, related, my bids/orders/watching, config): no rehearsal_key${leaked.length ? ' LEAKS: ' + leaked.join(', ') : ''}`);
    const evs = [];
    for (const user of [null, O]) {
      const c = await client(u, pub.id, user);
      await sleep(1500);
      evs.push(...c.events);
      c.close();
    }
    ok(evs.length >= 4 && !evs.some(e => leak(e.payload)), `the room's socket events to an anonymous visitor and a buyer (${evs.map(e => e.event).filter((v, i, a) => a.indexOf(v) === i).join(', ')}): no rehearsal_key`);
    const adminRow = await call(u, 'GET', `/auction/${pub.id}`, ADMIN);
    ok(adminRow.j && adminRow.j.rehearsal_key === PUBKEY, 'the admin (the host) does get it: the check above is not empty-handed');
    const pv = require(BE + '/public_view');
    ok(pv.AUCTION_HOST_ONLY.includes('rehearsal_key') && !pv.AUCTION_PUBLIC.includes('rehearsal_key') && !('rehearsal_key' in pv.auctionFor({ rehearsal_key: 'x', host_username: 'whatthefind' }, 'someone', 'whatthefind')),
      'public_view: rehearsal_key is host-only, not in the public allow-list, and auctionFor strips it for anyone but the host/admin');

    console.log('\n== Rotate the key ==');
    from = tc.mark();
    r = await call(u, 'POST', `/admin/live/${ID}/rehearsal-key`, ADMIN);
    const KEY2 = r.j && r.j.rehearsal_key;
    const kicked = await tc.waitFor('auction_error', p => p.code === 'rehearsal_closed', 3000, from);
    ok(r.s === 200 && KEY2 && KEY2 !== KEY && kicked, 'rotated: a new key, and the old-key tester is sent out of the room');
    from = tc.mark();
    tc.emit('place_bid', { max_amount: 9 });
    const after = await tc.waitFor('bid_error', () => true, 3000, from);
    ok(after && after.payload.code === 'not_found', `the old-key socket can't bid any more (${after && after.payload.code})`);
    ok((await call(u, 'GET', reads(KEY)[0], T)).s === 404 && (await call(u, 'GET', reads(KEY2)[0], T)).s === 200, 'old key -> 404, new key -> 200');
    tc.sock.close();

    console.log('\n== End, and no publishing a rehearsal ==');
    e = await ask(host, 'end_show', {}, HOST_ANSWERS);
    ok(e && e.payload.code === 'lot_open', 'End is refused while the lot is open (rehearsals too)');
    await ask(host, 'sold_now', {}, HOST_ANSWERS);
    e = await ask(host, 'end_show', {}, HOST_ANSWERS);
    a = await show(ID);
    ok(e && e.event === 'host_ok' && a.status === 'draft' && a.ended_at, `ended: still a draft ('${a.status}'), ended_at set`);
    r = await call(u, 'POST', `/auction/${ID}/publish`, ADMIN);
    ok(r.s === 400 && r.j.code === 'rehearsed', `publishing the rehearsed draft -> ${r.s} (${r.j && r.j.error})`);
    r = await call(u, 'POST', `/admin/live/${(await K.mkShow('published', { status: 'upcoming' })).id}/rehearsal-key`, ADMIN);
    ok(r.s === 400, `a published show has no rehearsal link (${r.s})`);
    host.close();
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
