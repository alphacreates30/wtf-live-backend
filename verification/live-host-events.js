// Live shows phase 2a (G1, wtf-handoff LIVE_SHOWS_PHASE2_BRIEF.md step 2a; audit §2): the show lifecycle and the
// host's events. Needs migrations za, zb and zd. Local servers on the test database with LIVE_ENABLED=true; Stripe is
// an in-process fake that always succeeds, Resend is blanked (nothing is charged or sent).
//   lifecycle  create (start time + default clock, no premium) -> publish = scheduled, not on air -> Go live ->
//              ... -> End show. Only the host (or admin) can send host events; LIVE_ENABLED off refuses them all.
//   machine    out-of-order steps refused with a code: show_lot while a lot sells, start_clock with nothing on screen,
//              sold_now with no bids, add_time / pass with nothing open, Go live twice, End mid-lot, anything after End.
//   steps      show_lot -> start_clock (the lot card's preset, else the show's; Sudden death) -> add_time (+15 s exactly)
//              -> sold_now (one order, the winner's username) / pass (unsold, no order) -> run_again (a copy with the
//              next free lot number, next or at the end, once) -> reorder_lineup (lot numbers unchanged) -> hold.
//              Every accepted event records host activity.
//   auto-pace  after a sale the next lot goes on screen and its clock starts after 15 s of talk time; Hold stops it;
//              releasing Hold starts it again.
//   auto-end   on air, no host activity for 60 min, no lot open -> ended (a rehearsal: ended_at, still a draft); never
//              while a lot is open; not before 60 min.
//   screens    GET /auction/:id/show-state and /lineup (public: no ids, no maxes), /admin/live/:id/checklist (who is in
//              the room and can bid) and /admin/live/:id/packing (winner list, one box per buyer), admin only.
require('./guard')(__filename);
const K = require('./live-kit')('hostev');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, client, ask, call, sleep, boot, BE, dbNow } = K;
process.chdir(BE);
const ON = { LIVE_ENABLED: 'true' };
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const HOST_ANSWERS = ['host_ok', 'host_error'];
const show = async id => die(await s.from('auctions').select('*').eq('id', id).single());

(async () => {
  const probe = await s.from('auctions').select('shown_item_id').limit(1);
  if (probe.error) { console.log('auctions.shown_item_id is missing: apply migration zd (2026-10-18zd-live-show-lifecycle.sql) first.'); process.exit(2); }
  const servers = [];
  try {
    await K.syncClock();
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('live-hostev', 3661, src, { env: ON, timers: 'real', patch: OK_STRIPE });
    const off = await boot('live-hostev-off', 3662, src, {});
    servers.push(srv, off);
    const A = await mkUser('a'), B = await mkUser('b');

    console.log('== Create and publish: scheduled, not on air ==');
    let r = await call(srv.url, 'POST', '/auction', ADMIN, { title: `${K.P} main ${K.TAG}`, description: 'x', starting_bid: 0, mode: 'live', fulfillment_mode: 'shipping',
      starts_at: new Date(Date.now() - 60e3).toISOString(), clock_seconds: 20 });
    ok(r.s === 400 && /60, 30, 15 or 5/.test(r.j.error), `a 20 s default clock is refused (${r.s})`);
    r = await call(srv.url, 'POST', '/auction', ADMIN, { title: `${K.P} main ${K.TAG}`, description: 'x', starting_bid: 0, mode: 'live', fulfillment_mode: 'shipping',
      starts_at: new Date(Date.now() - 60e3).toISOString(), clock_seconds: 15, buyers_premium_pct: 15 });
    const SHOW = r.j.id;
    if (SHOW) K.made.auctions.push(SHOW);
    ok(r.s === 201 && r.j.status === 'draft' && r.j.clock_seconds === 15 && r.j.auto_pace === false && Number(r.j.buyers_premium_pct) === 0 && r.j.ends_at === null,
      `created: draft, default clock ${r.j.clock_seconds} s, auto-pace off, premium ${r.j.buyers_premium_pct}%, no end time`);
    const lots = [];
    for (let i = 1; i <= 4; i++) lots.push((await call(srv.url, 'POST', `/auction/${SHOW}/items`, ADMIN, { title: `${K.P} lot ${i} ${K.TAG}`, starting_bid: 0 })).j.id);
    const [L1, L2, L3, L4] = lots;
    r = await call(srv.url, 'PATCH', `/auction/${SHOW}`, ADMIN, { clock_seconds: 20 });
    ok(r.s === 400, `PATCH a 20 s clock -> ${r.s}`);
    r = await call(srv.url, 'PATCH', `/auction/${SHOW}`, ADMIN, { clock_seconds: 30, auto_pace: false });
    ok(r.s === 200 && r.j.clock_seconds === 30, `PATCH the default clock to 30 s -> ${r.s}`);
    r = await call(srv.url, 'POST', `/auction/${SHOW}/publish`, ADMIN);
    ok(r.s === 200 && r.j.status === 'upcoming' && !r.j.on_air_at, `publish with a start time already passed: '${r.j.status}', not on air (two-step start)`);
    for (const u of [A, B]) await terms(u, SHOW);

    const host = await client(srv.url, SHOW, ADMIN), ca = await client(srv.url, SHOW, A), cb = await client(srv.url, SHOW, B), anon = await client(srv.url, SHOW);
    const st0 = await anon.waitFor('show_state');
    ok(st0 && st0.payload.on_air === false && st0.payload.up_next.length === 3 && st0.payload.up_next[0].lot_number === 1, `on join: show_state (not on air, up next lots ${st0 && st0.payload.up_next.map(l => l.lot_number).join(', ')})`);

    console.log('\n== Only the host; nothing before Go live ==');
    let e = await ask(ca, 'go_live', {}, HOST_ANSWERS);
    ok(e && e.event === 'host_error' && /Only the host/.test(e.payload.message), `a buyer's go_live: ${e && e.payload.message}`);
    e = await ask(ca, 'show_lot', {}, HOST_ANSWERS);
    ok(e && e.event === 'host_error', `a buyer's show_lot refused`);
    e = await ask(host, 'show_lot', {}, HOST_ANSWERS);
    ok(e && e.payload.code === 'not_on_air', `show_lot before Go live: ${e && e.payload.code}`);
    const offHost = await client(off.url, SHOW, ADMIN);
    e = await ask(offHost, 'go_live', {}, HOST_ANSWERS);
    ok(e && e.payload.code === 'live_off', `LIVE_ENABLED off: go_live -> ${e && e.payload.code}`);
    offHost.close();
    ok((await call(off.url, 'GET', `/auction/${SHOW}/show-state`)).s === 404, 'LIVE_ENABLED off: show-state 404');

    console.log('\n== Go live ==');
    let from = anon.mark();
    e = await ask(host, 'go_live', {}, HOST_ANSWERS);
    let a = await show(SHOW);
    const started = await anon.waitFor('auction_started', () => true, 3000, from);
    const onAir = await anon.waitFor('show_state', p => p.on_air, 3000, from);
    ok(e && e.event === 'host_ok' && a.status === 'live' && a.on_air_at && a.last_host_activity_at && started && onAir, `on air: status '${a.status}', on_air_at set, host activity recorded, the room told`);
    e = await ask(host, 'go_live', {}, HOST_ANSWERS);
    ok(e && e.payload.code === 'already_on_air', `Go live twice: ${e && e.payload.code}`);

    console.log('\n== The state machine refuses steps out of order ==');
    for (const [ev, code] of [['start_clock', 'no_lot_shown'], ['add_time', 'no_lot_open'], ['sold_now', 'no_lot_open'], ['pass', 'no_lot_open']]) {
      e = await ask(host, ev, {}, HOST_ANSWERS);
      ok(e && e.payload.code === code, `${ev} with nothing on screen: ${e && e.payload.code}`);
    }
    e = await ask(ca, 'place_bid', { max_amount: 5 }, ['bid_ok', 'bid_error']);
    ok(e && e.event === 'bid_error' && e.payload.code === 'not_found', `a bid with no lot open: ${e && e.payload.code}`);

    console.log('\n== Show lot 1, its card clock, start ==');
    from = anon.mark();
    e = await ask(host, 'show_lot', {}, HOST_ANSWERS);
    let st = await anon.waitFor('show_state', p => p.shown, 3000, from);
    ok(e && e.event === 'host_ok' && e.payload.lot_number === 1 && st && st.payload.shown.id === L1 && !st.payload.open, `lot 1 on screen, no clock yet (show_state.shown = lot ${st && st.payload.shown.lot_number})`);
    e = await ask(ca, 'place_bid', { itemId: L1, max_amount: 5 }, ['bid_ok', 'bid_error']);
    ok(e && e.payload.code === 'lot_not_open', `a bid on the lot on screen before its clock: ${e && e.payload.code}`);
    e = await ask(host, 'set_lot_clock', { itemId: L1, seconds: 20 }, HOST_ANSWERS);
    ok(e && e.payload.code === 'bad_clock', 'the card refuses a 20 s clock');
    e = await ask(host, 'set_lot_clock', { itemId: L1, seconds: 60 }, HOST_ANSWERS);
    ok(e && e.event === 'host_ok' && (await K.lot(L1)).clock_seconds === 60, 'the card sets lot 1 to 60 s');
    const act0 = (await show(SHOW)).last_host_activity_at;
    await sleep(1100);
    e = await ask(host, 'start_clock', {}, HOST_ANSWERS);
    let row = await K.lot(L1);
    ok(e && e.event === 'host_ok' && row.status === 'open' && near(Date.parse(row.ends_at) - dbNow(), 60000, 3000) && row.extend_by_seconds === 5,
      `start_clock: lot 1 open on the card's 60 s (late-bid rule on)`);
    ok((await show(SHOW)).last_host_activity_at > act0, 'host activity moved on');
    for (const [ev, code] of [['show_lot', 'lot_open'], ['start_clock', 'lot_open'], ['end_show', 'lot_open']]) {
      e = await ask(host, ev, {}, HOST_ANSWERS);
      ok(e && e.payload.code === code, `${ev} while lot 1 sells: ${e && e.payload.code}`);
    }
    e = await ask(host, 'sold_now', {}, HOST_ANSWERS);
    ok(e && e.payload.code === 'no_bids', `Sold now with no bids: ${e && e.payload.code}`);
    const end0 = Date.parse(row.ends_at);
    e = await ask(host, 'add_time', {}, HOST_ANSWERS);
    ok(e && e.event === 'host_ok' && Date.parse((await K.lot(L1)).ends_at) - end0 === 15000, `+15 s: ends_at moved ${Date.parse((await K.lot(L1)).ends_at) - end0} ms`);

    from = anon.mark();
    e = await ask(ca, 'place_bid', { max_amount: 5 }, ['bid_ok', 'bid_error']);
    const nb = await anon.waitFor('new_bid', () => true, 3000, from);
    ok(e && e.event === 'bid_ok' && nb && nb.payload.username === A.username && nb.payload.amount === 1, `A bids: the room sees "@${nb && nb.payload.username} $${nb && nb.payload.amount}" (never the max)`);
    from = anon.mark();
    e = await ask(host, 'sold_now', {}, HOST_ANSWERS);
    const closed = await anon.waitFor('lot_closed', p => p.item_id === L1, 5000, from);
    st = await anon.waitFor('show_state', p => p.last && p.last.item_id === L1, 5000, from);
    let orders = (await s.from('orders').select('*').eq('item_id', L1)).data;
    ok(e && e.event === 'host_ok' && e.payload.username === A.username && closed && closed.payload.status === 'sold' && closed.payload.username === A.username && closed.payload.lot_number === 1,
      `Sold now: "Sold to @${closed && closed.payload.username}, $${closed && closed.payload.amount}" before the clock ran out`);
    ok(orders.length === 1 && orders[0].buyer_username === A.username && orders[0].hammer_cents === 100, `one order for lot 1 (A, $${orders[0] && orders[0].hammer_cents / 100})`);
    ok(st && st.payload.last.winner === A.username && st.payload.stats.sold_count === 1 && st.payload.stats.sold_total === 1 && st.payload.stats.lots_left === 3 && !st.payload.open,
      `show_state: last = sold to @A, stats ${st && JSON.stringify(st.payload.stats)}`);

    console.log('\n== Lot 2: Sudden death, then Pass with a bid ==');
    await ask(host, 'show_lot', {}, HOST_ANSWERS);
    e = await ask(host, 'start_clock', { seconds: 15, suddenDeath: true }, HOST_ANSWERS);
    row = await K.lot(L2);
    ok(e && e.event === 'host_ok' && row.status === 'open' && row.extend_by_seconds === 0 && near(Date.parse(row.ends_at) - dbNow(), 15000, 3000), 'lot 2 open: 15 s, Sudden death (bids add nothing)');
    await ask(cb, 'place_bid', { max_amount: 7 }, ['bid_ok', 'bid_error']);
    from = anon.mark();
    e = await ask(host, 'pass', {}, HOST_ANSWERS);
    const passed = await anon.waitFor('lot_closed', p => p.item_id === L2, 3000, from);
    st = await anon.waitFor('show_state', p => p.last && p.last.item_id === L2, 3000, from);
    ok(e && e.event === 'host_ok' && (await K.lot(L2)).status === 'unsold' && passed && passed.payload.passed && !passed.payload.username
      && !(await s.from('orders').select('id').eq('item_id', L2)).data.length, 'Pass with a bid: unsold, no order, no name');
    ok(st && st.payload.last.passed === true && st.payload.last.can_run_again === true, 'show_state: the passed lot can run again');

    console.log('\n== Run again ==');
    e = await ask(host, 'run_again', { itemId: L1, next: true }, HOST_ANSWERS);
    ok(e && e.payload.code === 'refused', `Run again on a SOLD lot: refused (${e && e.payload.message})`);
    from = anon.mark();
    e = await ask(host, 'run_again', { itemId: L2, next: true }, HOST_ANSWERS);
    const copyId = e && e.payload.item_id;
    const copy = copyId ? await K.lot(copyId) : null;
    const lc = await anon.waitFor('lineup_changed', () => true, 3000, from);
    ok(e && e.event === 'host_ok' && copy && copy.position === 4 && e.payload.lot_number === 5 && copy.status === 'pending' && copy.offer_next === true && copy.run_again_of === L2 && lc,
      `a copy: lot ${e && e.payload.lot_number} (next free number), waiting, offered next, points at lot 2; the room told`);
    ok((await K.lot(L2)).status === 'unsold' && (await K.lot(L2)).position === 1, 'lot 2 keeps its number and record');
    e = await ask(host, 'run_again', { itemId: L2, next: false }, HOST_ANSWERS);
    ok(e && e.payload.code === 'refused', `Run again twice: refused (${e && e.payload.message})`);
    e = await ask(host, 'show_lot', {}, HOST_ANSWERS);
    ok(e && e.payload.item_id === copyId && e.payload.lot_number === 5, `the next lot shown is the copy (lot ${e && e.payload.lot_number}), before lots 3 and 4`);
    e = await ask(host, 'pass', {}, HOST_ANSWERS);
    ok(e && e.event === 'host_ok' && (await K.lot(copyId)).status === 'unsold' && !(await show(SHOW)).shown_item_id, 'Pass on a lot on screen (clock not started): skipped, unsold');

    console.log('\n== Reorder the lineup ==');
    e = await ask(host, 'reorder_lineup', { itemIds: [L4] }, HOST_ANSWERS);
    ok(e && e.payload.code === 'lineup_changed', 'a list that is not every waiting lot is refused');
    e = await ask(host, 'reorder_lineup', { itemIds: [L4, L3] }, HOST_ANSWERS);
    const lu = await call(srv.url, 'GET', `/auction/${SHOW}/lineup`);
    ok(e && e.event === 'host_ok' && lu.s === 200 && lu.j.waiting.map(l => l.lot_number).join() === '4,3', `lineup now: lots ${lu.j.waiting && lu.j.waiting.map(l => l.lot_number).join(', ')} (numbers unchanged)`);
    ok(!/"leading_bidder"|"top_pre_bid"|"max_amount"/.test(JSON.stringify(lu.j)) && !JSON.stringify(lu.j).includes(A.id), 'the public lineup: no ids of bidders, no maxes');

    console.log('\n== Hold ==');
    e = await ask(host, 'hold', {}, HOST_ANSWERS);
    ok(e && e.payload.on === true && (await show(SHOW)).on_hold === true, 'Hold on');
    e = await ask(host, 'hold', {}, HOST_ANSWERS);
    ok(e && e.payload.on === false && (await show(SHOW)).on_hold === false, 'Hold off');

    console.log('\n== Lots 4 and 3; screens ==');
    await ask(host, 'show_lot', {}, HOST_ANSWERS);
    await ask(host, 'start_clock', { seconds: 30 }, HOST_ANSWERS);
    await ask(cb, 'place_bid', { max_amount: 9 }, ['bid_ok']);
    const ss = await call(srv.url, 'GET', `/auction/${SHOW}/show-state`, B), ssAnon = await call(srv.url, 'GET', `/auction/${SHOW}/show-state`);
    ok(ss.s === 200 && ss.j.open.lot_number === 4 && ss.j.open.leader === B.username && ss.j.you_lead === true && ssAnon.j.you_lead === false,
      `GET show-state: lot 4 open, leader @${ss.j.open && ss.j.open.leader}; B's copy says you_lead, anonymous not`);
    ok(!/"leading_bidder"|"top_pre_bid"|"max_amount"|"rehearsal_key"/.test(JSON.stringify(ssAnon.j)) && !JSON.stringify(ssAnon.j).includes(B.id), 'show-state: no ids, no maxes, no keys');
    const cl = await call(srv.url, 'GET', `/admin/live/${SHOW}/checklist`, ADMIN);
    const inRoom = cl.j && Object.fromEntries(cl.j.buyers_in_room.map(b => [b.username, b]));
    ok(cl.s === 200 && inRoom[A.username] && inRoom[A.username].card_verified && inRoom[A.username].terms && inRoom[B.username] && cl.j.lots.total === 5,
      `checklist: ${cl.j && cl.j.buyers_in_room.length} buyers in the room, each with card and terms status; ${cl.j && cl.j.lots.total} lots`);
    ok((await call(srv.url, 'GET', `/admin/live/${SHOW}/checklist`, A)).s === 403 && (await call(srv.url, 'GET', `/admin/live/${SHOW}/packing`, A)).s === 403, 'checklist and packing list: admin only');
    await ask(host, 'sold_now', {}, HOST_ANSWERS);
    await ask(host, 'show_lot', {}, HOST_ANSWERS);
    await ask(host, 'start_clock', { seconds: 30 }, HOST_ANSWERS);
    await ask(ca, 'place_bid', { max_amount: 4 }, ['bid_ok']);
    await ask(host, 'sold_now', {}, HOST_ANSWERS);
    e = await ask(host, 'show_lot', {}, HOST_ANSWERS);
    ok(e && e.payload.code === 'no_lots', `every lot offered: show_lot -> ${e && e.payload.code}`);

    console.log('\n== End show ==');
    from = anon.mark();
    e = await ask(host, 'end_show', {}, HOST_ANSWERS);
    a = await show(SHOW);
    const endedEv = await anon.waitFor('auction_ended', () => true, 3000, from);
    ok(e && e.event === 'host_ok' && a.status === 'ended' && a.ended_at && !a.shown_item_id && endedEv, `ended: '${a.status}', ended_at set, the room told`);
    for (const ev of ['end_show', 'show_lot', 'go_live']) {
      e = await ask(host, ev, {}, HOST_ANSWERS);
      ok(e && e.event === 'host_error' && ['not_on_air', 'ended'].includes(e.payload.code), `${ev} after the end: ${e && e.payload.code}`);
    }
    await sleep(1500);   // the hammer charges run off the critical path
    const pk = await call(srv.url, 'GET', `/admin/live/${SHOW}/packing`, ADMIN);
    const boxA = pk.j && pk.j.boxes.find(b => b.buyer === A.username), boxB = pk.j && pk.j.boxes.find(b => b.buyer === B.username);
    ok(pk.s === 200 && pk.j.winners.map(w => `${w.lot_number}:${w.buyer === A.username ? 'A' : 'B'}`).join() === '1:A,3:A,4:B',
      `winner list: ${pk.j && pk.j.winners.map(w => `lot ${w.lot_number} @${w.buyer === A.username ? 'A' : 'B'}`).join(', ')}`);
    ok(pk.j.boxes.length === 2 && boxA && boxA.lots.map(l => l.lot_number).join() === '1,3' && boxA.fulfillment === 'shipping' && boxA.group_id && boxB && boxB.lots.length === 1,
      `packing list: one box per buyer (A: lots ${boxA && boxA.lots.map(l => l.lot_number).join(' + ')}, B: lot ${boxB && boxB.lots[0].lot_number}), ship/pickup shown`);
    for (const c of [host, ca, cb, anon]) c.close();

    console.log('\n== Auto-pace and Hold ==');
    const ap = await mkShow('autopace', { status: 'upcoming', lots: 3, fields: { auto_pace: true, clock_seconds: 15 } });
    await terms(A, ap.id);
    const h2 = await client(srv.url, ap.id, ADMIN), a2 = await client(srv.url, ap.id, A);
    await ask(h2, 'go_live', {}, HOST_ANSWERS);
    await ask(h2, 'show_lot', {}, HOST_ANSWERS);
    await ask(h2, 'start_clock', {}, HOST_ANSWERS);
    await ask(a2, 'place_bid', { max_amount: 3 }, ['bid_ok']);
    from = a2.mark();
    await ask(h2, 'sold_now', {}, HOST_ANSWERS);
    st = await a2.waitFor('show_state', p => p.shown && p.shown.id === ap.lots[1] && p.autostart_at, 5000, from);
    ok(st && !st.payload.open && near(Date.parse(st.payload.autostart_at) - Date.now(), 15000, 3000), `after the sale: lot 2 on screen by itself, its clock due in ~15 s`);
    const act = await a2.waitFor('item_activated', p => p.item.id === ap.lots[1], 20000, from);
    ok(act && act.at - (st ? st.at : 0) > 12000, `lot 2's clock started by itself after the talk time (${act && st ? ((act.at - st.at) / 1000).toFixed(1) : '?'} s)`);
    await ask(a2, 'place_bid', { max_amount: 3 }, ['bid_ok']);
    from = a2.mark();
    await ask(h2, 'sold_now', {}, HOST_ANSWERS);
    await a2.waitFor('show_state', p => p.shown && p.shown.id === ap.lots[2] && p.autostart_at, 5000, from);
    e = await ask(h2, 'hold', { on: true }, HOST_ANSWERS);
    let apRow = await show(ap.id);
    ok(e && e.payload.on === true && apRow.on_hold && !apRow.autostart_at, 'Hold: the planned start is cancelled');
    await sleep(17000);
    ok((await K.lot(ap.lots[2])).status === 'pending', 'held: lot 3 did not start after the talk time');
    from = a2.mark();
    e = await ask(h2, 'hold', { on: false }, HOST_ANSWERS);
    apRow = await show(ap.id);
    ok(e && e.payload.on === false && apRow.autostart_at, 'Hold released: lot 3 due after the talk time again');
    const act3 = await a2.waitFor('item_activated', p => p.item.id === ap.lots[2], 20000, from);
    ok(!!act3, 'lot 3 started by itself');
    await ask(h2, 'pass', {}, HOST_ANSWERS);
    await ask(h2, 'end_show', {}, HOST_ANSWERS);
    h2.close(); a2.close();
    srv.stop(); off.stop(); servers.length = 0;

    console.log('\n== Auto-end after 60 min with no host activity ==');
    const ago = m => new Date(Date.now() - m * 60e3).toISOString();
    const idle = await mkShow('idle', { status: 'live', lots: 1, fields: { on_air_at: ago(120), last_host_activity_at: ago(61) } });
    const busy = await mkShow('idle-lot-open', { status: 'live', lots: 1, fields: { on_air_at: ago(120), last_host_activity_at: ago(90) } });
    await s.from('auction_items').update({ status: 'open', ends_at: new Date(Date.now() + 3600e3).toISOString(), extend_window_seconds: 5, extend_by_seconds: 5, current_bid: 0, bid_count: 0 }).eq('id', busy.lots[0]);
    const recent = await mkShow('recent', { status: 'live', lots: 1, fields: { on_air_at: ago(120), last_host_activity_at: ago(30) } });
    const quiet = await mkShow('never-tapped', { status: 'live', lots: 1, fields: { on_air_at: ago(65) } });
    const reh = await mkShow('rehearsal-idle', { status: 'draft', lots: 1, fields: { on_air_at: ago(120), last_host_activity_at: ago(61) } });
    const job = await boot('live-hostev-job', 3663, src, { env: ON, patch: OK_STRIPE });   // timers stubbed: the 30 s job runs once at boot
    servers.push(job);
    await sleep(6000);
    job.stop(); servers.length = 0;
    const [si, sb, sr, sq, sh] = await Promise.all([idle, busy, recent, quiet, reh].map(x => show(x.id)));
    ok(si.status === 'ended' && si.ended_at, `61 min idle, nothing open: ended (${si.status})`);
    ok(sb.status === 'live' && !sb.ended_at, `90 min idle but a lot is open: still on air (${sb.status})`);
    ok(sr.status === 'live', `30 min idle: still on air (${sr.status})`);
    ok(sq.status === 'ended', `on air 65 min and the host never tapped anything: ended (${sq.status})`);
    ok(sh.status === 'draft' && sh.ended_at, `an idle rehearsal: ended_at set, still a draft (hidden)`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
