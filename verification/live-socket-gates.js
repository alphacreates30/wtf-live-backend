// Who may bid (G1 phase 1, LIVE_SHOWS_BRIEF.md §1.3; LIVE_SHOWS_PHASE0_REVIEW.md question 2). Needs migration za.
// Live socket bids get the same gates as the REST bid, and two gates now apply EVERYWHERE (timed lots too):
// a VERIFIED card (the $1 check passed, not just a saved card) and the host/admin account can never bid.
//   socket   not logged in, no profile, pending, blocked, no card, unverified card, no terms for this show, the
//            host, show not on air, a bad amount: each refused with its code, and nothing is written
//   REST     an unverified card is refused on a timed bid, a pre-bid and the terms step; the admin is refused on a
//            timed bid and pre-bid (OLD = pinned 93db3d7 took both); a verified buyer still bids
require('./guard')(__filename);
const K = require('./live-kit')('gates');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, client, ask, call, sleep, boot, BE } = K;
process.chdir(BE);
const OLD_COMMIT = '93db3d7';

(async () => {
  const probe = await s.from('auction_items').select('extend_by_seconds').limit(1);
  if (probe.error) { console.log('auction_items.extend_by_seconds is missing: apply migration za (2026-10-15za-live-bidding.sql) first.'); process.exit(2); }
  const servers = [];
  try {
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('live-gates', 3621, src, { env: { LIVE_ENABLED: 'true' } });
    servers.push(srv);
    const good = await mkUser('good'), pending = await mkUser('pend', { status: 'pending' }), blocked = await mkUser('blk', { status: 'blocked' });
    const nocard = await mkUser('nocard', { card: false }), unver = await mkUser('unver', { verified: false }), noterms = await mkUser('noterms');
    const noprof = await mkUser('noprof', { profile: false });
    const show = await mkShow('gates', { lots: 1 });
    const offAir = await mkShow('offair', { lots: 1, status: 'upcoming' });
    for (const u of [good, pending, blocked, nocard, unver, noprof]) { await terms(u, show.id); await terms(u, offAir.id); }

    const host = await client(srv.url, show.id, ADMIN);
    const e0 = await ask(host, 'next_item', { timerSeconds: 120 }, ['item_activated', 'host_error']);
    ok(e0 && e0.event === 'item_activated', 'the host opens the lot');
    const L = show.lots[0];
    const snapshot = async () => { const l = await K.lot(L); const pb = (await s.from('pre_bids').select('id').eq('item_id', L)).data.length; return `${l.bid_count}/${l.current_bid}/${l.leading_bidder}/${pb}`; };
    const start = await snapshot();

    console.log('== Socket bids that must be refused ==');
    // join_auction already refuses pending/blocked/no-profile accounts, so those bid from an anonymous socket
    // (the bid carries its own token and is checked on its own).
    const anon = await client(srv.url, show.id);
    const cases = [
      ['not logged in', anon, { max_amount: 5, token: 'not-a-token' }, 'login_required'],
      ['no profile', anon, { max_amount: 5, token: noprof.tok }, 'no_profile'],
      ['pending approval', anon, { max_amount: 5, token: pending.tok }, 'not_approved'],
      ['blocked', anon, { max_amount: 5, token: blocked.tok }, 'blocked'],
      ['no card', anon, { max_amount: 5, token: nocard.tok }, 'no_card'],
      ['card saved but not verified', anon, { max_amount: 5, token: unver.tok }, 'card_not_verified'],
      ['no terms for this show', anon, { max_amount: 5, token: noterms.tok }, 'terms_required'],
      ['the host', anon, { max_amount: 5, token: ADMIN.tok }, 'host_cannot_bid'],
      ['an amount of $0.50', anon, { max_amount: 0.5, token: good.tok }, 'bad_amount'],
      ['an amount of "lots"', anon, { max_amount: 'lots', token: good.tok }, 'bad_amount'],
    ];
    for (const [label, c, payload, code] of cases) {
      const e = await ask(c, 'place_bid', payload, ['bid_error', 'bid_ok']);
      ok(e && e.event === 'bid_error' && e.payload.code === code, `${label} -> ${e ? e.event + ' ' + e.payload.code + ' "' + e.payload.message + '"' : 'no answer'}`);
    }
    const offSock = await client(srv.url, offAir.id, good);
    let e = await ask(offSock, 'place_bid', { max_amount: 5 }, ['bid_error', 'bid_ok']);
    ok(e && e.event === 'bid_error' && e.payload.code === 'not_on_air', `show not on air -> ${e && e.payload.code}`);
    ok((await snapshot()) === start, `nothing written by any refused bid (bids/price/leader/maxes ${start})`);

    console.log('\n== A buyer who passes every gate ==');
    const gs = await client(srv.url, show.id, good);
    e = await ask(gs, 'place_bid', { max_amount: 5 }, ['bid_error', 'bid_ok']);
    const l = await K.lot(L);
    ok(e && e.event === 'bid_ok' && l.leading_bidder === good.username && Number(l.current_bid) === 1, `approved, verified card, terms accepted: bid taken (leads at $${l.current_bid})`);
    for (const c of [host, anon, offSock, gs]) c.close();

    console.log('\n== Timed auctions: verified card and no host bids (REST) ==');
    const timedRun = async (label, url) => {
      const a = await K.mkStandard('timed-' + label);
      const open = die(await s.from('auction_items').insert({ auction_id: a, title: K.P + ' timed open', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: new Date(Date.now() + 3600e3).toISOString() }).select().single()).id;
      const pend = die(await s.from('auction_items').insert({ auction_id: a, title: K.P + ' timed pending', starting_bid: 0, position: 1, status: 'pending' }).select().single()).id;
      await terms(unver, a, 15); await terms(good, a, 15);
      const adminTerms = await call(url, 'POST', `/auction/${a}/terms-acceptance`, ADMIN, {});
      return {
        unverBid: await call(url, 'POST', `/auction/${a}/items/${open}/bid`, unver, { max_amount: 5 }),
        unverPre: await call(url, 'POST', `/auction/${a}/items/${pend}/prebid`, unver, { max_amount: 5 }),
        unverTerms: await call(url, 'POST', `/auction/${show.id}/terms-acceptance`, unver, {}),
        adminTerms,
        adminBid: await call(url, 'POST', `/auction/${a}/items/${open}/bid`, ADMIN, { max_amount: 7 }),
        adminPre: await call(url, 'POST', `/auction/${a}/items/${pend}/prebid`, ADMIN, { max_amount: 7 }),
        goodBid: await call(url, 'POST', `/auction/${a}/items/${open}/bid`, good, { max_amount: 9 }),
        lot: await K.lot(open),
      };
    };
    const oldSrv = await boot('live-gates-old', 3622, require('./guard').sourceAt(OLD_COMMIT, BE));
    servers.push(oldSrv);
    const o = await timedRun('old', oldSrv.url);
    oldSrv.stop();
    ok(o.unverBid.s === 200 && o.adminBid.s === 200, `OLD ${OLD_COMMIT}: unverified card bid -> ${o.unverBid.s}, admin bid -> ${o.adminBid.s}  <- BOTH TAKEN`);
    const n = await timedRun('new', srv.url);
    ok(n.unverBid.s === 403 && n.unverBid.j.code === 'card_not_verified', `NEW: unverified card, timed bid -> ${n.unverBid.s} ${n.unverBid.j && n.unverBid.j.code}`);
    ok(n.unverPre.s === 403 && n.unverPre.j.code === 'card_not_verified', `NEW: unverified card, pre-bid -> ${n.unverPre.s} ${n.unverPre.j && n.unverPre.j.code}`);
    ok(n.unverTerms.s === 403 && n.unverTerms.j.code === 'card_not_verified', `NEW: unverified card, accept terms -> ${n.unverTerms.s} ${n.unverTerms.j && n.unverTerms.j.code}`);
    ok(n.adminBid.s === 403 && n.adminBid.j.code === 'host_cannot_bid', `NEW: admin timed bid -> ${n.adminBid.s} ${n.adminBid.j && n.adminBid.j.code}`);
    ok(n.adminPre.s === 403 && n.adminPre.j.code === 'host_cannot_bid', `NEW: admin pre-bid -> ${n.adminPre.s} ${n.adminPre.j && n.adminPre.j.code}`);
    ok(n.adminTerms.s === 403 && n.adminTerms.j.code === 'host_cannot_bid', `NEW: admin accept terms -> ${n.adminTerms.s}`);
    ok(n.goodBid.s === 200 && n.lot.leading_bidder === good.username && n.lot.bid_count === 1, `NEW: a verified buyer's timed bid -> ${n.goodBid.s}, the only bid on the lot`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
  }
  K.finish();
})();
