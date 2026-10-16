// Charge at the hammer (G1 phase 1, LIVE_SHOWS_BRIEF.md §1.4; review answers 1 and 3). Needs migrations z and za.
// Local servers on the test database with LIVE_ENABLED=true and POINTS_ENABLED=true. Stripe is an in-process FAKE
// that takes 800 ms per charge and records every amount (one customer always declines); Resend is a stub that
// writes to a file. Nothing is charged or sent. points_settings.enabled is switched on and put back as it was.
//   hammer     the lot closes, ONE order (the lot's id, no premium), and the room hears it BEFORE Stripe answers:
//              the charge is off the host's path; the amount sent to Stripe is the winning bid
//   emails     no per-lot win email in a live show; a declined card: the buyer's decline email (no premium row) and
//              the admin's, at once
//   closers    two servers watching the same lot: one order, one charge
//   points     G2 per lot through discountsForCharge: a 300-point buyer's $40 lot is charged $15 (one $25 reward);
//              a $10 lot with a reward is $0, paid with no Stripe call; a show's 20% code covers every lot that
//              buyer wins in it; points earned on what was paid for
//   recovery   a sold live lot left without an order, and a live order never charged, are finished at boot
require('./guard')(__filename);
const fs = require('fs');
const K = require('./live-kit')('hammer');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, client, ask, sleep, boot, BE, dbAt } = K;
process.chdir(BE);
const MAIL = BE + '/run.tmp-live-hammer-mail.log', CALLS = BE + '/run.tmp-live-hammer-stripe.log';

const FAKE_STRIPE = `const stripe = {
  paymentIntents: {
    create: async (p) => {
      const t0 = Date.now();
      await new Promise(r => setTimeout(r, 800));
      if (p.customer === 'cus_ZZLIVE_decl') { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; throw e; }
      const id = 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12);
      require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ id, amount: p.amount, customer: p.customer, md: p.metadata || {}, t0, t1: Date.now() }) + '\\n');
      return { id };
    },
    retrieve: async () => ({}),
    cancel: async () => ({}),
  },
  paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) },
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
const PATCH = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;', FAKE_STRIPE]];
const ENV = { LIVE_ENABLED: 'true', POINTS_ENABLED: 'true', RESEND_API_KEY: 're_zztest_stub', ADMIN_EMAIL: 'admin@example.invalid' };
const lines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const mails = () => lines(MAIL), charges = () => lines(CALLS);
const emailOf = u => `${u.username}@example.invalid`;
const mailsTo = u => mails().filter(m => [].concat(m.to).includes(emailOf(u)));

(async () => {
  const probe = await s.from('auction_items').select('extend_by_seconds').limit(1);
  const probeZ = await s.from('points_ledger').select('id').limit(1);
  if (probe.error || probeZ.error) { console.log('Apply migrations z (points) and za (live bidding) first.'); process.exit(2); }
  const before = die(await s.from('points_settings').select('*').eq('id', 1).single());
  for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
  const servers = [];
  let promoId = null;
  try {
    await K.syncClock();
    die(await s.from('points_settings').update({ enabled: true }).eq('id', 1).select());
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('live-hammer', 3631, src, { env: ENV, preload: STUBS, patch: PATCH, timers: 'real', log: true });
global.SRV = srv;
    servers.push(srv);
    await sleep(1500);

    const W = await mkUser('w'), D = await mkUser('d', { customer: 'cus_ZZLIVE_decl' }), P = await mkUser('p'), Z = await mkUser('z'), Q = await mkUser('q');
    // Starting bids set the hammer price exactly (a lone bidder pays the starting bid).
    const prices = [12.34, 7, 40, 10, 50, 30, 9];
    const show = await mkShow('main', { lots: prices.length });
    for (let i = 0; i < prices.length; i++) die(await s.from('auction_items').update({ starting_bid: prices[i] }).eq('id', show.lots[i]).select());
    for (const u of [W, D, P, Z, Q]) await terms(u, show.id);
    die(await s.from('points_ledger').insert([{ user_id: P.id, kind: 'adjust', points: 300, note: 'zztest' }, { user_id: Z.id, kind: 'adjust', points: 250, note: 'zztest' }]).select());
    promoId = die(await s.from('promotions').insert({ auction_id: show.id, kind: 'percent_code', code: 'ZZLIVE' + K.TAG.toUpperCase(), percent: 20,
      starts_at: dbAt(-3600e3), ends_at: dbAt(3600e3) }).select().single()).id;
    die(await s.from('promotion_uses').insert({ promotion_id: promoId, user_id: Q.id, auction_id: show.id }).select());

    const host = await client(srv.url, show.id, ADMIN);
    const anon = await client(srv.url, show.id);
    const socks = {};
    for (const [k, u] of Object.entries({ W, D, P, Z, Q })) socks[k] = await client(srv.url, show.id, u);
    // Offer the next lot, the winner bids its starting price, wait for the hammer.
    async function sell(lotId, winnerKey, price) {
      const from = anon.mark();
      const e = await ask(host, 'next_item', { timerSeconds: 5 }, ['item_activated', 'host_error']);
      if (!e || e.event !== 'item_activated') throw new Error('could not open lot: ' + JSON.stringify(e && e.payload));
      const b = await ask(socks[winnerKey], 'place_bid', { itemId: lotId, max_amount: price }, ['bid_ok', 'bid_error']);
      if (!b || b.event !== 'bid_ok') throw new Error('bid refused: ' + JSON.stringify(b && b.payload));
      return anon.waitFor('lot_closed', p => p.item_id === lotId, 15000, from);
    }
    const orderOf = async lotId => (await s.from('orders').select('*').eq('item_id', lotId)).data;
    const settle = async (lotId, ms = 6000) => { const end = Date.now() + ms; let o; while (Date.now() < end) { o = (await orderOf(lotId))[0]; if (o && !['unpaid', 'charging'].includes(o.payment_status)) return o; await sleep(200); } return o; };

    console.log('== The hammer: order now, charge off the host\'s path ==');
    const [L1, L2, L3, L4, L5, L6, L7] = show.lots;
    const c1 = await sell(L1, 'W', 12.34);
    const o1 = await settle(L1);
    const ch1 = charges().filter(c => c.md.order_id === o1?.id);
    ok(c1 && c1.payload.status === 'sold' && c1.payload.amount === 12.34, `lot 1 sold at $${c1 && c1.payload.amount}`);
    ok(ch1.length === 1 && c1.at < ch1[0].t1, `the room heard "sold" ${ch1[0] ? ch1[0].t1 - c1.at : '?'} ms BEFORE Stripe answered (charge not awaited by the hammer)`);
    ok(ch1[0] && ch1[0].amount === 1234 && o1.hammer_cents === 1234 && o1.premium_cents === 0 && o1.total_cents === 1234 && o1.payment_status === 'paid' && o1.payment_intent_id === ch1[0].id,
      `charged $${ch1[0] && ch1[0].amount / 100} = the winning bid, no premium; order paid with that PaymentIntent`);
    ok(!mailsTo(W).length, `no per-lot win email in a live show (${mailsTo(W).length} emails to the winner)`);

    console.log('\n== A declined card ==');
    await sell(L2, 'D', 7);
    const o2 = await settle(L2);
    await sleep(500);
    const dm = mailsTo(D);
    const adminMail = mails().filter(m => [].concat(m.to).includes('admin@example.invalid') && /Payment failed/i.test(m.subject));
    ok(o2 && o2.payment_status === 'failed' && /declined/i.test(o2.payment_error || ''), `order '${o2 && o2.payment_status}': ${o2 && o2.payment_error}`);
    ok(dm.length === 1 && /payment issue|did not go through/i.test(dm[0].subject) && !/premium/i.test(dm[0].html) && /\$7\.00/.test(dm[0].html), `the buyer's decline email at once ("${dm[0] && dm[0].subject}"), $7.00, no premium row`);
    ok(adminMail.some(m => m.subject.includes(D.username) || m.subject.includes(o2.id)), 'the admin is emailed too');

    console.log('\n== Points (G2) per lot ==');
    await sell(L3, 'P', 40);
    const o3 = await settle(L3);
    await sleep(400);
    const ch3 = charges().filter(c => c.md.order_id === o3?.id);
    const ledP = (await s.from('points_ledger').select('kind, points, order_id').eq('user_id', P.id).order('id')).data;
    ok(ch3.length === 1 && ch3[0].amount === 1500 && o3.discount_kind === 'points_reward' && o3.discount_cents === 2500 && o3.total_cents === 1500 && o3.hammer_cents === 4000,
      `300 points, $40 lot: one $25 reward, Stripe charged $${ch3[0] && ch3[0].amount / 100}`);
    ok(ledP.some(r => r.kind === 'redeem' && r.points === -250 && r.order_id === o3.id) && ledP.some(r => r.kind === 'earn' && r.points === 40 && r.order_id === o3.id),
      `ledger: -250 redeemed on that order, +40 earned once paid (balance ${ledP.reduce((t, r) => t + r.points, 0)})`);
    await sell(L4, 'Z', 10);
    const o4 = await settle(L4);
    ok(o4 && o4.payment_status === 'paid' && o4.payment_intent_id === 'no_charge_discount' && o4.total_cents === 0 && !charges().some(c => c.md.order_id === o4.id),
      `250 points, $10 lot: $0, paid with no Stripe call (${o4 && o4.payment_intent_id})`);
    await sell(L5, 'Q', 50);
    await sell(L6, 'Q', 30);
    const o5 = await settle(L5), o6 = await settle(L6);
    const ch5 = charges().filter(c => c.md.order_id === o5?.id), ch6 = charges().filter(c => c.md.order_id === o6?.id);
    ok(o5?.discount_kind === 'promo_code' && o6?.discount_kind === 'promo_code' && ch5[0]?.amount === 4000 && ch6[0]?.amount === 2400,
      `the show's 20% code on both of Q's lots: $50 -> $${ch5[0] && ch5[0].amount / 100}, $30 -> $${ch6[0] && ch6[0].amount / 100}`);

    console.log('\n== Two servers watching the same lot ==');
    const from7 = anon.mark();
    await ask(host, 'next_item', { timerSeconds: 15 }, ['item_activated']);
    await ask(socks.W, 'place_bid', { itemId: L7, max_amount: 9 }, ['bid_ok']);
    const srv2 = await boot('live-hammer-2', 3632, src, { env: ENV, preload: STUBS, patch: PATCH, timers: 'real' });   // watches the open lot at boot
    servers.push(srv2);
    await anon.waitFor('lot_closed', p => p.item_id === L7, 15000, from7);
    await sleep(2500);
    const o7 = await orderOf(L7);
    const ch7 = charges().filter(c => o7.some(o => o.id === c.md.order_id));
    ok(o7.length === 1 && ch7.length === 1 && ch7[0].amount === 900, `one order, one charge ($${ch7[0] && ch7[0].amount / 100})`);
    for (const c of [host, anon, ...Object.values(socks)]) c.close();
    srv.stop(); srv2.stop(); servers.length = 0;

    console.log('\n== Recovery at boot ==');
    const show2 = await mkShow('recover', { lots: 2 });
    await terms(W, show2.id);
    const [R1, R2] = show2.lots;
    die(await s.from('auction_items').update({ status: 'sold', current_bid: 6, bid_count: 1, leading_bidder: W.username, ends_at: dbAt(-10e3), extend_window_seconds: 5, extend_by_seconds: 5 }).eq('id', R1).select());
    die(await s.from('auction_items').update({ status: 'sold', current_bid: 8, bid_count: 1, leading_bidder: W.username, ends_at: dbAt(-120e3), extend_window_seconds: 5, extend_by_seconds: 5 }).eq('id', R2).select());
    die(await s.from('orders').insert({ auction_id: show2.id, item_id: R2, buyer_username: W.username, buyer_user_id: W.id, item_title: 'Lot 2: ' + K.P, final_bid: 8,
      hammer_cents: 800, premium_cents: 0, total_cents: 800, status: 'pending', payment_status: 'unpaid', fulfillment_choice: 'shipping', created_at: dbAt(-120e3) }).select());
    const srv3 = await boot('live-hammer-3', 3633, src, { env: ENV, preload: STUBS, patch: PATCH, timers: 'real' });
    servers.push(srv3);
    await sleep(4000);
    const r1 = (await orderOf(R1))[0], r2 = (await orderOf(R2))[0];
    ok(r1 && r1.payment_status === 'paid' && charges().some(c => c.md.order_id === r1.id && c.amount === 600), `a sold live lot with no order: order created and charged $6 (${r1 && r1.payment_status})`);
    ok(r2 && r2.payment_status === 'paid' && charges().filter(c => c.md.order_id === r2.id).length === 1, `a live order never charged: charged once (${r2 && r2.payment_status})`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    if (process.env.ZZ_DEBUG && global.SRV) console.log('--- server log --- ' + global.SRV.log().slice(-6000));
    servers.forEach(x => x.stop());
    await s.from('points_settings').update({ enabled: before.enabled }).eq('id', 1);
    if (promoId) { await s.from('promotion_uses').delete().eq('promotion_id', promoId); await s.from('promotions').delete().eq('id', promoId); }
    await s.from('email_send_log').delete().gte('sent_at', new Date(Date.now() - 30 * 60e3).toISOString()).in('kind', ['won', 'failed', 'admin']);
    await K.cleanup();
    for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
    const after = (await s.from('points_settings').select('enabled').eq('id', 1).single()).data;
    if (after?.enabled !== before.enabled) { console.log('points_settings.enabled NOT restored'); K.state.fails++; }
  }
  K.finish();
})();
