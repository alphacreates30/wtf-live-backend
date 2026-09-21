// /charge-winner authorisation scope. OLD is PINNED to the commit before the fix (a1b2dd5), so the reproduction stays valid.
// No Stripe key locally: the fixture buyer has no card, so a charge that gets past authorisation fails cleanly with
// "No payment method on file" and marks the invoice 'failed' - that DB write is the evidence the action was performed.
const fs = require('fs');
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
const OLD_COMMIT = 'a1b2dd5';

async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  const runner = BE + '/run.tmp-' + name + '.js';
  // Stripe/Resend forced empty: nothing can be charged or emailed from here.
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
// the caller hosts A only; B (its invoice and orders) belongs to a different host
const CALLER = 'zztest_chghost_a', OTHER = 'zztest_chghost_b', BUYER = 'zztest_chgbuyer';
const tok = jwt.sign({ id: crypto.randomUUID(), username: CALLER }, process.env.JWT_SECRET, { expiresIn: '10m' });
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const made = { auctions: [], invoices: [], orders: [] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const mkAuction = async (label, host) => { const d = die(await s.from('auctions').insert({ title: 'ZZTEST_chg_' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: host, ends_at: future(-1) }).select().single()); made.auctions.push(d.id); return d.id; };
const mkInvoice = async a => { const d = die(await s.from('invoices').insert({ auction_id: a, buyer_user_id: 'zztest-chgbuyer-' + a, buyer_username: BUYER, total_cents: 1610, payment_status: 'unpaid' }).select().single()); made.invoices.push(d.id); return d.id; };
const mkOrder = async (a, inv) => { const d = die(await s.from('orders').insert({ auction_id: a, invoice_id: inv || null, buyer_username: BUYER, buyer_user_id: 'zztest-chgbuyer-' + a, item_title: 'ZZTEST_chg lot', final_bid: 14, status: 'pending', payment_status: 'unpaid' }).select().single()); made.orders.push(d.id); return d.id; };
const charge = (port, body) => fetch('http://localhost:' + port + '/charge-winner', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const invState = async id => (await s.from('invoices').select('payment_status,payment_error').eq('id', id).single()).data;
const ordState = async id => (await s.from('orders').select('payment_status,payment_error').eq('id', id).single()).data;
const reset = async (inv, ord) => { await s.from('invoices').update({ payment_status: 'unpaid', payment_error: null, charging_since: null }).eq('id', inv); await s.from('orders').update({ payment_status: 'unpaid', payment_error: null }).eq('id', ord); };

(async () => {
  const servers = [];
  try {
    const oldSrc = execSync('git show ' + OLD_COMMIT + ':server.js', { cwd: BE, maxBuffer: 50e6 }).toString();
    const newSrc = fs.readFileSync(BE + '/server.js', 'utf8');
    const A = await mkAuction('A_callers', CALLER), B = await mkAuction('B_others', OTHER);
    const invA = await mkInvoice(A), invB = await mkInvoice(B);
    const ordA = await mkOrder(A, invA), ordB = await mkOrder(B, invB);
    const liveB = await mkOrder(B, null); // no invoice: chargeOrder path
    servers.push(await boot('old', 3271, oldSrc), await boot('new', 3272, newSrc));
    const untouched = async () => { const i = await invState(invB), o = await ordState(ordB), l = await ordState(liveB); return i.payment_status === 'unpaid' && o.payment_status === 'unpaid' && l.payment_status === 'unpaid'; };

    console.log(`== REPRODUCE on ${OLD_COMMIT} (pre-fix): caller hosts A only; targets things that live in B ==`);
    let r = await charge(3271, { auction_id: A, invoice_id: invB });
    let st = await invState(invB);
    ok(r.s === 402 && st.payment_status === 'failed', `OLD: {auction_id: A, invoice_id: <B's>} got past auth and ACTED on B's invoice: ${r.s}, B invoice now '${st.payment_status}' <- HOLE REPRODUCED`);
    await reset(invB, ordB);
    r = await charge(3271, { auction_id: A, order_id: ordB });
    st = await invState(invB);
    ok(r.s === 402 && st.payment_status === 'failed', `OLD: {auction_id: A, order_id: <B's>} acted on B's order/invoice: ${r.s}, B invoice '${st.payment_status}' <- HOLE REPRODUCED`);
    await reset(invB, ordB);
    r = await charge(3271, { invoice_id: invB });
    ok(r.s === 403 && await untouched(), `OLD control: invoice_id alone (auth derived from the invoice) is 403 (${r.s})`);

    console.log('\n== SAME requests on the FIXED code ==');
    r = await charge(3272, { auction_id: A, invoice_id: invB });
    ok(r.s === 404 && await untouched(), `NEW: {auction_id: A, invoice_id: <B's>} -> ${r.s} ${r.j.error}, B untouched`);
    r = await charge(3272, { auction_id: A, order_id: ordB });
    ok(r.s === 404 && await untouched(), `NEW: {auction_id: A, order_id: <B's>} -> ${r.s}, B untouched`);
    r = await charge(3272, { auction_id: A, order_id: liveB });
    ok(r.s === 404 && await untouched(), `NEW: {auction_id: A, order_id: <B's invoice-less order>} -> ${r.s}, B untouched`);
    r = await charge(3272, { auction_id: A, invoice_id: invA, order_id: ordB });
    ok(r.s === 404 && await untouched(), `NEW: own invoice + someone else's order_id smuggled alongside -> ${r.s}, B untouched`);
    r = await charge(3272, { invoice_id: invB });
    ok(r.s === 403 && await untouched(), `NEW: invoice_id alone on B's invoice -> ${r.s}`);
    r = await charge(3272, { order_id: ordB });
    ok(r.s === 403 && await untouched(), `NEW: order_id alone on B's order -> ${r.s}`);
    r = await charge(3272, { auction_id: B, winner_username: BUYER });
    ok(r.s === 403 && await untouched(), `NEW: legacy auction_id=B + winner -> ${r.s}`);
    r = await charge(3272, { invoice_id: crypto.randomUUID() });
    ok(r.s === 404, `NEW: nonexistent invoice id -> ${r.s}`);
    r = await charge(3272, { order_id: crypto.randomUUID() });
    ok(r.s === 404, `NEW: nonexistent order id -> ${r.s}`);

    console.log('\n== FIXED code still allows the legitimate cases (they reach chargeInvoice: "No payment method", no Stripe) ==');
    r = await charge(3272, { invoice_id: invA });
    st = await invState(invA);
    ok(r.s === 402 && r.j.detail === 'No payment method on file' && st.payment_status === 'failed', `NEW: own invoice_id alone: ${r.s} "${r.j.detail}", invoice '${st.payment_status}'`);
    await reset(invA, ordA);
    r = await charge(3272, { auction_id: A, invoice_id: invA });
    ok(r.s === 402 && r.j.detail === 'No payment method on file', `NEW: own auction_id + invoice_id (what the UI sends): ${r.s} "${r.j.detail}"`);
    await reset(invA, ordA);
    r = await charge(3272, { auction_id: A.toUpperCase(), invoice_id: invA.toUpperCase(), order_id: ordA });
    ok(r.s === 402 && r.j.detail === 'No payment method on file', `NEW: UPPERCASE ids, invoice + its own order: ${r.s} "${r.j.detail}"`);
    await reset(invA, ordA);
    r = await charge(3272, { order_id: ordA });
    ok(r.s === 402 && r.j.detail === 'No payment method on file', `NEW: own order_id (routes to its invoice): ${r.s} "${r.j.detail}"`);
    await reset(invA, ordA);
    r = await charge(3272, { auction_id: A, winner_username: BUYER });
    ok(r.s === 402 || r.s === 404, `NEW: legacy auction_id + winner on own auction reaches the charge path: ${r.s} ${r.j.error}`);
  } finally {
    servers.forEach(x => x.cleanup());
    if (made.orders.length) await s.from('orders').delete().in('id', made.orders);
    if (made.invoices.length) await s.from('invoices').delete().in('id', made.invoices);
    if (made.auctions.length) await s.from('auctions').delete().in('id', made.auctions);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_chg_%')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_chg %')).data.length + (await s.from('invoices').select('id').in('id', made.invoices)).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
