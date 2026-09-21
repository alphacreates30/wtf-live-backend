// Fix 2: the AUTO-CLOSE JOB must never re-attempt a FAILED invoice; a HUMAN (manual Charge/Retry -> /charge-winner) still
// can. OLD is PINNED to the commit before the fix (670cdb5), where chargeInvoice's claim accepted 'failed' for everyone.
//
// Why it matters: an overlapping job tick (a tick outlasting its 30s interval, or a second instance) re-enters an
// auction it already charged; on the old code that re-claimed every FAILED invoice and re-attempted the declined card
// with a fresh idempotency key - an automatic retry nobody decided on. Measured on the 200-lot run: 23 charge attempts
// for 20 invoices.
//
// Stripe is an in-process FAKE (no key, no network, nothing charged, Resend blank). The job's call is reached through a
// test-only route patched into the local copies of server.js: it calls chargeInvoice(id, { auto: true }) exactly as
// buildAndChargeInvoicesForAuction does (on OLD it calls chargeInvoice(id): the old code has no such option, which is
// the point). Borrows zztest_paid_ok's profile read-only for the buyer's saved-card ids.
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
const OLD_COMMIT = '670cdb5';
const CALLS = os.tmpdir() + '/zztest-automan-' + process.pid + '.log';
const BUYER = 'zztest_paid_ok';

const FAKE = `const stripe = { paymentIntents: { create: async (p) => { require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ invoice: p.metadata && p.metadata.invoice_id }) + '\\n'); return { id: 'pi_ZZAUTOMAN_' + require('crypto').randomUUID().slice(0, 8) }; }, retrieve: async () => ({}) } };`;
const patch = (src, autoCall) => {
  const line = "const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;";
  const mark = "// -- Stripe webhook --\napp.post('/webhook/stripe'";
  if (!src.includes(line) || !src.includes(mark)) throw new Error('patch markers not found');
  return src.replace(line, FAKE).replace(mark, "app.post('/__zz/auto/:id', async (req, res) => { res.json(await " + autoCall + "); });\n" + mark);
};
async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js', runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const tok = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const made = { auctions: [], invoices: [], orders: [] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
let BUYER_ID;
async function mkInvoice(label, { status = 'unpaid', error = null, chargingAgoMin = null }) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_automan_' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
  made.auctions.push(a.id);
  const inv = die(await s.from('invoices').insert({ auction_id: a.id, buyer_user_id: BUYER_ID, buyer_username: BUYER, total_cents: 1610, payment_status: status, payment_error: error, charging_since: chargingAgoMin ? new Date(Date.now() - chargingAgoMin * 60e3).toISOString() : null }).select().single());
  made.invoices.push(inv.id);
  made.orders.push(die(await s.from('orders').insert({ auction_id: a.id, invoice_id: inv.id, buyer_username: BUYER, buyer_user_id: BUYER_ID, item_title: 'ZZTEST_automan lot', final_bid: 14, hammer_cents: 1400, premium_cents: 210, total_cents: 1610, status: 'pending', payment_status: status }).select().single()).id);
  return inv.id;
}
const inv = async id => (await s.from('invoices').select('payment_status,payment_intent_id,payment_error').eq('id', id).single()).data;
const attempts = id => { try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(l => l && JSON.parse(l).invoice === id).length; } catch { return 0; } };
const post = (port, path, body) => fetch('http://localhost:' + port + path, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));

(async () => {
  const servers = [];
  try {
    BUYER_ID = String(die(await s.from('users').select('id').eq('username', BUYER).single()).id);
    const oldSrc = execSync('git show ' + OLD_COMMIT + ':server.js', { cwd: BE, maxBuffer: 50e6 }).toString();
    const newSrc = fs.readFileSync(BE + '/server.js', 'utf8');
    servers.push(await boot('old', 3311, patch(oldSrc, 'chargeInvoice(req.params.id)')), await boot('new', 3312, patch(newSrc, 'chargeInvoice(req.params.id, { auto: true })')));

    console.log(`== REPRODUCE on ${OLD_COMMIT} (pre-fix): the job's call re-attempts a FAILED invoice ==`);
    let id = await mkInvoice('old_failed', { status: 'failed', error: 'Your card was declined.' });
    let r = await post(3311, '/__zz/auto/' + id); let st = await inv(id);
    ok(attempts(id) === 1 && st.payment_status === 'paid', `OLD: the job path re-attempted the declined invoice on its own (${attempts(id)} charge attempt, invoice now '${st.payment_status}')  <- AUTOMATIC RETRY OF A DECLINED CARD`);

    console.log('\n== SAME on the FIXED code ==');
    id = await mkInvoice('new_failed', { status: 'failed', error: 'Your card was declined.' });
    r = await post(3312, '/__zz/auto/' + id); st = await inv(id);
    ok(attempts(id) === 0 && r.j.skipped === true && st.payment_status === 'failed' && st.payment_error === 'Your card was declined.', `NEW: the job path SKIPS a failed invoice: ${attempts(id)} attempts, "${r.j.error}", invoice still '${st.payment_status}' with its original reason`);
    r = await post(3312, '/charge-winner', { invoice_id: id }); st = await inv(id);
    ok(r.s === 200 && attempts(id) === 1 && st.payment_status === 'paid' && st.payment_intent_id, `NEW: a HUMAN's /charge-winner (manual Retry) still picks the same failed invoice up: ${r.s}, ${attempts(id)} attempt, invoice '${st.payment_status}' with intent ${st.payment_intent_id}`);

    console.log('\n== FIXED code: the job still does its real work ==');
    id = await mkInvoice('new_unpaid', { status: 'unpaid' });
    r = await post(3312, '/__zz/auto/' + id); st = await inv(id);
    ok(attempts(id) === 1 && st.payment_status === 'paid', `NEW: the job path charges an UNPAID invoice: ${attempts(id)} attempt, '${st.payment_status}'`);
    r = await post(3312, '/__zz/auto/' + id);
    ok(attempts(id) === 1 && r.j.alreadyCharged === true, `NEW: the job path on the now-PAID invoice is a no-op (alreadyCharged, still ${attempts(id)} attempt)`);
    id = await mkInvoice('new_stale', { status: 'charging', chargingAgoMin: 10 });
    r = await post(3312, '/__zz/auto/' + id); st = await inv(id);
    ok(attempts(id) === 1 && st.payment_status === 'paid', `NEW: crash recovery is kept: an invoice stuck 'charging' for 10 min is reclaimed by the job (${attempts(id)} attempt, '${st.payment_status}')`);
    id = await mkInvoice('new_fresh_charging', { status: 'charging', chargingAgoMin: 1 });
    r = await post(3312, '/__zz/auto/' + id); st = await inv(id);
    ok(attempts(id) === 0 && r.j.skipped === true && st.payment_status === 'charging', `NEW: an invoice being charged right now (1 min) is left alone: ${attempts(id)} attempts, '${st.payment_status}'`);
    id = await mkInvoice('new_manual_failed_twice', { status: 'failed', error: 'x' });
    await post(3312, '/charge-winner', { invoice_id: id });
    ok(attempts(id) === 1, `NEW: manual retry attempts once per click (${attempts(id)})`);
  } finally {
    servers.forEach(x => x.cleanup());
    try { fs.unlinkSync(CALLS); } catch {}
    if (made.orders.length) await s.from('orders').delete().in('id', made.orders);
    if (made.invoices.length) await s.from('invoices').delete().in('id', made.invoices);
    if (made.auctions.length) await s.from('auctions').delete().in('id', made.auctions);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_automan_%')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_automan %')).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
