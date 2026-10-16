// Live shows phase 1b (G1, LIVE_SHOWS_PHASE0_AUDIT.md §1.5-1.6 + pre-bid expiry; review answers 4 and 5).
// Needs migrations z, za and zb. Local servers on the test database with LIVE_ENABLED=true and POINTS_ENABLED=true.
// Stripe is an in-process FAKE (the card pm_ZZLIVE_bad always declines; every amount recorded); Resend writes to a
// file. Nothing is charged or sent. points_settings.enabled is switched on and put back as it was.
//   decline    the buyer is told in the room and can't bid (socket or pre-bid) in that show; the host gets an alert
//              on the lot; their pre-bid on a later lot doesn't count; a new verified card charges the lot at once
//              and clears both alerts
//   end        End is refused while a lot is open; Pass closes it with no sale
//   one box    every lot a buyer wins in a show is in one order group
//   summary    after the show, ONE "your show wins" email per buyer (lots, declined ones marked, one box); never twice
//   re-offer   only after the show, only an unpaid lot: to a timed auction (open until its end, photos copied) or a
//              later live show (waiting); the order is cancelled and leaves the box; a points reward spent on it comes
//              back; the admin's count of failed live payments per buyer
//   expiry     a show not on air 24 h after its start releases its pre-bids: deleted, one email per bidder, an outbox
//              row each, once; pre-bidding then closed. Controls: 23 h, and a show that went on air
//   my orders  a live lot's own discount line
require('./guard')(__filename);
const fs = require('fs');
const K = require('./live-kit')('after');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, prebid, client, ask, call, sleep, boot, BE, dbAt } = K;
process.chdir(BE);
const MAIL = BE + '/run.tmp-live-after-mail.log', CALLS = BE + '/run.tmp-live-after-stripe.log';

const FAKE_STRIPE = `const stripe = {
  paymentIntents: {
    create: async (p) => {
      await new Promise(r => setTimeout(r, 300));
      if (p.payment_method === 'pm_ZZLIVE_bad') { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; throw e; }
      const id = 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12);
      require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ id, amount: p.amount, md: p.metadata || {}, capture: p.capture_method || null }) + '\\n');
      return { id };
    },
    cancel: async () => ({}),
    retrieve: async () => ({}),
  },
  paymentMethods: { attach: async () => ({}), retrieve: async () => ({ card: { last4: '4242' } }) },
  customers: { update: async () => ({}) },
  setupIntents: { create: async () => ({ client_secret: 'zz' }) },
};`;
const STUBS = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com')) {
    const b = JSON.parse(opts.body || '{}');
    require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject, html: b.html }) + '\\n');
    return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
  }
  return realFetch(url, opts);
};`;
const TEST_ROUTES = `app.post('/__test/live-housekeeping', async (req, res) => res.json(await releaseExpiredPrebids(new Date(Date.now() + Number(req.query.ahead_ms || 0)))));
app.post('/__test/live-summaries/:id', async (req, res) => res.json({ sent: await sendLiveShowSummaries(req.params.id) }));
const PORT = process.env.PORT || 3001;`;
const PATCH = [
  ['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;', FAKE_STRIPE],
  ['const PORT = process.env.PORT || 3001;', TEST_ROUTES],
];
const ENV = { LIVE_ENABLED: 'true', POINTS_ENABLED: 'true', RESEND_API_KEY: 're_zztest_stub', ADMIN_EMAIL: 'admin@example.invalid' };
const lines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const mailsTo = u => lines(MAIL).filter(m => [].concat(m.to).includes(`${u.username}@example.invalid`));
const charges = () => lines(CALLS).filter(c => !c.capture);   // not the $1 card checks

(async () => {
  for (const [t, c] of [['auction_items', 'extend_by_seconds'], ['auctions', 'on_air_at'], ['points_ledger', 'id']]) {
    if ((await s.from(t).select(c).limit(1)).error) { console.log('Apply migrations z, za and zb first.'); process.exit(2); }
  }
  const before = die(await s.from('points_settings').select('*').eq('id', 1).single());
  for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
  const servers = [];
  try {
    await K.syncClock();
    die(await s.from('points_settings').update({ enabled: true }).eq('id', 1).select());
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('live-after', 3641, src, { env: ENV, preload: STUBS, patch: PATCH, timers: 'real' });
    servers.push(srv);
    await sleep(1500);

    const D = await mkUser('d', { pm: 'pm_ZZLIVE_bad' }), E = await mkUser('e', { pm: 'pm_ZZLIVE_bad' }), F = await mkUser('f', { pm: 'pm_ZZLIVE_bad' });
    const W = await mkUser('w'), P = await mkUser('p');
    const prices = [7, 10, 40, 12, 9, 40, 5, 6];
    const show = await mkShow('main', { lots: prices.length });
    for (let i = 0; i < prices.length; i++) die(await s.from('auction_items').update({ starting_bid: prices[i] }).eq('id', show.lots[i]).select());
    const [L1, L2, L3, L4, L5, L6, L7, L8] = show.lots;
    die(await s.from('item_images').insert({ item_id: L3, url: 'https://example.invalid/zz-l3-2.jpg', position: 1 }).select());
    for (const u of [D, E, F, W, P]) await terms(u, show.id);
    die(await s.from('points_ledger').insert([{ user_id: E.id, kind: 'adjust', points: 300, note: 'zztest' }, { user_id: P.id, kind: 'adjust', points: 300, note: 'zztest' }]).select());
    await prebid(E, show.id, L8, 30);   // made before the show

    const host = await client(srv.url, show.id, ADMIN);
    const anon = await client(srv.url, show.id);
    const so = {};
    for (const [k, u] of Object.entries({ D, E, F, W, P })) so[k] = await client(srv.url, show.id, u);
    async function sell(lotId, key, price) {
      const from = anon.mark();
      const e = await ask(host, 'next_item', { timerSeconds: 5 }, ['item_activated', 'host_error']);
      if (!e || e.event !== 'item_activated') throw new Error('could not open lot: ' + JSON.stringify(e && e.payload));
      if (key) { const b = await ask(so[key], 'place_bid', { itemId: lotId, max_amount: price }, ['bid_ok', 'bid_error']); if (b?.event !== 'bid_ok') throw new Error('bid refused: ' + JSON.stringify(b && b.payload)); }
      return anon.waitFor('lot_closed', p => p.item_id === lotId, 15000, from);
    }
    const orderOf = async lotId => (await s.from('orders').select('*').eq('item_id', lotId)).data[0];
    const settle = async (lotId, ms = 6000) => { const end = Date.now() + ms; let o; while (Date.now() < end) { o = await orderOf(lotId); if (o && !['unpaid', 'charging'].includes(o.payment_status)) return o; await sleep(200); } return o; };

    console.log('== Declined card mid-show ==');
    const fromD = so.D.mark(), fromH = host.mark();
    await sell(L1, 'D', 7);
    const o1 = await settle(L1);
    const pf = await so.D.waitFor('payment_failed', p => p.item_id === L1, 4000, fromD);
    const hf = await host.waitFor('lot_payment_failed', p => p.item_id === L1, 4000, fromH);
    ok(o1?.payment_status === 'failed' && pf && /Update your card/.test(pf.payload.message), `the buyer is told in the room: "${pf && pf.payload.message}"`);
    ok(hf && hf.payload.buyer === D.username && hf.payload.order_id === o1.id, 'the host gets an alert on that lot (with the buyer)');
    ok(!so.W.events.slice(0).some(e => e.event === 'payment_failed' || e.event === 'lot_payment_failed'), 'other buyers hear nothing about it');
    await ask(host, 'next_item', { timerSeconds: 5 }, ['item_activated']);
    let e = await ask(so.D, 'place_bid', { itemId: L2, max_amount: 50 }, ['bid_ok', 'bid_error']);
    ok(e && e.event === 'bid_error' && e.payload.code === 'payment_failed', `D bids again in the show -> ${e && e.payload.code}`);
    let r = await call(srv.url, 'POST', `/auction/${show.id}/items/${L8}/prebid`, D, { max_amount: 20 });
    ok(r.s === 403 && r.j.code === 'payment_failed', `D pre-bids on a later lot -> ${r.s} ${r.j && r.j.code}`);
    await ask(so.W, 'place_bid', { itemId: L2, max_amount: 10 }, ['bid_ok']);
    const fromH2 = host.mark(), fromD2 = so.D.mark();
    r = await call(srv.url, 'POST', '/save-payment-method', D, { payment_method_id: 'pm_ZZLIVE_good' });
    const fixed = await so.D.waitFor('payment_ok', p => p.item_id === L1, 6000, fromD2);
    const hfix = await host.waitFor('lot_payment_fixed', p => p.item_id === L1, 3000, fromH2);
    const o1b = await orderOf(L1);
    ok(r.s === 200 && r.j.card_verified === true && o1b.payment_status === 'paid' && charges().some(c => c.md.order_id === o1.id && c.amount === 700),
      `D saves a new card: verified, the lot is charged $7 at once (${o1b.payment_status})`);
    ok(fixed && hfix, 'the buyer hears "you can bid again" and the host\'s alert clears');
    await anon.waitFor('lot_closed', p => p.item_id === L2, 10000);

    console.log('\n== More lots: a box, more declines, points ==');
    await sell(L3, 'E', 40);   // E has 300 points: a $25 reward, then the card declines
    await sell(L4, 'W', 12);
    await sell(L5, 'F', 9);
    await sell(L6, 'P', 40);
    const [o2, o3, o4, o5, o6] = [await settle(L2), await settle(L3), await settle(L4), await settle(L5), await settle(L6)];
    ok(o2.group_id && o2.group_id === o4.group_id && o3.group_id && o3.group_id !== o2.group_id, `one box per buyer per show: W's two lots share a group; E's is its own`);
    ok(o3.payment_status === 'failed' && o3.discount_kind === 'points_reward' && o3.total_cents === 1500 && o5.payment_status === 'failed', "E's $40 lot: $25 reward decided, card declined; F declined too");

    console.log('\n== A blocked buyer\'s pre-bid; End while a lot is open; Pass ==');
    let from = anon.mark();
    await ask(host, 'next_item', { timerSeconds: 30 }, ['item_activated']);
    await ask(so.W, 'place_bid', { itemId: L7, max_amount: 5 }, ['bid_ok']);
    e = await ask(host, 'end_auction', {}, ['auction_ended', 'host_error']);
    ok(e && e.event === 'host_error' && e.payload.code === 'lot_open', `End with a lot open -> ${e && e.payload.message}`);
    e = await ask(host, 'pass_lot', {}, ['host_error', 'lot_closed']);
    const p7 = await anon.waitFor('lot_closed', p => p.item_id === L7, 3000, from);
    ok(p7 && p7.payload.status === 'unsold' && p7.payload.passed && !(await orderOf(L7)), 'Pass: lot 7 unsold with a bid on it, no order');
    from = anon.mark();
    const act8 = await ask(host, 'next_item', { timerSeconds: 5 }, ['item_activated']);
    const l8 = await K.lot(L8);
    ok(act8 && l8.leading_bidder === null && l8.pre_bid_count === 0 && !(await s.from('pre_bids').select('id').eq('item_id', L8)).data.length,
      "E's pre-bid from before the show doesn't count once E's card declined (lot 8 opens with no leader)");
    await anon.waitFor('lot_closed', p => p.item_id === L8, 10000, from);

    console.log('\n== Re-offer: not before the show ends ==');
    const timed = await K.mkStandard('reoffer-timed', { status: 'upcoming', fields: { ends_at: dbAt(48 * 3600e3) } });
    const later = await mkShow('later', { status: 'upcoming', lots: 0 });
    let un = await call(srv.url, 'GET', `/admin/live/${show.id}/unpaid`, ADMIN);
    ok(un.s === 200 && un.j.can_reoffer === false && un.j.lots.length === 2, `the host's unpaid list during the show: ${un.j.lots && un.j.lots.length} lots, can't re-offer yet`);
    r = await call(srv.url, 'POST', `/admin/live/orders/${o3.id}/reoffer`, ADMIN, { auction_id: timed });
    ok(r.s === 400 && /until the end of the show/.test(r.j.error), `re-offer during the show -> ${r.s} ${r.j && r.j.error}`);
    r = await call(srv.url, 'POST', `/admin/live/orders/${o3.id}/reoffer`, E, { auction_id: timed });
    ok(r.s === 403, `a buyer can't re-offer -> ${r.s}`);

    console.log('\n== End the show: one summary email per buyer ==');
    const mailsBefore = lines(MAIL).length;
    e = await ask(host, 'end_auction', {}, ['auction_ended', 'host_error']);
    ok(e && e.event === 'auction_ended', 'End with no lot open: the show ends');
    const wins = () => lines(MAIL).filter(m => /Your wins from/.test(m.subject)).length;
    for (let i = 0; i < 40 && wins() < 5; i++) await sleep(250);   // sent one after another
    const wMail = mailsTo(W).filter(m => /Your wins from/.test(m.subject));
    const eMail = mailsTo(E).filter(m => /Your wins from/.test(m.subject)), dMail = mailsTo(D).filter(m => /Your wins from/.test(m.subject));
    ok(wMail.length === 1 && /2 lots/.test(wMail[0].html) && /ships together in one box/.test(wMail[0].html) && /\$22\.00/.test(wMail[0].html) && !/declined/i.test(wMail[0].html),
      "W: one email, 2 lots, $22.00 charged, one box");
    ok(eMail.length === 1 && /Card declined/.test(eMail[0].html) && /Points reward/.test(eMail[0].html), 'E: the lot marked "Card declined", the reward line shown');
    ok(dMail.length === 1 && /Paid/.test(dMail[0].html) && !mailsTo(D).some(m => /You won it/.test(m.subject)), 'D: Paid, and no per-lot win email');
    r = await call(srv.url, 'POST', `/__test/live-summaries/${show.id}`);
    await sleep(500);
    ok(r.j.sent === false && lines(MAIL).filter(m => /Your wins from/.test(m.subject)).length === 5 && lines(MAIL).length >= mailsBefore + 5, 'asked again: nothing sent twice (5 buyers, 5 emails)');

    console.log('\n== Re-offer after the show ==');
    un = await call(srv.url, 'GET', `/admin/live/${show.id}/unpaid`, ADMIN);
    ok(un.j.can_reoffer === true && un.j.lots.map(l => l.item_id).sort().join() === [L3, L5].sort().join(), 'after the show: lots 3 and 5 can be re-offered');
    r = await call(srv.url, 'POST', `/admin/live/orders/${o3.id}/reoffer`, ADMIN, { auction_id: timed });
    const n3 = r.j && r.j.item_id ? await K.lot(r.j.item_id) : null;
    const imgs = n3 ? (await s.from('item_images').select('url').eq('item_id', n3.id)).data : [];
    const t = (await s.from('auctions').select('ends_at').eq('id', timed).single()).data;
    const o3b = await orderOf(L3);
    const ledE = (await s.from('points_ledger').select('kind, points, order_id').eq('user_id', E.id)).data;
    ok(r.s === 200 && n3 && n3.status === 'open' && n3.auction_id === timed && Date.parse(n3.ends_at) === Date.parse(t.ends_at) && n3.title === (await K.lot(L3)).title && imgs.length === 1,
      'to a timed auction: a copy of the lot, open until that auction ends, photos copied');
    ok(o3b.payment_status === 'cancelled' && o3b.group_id === null && (await K.lot(L3)).status === 'unsold', "E's order cancelled (kept), out of the box; the show's lot marked unsold");
    ok(ledE.some(x => x.kind === 'adjust' && x.points === 250 && x.order_id === o3.id) && ledE.reduce((a, x) => a + x.points, 0) === 300, "E's 250 points spent on it came back (balance 300)");
    r = await call(srv.url, 'POST', `/admin/live/orders/${o3.id}/reoffer`, ADMIN, { auction_id: timed });
    ok(r.s === 400, `re-offer the same lot again -> ${r.s} ${r.j && r.j.error}`);
    r = await call(srv.url, 'POST', `/admin/live/orders/${o5.id}/reoffer`, ADMIN, { auction_id: show.id });
    ok(r.s === 400, `re-offer into the show it came from -> ${r.s}`);
    r = await call(srv.url, 'POST', `/admin/live/orders/${o5.id}/reoffer`, ADMIN, { auction_id: later.id });
    const n5 = r.j && r.j.item_id ? await K.lot(r.j.item_id) : null;
    ok(r.s === 200 && n5 && n5.status === 'pending' && n5.ends_at === null && n5.auction_id === later.id, 'to a later live show: waiting to be offered');
    r = await call(srv.url, 'POST', '/save-payment-method', E, { payment_method_id: 'pm_ZZLIVE_good2' });
    await sleep(1500);
    ok((await orderOf(L3)).payment_status === 'cancelled' && !charges().some(c => c.md.order_id === o3.id), 'E fixing the card after the re-offer charges nothing for it');
    const fp = await call(srv.url, 'GET', '/admin/live/failed-payments', ADMIN);
    const row = u => (fp.j || []).find(x => x.username === u.username);
    ok(fp.s === 200 && row(E)?.reoffered === 1 && row(F)?.reoffered === 1 && !row(D) && !row(W), `failed live payments per buyer: E ${JSON.stringify(row(E))}, D (fixed) not listed`);
    ok((await call(srv.url, 'GET', '/admin/live/failed-payments', W)).s === 403, 'buyers get 403');

    console.log('\n== My Orders: a live lot\'s discount line ==');
    const mine = (await call(srv.url, 'GET', '/my-orders', P)).j.find(o => o.item_title.includes('lot 6'));
    ok(mine && mine.discount && mine.discount.kind === 'points_reward' && mine.discount.cents === 2500 && mine.total_cents === 1500 && mine.invoice === null, `P's $40 lot: discount ${JSON.stringify(mine && mine.discount)}, total $${mine && mine.total_cents / 100}`);

    for (const c of [host, anon, ...Object.values(so)]) c.close();

    console.log('\n== Pre-bid expiry (24 h) ==');
    const A = await mkUser('a'), B = await mkUser('b');
    const late = await mkShow('late', { status: 'upcoming', lots: 2, fields: { starts_at: dbAt(-25 * 3600e3) } });
    const recent = await mkShow('recent', { status: 'upcoming', lots: 1, fields: { starts_at: dbAt(-23 * 3600e3) } });
    const aired = await mkShow('aired', { status: 'live', lots: 1, fields: { starts_at: dbAt(-25 * 3600e3), on_air_at: dbAt(-25 * 3600e3) } });
    await prebid(A, late.id, late.lots[0], 12); await prebid(A, late.id, late.lots[1], 14); await prebid(B, late.id, late.lots[0], 11);
    await prebid(A, recent.id, recent.lots[0], 9); await prebid(A, aired.id, aired.lots[0], 9);
    die(await s.from('auction_items').update({ pre_bid_count: 2, top_pre_bid: 12 }).eq('id', late.lots[0]).select());
    r = await call(srv.url, 'POST', '/__test/live-housekeeping');
    const leftLate = (await s.from('pre_bids').select('id').eq('auction_id', late.id)).data.length;
    const l0 = await K.lot(late.lots[0]);
    const aMail = mailsTo(A).filter(m => /were released/.test(m.subject)), bMail = mailsTo(B).filter(m => /were released/.test(m.subject));
    const notes = (await s.from('notifications').select('user_id, kind, payload, sent_at').in('user_id', [A.id, B.id])).data;
    ok(r.j.shows >= 1 && leftLate === 0 && l0.pre_bid_count === 0 && l0.top_pre_bid === null, 'a show 25 h past its start and never on air: its 3 pre-bids deleted, the lot counts reset');
    ok(aMail.length === 1 && /Lot 1/.test(aMail[0].html) && /Lot 2/.test(aMail[0].html) && bMail.length === 1, 'one email per bidder listing their lots (A: lots 1 and 2; B: lot 1)');
    ok(notes.filter(n => n.kind === 'prebid_released' && n.sent_at && n.payload.auction_id === late.id).length === 2, 'an outbox row per bidder (kind prebid_released, sent) is the record');
    ok((await s.from('pre_bids').select('id').eq('auction_id', recent.id)).data.length === 1 && (await s.from('pre_bids').select('id').eq('auction_id', aired.id)).data.length === 1,
      'controls: 23 h past its start, and a show that went on air: pre-bids kept');
    r = await call(srv.url, 'POST', '/__test/live-housekeeping');
    ok(mailsTo(A).filter(m => /were released/.test(m.subject)).length === 1, 'run again: nothing sent twice');
    r = await call(srv.url, 'POST', `/auction/${late.id}/items/${late.lots[0]}/prebid`, A, { max_amount: 20 });
    ok(r.s === 400 && r.j.code === 'prebids_released', `pre-bidding on that show is closed -> ${r.s} ${r.j && r.j.code}`);
    await s.from('notifications').delete().in('user_id', [A.id, B.id]);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await s.from('points_settings').update({ enabled: before.enabled }).eq('id', 1);
    await s.from('email_send_log').delete().gte('sent_at', new Date(Date.now() - 30 * 60e3).toISOString()).in('kind', ['won', 'failed', 'admin', 'prebid_released']);
    await K.cleanup();
    for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
    if ((await s.from('points_settings').select('enabled').eq('id', 1).single()).data?.enabled !== before.enabled) { console.log('points_settings.enabled NOT restored'); K.state.fails++; }
  }
  K.finish();
})();
