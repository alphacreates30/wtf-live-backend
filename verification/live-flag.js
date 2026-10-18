// Live shows switch + no premium / no reserve (G1 phase 1, LIVE_SHOWS_BRIEF.md ground rules and §1.4). Needs migration za.
// Two local servers on the test database: LIVE_ENABLED unset (production today) and LIVE_ENABLED=true.
//   off  /config says live_enabled false; creating a live show 400; the host can't open a lot, a buyer can't bid,
//        live pre-bids are refused, the video token is 404 - and nothing is written
//   on   a live show is created with buyers_premium_pct 0; a premium can't be set (400), and the database forces 0
//        even on a direct write; bulk lots with a reserve are refused, the rest wait as 'pending' with no clock; a
//        reserve written straight to a live lot is dropped; a timed auction still gets its 15% default
require('./guard')(__filename);
const K = require('./live-kit')('flag');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, client, ask, call, sleep, boot, BE } = K;
process.chdir(BE);

(async () => {
  const probe = await s.from('auction_items').select('extend_by_seconds').limit(1);
  if (probe.error) { console.log('auction_items.extend_by_seconds is missing: apply migration za (2026-10-15za-live-bidding.sql) first.'); process.exit(2); }
  const servers = [];
  try {
    const src = require('./guard').readSource(BE + '/server.js');
    const off = await boot('live-flag-off', 3601, src, { env: { LIVE_ENABLED: '' } });
    const on = await boot('live-flag-on', 3602, src, { env: { LIVE_ENABLED: 'true' } });
    servers.push(off, on);
    const B = await mkUser('b');

    console.log('== LIVE_ENABLED unset (production today) ==');
    let r = await call(off.url, 'GET', '/config');
    ok(r.s === 200 && r.j.live_enabled === false, `/config live_enabled: ${r.j && r.j.live_enabled}`);
    r = await call(off.url, 'POST', '/auction', ADMIN, { title: K.P + ' create-off ' + K.TAG, starting_bid: 0, mode: 'live', fulfillment_mode: 'shipping' });
    ok(r.s === 400, `POST /auction mode live -> ${r.s} ${r.j && r.j.error}`);
    const show = await mkShow('off', { lots: 2 });
    await terms(B, show.id);
    const host = await client(off.url, show.id, ADMIN);
    const buyer = await client(off.url, show.id, B);
    let e = await ask(host, 'next_item', { timerSeconds: 30 }, ['host_error', 'item_activated']);
    ok(e && e.event === 'host_error' && e.payload.code === 'live_off', `host next_item -> ${e && e.event} ${JSON.stringify(e && e.payload)}`);
    e = await ask(buyer, 'place_bid', { max_amount: 5 }, ['bid_error', 'bid_ok']);
    ok(e && e.event === 'bid_error' && e.payload.code === 'live_off', `buyer place_bid -> ${e && e.event} ${JSON.stringify(e && e.payload)}`);
    for (const ev of ['start_auction', 'end_auction', 'extend_auction']) {
      e = await ask(host, ev, { extraSeconds: 15 }, ['host_error', 'auction_started', 'auction_ended', 'item_extended']);
      ok(e && e.event === 'host_error' && e.payload.code === 'live_off', `host ${ev} -> ${e && e.event} ${e && e.payload.code}`);
    }
    r = await call(off.url, 'POST', `/auction/${show.id}/items/${show.lots[0]}/prebid`, B, { max_amount: 12 });
    ok(r.s === 400 && r.j.code === 'live_off', `live pre-bid -> ${r.s} ${r.j && r.j.code}`);
    r = await call(off.url, 'GET', `/auction/${show.id}/token`, B);
    ok(r.s === 404, `video token -> ${r.s}`);
    const l0 = await K.lot(show.lots[0]);
    const writes = (await s.from('bids').select('id').eq('auction_id', show.id)).data.length + (await s.from('pre_bids').select('id').eq('auction_id', show.id)).data.length;
    ok(l0.status === 'pending' && writes === 0 && (await s.from('auctions').select('status').eq('id', show.id).single()).data.status === 'live', `nothing written: lot '${l0.status}', ${writes} bids/pre-bids, show still on air`);
    host.close(); buyer.close();

    console.log('\n== LIVE_ENABLED=true ==');
    r = await call(on.url, 'GET', '/config');
    ok(r.s === 200 && r.j.live_enabled === true, `/config live_enabled: ${r.j && r.j.live_enabled}`);
    // A live show needs a start time (phase 2a: the host sets it; it stays scheduled until Go live).
    r = await call(on.url, 'POST', '/auction', ADMIN, { title: K.P + ' create-nostart ' + K.TAG, starting_bid: 0, mode: 'live', fulfillment_mode: 'shipping' });
    ok(r.s === 400 && /start time/.test(r.j && r.j.error), `POST /auction mode live with no start time -> ${r.s} ${r.j && r.j.error}`);
    r = await call(on.url, 'POST', '/auction', ADMIN, { title: K.P + ' create-on ' + K.TAG, starting_bid: 0, mode: 'live', fulfillment_mode: 'shipping', starts_at: new Date(Date.now() + 3600e3).toISOString() });
    const created = r.j;
    if (created?.id) K.made.auctions.push(created.id);
    ok(r.s === 201 && created.mode === 'live' && Number(created.buyers_premium_pct) === 0 && created.status === 'draft', `POST /auction mode live -> ${r.s}, mode ${created && created.mode}, premium ${created && created.buyers_premium_pct}%, ${created && created.status}`);
    r = await call(on.url, 'PATCH', `/auction/${created.id}`, ADMIN, { buyers_premium_pct: 15 });
    ok(r.s === 400 && /premium/i.test(r.j.error), `PATCH premium 15% on a live show -> ${r.s} ${r.j && r.j.error}`);
    r = await call(on.url, 'PATCH', `/auction/${created.id}`, ADMIN, { buyers_premium_pct: 0, description: 'story' });
    ok(r.s === 200 && Number(r.j.buyers_premium_pct) === 0, `PATCH premium 0 + description -> ${r.s}`);
    await s.from('auctions').update({ buyers_premium_pct: 20 }).eq('id', created.id);
    const pct = (await s.from('auctions').select('buyers_premium_pct').eq('id', created.id).single()).data.buyers_premium_pct;
    ok(Number(pct) === 0, `a direct database write of 20% on a live show is stored as ${pct}% (trigger)`);
    r = await call(on.url, 'POST', `/auction/${created.id}/items/bulk`, ADMIN, { lots: [{ title: K.P + ' with reserve', reserve_price: 50 }, { title: K.P + ' plain', ends_at: new Date(Date.now() + 3600e3).toISOString() }] });
    const lots = (await s.from('auction_items').select('title, status, ends_at, reserve_price').eq('auction_id', created.id)).data;
    ok(r.j.created_count === 1 && r.j.failed_count === 1 && /reserve/i.test(r.j.failed[0].error), `bulk: the lot with a reserve refused ("${r.j.failed && r.j.failed[0] && r.j.failed[0].error}"), the other created`);
    ok(lots.length === 1 && lots[0].status === 'pending' && lots[0].ends_at === null && lots[0].reserve_price === null, `the live lot waits: '${lots[0] && lots[0].status}', no clock, no reserve`);
    const direct = die(await s.from('auction_items').insert({ auction_id: created.id, title: K.P + ' direct', starting_bid: 0, position: 5, status: 'pending', reserve_price: 99 }).select().single());
    ok(direct.reserve_price === null, `a reserve written straight to a live lot is stored as ${direct.reserve_price} (trigger)`);
    r = await call(on.url, 'POST', '/auction', ADMIN, { title: K.P + ' timed ' + K.TAG, starting_bid: 0, mode: 'standard', fulfillment_mode: 'shipping' });
    if (r.j?.id) K.made.auctions.push(r.j.id);
    ok(r.s === 201 && r.j.mode === 'standard' && Number(r.j.buyers_premium_pct) === 15, `a timed auction still gets its premium: ${r.j && r.j.buyers_premium_pct}%`);
    r = await call(on.url, 'GET', `/auction/${show.id}/token`, B);
    ok(r.s === 200 || r.s === 503, `video token with live on -> ${r.s} (200, or 503 when this machine has no LiveKit keys)`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
  }
  K.finish();
})();
