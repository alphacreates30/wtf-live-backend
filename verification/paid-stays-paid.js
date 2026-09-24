// #37: a charged invoice must stay 'paid' even if the won-and-charged email step throws. OLD is PINNED to the commit
// before the fix (1ffce81), so the reproduction stays valid.
//
// Stripe is FAKED inside the local test servers (source-replaced `const stripe`), so no real card, no real charge and
// no network call to Stripe. The email step is FORCED to throw by replacing the body of notifyInvoiceWonAndCharged
// (in real code it swallows its own errors, so today this is a structural hazard, not a live failure). Resend is
// blanked, so no email is sent either way. The fake counts create() calls in a temp file so "exactly one charge"
// is checked, not assumed.
// The throwaway invoices borrow the buyer profile of an existing fixture (read-only): zztest_paid_ok.
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '1ffce81';
const CALLS = os.tmpdir() + '/zztest-stripe-calls-' + process.pid + '.log';
const BUYER_USERNAME = 'zztest_paid_ok';

const FAKE_STRIPE = `const stripe = { paymentIntents: { create: async (p, o) => { require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ amount: p.amount, metadata: p.metadata }) + '\\n'); if (process.env.ZZ_DECLINE) { const e = new Error('Your card was declined.'); throw e; } return { id: 'pi_ZZTESTFAKE_' + require('crypto').randomUUID().slice(0, 8) }; }, retrieve: async () => ({}) } };`;
const withFakeStripe = src => { const line = "const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;"; if (!src.includes(line)) throw new Error('stripe line not found'); return src.replace(line, FAKE_STRIPE); };
const withNotifyThrowing = src => { const sig = "async function notifyInvoiceWonAndCharged(invoiceId, paymentIntentId) {"; if (!src.includes(sig)) throw new Error('notify fn not found'); return src.replace(sig, sig + "\n  throw new Error('ZZTEST forced notify failure');"); };

async function boot(name, port, source, env = '') {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; " + env + " require('./server.tmp-" + name + ".js');");
  const logFd = fs.openSync(os.tmpdir() + '/zztest-paidstays-' + name + '.log', 'w');
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: ['ignore', logFd, logFd] });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const tok = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const made = { auctions: [], invoices: [], orders: [] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
let BUYER_ID;
const mkInvoice = async (label, preset) => {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_paidstays_' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
  made.auctions.push(a.id);
  const inv = die(await s.from('invoices').insert({ auction_id: a.id, buyer_user_id: BUYER_ID, buyer_username: BUYER_USERNAME, total_cents: 1610, payment_status: preset ? 'paid' : 'unpaid', payment_intent_id: preset || null }).select().single());
  made.invoices.push(inv.id);
  for (const [t, h, p] of [['Lot 1', 100, 15], ['Lot 2', 1300, 195]]) {
    made.orders.push(die(await s.from('orders').insert({ auction_id: a.id, invoice_id: inv.id, buyer_username: BUYER_USERNAME, buyer_user_id: BUYER_ID, item_title: 'ZZTEST_paidstays ' + t, final_bid: h / 100, hammer_cents: h, premium_cents: p, total_cents: h + p, status: 'pending', payment_status: preset ? 'paid' : 'unpaid', payment_intent_id: preset || null }).select().single()).id);
  }
  return inv.id;
};
const charge = (port, invoice_id) => fetch('http://localhost:' + port + '/charge-winner', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ invoice_id }) }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const state = async id => {
  const i = (await s.from('invoices').select('payment_status,payment_intent_id,payment_error,payment_failed_email_sent_at').eq('id', id).single()).data;
  const o = (await s.from('orders').select('payment_status,payment_intent_id,payment_error').eq('invoice_id', id)).data;
  return { i, o, ordersPaid: o.every(x => x.payment_status === 'paid' && x.payment_intent_id === i.payment_intent_id) };
};
const createCalls = () => { try { return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

(async () => {
  const servers = [];
  try {
    BUYER_ID = die(await s.from('users').select('id').eq('username', BUYER_USERNAME).single()).id;
    const prof = die(await s.from('profiles').select('stripe_customer_id,stripe_payment_method_id').eq('user_id', String(BUYER_ID)).single());
    if (!prof.stripe_customer_id || !prof.stripe_payment_method_id) throw new Error('fixture buyer has no saved card');
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    // ports 3281-3285: old/new with the email step forced to throw; new with a healthy email step; new with a declining card
    servers.push(
      await boot('oldthrow', 3281, withNotifyThrowing(withFakeStripe(oldSrc))),
      await boot('newthrow', 3282, withNotifyThrowing(withFakeStripe(newSrc))),
      await boot('newok', 3283, withFakeStripe(newSrc)),
      await boot('newdecl', 3284, withFakeStripe(newSrc), "process.env.ZZ_DECLINE='1';"),
      // the wrapper switched off (its catch rethrows), so the throw DOES reach chargeInvoice's catch: only the guard is left
      await boot('newguard', 3285, withNotifyThrowing(withFakeStripe(newSrc).replace("console.error('won email failed after a successful charge (invoice stays paid):', invoiceId, e.message);", "throw e;"))),
    );

    console.log(`== REPRODUCE on ${OLD_COMMIT} (pre-fix): email step throws AFTER the charge ==`);
    let id = await mkInvoice('old_fresh'); let r = await charge(3281, id); let st = await state(id);
    ok(createCalls() === 1 && st.i.payment_intent_id && st.i.payment_status === 'failed', `OLD fresh charge (${createCalls()} fake charge): ${r.s}, invoice '${st.i.payment_status}' with payment_intent_id ${st.i.payment_intent_id} and error "${st.i.payment_error}"  <- PAID INVOICE FLIPPED TO FAILED`);
    ok(st.o.every(x => x.payment_status === 'failed' && x.payment_intent_id), `OLD: the child orders were flipped to failed too, still holding the intent id`);
    id = await mkInvoice('old_already', 'pi_ZZTESTFAKE_preset1'); r = await charge(3281, id); st = await state(id);
    ok(st.i.payment_status === 'failed' && st.i.payment_intent_id === 'pi_ZZTESTFAKE_preset1', `OLD already-charged path (a re-click on a paid invoice): invoice '${st.i.payment_status}' with intent ${st.i.payment_intent_id}  <- PAID INVOICE FLIPPED TO FAILED`);

    console.log('\n== SAME on the FIXED code ==');
    fs.writeFileSync(CALLS, '');
    id = await mkInvoice('new_fresh'); r = await charge(3282, id); st = await state(id);
    ok(createCalls() === 1 && r.s === 200 && r.j.success && st.i.payment_status === 'paid' && st.i.payment_error === null && st.ordersPaid && st.i.payment_failed_email_sent_at === null, `NEW fresh charge, email step throws: ${r.s}, exactly ${createCalls()} charge, invoice '${st.i.payment_status}', intent ${st.i.payment_intent_id}, orders mirrored, no payment-failed marker`);
    id = await mkInvoice('new_already', 'pi_ZZTESTFAKE_preset2'); const before = createCalls(); r = await charge(3282, id); st = await state(id);
    ok(createCalls() === before && r.s === 200 && st.i.payment_status === 'paid' && st.i.payment_intent_id === 'pi_ZZTESTFAKE_preset2' && st.ordersPaid, `NEW already-charged path, email step throws: ${r.s}, no new charge, invoice '${st.i.payment_status}', intent unchanged`);

    console.log('\n== FIXED code, second layer alone: wrapper disabled, so the throw reaches the failure handler ==');
    id = await mkInvoice('new_guard'); r = await charge(3285, id); st = await state(id);
    ok(r.s === 402 && st.i.payment_status === 'paid' && st.i.payment_error === null && st.i.payment_intent_id && st.ordersPaid, `NEW guard alone: the handler ran (${r.s}) but the invoice is STILL '${st.i.payment_status}' with intent ${st.i.payment_intent_id}, orders still paid`);

    console.log('\n== FIXED code, legitimate cases unchanged ==');
    fs.writeFileSync(CALLS, '');
    id = await mkInvoice('new_healthy'); r = await charge(3283, id); st = await state(id);
    ok(createCalls() === 1 && r.s === 200 && st.i.payment_status === 'paid' && st.ordersPaid, `NEW healthy email step: ${r.s}, ${createCalls()} charge, invoice '${st.i.payment_status}', orders mirrored`);
    fs.writeFileSync(CALLS, '');
    id = await mkInvoice('new_decl'); r = await charge(3284, id); st = await state(id);
    ok(createCalls() === 1 && r.s === 402 && r.j.detail === 'Your card was declined.' && st.i.payment_status === 'failed' && st.i.payment_intent_id === null && st.i.payment_error === 'Your card was declined.' && st.o.every(x => x.payment_status === 'failed' && x.payment_error === 'Your card was declined.'), `NEW a genuine decline is still recorded: ${r.s} "${r.j.detail}", invoice '${st.i.payment_status}', intent null, orders failed`);
    r = await charge(3284, id); st = await state(id);
    ok(createCalls() === 2 && r.s === 402 && st.i.payment_status === 'failed', `NEW retry of the failed invoice reaches the (fake) charge again: ${createCalls()} charges total, still 'failed'`);
  } finally {
    servers.forEach(x => x.cleanup());
    try { fs.unlinkSync(CALLS); } catch {}
    if (made.orders.length) await s.from('orders').delete().in('id', made.orders);
    if (made.invoices.length) await s.from('invoices').delete().in('id', made.invoices);
    if (made.auctions.length) await s.from('auctions').delete().in('id', made.auctions);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_paidstays_%')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_paidstays %')).data.length + (made.invoices.length ? (await s.from('invoices').select('id').in('id', made.invoices)).data.length : 0);
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
