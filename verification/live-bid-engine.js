// Live shows: one bidding engine (G1 phase 1, LIVE_SHOWS_BRIEF.md §1.1, §1.2). Needs migration za.
// Local servers on the test database with LIVE_ENABLED=true; Stripe and Resend blanked (nothing is charged or sent).
//   opening    a lot never opens at the top pre-bid max: 2+ pre-bids open at second + increment with the top
//              pre-bidder leading; one pre-bid opens at the opening minimum; none = no leader. Nobody's max, and no
//              top_pre_bid key, in what the room receives.
//   proxy      socket bids go through place_standard_bid: proxy battle, tier increments, cents, the leader raising
//              their max changes nothing public, each viewer told only whether THEY lead
//   race       two bidders at the same moment: both bids counted, nothing lost, the higher max leads
//   clock      a bid in the last 5 s adds 5 s (database clock); Sudden death adds nothing; the hammer at 0 sells to
//              the leader (one order, no premium, the lot's own id) and the room hears it
//   fences     REST /bid refuses a live lot; pre-bids and withdrawals only before the lot opens; the timed close job
//              leaves live lots alone (OLD = pinned 93db3d7 closes one); one lot open at a time; end_auction hammers
//              the open lot and creates no auction-level order; a restart mid-lot resumes from ends_at
require('./guard')(__filename);
const K = require('./live-kit')('engine');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, prebid, client, ask, call, sleep, boot, BE, dbNow, dbAt } = K;
process.chdir(BE);
const OLD_COMMIT = '93db3d7';
const ON = { LIVE_ENABLED: 'true' };
// Stripe: an in-process fake that always succeeds (nothing leaves the machine). Since phase 1b a declined live lot
// blocks its buyer from bidding again in that show, so a blanked Stripe would block every winner after one win.
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];

const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const probe = await s.from('auction_items').select('extend_by_seconds').limit(1);
  if (probe.error) { console.log('auction_items.extend_by_seconds is missing: apply migration za (2026-10-15za-live-bidding.sql) first.'); process.exit(2); }
  const servers = [];
  try {
    console.log(`(this machine's clock is ${(await K.syncClock()) / 1000} s from the database's; lots are timed by the database)\n`);
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('live-engine', 3611, src, { env: ON, timers: 'real', patch: OK_STRIPE });
    servers.push(srv);
    const A = await mkUser('a'), B = await mkUser('b'), C = await mkUser('c'), O = await mkUser('o');
    const show = await mkShow('main', { lots: 7 });
    for (const u of [A, B, C, O]) await terms(u, show.id);
    const [L1, L2, L3, L4, L5, L6, L7] = show.lots;
    await prebid(A, show.id, L1, 40); await prebid(B, show.id, L1, 25); await prebid(C, show.id, L1, 10);
    await prebid(A, show.id, L2, 391.27);

    const host = await client(srv.url, show.id, ADMIN);
    const ca = await client(srv.url, show.id, A), cb = await client(srv.url, show.id, B), cc = await client(srv.url, show.id, C);
    const anon = await client(srv.url, show.id);

    console.log('== Opening price (never the top max) ==');
    let from = anon.mark();
    let e = await ask(host, 'next_item', { timerSeconds: 20 }, ['item_activated', 'host_error']);
    ok(e && e.event === 'host_error' && /60, 30, 15 or 5/.test(e.payload.message), `a 20 s clock is refused: ${e && e.payload.message}`);
    e = await ask(host, 'next_item', { timerSeconds: 30 }, ['item_activated', 'host_error']);
    let act = await anon.waitFor('item_activated', () => true, 4000, from);
    let row = await K.lot(L1);
    ok(e && e.event === 'item_activated' && act && act.payload.item.current_bid == 26 && row.leading_bidder === A.username,
      `3 pre-bids (40 / 25 / 10): opens at $${act && act.payload.item.current_bid} = 25 + $1, top pre-bidder leads (${row.leading_bidder === A.username ? 'A' : row.leading_bidder})`);
    const text = JSON.stringify(anon.events.slice(from));
    ok(!/"top_pre_bid"|"max_amount"|"leading_bidder"/.test(text), `no bidder or max keys in anything the anonymous viewer received (${anon.events.length - from} events)`);
    ok(row.status === 'open' && row.extend_by_seconds === 5 && row.extend_window_seconds === 5 && row.bid_count === 1 && near(Date.parse(row.ends_at) - dbNow(), 30000, 3000),
      `lot open with a 30 s database clock (presets 60 / 30 / 15 / 5), late-bid rule 5 s / 5 s, the opening counted as 1 bid`);
    const ya = await ca.waitFor('item_activated'), yb = await cb.waitFor('item_activated');
    ok(ya && ya.payload.you_lead === true && yb && yb.payload.you_lead === false, 'each viewer is told only whether THEY lead (A yes, B no)');

    console.log('\n== Proxy bidding over the socket (the timed engine) ==');
    from = ca.mark();
    e = await ask(cb, 'place_bid', { itemId: L1, max_amount: 30 }, ['bid_ok', 'bid_error']);
    row = await K.lot(L1);
    ok(e && e.event === 'bid_ok' && e.payload.your_status === 'outbid' && Number(row.current_bid) === 31 && row.leading_bidder === A.username,
      `B max $30 vs A's $40: price $${row.current_bid}, A still leads, B told 'outbid'`);
    let nb = await ca.waitFor('new_bid', () => true, 3000, from);
    // Live shows name the bid's leader (phase 2: the proxy bid is A's, so '@A $31'), never a max or an id.
    ok(nb && nb.payload.you_lead === true && nb.payload.amount === 31 && nb.payload.username === A.username && !('leading_bidder' in nb.payload)
      && !/max|top_pre/.test(Object.keys(nb.payload).join()) && !JSON.stringify(nb.payload).includes(A.id), `A's room event: ${nb && nb.payload.amount} by @${nb && nb.payload.username}, you_lead ${nb && nb.payload.you_lead}, no max, no id`);
    e = await ask(cc, 'place_bid', { max_amount: 60 }, ['bid_ok', 'bid_error']);   // no itemId: the open lot
    row = await K.lot(L1);
    ok(e && e.payload.your_status === 'winning' && Number(row.current_bid) === 41 && row.leading_bidder === C.username, `C max $60 (no itemId = the open lot): leads at $${row.current_bid} = A's 40 + $1`);
    e = await ask(ca, 'place_bid', { itemId: L1, max_amount: 55 }, ['bid_ok', 'bid_error']);
    row = await K.lot(L1);
    ok(e && e.payload.your_status === 'outbid' && Number(row.current_bid) === 56, `A max $55: C leads at $${row.current_bid}`);
    e = await ask(ca, 'place_bid', { itemId: L1, max_amount: 57 }, ['bid_ok', 'bid_error']);
    ok(e && e.event === 'bid_error' && e.payload.code === 'below_minimum' && /58\.00/.test(e.payload.message), `A $57 when $50-99 lots go up $2 -> ${e && e.payload.message}`);
    e = await ask(ca, 'place_bid', { itemId: L1, max_amount: 58.5 }, ['bid_ok', 'bid_error']);
    row = await K.lot(L1);
    ok(e && e.event === 'bid_ok' && Number(row.current_bid) === 60 && row.leading_bidder === C.username, `A $58.50 (cents): C still leads at $${row.current_bid}`);
    const before = await K.lot(L1);
    from = cb.mark();
    e = await ask(cc, 'place_bid', { itemId: L1, max_amount: 80 }, ['bid_ok', 'bid_error']);
    row = await K.lot(L1);
    const leakToB = await cb.waitFor('new_bid', () => true, 800, from);
    ok(e && e.payload.max_only === true && Number(row.current_bid) === Number(before.current_bid) && row.bid_count === before.bid_count && !leakToB,
      `the leader raising their max to $80: price and bid count unchanged, nothing sent to the room`);
    e = await ask(host, 'place_bid', { itemId: L1, max_amount: 100 }, ['bid_ok', 'bid_error']);
    ok(e && e.event === 'bid_error' && e.payload.code === 'host_cannot_bid', `the host bids -> ${e && e.payload.code}`);

    console.log('\n== Fences while a lot is open ==');
    let r = await call(srv.url, 'POST', `/auction/${show.id}/items/${L1}/bid`, B, { max_amount: 200 });
    ok(r.s === 400 && r.j.code === 'live_lot', `REST /bid on a live lot -> ${r.s} ${r.j && r.j.code}`);
    r = await call(srv.url, 'POST', `/auction/${show.id}/items/${L1}/prebid`, O, { max_amount: 200 });
    ok(r.s === 400, `pre-bid on the open lot -> ${r.s} ${r.j && r.j.error}`);
    r = await call(srv.url, 'DELETE', `/auction/${show.id}/items/${L1}/prebid`, C);
    const cMax = (await s.from('pre_bids').select('max_amount').eq('item_id', L1).eq('buyer_user_id', C.id).single()).data;
    ok(r.s === 400 && Number(cMax.max_amount) === 80, `the leader withdrawing their max from the open lot -> ${r.s}, max still $${cMax.max_amount}`);
    e = await ask(host, 'next_item', { timerSeconds: 30 }, ['item_activated', 'host_error']);
    ok(e && e.event === 'host_error' && /still open/.test(e.payload.message), `next lot while one is open -> ${e && e.payload.message}`);
    const pend = await K.lot(L2);
    ok(pend.status === 'pending', 'the next lot is still waiting');

    console.log('\n== The hammer at 0 ==');
    from = anon.mark();
    const fromC = cc.mark();
    const closed = await anon.waitFor('lot_closed', p => p.item_id === L1, 30000, from);
    row = await K.lot(L1);
    const won = await cc.waitFor('lot_closed', p => p.item_id === L1, 2000, fromC);
    // The room hears the hammer before the order is written (phase 8): wait for the order.
    let orders = [];
    for (let i = 0; i < 40 && !orders.length; i++) { orders = (await s.from('orders').select('*').eq('item_id', L1)).data; if (!orders.length) await sleep(250); }
    ok(closed && closed.payload.status === 'sold' && closed.payload.amount === 60 && closed.payload.you_won === false && won && won.payload.you_won === true,
      `room: sold $${closed && closed.payload.amount}; only C hears "you won"`);
    ok(row.status === 'sold' && orders.length === 1 && orders[0].buyer_username === C.username && orders[0].hammer_cents === 6000 && orders[0].premium_cents === 0 && orders[0].total_cents === 6000,
      `one order for the lot: C, hammer $60, premium $0, total $${orders[0] && orders[0].total_cents / 100}`);
    // Live shows show the winner's username (phase 2), and nothing else about anyone: no id, no max, no leading_bidder.
    ok(closed && closed.payload.username === C.username && !/"leading_bidder"|"max_amount"|"top_pre_bid"/.test(JSON.stringify(closed.payload)) && !JSON.stringify(closed.payload).includes(C.id),
      `lot_closed names the winner by username only (@${closed && closed.payload.username})`);

    console.log('\n== One pre-bid / none ==');
    from = anon.mark();
    await ask(host, 'next_item', { timerSeconds: 60 }, ['item_activated', 'host_error']);
    act = await anon.waitFor('item_activated', () => true, 4000, from);
    row = await K.lot(L2);
    ok(act && act.payload.item.current_bid == 1 && row.leading_bidder === A.username && !JSON.stringify(act.payload).includes('391.27'),
      `one pre-bid of $391.27: opens at $${act && act.payload.item.current_bid} (the opening minimum), A leads, the max is nowhere in the event`);

    console.log('\n== Late bid adds 5 s (database clock) ==');
    const tick = await anon.waitFor('item_timer_tick', p => p.item_id === L2 && p.seconds <= 57, 8000, from);
    ok(tick && tick.payload.ends_at && tick.payload.server_now && tick.payload.auctionId === show.id, `ticks carry ends_at + server_now (${tick && tick.payload.seconds}s left)`);
    // Pull the clock in to 3 s left, then bid.
    await s.from('auction_items').update({ ends_at: dbAt(3000) }).eq('id', L2);
    const end0 = Date.parse((await K.lot(L2)).ends_at);
    e = await ask(cb, 'place_bid', { itemId: L2, max_amount: 10 }, ['bid_ok', 'bid_error']);
    const end1 = Date.parse((await K.lot(L2)).ends_at);
    ok(e && e.event === 'bid_ok' && near(end1 - end0, 5000, 5), `a bid with ~3 s left: ends_at moved +${end1 - end0} ms`);
    await sleep(500);
    e = await ask(cc, 'place_bid', { itemId: L2, max_amount: 20 }, ['bid_ok', 'bid_error']);
    const end2 = Date.parse((await K.lot(L2)).ends_at);
    ok(e && e.event === 'bid_ok' && end2 === end1, `a bid with ~7 s left adds nothing (ends_at unchanged)`);
    from = anon.mark();
    const c2 = await anon.waitFor('lot_closed', p => p.item_id === L2, 15000, from);
    ok(c2 && c2.payload.status === 'sold' && (await K.lot(L2)).leading_bidder === A.username && c2.at + (dbNow() - Date.now()) >= end2 - 300, `closed at the extended time, sold to A (max $391.27) at $${c2 && c2.payload.amount}`);

    console.log('\n== Sudden death ==');
    from = anon.mark();
    e = await ask(host, 'next_item', { timerSeconds: 60, suddenDeath: true }, ['item_activated', 'host_error']);
    ok(e && e.payload.sudden_death === true && (await K.lot(L3)).extend_by_seconds === 0, 'lot 3 opened with Sudden death (extend_by 0)');
    await s.from('auction_items').update({ ends_at: dbAt(3000) }).eq('id', L3);
    const sd0 = Date.parse((await K.lot(L3)).ends_at);
    e = await ask(cb, 'place_bid', { itemId: L3, max_amount: 5 }, ['bid_ok', 'bid_error']);
    ok(e && e.event === 'bid_ok' && Date.parse((await K.lot(L3)).ends_at) === sd0, 'a bid with ~3 s left adds nothing');
    const c3 = await anon.waitFor('lot_closed', p => p.item_id === L3, 10000, from);
    ok(c3 && c3.payload.status === 'sold' && c3.payload.amount === 1, `closed on time, sold at $${c3 && c3.payload.amount}`);

    console.log('\n== No bids: unsold, no order ==');
    from = anon.mark();
    await ask(host, 'next_item', { timerSeconds: 5 }, ['item_activated', 'host_error']);
    const c4 = await anon.waitFor('lot_closed', p => p.item_id === L4, 12000, from);
    ok(c4 && c4.payload.status === 'unsold' && c4.payload.amount === null && !(await s.from('orders').select('id').eq('item_id', L4)).data.length, `lot 4 with no bids: ${c4 && c4.payload.status}, no order`);

    console.log('\n== Two bidders at the same moment ==');
    from = anon.mark();
    await ask(host, 'next_item', { timerSeconds: 60 }, ['item_activated', 'host_error']);
    const pre = await K.lot(L5);
    const [ra, rb] = await Promise.all([ask(ca, 'place_bid', { itemId: L5, max_amount: 70 }, ['bid_ok', 'bid_error']), ask(cb, 'place_bid', { itemId: L5, max_amount: 80 }, ['bid_ok', 'bid_error'])]);
    row = await K.lot(L5);
    const nBids = (await s.from('bids').select('id').eq('item_id', L5)).data.length;
    ok(ra && rb && ra.event === 'bid_ok' && rb.event === 'bid_ok' && row.leading_bidder === B.username && row.bid_count === pre.bid_count + 2 && nBids === 2 && Number(row.current_bid) > 70 && Number(row.current_bid) <= 80,
      `both counted (bid_count ${pre.bid_count} -> ${row.bid_count}, ${nBids} bid rows), B's higher max leads at $${row.current_bid}`);

    console.log('\n== End show: refused while a lot is open; Pass; then End once ==');
    e = await ask(host, 'end_auction', {}, ['auction_ended', 'host_error']);
    ok(e && e.event === 'host_error' && e.payload.code === 'lot_open' && (await K.lot(L5)).status === 'open', `End with lot 5 open -> ${e && e.payload.message}`);
    from = anon.mark();
    // Pull lot 5's clock in, then a bid: the server learns a lot's end time from the database through bids (and the
    // host's +N s), not by re-reading it every second.
    await s.from('auction_items').update({ ends_at: dbAt(1500) }).eq('id', L5);
    await ask(cc, 'place_bid', { itemId: L5, max_amount: 75 }, ['bid_ok', 'bid_error']);
    const c5 = await anon.waitFor('lot_closed', p => p.item_id === L5, 10000, from);
    ok(c5 && c5.payload.status === 'sold', 'lot 5 sells when its clock finishes');
    await ask(host, 'next_item', { timerSeconds: 60 }, ['item_activated', 'host_error']);
    await ask(cb, 'place_bid', { itemId: L6, max_amount: 15 }, ['bid_ok', 'bid_error']);
    from = anon.mark();
    e = await ask(host, 'pass_lot', {}, ['host_error', 'lot_closed']);
    const p6 = await anon.waitFor('lot_closed', p => p.item_id === L6, 3000, from);
    ok(p6 && p6.payload.status === 'unsold' && p6.payload.passed === true && (await K.lot(L6)).status === 'unsold' && !(await s.from('orders').select('id').eq('item_id', L6)).data.length,
      'Pass with a bid on it: lot 6 unsold, no order');
    e = await ask(host, 'pass_lot', {}, ['host_error', 'lot_closed']);
    ok(e && e.event === 'host_error' && /No lot is open/.test(e.payload.message), 'Pass with nothing open is refused');
    const fromEnd = anon.mark(), fromHost = host.mark();
    host.emit('end_auction', {}); host.emit('end_auction', {});
    await sleep(1500);
    const endedEvents = anon.events.slice(fromEnd).filter(x => x.event === 'auction_ended').length;
    const refused = host.events.slice(fromHost).filter(x => x.event === 'host_error').length;
    orders = (await s.from('orders').select('item_id, buyer_username, hammer_cents').eq('auction_id', show.id)).data;
    const ended = (await s.from('auctions').select('status').eq('id', show.id).single()).data.status;
    ok(ended === 'ended' && endedEvents === 1 && refused === 1, `End tapped twice: show '${ended}', the room told once, the second tap refused`);
    ok(orders.every(o => o.item_id) && orders.length === 4, `every order is a lot (${orders.length} orders: lots 1, 2, 3, 5; none for the show itself)`);
    ok((await K.lot(L7)).status === 'pending', 'a lot never offered stays pending (the host can run it later)');
    for (const c of [host, ca, cb, cc, anon]) c.close();

    console.log('\n== A restart mid-lot resumes the clock from the database ==');
    const show2 = await mkShow('restart', { lots: 1 });
    await terms(A, show2.id);
    const h = await client(srv.url, show2.id, ADMIN);
    await ask(h, 'next_item', { timerSeconds: 5 }, ['item_activated']);
    const a2 = await client(srv.url, show2.id, A);
    await ask(a2, 'place_bid', { max_amount: 3 }, ['bid_ok']);
    h.close(); a2.close();
    srv.stop(); servers.length = 0;
    const srv2 = await boot('live-engine-2', 3612, src, { env: ON, timers: 'real', patch: OK_STRIPE, log: true });
    servers.push(srv2);
    // Wait on the real condition (the lot sold and its order written), not a fixed delay: this used to sleep 15 s of
    // this machine's time, for about 8.7 s of work, and failed twice in full runs (2026-10-18; never alone, never in
    // 12 runs under load). Then judge by the DATABASE clock: the hammer (the order's created_at) within 5 s of the
    // later of the lot's ends_at and the moment the new server was up.
    const upAt = Date.parse((await s.rpc('live_db_now')).data);
    let l7 = null, o7 = [];
    for (let i = 0; i < 90; i++) {
      l7 = (await s.from('auction_items').select('status, ends_at').eq('auction_id', show2.id).single()).data;
      o7 = (await s.from('orders').select('hammer_cents, created_at').eq('auction_id', show2.id)).data;
      if (l7.status === 'sold' && o7.length) break;
      await sleep(500);
    }
    const lateBy = o7.length ? (Date.parse(o7[0].created_at) - Math.max(Date.parse(l7.ends_at), upAt)) / 1000 : null;
    ok(l7.status === 'sold' && o7.length === 1 && o7[0].hammer_cents === 100 && lateBy !== null && lateBy <= 5,
      `the lot's server stopped; a new one sold it at ends_at by the database clock (${l7.status}, ${o7.length} order, ${lateBy === null ? 'no hammer' : lateBy.toFixed(1) + ' s after ends_at or its boot'})`);
    if (l7.status !== 'sold' || o7.length !== 1 || !(lateBy <= 5)) console.log('--- second server log ---' + srv2.log().slice(-3000));
    srv2.stop(); servers.length = 0;

    console.log('\n== The timed close job leaves live lots alone ==');
    const fenceRun = async (label, port, source) => {
      const sh = await mkShow('fence-' + label, { lots: 1 });
      await s.from('auction_items').update({ status: 'open', ends_at: dbAt(-60e3), extend_window_seconds: 5, extend_by_seconds: 5, current_bid: 0, bid_count: 0 }).eq('id', sh.lots[0]);
      const std = await K.mkStandard('fence-control-' + label);
      const stdLot = die(await s.from('auction_items').insert({ auction_id: std, title: K.P + ' timed lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: dbAt(-60e3) }).select().single()).id;
      const x = await boot('live-fence-' + label, port, source, { env: ON });   // timers stubbed: the close job runs once at boot
      await sleep(5000);
      x.stop();
      return { live: (await K.lot(sh.lots[0])).status, timed: (await K.lot(stdLot)).status };
    };
    const oldF = await fenceRun('old', 3613, require('./guard').sourceAt(OLD_COMMIT, BE));
    ok(oldF.live === 'unsold' && oldF.timed === 'unsold', `OLD ${OLD_COMMIT}: the timed job closed the live lot ('${oldF.live}')  <- TWO CLOSERS`);
    // The live hammer's timers are off here as on the old commit (setInterval stubbed; since phase 8 also its one-shot
    // close timer), so only the timed job could close the live lot.
    const newF = await fenceRun('new', 3614, src.replace('function armLiveClose(itemId, w) {', 'function armLiveClose(itemId, w) { return;'));
    ok(newF.live === 'open' && newF.timed === 'unsold', `NEW: live lot left '${newF.live}' for the live hammer; the timed control lot was closed ('${newF.timed}')`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
  }
  K.finish();
})();
