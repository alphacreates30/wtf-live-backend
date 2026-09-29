// Security review #19: the Stripe payment_intent.payment_failed webhook set an invoice (or order) to 'failed' even
// when it was already paid - a late failure event for an EARLIER attempt relabelled a later successful charge. Now
// it only touches rows with no PaymentIntent id (set only on success); unpaid ones still record the failure.
// OLD is PINNED to e8711c7 (before the fix). Local servers on the test database. Events are signed here with a
// throwaway webhook secret given to these servers only; the servers get a fake Stripe key so the webhook path
// exists, and their auto-close job is removed - nothing calls Stripe.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const Stripe = require(BE + '/node_modules/stripe');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'e8711c7';
const WHSEC = 'whsec_zztest_' + crypto.randomBytes(16).toString('hex');
const ENV = { STRIPE_SECRET_KEY: 'sk_test_zztest_not_a_real_key', STRIPE_WEBHOOK_SECRET: WHSEC };
const NO_AUTOCLOSE = [['setInterval(autoCloseStandardItems, 30000)\nautoCloseStandardItems()', '/* auto-close off for this suite */']];
const stripe = Stripe('sk_test_zztest_not_a_real_key');
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = [];

async function fixtures(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_whfail ' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind' }).select().single());
  made.push(a.id);
  const inv = async (paid) => die(await s.from('invoices').insert({ auction_id: a.id, buyer_user_id: 'zztest-whfail-' + (paid ? 'paid' : 'unpaid'), buyer_username: 'zztest_whfail', total_cents: 1150, payment_status: paid ? 'paid' : 'unpaid', payment_intent_id: paid ? 'pi_ZZTEST_paid_' + label : null }).select().single()).id;
  const order = async (paid, invoiceId, buyer) => die(await s.from('orders').insert({ auction_id: a.id, invoice_id: invoiceId, buyer_username: 'zztest_whfail', buyer_user_id: buyer, item_title: 'ZZTEST_whfail order', final_bid: 10, status: 'pending', payment_status: paid ? 'paid' : 'unpaid', payment_intent_id: paid ? 'pi_ZZTEST_paid_' + label : null }).select().single()).id;
  const paidInv = await inv(true), unpaidInv = await inv(false);
  return {
    paidInv, paidInvOrder: await order(true, paidInv, 'zztest-whfail-paid'),
    unpaidInv, unpaidInvOrder: await order(false, unpaidInv, 'zztest-whfail-unpaid'),
    paidOrder: await order(true, null, 'zztest-whfail-o1'), unpaidOrder: await order(false, null, 'zztest-whfail-o2'),
  };
}
async function failEvent(url, metadata) {
  const payload = JSON.stringify({ id: 'evt_zztest_' + crypto.randomBytes(6).toString('hex'), object: 'event', type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_ZZTEST_attempt', object: 'payment_intent', metadata, last_payment_error: { message: 'Your card was declined.' } } } });
  const r = await fetch(url + '/webhook/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) }, body: payload });
  return r.status;
}
const st = async (table, id) => die(await s.from(table).select('payment_status').eq('id', id).single()).payment_status;
async function run(url, f) {
  const codes = [await failEvent(url, { invoice_id: f.paidInv }), await failEvent(url, { invoice_id: f.unpaidInv }), await failEvent(url, { order_id: f.paidOrder }), await failEvent(url, { order_id: f.unpaidOrder })];
  return { codes, paidInv: await st('invoices', f.paidInv), paidInvOrder: await st('orders', f.paidInvOrder), unpaidInv: await st('invoices', f.unpaidInv), unpaidInvOrder: await st('orders', f.unpaidInvOrder), paidOrder: await st('orders', f.paidOrder), unpaidOrder: await st('orders', f.unpaidOrder) };
}

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('whfail-old', 3531, oldSrc, { env: ENV, patch: NO_AUTOCLOSE }), newSrv = await boot('whfail-new', 3532, newSrc, { env: ENV, patch: NO_AUTOCLOSE });
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT}: a late "payment failed" event arrives for invoices/orders ==`);
    let r = await run(oldSrv.url, await fixtures('old'));
    ok(r.codes.every(c => c === 200), `OLD: all 4 signed events accepted (${r.codes})`);
    ok(r.paidInv === 'failed' && r.paidInvOrder === 'failed' && r.paidOrder === 'failed', `OLD: a PAID invoice -> '${r.paidInv}' (its order '${r.paidInvOrder}'), a PAID order -> '${r.paidOrder}'  <- CHARGED, NOW SHOWN FAILED`);

    console.log('\n== SAME on the FIXED code ==');
    r = await run(newSrv.url, await fixtures('new'));
    ok(r.codes.every(c => c === 200), `NEW: all 4 signed events accepted (${r.codes})`);
    ok(r.paidInv === 'paid' && r.paidInvOrder === 'paid' && r.paidOrder === 'paid', `NEW: paid invoice stays '${r.paidInv}' (order '${r.paidInvOrder}'), paid order stays '${r.paidOrder}'`);
    ok(r.unpaidInv === 'failed' && r.unpaidInvOrder === 'failed' && r.unpaidOrder === 'failed', `NEW: unpaid invoice -> '${r.unpaidInv}' (order '${r.unpaidInvOrder}'), unpaid order -> '${r.unpaidOrder}' (real failures still recorded)`);
    const bad = await fetch(newSrv.url + '/webhook/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=bad' }, body: '{}' });
    ok(bad.status === 400, `NEW: an unsigned event is still refused (${bad.status})`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made) { await s.from('orders').delete().eq('auction_id', id); await s.from('invoices').delete().eq('auction_id', id); await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_whfail%')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_whfail%')).data.length + (await s.from('invoices').select('id').eq('buyer_username', 'zztest_whfail')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
