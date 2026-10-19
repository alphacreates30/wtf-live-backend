// At an equal max, the bidder who reached that max FIRST leads (migration zf; found by live-load.js, 2026-10-19).
// Without zf the engine kept a raised max's ORIGINAL row time, so a buyer who first bid earlier won a tie they
// reached later. Without zf on this database: the bug is reproduced, the suite says so and exits 2.
// Checked (with zf), on the engine itself and through the server:
//   timed   A $5, B $10 (B leads $6), A raises to $10 -> B still leads at $10, A told "outbid"; two buyers sending
//           the same max: the first one leads; the leader raising their own max keeps the lead when a challenger
//           later reaches it;
//   live    pre-bids through POST .../prebid: A $10, B $20, A raises to $20 -> the lot opens with B leading at $20;
//           five buyers tapping Bid at the same amount at once, 8 rounds: exactly one is told "winning" (besides the
//           leader's own max-only raise), and that one is the leader the room hears.
// THROWAWAY rows only (live-kit, ZZTEST_live_ties*), cleaned up.
require('./guard')(__filename);
const K = require('./live-kit')('ties');
const { s, ok, die, ADMIN, mkUser, mkShow, mkStandard, terms, client, ask, call, boot, BE, sleep } = K;
process.chdir(BE);
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];
const HA = ['host_ok', 'host_error'];

async function timedLot() {
  const aid = await mkStandard('timed');
  return die(await s.from('auction_items').insert({ auction_id: aid, title: K.P + ' lot ' + K.TAG, starting_bid: 0, current_bid: 0, position: 0, status: 'open',
    ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
}
const bidder = lot => async (u, max) => { const r = await s.rpc('place_standard_bid', { p_item_id: lot.id, p_user_id: u.id, p_username: u.username, p_max_amount: max }); if (r.error) throw new Error(r.error.message); return r.data; };
const who = (row, users) => (users.find(u => u.username === row.leading_bidder) || {}).label;

(async () => {
  const servers = [];
  let missing = false;
  try {
    const A = await mkUser('a'), B = await mkUser('b'), C = await mkUser('c');
    A.label = 'A'; B.label = 'B'; C.label = 'C';
    const users = [A, B, C];

    console.log('== Timed lot: a raised max that only ties ==');
    let lot = await timedLot(), bid = bidder(lot);
    await bid(A, 5); await sleep(30);
    let r = await bid(B, 10);
    const bLed = who(r, users) === 'B' && Number(r.current_bid) === 6;
    await sleep(30);
    r = await bid(A, 10);
    if (who(r, users) === 'A') {
      missing = true;
      console.log(`REPRODUCED (migration zf is not on this database): A $5, B $10 (B led at $6: ${bLed}), A raised to $10 AFTER B had it -> A leads at $${r.current_bid}`);
      return;
    }
    ok(bLed && who(r, users) === 'B' && Number(r.current_bid) === 10, `A $5, B $10 (B leads $6), A raises to $10 after B had it: B keeps the lead at $${r.current_bid} (A is told outbid)`);

    lot = await timedLot(); bid = bidder(lot);
    await bid(A, 10); await sleep(30);
    r = await bid(B, 10);
    ok(who(r, users) === 'A' && Number(r.current_bid) === 10, `the same $10 max from A, then B: A (first) leads at $${r.current_bid}`);

    lot = await timedLot(); bid = bidder(lot);
    await bid(C, 3); await sleep(30);
    await bid(A, 10); await sleep(30);
    const raise = await s.rpc('update_standard_leader_max', { p_item_id: lot.id, p_username: A.username, p_max_amount: 20 });
    ok(!raise.error && raise.data && raise.data.length === 1, `the leader A raises their own max to $20 (max only)${raise.error ? ' ' + raise.error.message : ''}`);
    await sleep(30);
    r = await bid(C, 20);
    ok(who(r, users) === 'A' && Number(r.current_bid) === 20, `C, who first bid before A, reaches $20 after A's raise: A keeps the lead at $${r.current_bid}`);

    console.log('\n== Live show: pre-bids, then five taps at once ==');
    const srv = await boot('ties', 3725, require('./guard').readSource(BE + '/server.js'), { env: { LIVE_ENABLED: 'true' }, timers: 'real', patch: OK_STRIPE });
    servers.push(srv);
    const show = await mkShow('show', { status: 'upcoming', lots: 2, fields: { starts_at: new Date(Date.now() + 36e5).toISOString() } });
    const five = [A, B, C, await mkUser('d'), await mkUser('e')];
    for (const u of five) await terms(u, show.id);
    let p = await call(srv.url, 'POST', `/auction/${show.id}/items/${show.lots[0]}/prebid`, A, { max_amount: 10 });
    await sleep(30);
    const p2 = await call(srv.url, 'POST', `/auction/${show.id}/items/${show.lots[0]}/prebid`, B, { max_amount: 20 });
    await sleep(30);
    const p3 = await call(srv.url, 'POST', `/auction/${show.id}/items/${show.lots[0]}/prebid`, A, { max_amount: 20 });
    ok(p.s === 200 && p2.s === 200 && p3.s === 200, `pre-bids saved: A $10, B $20, then A raises to $20 (${p.s} ${p2.s} ${p3.s})`);
    const host = await client(srv.url, show.id, ADMIN);
    await ask(host, 'go_live', {}, HA);
    await ask(host, 'show_lot', {}, HA);
    await ask(host, 'start_clock', { seconds: 60 }, HA);
    const opened = await host.waitFor('item_activated', () => true, 5000);
    ok(opened && opened.payload.leader === B.username && Number(opened.payload.item.current_bid) === 20, `the lot opens with B (who reached $20 first) leading at $${opened && opened.payload.item.current_bid}`);

    const cs = await Promise.all(five.map(u => client(srv.url, show.id, u)));
    let next = (await cs[0].waitFor('show_state', x => x.open, 5000)).payload.open.next_bid;
    let clean = 0, agree = 0;
    for (let round = 0; round < 8; round++) {
      const marks = cs.map(c => c.mark()), hm = host.mark();
      const amount = next;
      for (const c of cs) c.emit('place_bid', { max_amount: amount });
      const answers = await Promise.all(cs.map((c, i) => c.waitFor('bid_ok', () => true, 8000, marks[i]).then(a => a || c.events.slice(marks[i]).find(e => e.event === 'bid_error'))));
      const told = answers.map((a, i) => (a && a.event === 'bid_ok' && a.payload.your_status === 'winning' && !a.payload.max_only ? five[i].username : null)).filter(Boolean);
      await sleep(400);
      const lastNew = host.events.slice(hm).filter(e => e.event === 'new_bid').pop();
      const leader = (await s.from('auction_items').select('leading_bidder').eq('id', show.lots[0]).single()).data.leading_bidder;
      if (told.length <= 1) clean++;
      if (told.length === 0 || (told[0] === leader && (!lastNew || lastNew.payload.username === leader))) agree++;
      console.log(`  round ${round + 1}: $${amount}: told "winning": ${told.length ? told.map(n => n.split('_')[3]).join(', ') : 'nobody (the leader raised)'}; leader ${leader.split('_')[3]}`);
      const st = await cs[0].waitFor('show_state', x => x.open && x.open.next_bid > amount, 3000, marks[0]);
      next = st ? st.payload.open.next_bid : (lastNew ? lastNew.payload.next_bid : amount + 1);
    }
    ok(clean === 8, `each round, at most one tap is told "winning" (${clean}/8)`);
    ok(agree === 8, `and that one is the leader the room hears (${agree}/8)`);
    for (const c of [host, ...cs]) c.close();
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    if (missing) { console.log('\nMigration zf is missing: the bug is reproduced above. Exit 2.'); process.exit(2); }
    K.finish();
  }
})();
