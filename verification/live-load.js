// Live shows phase 8: load (wtf-handoff LIVE_SHOWS_BRIEF.md §8; LIVE_SHOWS_PHASE0_AUDIT.md §8). One local server on
// wtf-test (LIVE_ENABLED, real timers, Stripe faked in-process): 50 viewers (45 guests, 5 logged-in buyers who don't
// bid) + 5 bidders + the host in one show. Measured on this machine's clock (both ends are here):
//   bid -> bid_ok          the bidder's own answer
//   bid -> new_bid         at every one of the 56 clients (each client's arrival is one sample)
//   Sold tap -> lot_closed at every client (the host's sold_now)
//   clock -> lot_closed    from the lot's ends_at (the DATABASE clock, converted with the measured offset) to each
//                          client's lot_closed: the close timer, the close, then the room (the order comes after)
// Scenario A: one bid at a time, 30 bids on lot 1 (each a new leader), then Sold. Scenario B: all 5 bidders tap Bid
// at the same moment, 10 rounds on lot 2 (one wins each round, the others are told why), then the 15 s clock runs out.
// Also: no client misses a new_bid or the hammer; and the server's own time (patched in for this run only: the bid's
// gates + engine, and emitPerViewer's fetchSockets + emit loop).
// Numbers are this machine to Supabase (a slower link than Railway's) with the clients on the same machine as the
// server: read them as the database side's upper bound, without the viewers' own network.
// THROWAWAY rows only (live-kit, ZZTEST_live_load*), cleaned up.
require('./guard')(__filename);
const K = require('./live-kit')('load');
const { ok, ADMIN, mkUser, mkShow, terms, client, ask, boot, BE, sleep, syncClock, dbNow } = K;
process.chdir(BE);
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];
// Server-side timing for this run only.
const TRACE = [
  [`async function emitPerViewer(room, event, payloadFor) {
  for (const s of await io.in(room).fetchSockets()) s.emit(event, payloadFor(s.data?.username || null));
}`, `async function emitPerViewer(room, event, payloadFor) {
  const t0 = process.hrtime.bigint();
  const socks = await io.in(room).fetchSockets();
  const t1 = process.hrtime.bigint();
  for (const s of socks) s.emit(event, payloadFor(s.data?.username || null));
  const t2 = process.hrtime.bigint();
  console.log(\`TRACE epv \${event} \${socks.length} \${Number(t1 - t0) / 1e6} \${Number(t2 - t1) / 1e6}\`);
}`],
  [`  on('place_bid', async ({ auctionId, itemId, max_amount, amount, token }) => {
    const fail = (message, code) => socket.emit('bid_error', code ? { message, code } : { message });`,
   `  on('place_bid', async ({ auctionId, itemId, max_amount, amount, token }) => {
    const zzT0 = Date.now();
    const fail = (message, code) => { console.log(\`TRACE bidfail \${Date.now() - zzT0}\`); socket.emit('bid_error', code ? { message, code } : { message }); };`],
  [`    if (data.ends_at) watchLiveLot(data);   // a late bid may have added time
    socket.emit('bid_ok', bidResult(data, user.username));`,
   `    if (data.ends_at) watchLiveLot(data);   // a late bid may have added time
    console.log(\`TRACE bid \${Date.now() - zzT0}\`);
    socket.emit('bid_ok', bidResult(data, user.username));`],
];
const pct = (xs, p) => { if (!xs.length) return NaN; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)]; };
const fmt = xs => (!xs.length ? 'none' : `p50 ${pct(xs, 50).toFixed(0)} ms, p95 ${pct(xs, 95).toFixed(0)} ms, max ${Math.max(...xs).toFixed(0)} ms (${xs.length} samples)`);
const HA = ['host_ok', 'host_error'];
// The first `event` matching pred at or after index `from` on client c, waiting up to ms.
const arrival = (c, event, pred, from = 0) => c.events.slice(from).find(e => e.event === event && pred(e.payload));

(async () => {
  const servers = [];
  const R = {};
  try {
    const src = require('./guard').readSource(BE + '/server.js');
    for (const [a] of TRACE) if (!src.includes(a)) throw new Error('trace anchor missing: ' + a.slice(0, 60));
    const srv = await boot('live-load', 3720, TRACE.reduce((t, [a, b]) => t.replace(a, b), src), { env: { LIVE_ENABLED: 'true' }, timers: 'real', patch: OK_STRIPE, log: true });
    servers.push(srv);
    const u = srv.url;
    await syncClock();
    const bidders = [], watchers = [];
    for (let i = 0; i < 5; i++) bidders.push(await mkUser('bid' + i));
    for (let i = 0; i < 5; i++) watchers.push(await mkUser('watch' + i));
    const show = await mkShow('show', { lots: 2 });
    for (const b of bidders) await terms(b, show.id);

    console.log('== Joining: 45 guests, 5 logged-in viewers, 5 bidders, the host ==');
    const host = await client(u, show.id, ADMIN);
    const t0 = Date.now();
    const joins = [];
    for (let i = 0; i < 45; i++) joins.push(client(u, show.id));
    for (const w of watchers) joins.push(client(u, show.id, w));
    const viewers = await Promise.all(joins);
    const bc = await Promise.all(bidders.map(b => client(u, show.id, b)));
    const all = [host, ...viewers, ...bc];
    R.join = Date.now() - t0;
    ok(all.length === 56, `56 clients in the room (50 viewers joined at once in ${R.join} ms)`);

    // ---------------------------------------------------------------- A: one bid at a time
    console.log('\n== A: one bid at a time, 30 bids on lot 1 ==');
    await ask(host, 'show_lot', {}, HA);
    await ask(host, 'start_clock', { seconds: 60 }, HA);
    let st = await bc[0].waitFor('show_state', p => p.open, 5000);
    let next = st.payload.open.next_bid;
    const okLat = [], nbLat = [], lastLat = [];
    let lost = 0;
    for (let k = 0; k < 30; k++) {
      const i = k % 5, c = bc[i];
      const marks = all.map(x => x.mark());
      const amount = next;
      const sent = Date.now();
      c.emit('place_bid', { max_amount: amount });
      const r = await c.waitFor('bid_ok', () => true, 8000, marks[all.indexOf(c)]);
      if (!r) { ok(false, `bid ${k + 1} ($${amount}): no bid_ok`); break; }
      okLat.push(r.at - sent);
      const end = Date.now() + 8000;
      let got = [];
      while (Date.now() < end) {
        got = all.map((x, j) => arrival(x, 'new_bid', p => p.amount === amount, marks[j]));
        if (got.every(Boolean)) break;
        await sleep(10);
      }
      lost += got.filter(g => !g).length;
      const arrivals = got.filter(Boolean).map(g => g.at - sent);
      nbLat.push(...arrivals);
      lastLat.push(Math.max(...arrivals));
      next = got.find(Boolean).payload.next_bid;
    }
    R.okA = okLat; R.nbA = nbLat; R.lastA = lastLat;
    ok(lost === 0, `no client missed a new_bid (${30 * 56} deliveries, ${lost} missing)`);
    console.log(`  bid -> bid_ok:            ${fmt(okLat)}`);
    console.log(`  bid -> new_bid (each):    ${fmt(nbLat)}`);
    console.log(`  bid -> new_bid (the 56th): ${fmt(lastLat)}`);
    let marks = all.map(x => x.mark());
    let sent = Date.now();
    await ask(host, 'sold_now', {}, HA);
    let closed = [];
    for (let w = 0; w < 400 && closed.filter(Boolean).length < all.length; w++) { closed = all.map((x, j) => arrival(x, 'lot_closed', p => p.status === 'sold', marks[j])); await sleep(10); }
    const soldLat = closed.filter(Boolean).map(g => g.at - sent);
    R.sold = soldLat;
    ok(closed.every(Boolean), `every client heard the hammer (${closed.filter(Boolean).length}/56)`);
    console.log(`  Sold tap -> lot_closed:   ${fmt(soldLat)}`);

    // ---------------------------------------------------------------- B: all five at once
    console.log('\n== B: all 5 bidders tap Bid at once, 10 rounds on lot 2, then the clock runs out ==');
    await sleep(500);
    await ask(host, 'show_lot', {}, HA);
    await ask(host, 'start_clock', { seconds: 15 }, HA);
    st = await bc[0].waitFor('show_state', p => p.open && p.open.lot_number === 2, 5000, bc[0].events.length - 20);
    next = st ? st.payload.open.next_bid : 1;
    const burstAnswer = [], burstNew = [];
    let refusedOk = true, winners = 0, lostB = 0, lastEndsAt = null;
    for (let round = 0; round < 10; round++) {
      marks = all.map(x => x.mark());
      const amount = next;
      sent = Date.now();
      for (const c of bc) c.emit('place_bid', { max_amount: amount });
      const answers = await Promise.all(bc.map((c, i) => c.waitFor('bid_ok', () => true, 8000, marks[all.indexOf(c)]).then(okE => okE || arrival(c, 'bid_error', () => true, marks[all.indexOf(c)]))));
      for (const a of answers) if (a) burstAnswer.push(a.at - sent);
      // At most one tap is told "winning" (the round's leader's own max-only raise aside): migration zf. Before it,
      // a tie went to the buyer whose row was oldest, and several taps in one round were told "winning" in turn.
      const told = answers.filter(a => a && a.event === 'bid_ok' && a.payload.your_status === 'winning' && !a.payload.max_only);
      winners += told.length <= 1 ? 1 : 0;
      refusedOk = refusedOk && answers.every(Boolean);
      const end = Date.now() + 8000;
      let got = [];
      while (Date.now() < end) {
        got = all.map((x, j) => arrival(x, 'new_bid', p => p.amount >= amount, marks[j]));
        if (got.every(Boolean)) break;
        await sleep(10);
      }
      lostB += got.filter(g => !g).length;
      burstNew.push(...got.filter(Boolean).map(g => g.at - sent));
      const last = got.filter(Boolean).sort((x, y) => y.payload.bid_count - x.payload.bid_count)[0];
      if (last) { next = last.payload.next_bid; lastEndsAt = last.payload.ends_at || lastEndsAt; }
      await sleep(150);
    }
    R.burstAnswer = burstAnswer; R.burstNew = burstNew;
    ok(refusedOk && winners === 10, `every tap answered (bid_ok or bid_error), at most one told "winning" per round (${winners}/10 rounds)`);
    ok(lostB === 0, `no client missed a new_bid in the bursts (${lostB} missing)`);
    console.log(`  tap -> answer (5 at once): ${fmt(burstAnswer)}`);
    console.log(`  tap -> new_bid (each):     ${fmt(burstNew)}`);
    marks = all.map(x => x.mark());
    closed = [];
    for (let w = 0; w < 4000 && closed.filter(Boolean).length < all.length; w++) { closed = all.map((x, j) => arrival(x, 'lot_closed', p => p.lot_number === 2, marks[j])); await sleep(10); }
    const lot2 = (await K.s.from('auction_items').select('ends_at, status').eq('id', show.lots[1]).single()).data;
    await syncClock();
    const endsAt = Date.parse(lot2.ends_at);
    const clockLat = closed.filter(Boolean).map(g => g.at + (dbNow() - Date.now()) - endsAt);
    R.clock = clockLat;
    ok(closed.every(Boolean) && lot2.status === 'sold', `the clock ran out: every client heard the hammer (${closed.filter(Boolean).length}/56, lot ${lot2.status})`);
    console.log(`  clock -> lot_closed:       ${fmt(clockLat)}`);

    console.log('\n== The server\'s own time (this run only) ==');
    const log = srv.log().split('\n');
    const bidMs = log.map(l => /TRACE bid (\d+)/.exec(l)).filter(Boolean).map(m => +m[1]);
    const failMs = log.map(l => /TRACE bidfail (\d+)/.exec(l)).filter(Boolean).map(m => +m[1]);
    const epv = log.map(l => /TRACE epv new_bid (\d+) ([\d.]+) ([\d.]+)/.exec(l)).filter(Boolean);
    console.log(`  a bid's gates + engine (accepted): ${fmt(bidMs)}`);
    console.log(`  a refused bid (lost the race):     ${fmt(failMs)}`);
    console.log(`  emitPerViewer new_bid: ${epv.length} calls to ${Math.max(...epv.map(m => +m[1]))} sockets; fetchSockets ${fmt(epv.map(m => +m[2]))}; the emit loop ${fmt(epv.map(m => +m[3]))}`);

    console.log('\n== Targets ==');
    // Targets (2026-10-19, after the phase 8 fixes measured 175 / 185 / 301 / 215 ms p95 from this machine), with room
    // for a busy run. Before the fixes: 518 / 469 / 985 / 2457 ms.
    ok(pct(R.nbA, 95) <= 600 && pct(R.burstNew, 95) <= 600, `bid -> new_bid at every client: p95 ${pct(R.nbA, 95).toFixed(0)} ms one at a time, ${pct(R.burstNew, 95).toFixed(0)} ms in bursts (target 600)`);
    ok(pct(R.sold, 95) <= 600, `Sold tap -> lot_closed at every client: p95 ${pct(R.sold, 95).toFixed(0)} ms (target 600)`);
    ok(pct(R.clock, 95) <= 1000, `clock -> lot_closed: p95 ${pct(R.clock, 95).toFixed(0)} ms after ends_at by the database clock (target 1000)`);
    ok(Math.max(...epv.map(m => +m[3])) < 50, `emitPerViewer's loop over 56 sockets stays small (max ${Math.max(...epv.map(m => +m[3])).toFixed(1)} ms)`);
    for (const c of all) c.close();
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
