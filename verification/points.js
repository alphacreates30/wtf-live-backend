// Buyer points + promotions (G2, wtf-handoff POINTS_BRIEF.md). Needs migration z (exits 2 without it).
// Local servers on the test database; THROWAWAY rows only (ZZTEST_points*, zztest_pts_*), always cleaned up.
// Stripe is an in-process FAKE (records every PaymentIntent amount; one customer always declines; webhooks parse the
// raw body). Resend and Shippo are stubs inside the server process: nothing is charged, sent or bought.
// points_settings.enabled is switched on for the run and put back as it was.
//
//   maths     pure rewards.js: earn rounding, premium on the discounted amount, best-of code vs reward, Stripe's 50c
//   earn      only on a PAID invoice (a decline earns nothing); whole points per lot, rounded down
//   reward    one per invoice even with 600 points; premium worked out on the lower amount; the amount sent to Stripe
//             equals the discounted total; auto-apply off = no reward; never below $0 (no Stripe call at $0); a
//             re-run changes nothing; two invoices closing at once for a 250-point buyer: exactly one reward
//   code      enter / replace / remove; bad, draft, closed, after the invoice: refused; best one wins and the loser is
//             untouched (points kept / code not marked used)
//   refund    charge.refunded webhook: points taken back, never below 0, shortfall emailed to the admin; partial
//             refund changes nothing and tells the admin
//   shipping  free-shipping promo and bundle bonus (3+ lots) on the real label route: label bought, buyer not charged
//   expiry    reminder 30 days before (once), expiry after 12 months with no win (fake clock)
//   privacy   /me/points, /my-orders only the caller's; public promotions never carry the code; admin routes 403
//   switched off   POINTS_ENABLED unset: every buyer route says enabled:false / 404, invoices get no discount, no points
//   A5        delete_account removes the buyer's ledger, account and promo rows
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const R = require(BE + '/rewards');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const P = 'ZZTEST_points';
const TAG = crypto.randomBytes(3).toString('hex');
const MAIL = BE + '/run.tmp-points-mail.log', CALLS = BE + '/run.tmp-points-stripe.log';

const FAKE_STRIPE = `const stripe = {
  paymentIntents: {
    create: async (p) => {
      if (p.customer === 'cus_ZZPTS_decline') { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; throw e; }
      const id = 'pi_ZZPTS_' + require('crypto').randomUUID().slice(0, 12);
      require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ id, amount: p.amount, md: p.metadata || {} }) + '\\n');
      return { id };
    },
    retrieve: async () => ({}),
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body) },
};`;
const STUBS = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com')) {
    const b = JSON.parse(opts.body || '{}');
    require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject, html: b.html }) + '\\n');
    return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
  }
  if (u.startsWith('https://api.goshippo.com/rates/')) return new Response(JSON.stringify({ object_id: u.split('/')[4], amount: '7.50', currency: 'USD', provider: 'USPS' }));
  if (u.startsWith('https://api.goshippo.com/transactions/')) return new Response(JSON.stringify({ status: 'SUCCESS', object_id: 'tx_zz', label_url: 'https://example.invalid/label.pdf', tracking_number: 'ZZ123', tracking_url_provider: 'https://example.invalid/t' }));
  return realFetch(url, opts);
};`;
const TEST_ROUTES = `app.post('/__test/build/:id', async (req, res) => { await buildAndChargeInvoicesForAuction(req.params.id); res.json({ done: true }); });
app.post('/__test/housekeeping', async (req, res) => res.json(await runPointsHousekeeping(new Date(String(req.query.now)), { force: true })));
const PORT = process.env.PORT || 3001;`;
const PATCH = [
  ['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;', FAKE_STRIPE],
  ['const PORT = process.env.PORT || 3001;', TEST_ROUTES],
];
const ENV_ON = { POINTS_ENABLED: 'true', RESEND_API_KEY: 're_zztest_stub', SHIPPO_API_KEY: 'shippo_zztest_stub', ADMIN_EMAIL: 'admin@example.invalid', SITE_URL: 'https://site.zztest' };
const mails = () => (fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const charges = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const made = { users: [], auctions: [], orders: [], invoices: [], promos: [] };
const DAY = 864e5;

async function mkUser(label, { decline = false } = {}) {
  const id = crypto.randomUUID(), username = `zztest_pts_${label}_${TAG}`;
  const email = `${username}@example.invalid`;
  die(await s.from('users').insert({ id, username, password_hash: 'zztest-not-a-real-hash', email }).select().single());
  made.users.push(id);
  die(await s.from('profiles').insert({ user_id: id, full_name: 'ZZ Points ' + label, email, phone: '5555550100', address_line1: '1 ZZ St', city: 'Testville', state: 'CA', zip: '94000',
    status: 'approved', payment_status: 'ok', stripe_customer_id: decline ? 'cus_ZZPTS_decline' : 'cus_ZZPTS_' + label, stripe_payment_method_id: 'pm_ZZPTS' }).select().single());
  return { id, username, email, tok: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '30m' }) };
}
async function mkAuction(label, status = 'ended', extra = {}) {
  const a = die(await s.from('auctions').insert({ title: `${P} ${label} ${TAG}`, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind', ends_at: new Date().toISOString(), ...extra }).select().single());
  made.auctions.push(a.id);
  return a.id;
}
// An order as createOrderOnWin writes it (15% premium, integer cents).
async function mkOrder(auctionId, buyer, hammerCents, extra = {}) {
  const premium = Math.round(hammerCents * 15 / 100);
  const o = die(await s.from('orders').insert({ auction_id: auctionId, buyer_username: buyer.username, buyer_user_id: buyer.id, item_title: `${P} lot ${TAG}`, final_bid: hammerCents / 100,
    hammer_cents: hammerCents, premium_cents: premium, total_cents: hammerCents + premium, status: 'pending', payment_status: 'unpaid', fulfillment_choice: 'shipping', ...extra }).select().single());
  made.orders.push(o.id);
  return o;
}
const call = (url, method, path, tok, body) => fetch(url + path, {
  method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const invoiceOf = async (auctionId, buyer) => {
  const v = (await s.from('invoices').select('*').eq('auction_id', auctionId).eq('buyer_user_id', buyer.id).maybeSingle()).data;
  if (v && !made.invoices.includes(v.id)) made.invoices.push(v.id);
  return v;
};
const ledger = async buyer => (await s.from('points_ledger').select('kind, points, order_id, invoice_id, note').eq('user_id', buyer.id).order('id')).data || [];
const balance = async buyer => (await ledger(buyer)).reduce((t, r) => t + r.points, 0);
const chargedFor = invId => charges().filter(c => c.md.invoice_id === invId);

(async () => {
  const probe = await s.from('points_ledger').select('id').limit(1);
  if (probe.error) { console.log('points_ledger is missing on this database: apply migration z (2026-10-15z-points.sql) first.'); process.exitCode = 2; return; }
  const before = die(await s.from('points_settings').select('*').eq('id', 1).single());
  for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
  const servers = [];
  try {
    try {
      console.log('== rewards.js maths (pure) ==');
      const S = { ...R.DEFAULTS, enabled: true };
      ok(R.pointsForHammer(5299, S) === 52 && R.pointsForHammer(99, S) === 0 && R.pointsForHammer(10000, { ...S, points_per_dollar: 2 }) === 200, 'earn: whole dollars of the winning bid, rounded down ($52.99 -> 52, $0.99 -> 0), x points per $1');
      let d = R.decideDiscount({ hammerCents: 8000, premiumCents: 1200, balance: 260, settings: S });
      ok(d.kind === 'points_reward' && d.off_cents === 2500 && d.premium_off_cents === 375 && 1200 - 375 === Math.round((8000 - 2500) * 0.15), 'reward $25 off $80: premium saved $3.75, so the premium is 15% of $55');
      ok(R.decideDiscount({ hammerCents: 8000, balance: 249, settings: S }).kind === null, '249 points: no reward');
      ok(R.decideDiscount({ hammerCents: 8000, balance: 900, autoApply: false, settings: S }).kind === null, 'auto-apply off: no reward');
      ok(R.decideDiscount({ hammerCents: 1000, premiumCents: 150, balance: 250, settings: S }).off_cents === 1000, 'reward never more than the winning bids ($25 on a $10 win -> $10)');
      d = R.decideDiscount({ hammerCents: 20000, balance: 300, code: { promotion_id: 'p', percent: 20 }, settings: S });
      ok(d.kind === 'promo_code' && d.off_cents === 4000 && d.options.reward_cents === 2500, '20% code on $200 ($40) beats the $25 reward; both savings reported');
      d = R.decideDiscount({ hammerCents: 10000, balance: 300, code: { promotion_id: 'p', percent: 10 }, settings: S });
      ok(d.kind === 'points_reward' && d.options.code_cents === 1000, '10% code on $100 ($10) loses to the $25 reward');
      ok(R.decideDiscount({ hammerCents: 12500, balance: 300, code: { promotion_id: 'p', percent: 20 }, settings: S }).kind === 'promo_code', 'a tie uses the code (the buyer keeps their points)');
      ok(R.belowStripeMinimum(2898, { kind: 'points_reward', off_cents: 2500, premium_off_cents: 375 }) === 23 && R.belowStripeMinimum(5000, { kind: 'points_reward', off_cents: 2500, premium_off_cents: 375 }) === 0, "a 23c remainder (under Stripe's 50c) also comes off");
      const promos = [{ kind: 'bundle_free_shipping', auction_id: 'A', active: true, starts_at: '2026-01-01', ends_at: '2027-01-01' }];
      ok(R.shippingPromoFor([{ auction_id: 'A', created_at: '2026-06-01' }], promos, { A: 3 }) === 'bundle_free_shipping'
        && R.shippingPromoFor([{ auction_id: 'A', created_at: '2026-06-01' }], promos, { A: 2 }) === null
        && R.shippingPromoFor([{ auction_id: 'A', created_at: '2027-06-01' }], promos, { A: 3 }) === null
        && R.shippingPromoFor([{ auction_id: 'A', created_at: '2026-06-01' }, { auction_id: 'B', created_at: '2026-06-01' }], promos, { A: 3, B: 5 }) === null,
        'bundle bonus: 3+ lots in the event, won inside the promo window, every order in the box must qualify');

      die(await s.from('points_settings').update({ enabled: true }).eq('id', 1).select());
      const src = require('./guard').readSource(BE + '/server.js');
      const on = await boot('points-on', 3561, src, { env: ENV_ON, preload: STUBS, patch: PATCH, log: true });
      const off = await boot('points-off', 3562, src, { env: { ...ENV_ON, POINTS_ENABLED: '' }, preload: STUBS, patch: PATCH });
      servers.push(on, off);
      await sleep(2500);
      for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
      const U = on.url;
      const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '30m' });

      console.log('\n== Earn: only on a paid invoice ==');
      const A = await mkUser('a'), Dcl = await mkUser('decl', { decline: true });
      const X1 = await mkAuction('X1');
      const a1 = await mkOrder(X1, A, 5270), a2 = await mkOrder(X1, A, 10000);
      const dc = await mkOrder(X1, Dcl, 9000);
      await call(U, 'POST', `/__test/build/${X1}`);
      const invA = await invoiceOf(X1, A), invD = await invoiceOf(X1, Dcl);
      ok(invA.payment_status === 'paid' && !invA.discount_kind && invA.discount_decided_at && chargedFor(invA.id)[0]?.amount === 5270 + 791 + 10000 + 1500,
        `no points yet: no discount, charged the full ${chargedFor(invA.id)[0]?.amount}c`);
      let L = await ledger(A);
      ok(L.length === 2 && L.find(r => r.order_id === a1.id)?.points === 52 && L.find(r => r.order_id === a2.id)?.points === 100, `earned 52 + 100 per lot (${L.map(r => r.points).join(' + ')})`);
      ok(invD.payment_status === 'failed' && (await ledger(Dcl)).length === 0, 'declined card: invoice failed, no points');
      let m = mails().find(x => x.to === A.email && /You won/.test(x.subject));
      ok(m && m.html.includes('You earned <strong>152 points</strong>: 152 / 250'), 'won email: "You earned 152 points: 152 / 250"');

      console.log('\n== Reward: one per invoice, premium on the lower amount, the discounted amount is what Stripe gets ==');
      const B = await mkUser('b');
      let r = await call(U, 'POST', `/admin/points/${B.id}/adjust`, admin, { points: 260, note: 'ZZ test credit' });
      ok(r.s === 200 && r.j.balance === 260, 'admin adjust +260 with a note');
      ok((await call(U, 'POST', `/admin/points/${B.id}/adjust`, admin, { points: -1000, note: 'too much' })).s === 409, 'admin adjust below 0: 409');
      ok((await call(U, 'POST', `/admin/points/${B.id}/adjust`, admin, { points: 5 })).s === 400, 'admin adjust with no note: 400');
      const X2 = await mkAuction('X2');
      const b1 = await mkOrder(X2, B, 8000);
      await call(U, 'POST', `/__test/build/${X2}`);
      let invB = await invoiceOf(X2, B);
      ok(invB.discount_kind === 'points_reward' && invB.discount_cents === 2500 && invB.discount_premium_cents === 375 && invB.total_cents === 9200 - 2875 && invB.hammer_cents === 8000,
        `invoice: $80 + $12 premium, reward -$25, premium -$3.75 -> total ${invB.total_cents}c`);
      ok(chargedFor(invB.id).length === 1 && chargedFor(invB.id)[0].amount === 6325, `Stripe charged ${chargedFor(invB.id)[0]?.amount}c (the discounted total)`);
      L = await ledger(B);
      ok(L.filter(x => x.kind === 'redeem').length === 1 && L.find(x => x.kind === 'redeem').points === -250 && L.find(x => x.kind === 'earn')?.points === 80 && await balance(B) === 90,
        `ledger: +260 adjust, -250 reward, +80 earned -> balance ${await balance(B)}`);
      m = mails().find(x => x.to === B.email && /You won/.test(x.subject));
      ok(m && m.html.includes('Points reward') && m.html.includes('&minus;$25.00') && m.html.includes('&minus;$3.75') && m.html.includes('$63.25'), 'won email: "Points reward -$25.00", premium line, total $63.25');
      await call(U, 'POST', `/__test/build/${X2}`);
      ok(chargedFor(invB.id).length === 1 && (await ledger(B)).length === 3 && (await invoiceOf(X2, B)).total_cents === 6325, 're-run: no second charge, no second reward, total unchanged');

      const C = await mkUser('c');
      die(await s.rpc('points_adjust', { p_user_id: C.id, p_points: 600, p_note: 'ZZ' }));
      const X3 = await mkAuction('X3');
      await mkOrder(X3, C, 30000); await mkOrder(X3, C, 20000);
      await call(U, 'POST', `/__test/build/${X3}`);
      const invC = await invoiceOf(X3, C);
      ok(invC.discount_cents === 2500 && (await ledger(C)).filter(x => x.kind === 'redeem').length === 1 && await balance(C) === 600 - 250 + 500, `600 points, $500 won: ONE $25 reward (balance ${await balance(C)})`);

      console.log('\n== Auto-apply off; never below $0 ==');
      const Dn = await mkUser('d');
      die(await s.rpc('points_adjust', { p_user_id: Dn.id, p_points: 300, p_note: 'ZZ' }));
      r = await call(U, 'PUT', '/me/points/settings', Dn.tok, { auto_apply: false });
      ok(r.s === 200 && r.j.auto_apply === false && (await call(U, 'GET', '/me/points', Dn.tok)).j.auto_apply === false, 'buyer turns auto-apply off');
      ok((await call(U, 'PUT', '/me/points/settings', Dn.tok, { auto_apply: 'no' })).s === 400, 'auto_apply must be a boolean: 400');
      const X4 = await mkAuction('X4');
      await mkOrder(X4, Dn, 10000);
      await call(U, 'POST', `/__test/build/${X4}`);
      const invDn = await invoiceOf(X4, Dn);
      ok(!invDn.discount_kind && invDn.total_cents === 11500 && await balance(Dn) === 400, 'auto-apply off: no reward, points kept (+100 earned)');
      ok((await call(U, 'GET', '/me/points', A.tok)).j.auto_apply === true, 'auto-apply is ON by default');

      const E = await mkUser('e'), E2 = await mkUser('e2');
      die(await s.rpc('points_adjust', { p_user_id: E.id, p_points: 250, p_note: 'ZZ' }));
      die(await s.rpc('points_adjust', { p_user_id: E2.id, p_points: 250, p_note: 'ZZ' }));
      const X5 = await mkAuction('X5');
      await mkOrder(X5, E, 1000); await mkOrder(X5, E2, 2520);
      await call(U, 'POST', `/__test/build/${X5}`);
      const invE = await invoiceOf(X5, E), invE2 = await invoiceOf(X5, E2);
      ok(invE.total_cents === 0 && invE.discount_cents === 1000 && invE.discount_premium_cents === 150 && invE.payment_status === 'paid' && invE.payment_intent_id === 'no_charge_discount' && chargedFor(invE.id).length === 0,
        '$10 win with a $25 reward: $0, paid, Stripe never called (never below $0)');
      ok(invE2.total_cents === 0 && invE2.payment_status === 'paid' && chargedFor(invE2.id).length === 0, "$25.20 win: the 23c left (under Stripe's minimum) also comes off -> $0, no charge");
      ok(await balance(E) === 10 && await balance(E2) === 25, 'the winning bid still earns points on a $0 invoice');
      m = mails().find(x => x.to === E.email && /You won/.test(x.subject));
      ok(m && m.html.includes('Nothing to pay'), 'won email at $0: "Nothing to pay: your discount covered it."');

      console.log('\n== Two invoices closing at once, 250 points: exactly one reward ==');
      const F = await mkUser('f');
      die(await s.rpc('points_adjust', { p_user_id: F.id, p_points: 250, p_note: 'ZZ' }));
      const X6a = await mkAuction('X6a'), X6b = await mkAuction('X6b');
      await mkOrder(X6a, F, 5000); await mkOrder(X6b, F, 5000);
      await Promise.all([call(U, 'POST', `/__test/build/${X6a}`), call(U, 'POST', `/__test/build/${X6b}`)]);
      const f1 = await invoiceOf(X6a, F), f2 = await invoiceOf(X6b, F);
      ok([f1, f2].filter(v => v.discount_kind === 'points_reward').length === 1 && (await ledger(F)).filter(x => x.kind === 'redeem').length === 1 && await balance(F) === 100,
        `one invoice got the reward, the other none; balance ${await balance(F)} (never negative)`);

      console.log('\n== Promo code: enter before close; best one wins; no stacking ==');
      const X7 = await mkAuction('X7', 'live');
      const now = Date.now();
      let pr = await call(U, 'POST', '/admin/promotions', admin, { auction_id: X7, kind: 'percent_code', code: 'zz20' + TAG, percent: 20, starts_at: new Date(now - DAY).toISOString(), ends_at: new Date(now + DAY).toISOString() });
      ok(pr.s === 201 && pr.j.code === ('ZZ20' + TAG).toUpperCase(), `admin creates a 20% code (stored upper case: ${pr.j?.code})`);
      made.promos.push(pr.j.id);
      ok((await call(U, 'POST', '/admin/promotions', admin, { kind: 'percent_code', code: 'x', percent: 20, starts_at: new Date(now).toISOString(), ends_at: new Date(now + DAY).toISOString() })).s === 400, 'bad code: 400');
      ok((await call(U, 'POST', '/admin/promotions', admin, { kind: 'free_shipping', starts_at: new Date(now + DAY).toISOString(), ends_at: new Date(now).toISOString() })).s === 400, 'ends before it starts: 400');
      const pub = await call(U, 'GET', `/auction/${X7}/promotions`);
      ok(pub.s === 200 && pub.j.some(p => p.kind === 'percent_code' && p.percent === 20) && !JSON.stringify(pub.j).includes('ZZ20' + TAG.toUpperCase()) && !JSON.stringify(pub.j).toUpperCase().includes(('ZZ20' + TAG).toUpperCase()),
        'public event page: "20% off with a code", never the code itself');
      const G = await mkUser('g'), H = await mkUser('h');
      die(await s.rpc('points_adjust', { p_user_id: G.id, p_points: 300, p_note: 'ZZ' }));
      die(await s.rpc('points_adjust', { p_user_id: H.id, p_points: 300, p_note: 'ZZ' }));
      ok((await call(U, 'POST', '/checkout/apply-code', G.tok, { auction_id: X7, code: 'NOPE123' })).s === 400, 'wrong code: 400');
      ok((await call(U, 'POST', '/checkout/apply-code', null, { auction_id: X7, code: 'zz20' + TAG })).s === 401, 'no login: 401');
      r = await call(U, 'POST', '/checkout/apply-code', G.tok, { auction_id: X7, code: ' zz20' + TAG + ' ' });
      ok(r.s === 200 && r.j.entered.percent === 20 && /bigger saving/.test(r.j.note), 'buyer enters the code (any case, spaces trimmed); told the bigger saving is used');
      ok((await call(U, 'POST', '/checkout/apply-code', H.tok, { auction_id: X7, code: 'zz20' + TAG })).s === 200, 'a second buyer enters it too');
      ok((await call(U, 'GET', `/checkout/code?auction_id=${X7}`, G.tok)).j.entered.code === ('ZZ20' + TAG).toUpperCase(), 'GET /checkout/code shows the entered code');
      const Xd = await mkAuction('Xdraft', 'draft');
      ok((await call(U, 'POST', '/checkout/apply-code', G.tok, { auction_id: Xd, code: 'zz20' + TAG })).s === 404, 'a draft auction: 404');
      await mkOrder(X7, G, 20000); await mkOrder(X7, H, 10000);
      die(await s.from('auctions').update({ status: 'ended' }).eq('id', X7).select());
      ok((await call(U, 'POST', '/checkout/apply-code', A.tok, { auction_id: X7, code: 'zz20' + TAG })).s === 409, 'after the auction closed: 409');
      await call(U, 'POST', `/__test/build/${X7}`);
      const invG = await invoiceOf(X7, G), invH = await invoiceOf(X7, H);
      ok(invG.discount_kind === 'promo_code' && invG.discount_cents === 4000 && invG.discount_premium_cents === 600 && chargedFor(invG.id)[0]?.amount === 23000 - 4600 && await balance(G) === 300 + 200,
        `$200 win: 20% code ($40) beats the reward; charged ${chargedFor(invG.id)[0]?.amount}c; points NOT spent (balance ${await balance(G)})`);
      ok(invH.discount_kind === 'points_reward' && invH.discount_cents === 2500 && !(await s.from('promotion_uses').select('applied_at').eq('user_id', H.id).single()).data.applied_at,
        '$100 win: the $25 reward beats 20% ($20); the code is NOT marked used (no stacking)');
      ok((await call(U, 'POST', '/checkout/apply-code', G.tok, { auction_id: X7, code: 'zz20' + TAG })).s === 409, 'after the invoice: 409');
      r = await call(U, 'GET', '/admin/promotions?auction_id=' + X7, admin);
      ok(r.s === 200 && r.j.find(p => p.id === made.promos[0])?.uses.applied === 1 && r.j.find(p => p.id === made.promos[0])?.uses.entered === 2, 'admin promotions list: 2 entered, 1 used');
      ok((await call(U, 'DELETE', `/admin/promotions/${made.promos[0]}`, admin)).s === 409, 'a used code can\'t be deleted (switch it off instead)');
      r = await call(U, 'PATCH', `/admin/promotions/${made.promos[0]}`, admin, { active: false });
      ok(r.s === 200 && r.j.active === false, 'admin switches it off');

      console.log('\n== Refunds take the points back (charge.refunded) ==');
      const hook = body => fetch(U + '/webhook/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'zz' }, body: JSON.stringify(body) }).then(r => r.status);
      const piA = (await invoiceOf(X1, A)).payment_intent_id;
      let st = await hook({ type: 'charge.refunded', data: { object: { payment_intent: piA, amount: 17561, amount_refunded: 5000, refunded: false } } });
      ok(st === 200 && await balance(A) === 152 && mails().some(x => x.to === 'admin@example.invalid' && /partial refund/.test(x.subject)), 'partial refund: points unchanged, admin told');
      st = await hook({ type: 'charge.refunded', data: { object: { payment_intent: piA, amount: 17561, amount_refunded: 17561, refunded: true } } });
      ok(st === 200 && await balance(A) === 0 && (await ledger(A)).filter(x => x.kind === 'reverse').length === 2, 'full refund: both lots\' points taken back (balance 0)');
      await hook({ type: 'charge.refunded', data: { object: { payment_intent: piA, amount: 17561, amount_refunded: 17561, refunded: true } } });
      ok((await ledger(A)).filter(x => x.kind === 'reverse').length === 2, 'the same event again: nothing more');
      // B: 260 adjust - 250 reward + 80 earned = 90; spend 50 more by hand, then refund the $80 lot: only 40 can come back.
      die(await s.rpc('points_adjust', { p_user_id: B.id, p_points: -50, p_note: 'ZZ spend' }));
      await hook({ type: 'charge.refunded', data: { object: { payment_intent: invB.payment_intent_id, amount: 6325, amount_refunded: 6325, refunded: true } } });
      const rev = (await ledger(B)).find(x => x.kind === 'reverse');
      ok(await balance(B) === 0 && rev.points === -40 && /40 points already spent/.test(rev.note) && mails().some(x => x.to === 'admin@example.invalid' && /refund after the reward was used/.test(x.subject)),
        `refund after the points were spent: balance stops at 0 (${rev.points}), the reward isn't clawed back, admin told`);

      console.log('\n== Free shipping and the bundle bonus on the real label route (Shippo stubbed) ==');
      const K = await mkUser('k');
      const X8 = await mkAuction('X8');
      const k1 = await mkOrder(X8, K, 1000), k2 = await mkOrder(X8, K, 1000);
      pr = await call(U, 'POST', '/admin/promotions', admin, { auction_id: X8, kind: 'bundle_free_shipping', starts_at: new Date(now - DAY).toISOString(), ends_at: new Date(now + DAY).toISOString() });
      made.promos.push(pr.j.id);
      const before8 = charges().length;
      r = await call(U, 'POST', '/admin/orders/label', admin, { order_ids: [k1.id, k2.id], rate_id: 'rate_zz1', amount_cents: 750 });
      ok(r.s === 200 && r.j.buyer_paid_cents === 750 && r.j.shipping_promo === null && charges().length === before8 + 1, 'bundle bonus with only 2 lots won: buyer pays the $7.50 postage');
      const k3 = await mkOrder(X8, K, 1000), k4 = await mkOrder(X8, K, 1000);
      const before9 = charges().length;
      r = await call(U, 'POST', '/admin/orders/label', admin, { order_ids: [k3.id, k4.id], rate_id: 'rate_zz2', amount_cents: 750 });
      const k3row = (await s.from('orders').select('shipping_payment_status, shipping_cost_cents, shipping_promo, status').eq('id', k3.id).single()).data;
      ok(r.s === 200 && r.j.buyer_paid_cents === 0 && r.j.shipping_promo === 'bundle_free_shipping' && charges().length === before9 && k3row.shipping_payment_status === 'paid' && k3row.shipping_cost_cents === 0 && k3row.status === 'label_created',
        '4 lots won: this box ships free (label bought, buyer not charged, shipping_promo recorded)');
      const Ksh = await mkUser('ksh');
      const X9 = await mkAuction('X9');
      const s1 = await mkOrder(X9, Ksh, 1000);
      pr = await call(U, 'POST', '/admin/promotions', admin, { auction_id: X9, kind: 'free_shipping', starts_at: new Date(now - DAY).toISOString(), ends_at: new Date(now + DAY).toISOString() });
      made.promos.push(pr.j.id);
      const before10 = charges().length;
      r = await call(U, 'POST', '/admin/orders/label', admin, { order_ids: [s1.id], rate_id: 'rate_zz3', amount_cents: 750 });
      ok(r.s === 200 && r.j.shipping_promo === 'free_shipping' && charges().length === before10, 'free-shipping event: one lot ships free');
      r = await call(U, 'POST', '/admin/orders/label', admin, { order_ids: [s1.id], rate_id: 'rate_zz3', amount_cents: 750 });
      ok(r.s === 402, 'a second label for the same box: refused (already paid)');
      const ord = (await call(U, 'GET', '/my-orders', Ksh.tok)).j.find(o => o.id === s1.id);
      ok(ord.shipping_promo === 'free_shipping' && ord.shipping_cost_cents === 0, '/my-orders shows the free postage and why');

      console.log('\n== Privacy: own points only; buyers can\'t reach admin routes ==');
      const meB = await call(U, 'GET', '/me/points', B.tok), meC = await call(U, 'GET', '/me/points', C.tok);
      ok(meC.s === 200 && meC.j.enabled && meC.j.balance === 850 && meC.j.toward_next === 850 % 250 && meC.j.rewards_ready === 3 && meC.j.saved_cents === 2500 + 3750 * 0 + invC.discount_premium_cents,
        `/me/points: balance ${meC.j.balance}, ${meC.j.toward_next} / ${meC.j.per_reward}, ${meC.j.rewards_ready} rewards ready, saved ${meC.j.saved_cents}c`);
      ok(meC.j.expires_at && Math.abs(Date.parse(meC.j.expires_at) - (Date.now() + 365 * DAY)) < 3 * DAY, `expiry date about 12 months after the last win (${meC.j.expires_at})`);
      const everyone = [A, B, C, Dn, E, E2, F, G, H, K];
      const leak = (resp, self) => everyone.filter(u => u.id !== self.id).some(u => JSON.stringify(resp).includes(u.id) || JSON.stringify(resp).includes(u.username));
      ok(!leak(meB.j, B) && !leak(meC.j, C) && !JSON.stringify(meC.j).includes('user_id'), '/me/points carries no other buyer (no ids, no usernames)');
      const myC = await call(U, 'GET', '/my-orders', C.tok);
      ok(myC.j.every(o => o.auction_id === X3) && !leak(myC.j, C) && myC.j[0].invoice.discount_kind === 'points_reward' && myC.j.some(o => o.points_earned === 300), '/my-orders: own orders only, with the reward line and points earned');
      ok((await call(U, 'GET', '/me/points')).s === 401, '/me/points needs a login');
      for (const [m2, p] of [['GET', '/admin/points-settings'], ['PUT', '/admin/points-settings'], ['GET', '/admin/promotions'], ['POST', '/admin/promotions'], ['GET', `/admin/points/${C.id}`], ['POST', `/admin/points/${C.id}/adjust`], ['GET', '/admin/points-summary']]) {
        const x = await call(U, m2, p, B.tok, m2 === 'GET' ? undefined : { points: 999, note: 'x', enabled: true });
        ok(x.s === 403, `buyer -> ${m2} ${p.replace(C.id, ':id')}: 403 (${x.s})`);
      }
      r = await call(U, 'GET', '/admin/points-summary', admin);
      ok(r.s === 200 && r.j.points_outstanding >= 850 && r.j.value_cents === Math.floor(r.j.points_outstanding * 2500 / 250) && r.j.buyers >= 1, `admin total outstanding: ${r.j.points_outstanding} points = ${r.j.value_cents}c, ${r.j.buyers} buyers`);
      r = await call(U, 'GET', `/admin/points/${C.id}`, admin);
      ok(r.s === 200 && r.j.username === C.username && r.j.history.length === 4, `admin sees a buyer's history (${r.j.history?.length} rows)`);
      r = await call(U, 'GET', '/admin/points-settings', admin);
      ok(r.j.enabled && r.j.env_enabled && r.j.admin_enabled && r.j.points_per_reward === 250 && r.j.reward_cents === 2500 && r.j.expiry_months === 12 && r.j.points_per_dollar === 1, 'settings: defaults 1 / 250 / $25 / 12');
      ok((await call(U, 'PUT', '/admin/points-settings', admin, { points_per_reward: 0 })).s === 400 && (await call(U, 'PUT', '/admin/points-settings', admin, { reward_cents: 12.5 })).s === 400, 'settings: out-of-range values refused');

      console.log('\n== Switched off (POINTS_ENABLED unset): nothing shows, nothing changes ==');
      const O = off.url;
      ok(JSON.stringify((await call(O, 'GET', '/me/points', C.tok)).j) === '{"enabled":false}', '/me/points: { enabled: false } only');
      ok((await call(O, 'PUT', '/me/points/settings', C.tok, { auto_apply: false })).s === 404, 'auto-apply switch: 404');
      ok(JSON.stringify((await call(O, 'GET', `/auction/${X8}/promotions`)).j) === '[]', 'event promotions: []');
      ok((await call(O, 'POST', '/checkout/apply-code', C.tok, { auction_id: X8, code: 'ZZ20' + TAG })).s === 404, 'apply-code: 404');
      ok((await call(O, 'GET', '/admin/points-settings', admin)).j.enabled === false, 'admin sees enabled: false (env switch off)');
      const Q = await mkUser('q');
      die(await s.rpc('points_adjust', { p_user_id: Q.id, p_points: 300, p_note: 'ZZ' }));
      const X10 = await mkAuction('X10');
      await mkOrder(X10, Q, 10000);
      await call(O, 'POST', `/__test/build/${X10}`);
      const invQ = await invoiceOf(X10, Q);
      ok(invQ.payment_status === 'paid' && !invQ.discount_kind && !invQ.discount_decided_at && chargedFor(invQ.id)[0]?.amount === 11500 && await balance(Q) === 300, 'invoice: no reward, full price charged, no points earned');
      m = mails().find(x => x.to === Q.email && /You won/.test(x.subject));
      ok(m && !/You earned|Points reward/.test(m.html), 'won email: no points line, no reward line');
      const K2 = await mkUser('k2'); const X11 = await mkAuction('X11');
      const z1 = await mkOrder(X11, K2, 1000);
      die(await s.from('promotions').insert({ auction_id: X11, kind: 'free_shipping', starts_at: new Date(now - DAY).toISOString(), ends_at: new Date(now + DAY).toISOString() }).select().then(x => { if (x.data) made.promos.push(x.data[0].id); return x; }));
      r = await call(O, 'POST', '/admin/orders/label', admin, { order_ids: [z1.id], rate_id: 'rate_zz4', amount_cents: 750 });
      ok(r.s === 200 && r.j.shipping_promo === null && r.j.buyer_paid_cents === 750, 'a free-shipping promo is ignored: the buyer pays postage');

      console.log('\n== Expiry: reminder 30 days before, then expire (fake clock) ==');
      // Fresh buyers whose last win is placed in the past; the job runs at a fake "now".
      const Ex = await mkUser('ex'), Ex2 = await mkUser('ex2');
      die(await s.rpc('points_adjust', { p_user_id: Ex.id, p_points: 120, p_note: 'ZZ' }));
      die(await s.rpc('points_adjust', { p_user_id: Ex2.id, p_points: 120, p_note: 'ZZ' }));
      const lastWin = new Date(Date.now() - 2 * DAY);
      die(await s.from('points_accounts').update({ last_win_at: lastWin.toISOString() }).in('user_id', [Ex.id, Ex2.id]).select());
      const plus = (days) => new Date(lastWin.getTime() + days * DAY).toISOString();
      const exMails = () => mails().filter(x => x.to === Ex.email && /expire/.test(x.subject));
      await call(U, 'POST', `/__test/housekeeping?now=${encodeURIComponent(plus(300))}`);
      ok(exMails().length === 0 && await balance(Ex) === 120, 'month 10: nothing');
      await call(U, 'POST', `/__test/housekeeping?now=${encodeURIComponent(plus(345))}`);
      ok(exMails().length === 1 && exMails()[0].subject.startsWith('Your 120 points expire on'), `about 20 days before: reminder "${exMails()[0]?.subject}"`);
      await call(U, 'POST', `/__test/housekeeping?now=${encodeURIComponent(plus(350))}`);
      ok(exMails().length === 1, 'run again: no second reminder');
      // Ex2 wins again (new last_win_at): its expiry moves and the reminder re-arms for the new date.
      die(await s.from('points_accounts').update({ last_win_at: plus(340) }).eq('user_id', Ex2.id).select());
      await call(U, 'POST', `/__test/housekeeping?now=${encodeURIComponent(plus(367))}`);
      ok(await balance(Ex) === 0 && (await ledger(Ex)).some(x => x.kind === 'expire' && x.points === -120) && await balance(Ex2) === 120, '12 months + 2 days with no win: expired to 0; the buyer who won again keeps theirs');
      await call(U, 'POST', `/__test/housekeeping?now=${encodeURIComponent(plus(368))}`);
      ok((await ledger(Ex)).filter(x => x.kind === 'expire').length === 1, 'run again: nothing more to expire');

      console.log('\n== A5: deleting the account removes the points ==');
      const Del = await mkUser('del');
      die(await s.rpc('points_adjust', { p_user_id: Del.id, p_points: 77, p_note: 'ZZ' }));
      die(await s.from('promotion_uses').insert({ promotion_id: made.promos[1], user_id: Del.id, auction_id: X8 }).select());
      const newName = die(await s.rpc('delete_account', { p_user_id: Del.id }));
      const leftDel = (await s.from('points_ledger').select('id').eq('user_id', Del.id)).data.length + (await s.from('points_accounts').select('user_id').eq('user_id', Del.id)).data.length
        + (await s.from('promotion_uses').select('id').eq('user_id', Del.id)).data.length;
      ok(/^deleted_/.test(newName) && leftDel === 0, `delete_account: ledger, account and promo rows gone (${leftDel} left)`);

      ok(on.alive() && off.alive(), 'both servers still up');
      if (fails) console.log(on.log().split('\n').filter(l => /error|fail/i.test(l)).slice(0, 15).join('\n'));
    } catch (e) { console.log('ERR', e); fails++; }
  } finally {
    servers.forEach(x => x.stop());
    await s.from('points_settings').update({ enabled: before.enabled }).eq('id', 1);
    const users = made.users;
    if (users.length) {
      await s.from('points_ledger').delete().in('user_id', users);
      await s.from('points_accounts').delete().in('user_id', users);
      await s.from('promotion_uses').delete().in('user_id', users);
    }
    if (made.promos.length) await s.from('promotions').delete().in('id', made.promos);
    const invs = (await s.from('invoices').select('id').in('auction_id', made.auctions)).data || [];
    await s.from('orders').delete().in('auction_id', made.auctions);
    if (invs.length) await s.from('invoices').delete().in('id', invs.map(v => v.id));
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (users.length) {
      await s.from('account_deletions').delete().in('user_id', users);
      await s.from('reserved_usernames').delete().eq('username_hash', crypto.createHash('sha256').update(`zztest_pts_del_${TAG}`).digest('hex'));
      await s.from('profiles').delete().in('user_id', users);
      await s.from('users').delete().in('id', users);
    }
    await s.from('email_send_log').delete().gte('sent_at', new Date(Date.now() - 30 * 60e3).toISOString()).in('kind', ['won', 'failed', 'points_expiry', 'admin']);
    for (const f of [MAIL, CALLS]) try { fs.unlinkSync(f); } catch {}
    const left = (await s.from('auctions').select('id').like('title', P + '%')).data.length
      + (await s.from('users').select('id').like('username', 'zztest_pts_%')).data.length
      + (await s.from('orders').select('id').like('item_title', P + '%')).data.length
      + (users.length ? (await s.from('points_ledger').select('id').in('user_id', users)).data.length : 0)
      + (made.promos.length ? (await s.from('promotions').select('id').in('id', made.promos)).data.length : 0);
    const after = (await s.from('points_settings').select('enabled').eq('id', 1).single()).data;
    console.log('\nleftover throwaway rows:', left, '| points_settings.enabled restored to', after?.enabled);
    if (left || after?.enabled !== before.enabled) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; });
