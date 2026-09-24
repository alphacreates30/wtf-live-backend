// 200-lot close at scale (SCALE_200_LOTS_BRIEF.md s2). Slow (minutes) - not part of the quick suite run.
//
//   node verification/scale-200-close.js --yes-run-against-the-real-database [--lots=200] [--latency=800] [--only=single|double]
//
// The REAL autoCloseStandardItems() -> createOrderOnWin() -> buildAndChargeInvoicesForAuction() -> chargeInvoice()
// run in local copies of server.js against the real database, with THREE deliberate differences:
//   1. Stripe is an in-process FAKE (no network, no key, nothing charged). It counts every create() call per
//      invoice, adds latency, and declines for chosen buyers. So this proves our logic, NOT Stripe's latency.
//   2. Isolation: the fixture auction stays 'draft', which the PRODUCTION job skips, and the local copy of the job is
//      patched to touch ONLY the fixture auction. Otherwise the production server (same database, same job, every 30s)
//      would close it too - and this local copy would "charge" real auctions with fake Stripe.
//   3. Resend is blank and buyers have no email: nothing is sent.
// Every other line of the close path is unmodified. Numbers are from this machine to Supabase: a slower link than
// Railway's, so read them as an upper bound on the database side.
//
// Scenarios: 'single' = one server; 'double' = two servers running the job at once (overlapping ticks - the job has only an in-process
// cross-instance guard: the in-process flag stops one server overlapping itself, but a redeploy overlap runs two.)
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const LOTS = +arg('lots', 200), LATENCY = +arg('latency', 800), ONLY = arg('only', '');
const BUYERS = 20, DECLINERS = [5, 13], THROWER = 9, WHALE_LOTS = Math.min(25, Math.floor(LOTS / 8));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const pad = n => String(n).padStart(2, '0');
const uname = n => 'zztest_scale_b' + pad(n);

// ---------- patched server source ----------
function patchedServer(fixId, tag) {
  let src = require('./guard').readSource(BE + '/server.js');
  const rep = (a, b) => { if (!src.includes(a)) throw new Error('patch marker not found: ' + a.slice(0, 70)); src = src.replace(a, b); };
  // 1. fake Stripe
  rep("const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;",
`const stripe = { paymentIntents: {
  create: async (p, o) => {
    const t0 = Date.now();
    require('fs').appendFileSync(process.env.ZZ_STRIPE_LOG, JSON.stringify({ t: t0, invoice: p.metadata && p.metadata.invoice_id, customer: p.customer, amount: p.amount, key: o && o.idempotencyKey, pid: process.pid }) + '\\n');
    await new Promise(r => setTimeout(r, +process.env.ZZ_LATENCY || 0));
    if (String(p.customer).endsWith('_DECLINE')) { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; throw e; }
    if (String(p.customer).endsWith('_THROW')) throw new Error('socket hang up (simulated unexpected error)');
    return { id: 'pi_ZZSCALE_' + require('crypto').randomUUID().slice(0, 10) };
  },
  retrieve: async () => ({}) } };`);
  // 2. isolation: only the fixture auction, and the draft exemption only for it
  rep(".lt('ends_at', now)\n      .not('status', 'in', '(\"sold\",\"unsold\")')", ".lt('ends_at', now)\n      .eq('auction_id', '" + fixId + "')\n      .not('status', 'in', '(\"sold\",\"unsold\")')");
  rep("if (draftAuctionIds.has(item.auction_id)) continue", "if (false) continue");
  // the fixture stays 'draft' until the job ends it, so 'draft' here plays the role of production's status='live' filter:
  // once the job marks it 'ended' it is NOT revisited (dropping the status filter entirely made the job re-charge it every tick)
  rep(".eq('mode', 'standard')\n      .eq('status', 'live')\n    if (!liveAuctions?.length) return", ".eq('id', '" + fixId + "')\n      .eq('status', 'draft')\n    if (!liveAuctions?.length) return");
  // 3. instrumentation: tick boundaries + a count of Supabase HTTP requests, written to a per-process log
  rep("async function autoCloseStandardItems() {", "async function __realTick() {");
  rep("setInterval(autoCloseStandardItems, 30000)\nautoCloseStandardItems()",
`async function autoCloseStandardItems() {
  const t0 = Date.now(), r0 = global.__zzReqs, id = ++global.__zzTick;
  require('fs').appendFileSync(process.env.ZZ_TICK_LOG, JSON.stringify({ ev: 'start', tick: id, t: t0 }) + '\\n');
  try { await __realTick(); } finally { require('fs').appendFileSync(process.env.ZZ_TICK_LOG, JSON.stringify({ ev: 'end', tick: id, t: Date.now(), dur: Date.now() - t0, reqs: global.__zzReqs - r0 }) + '\\n'); }
}
setInterval(autoCloseStandardItems, 30000)
autoCloseStandardItems()`);
  return src;
}
async function boot(name, port, src, env) {
  const file = BE + '/server.tmp-' + name + '.js', runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(file, src);
  fs.writeFileSync(runner,
`global.__zzReqs = 0; global.__zzTick = 0;
const of = global.fetch; const host = new URL(process.env.SUPABASE_URL).host;
global.fetch = function (u, ...a) { try { if (String(u && u.url || u).includes(host)) global.__zzReqs++; } catch {} return of(u, ...a); };
process.env.PORT = '${port}'; process.env.STRIPE_SECRET_KEY = ''; process.env.RESEND_API_KEY = '';
require('./server.tmp-${name}.js');`);
  const logFd = fs.openSync(os.tmpdir() + '/zzscale-' + name + '.log', 'w');
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: ['ignore', logFd, logFd], env: { ...process.env, ...env } });
  for (let i = 0; i < 30; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { child, cleanup: () => { try { child.kill(); } catch {} try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}

// ---------- fixture ----------
async function mkFixture(label) {
  const users = [];
  for (let n = 1; n <= BUYERS; n++) users.push(die(await s.from('users').insert({ username: uname(n), password_hash: 'zztest-not-a-real-hash' }).select().single()));
  const auction = die(await s.from('auctions').insert({ title: 'ZZTEST_Scale_' + label, description: 'scale fixture', status: 'draft', mode: 'standard', buyers_premium_pct: 15, fulfillment_mode: 'shipping', host_username: 'whatthefind', starts_at: new Date().toISOString() }).select().single());
  for (let n = 1; n <= BUYERS; n++) {
    const cus = 'cus_ZZFAKE_' + pad(n) + (DECLINERS.includes(n) ? '_DECLINE' : n === THROWER ? '_THROW' : '');
    die(await s.from('profiles').insert({ user_id: String(users[n - 1].id), full_name: 'ZZ Scale ' + pad(n), email: null, phone: '0', address_line1: '1 ZZ St', city: 'Miami', state: 'FL', zip: '33125', country: 'US', status: 'approved', payment_status: 'ok', stripe_customer_id: cus, stripe_payment_method_id: 'pm_ZZFAKE_' + pad(n) }).select().single());
    die(await s.from('auction_terms_acceptances').insert({ auction_id: auction.id, user_id: String(users[n - 1].id), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: 'zz' }).select().single());
  }
  // lot plan: whale wins the first WHALE_LOTS; the middle band is spread over buyers 2..20 and SOLD; then 20 lots
  // with a bid but an unmet reserve (unsold); the rest have no bids (unsold)
  const soldEnd = Math.floor(LOTS * 0.75), reserveEnd = soldEnd + Math.floor(LOTS * 0.1);
  const t0 = Date.now() + 45000, plan = [];
  for (let i = 0; i < LOTS; i++) {
    let buyer = null, bid = 0, reserve = null;
    if (i < WHALE_LOTS) { buyer = 1; bid = 5 + (i % 7) * 3; }
    else if (i < soldEnd) { buyer = 2 + (i % (BUYERS - 1)); bid = 4 + (i * 7) % 90 + 0.5 * (i % 3); }
    else if (i < reserveEnd) { buyer = 2 + (i % (BUYERS - 1)); bid = 10; reserve = 50; }
    plan.push({ i, buyer, bid, reserve, sold: !!buyer && reserve == null });
  }
  const rows = plan.map(p => ({ auction_id: auction.id, title: 'ZZTEST scale lot ' + (p.i + 1), starting_bid: 1, position: p.i, status: 'pending', ends_at: new Date(t0 + p.i * 1000).toISOString(), current_bid: p.bid, leading_bidder: p.buyer ? uname(p.buyer) : null, bid_count: p.buyer ? 1 : 0, reserve_price: p.reserve }));
  for (let k = 0; k < rows.length; k += 50) die(await s.from('auction_items').insert(rows.slice(k, k + 50)).select('id'));
  const expected = {};
  for (const p of plan.filter(x => x.sold)) { const h = Math.round(p.bid * 100), pr = Math.round(h * 15 / 100); const e = expected[p.buyer] || (expected[p.buyer] = { lots: 0, total: 0 }); e.lots++; e.total += h + pr; }
  return { auction, users, plan, expected, lastEnd: t0 + (LOTS - 1) * 1000 };
}
async function cleanup(F) {
  if (!F) return;
  await s.from('orders').delete().eq('auction_id', F.auction.id);
  await s.from('invoices').delete().eq('auction_id', F.auction.id);
  const r = await s.rpc('delete_auction_cascade', { p_auction_id: F.auction.id });
  if (r.error) console.log('  cleanup: delete_auction_cascade error', r.error.message);
  const ids = F.users.map(u => String(u.id));
  await s.from('profiles').delete().in('user_id', ids);
  await s.from('users').delete().in('id', F.users.map(u => u.id));
}

// ---------- run one scenario ----------
async function scenario(name, instances) {
  console.log(`\n================ scenario: ${name} (${instances} server instance${instances > 1 ? 's' : ''}, fake-Stripe latency ${LATENCY}ms/call) ================`);
  let F, servers = [];
  const stripeLog = os.tmpdir() + '/zzscale-stripe-' + name + '.log'; fs.writeFileSync(stripeLog, '');
  try {
    F = await mkFixture(name);
    console.log(`fixture: ${LOTS} lots closing 1s apart (last at +${Math.round((F.lastEnd - Date.now()) / 1000)}s), ${Object.keys(F.expected).length} winning buyers, expected sold ${F.plan.filter(p => p.sold).length}, unsold ${F.plan.filter(p => !p.sold).length}; declining buyers ${DECLINERS.map(pad)}, erroring buyer ${pad(THROWER)}`);
    const src = patchedServer(F.auction.id, name);
    const tickLogs = [];
    for (let k = 0; k < instances; k++) {
      const tl = os.tmpdir() + `/zzscale-tick-${name}-${k}.log`; fs.writeFileSync(tl, ''); tickLogs.push(tl);
      servers.push(await boot(name + k, 3301 + k + (name === 'double' ? 10 : 0), src, { ZZ_STRIPE_LOG: stripeLog, ZZ_TICK_LOG: tl, ZZ_LATENCY: String(LATENCY) }));
    }
    const start = Date.now(); let endedAt = null;
    const deadline = F.lastEnd + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const a = die(await s.from('auctions').select('status').eq('id', F.auction.id).single());
      if (a.status === 'ended') { endedAt = Date.now(); break; }
    }
    await sleep(35000); // let a trailing tick (or the second instance) finish anything still in flight
    ok(!!endedAt, `auction reached 'ended' (${endedAt ? Math.round((endedAt - F.lastEnd) / 1000) + 's after the last lot ends' : 'TIMED OUT'})`);

    // ---- invariants ----
    const items = die(await s.from('auction_items').select('id,position,status,leading_bidder,current_bid').eq('auction_id', F.auction.id));
    const orders = die(await s.from('orders').select('id,item_id,buyer_username,total_cents,hammer_cents,premium_cents,invoice_id,payment_status,payment_intent_id').eq('auction_id', F.auction.id));
    const invoices = die(await s.from('invoices').select('id,buyer_username,total_cents,payment_status,payment_intent_id,payment_error,created_at,charging_since').eq('auction_id', F.auction.id));
    const soldItems = F.plan.filter(p => p.sold).length;
    ok(items.every(i => i.status === 'sold' || i.status === 'unsold') && items.filter(i => i.status === 'sold').length === soldItems, `every lot closed, ${items.filter(i => i.status === 'sold').length} sold / ${items.filter(i => i.status === 'unsold').length} unsold (expected ${soldItems} sold)`);
    const perItem = {}; orders.forEach(o => { perItem[o.item_id] = (perItem[o.item_id] || 0) + 1; });
    const dupes = Object.entries(perItem).filter(([, n]) => n > 1);
    ok(orders.length === soldItems && dupes.length === 0, `exactly ONE order per sold lot: ${orders.length} orders for ${soldItems} sold lots, ${dupes.length} lots with duplicate orders${dupes.length ? '  <- DOUBLE-BILLING: ' + dupes.slice(0, 3).map(d => d[0].slice(0, 8) + 'x' + d[1]).join(', ') : ''}`);
    ok(invoices.length === Object.keys(F.expected).length, `one invoice per winning buyer: ${invoices.length} invoices for ${Object.keys(F.expected).length} buyers`);
    let totalsOk = true; const bad = [];
    for (const [n, e] of Object.entries(F.expected)) { const inv = invoices.find(i => i.buyer_username === uname(+n)); const ords = orders.filter(o => o.buyer_username === uname(+n)); if (!inv || inv.total_cents !== e.total || ords.length !== e.lots || ords.some(o => o.invoice_id !== inv.id)) { totalsOk = false; bad.push(`b${pad(+n)}: invoice ${inv && inv.total_cents} vs expected ${e.total}, orders ${ords.length} vs ${e.lots}`); } }
    ok(totalsOk, 'every invoice total = the independently computed hammer+premium of that buyer\'s lots, and every order is linked to it' + (bad.length ? ' <- ' + bad.slice(0, 3).join('; ') : ''));
    const calls = fs.readFileSync(stripeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const byInv = {}; calls.forEach(c => { byInv[c.invoice] = (byInv[c.invoice] || 0) + 1; });
    const multi = Object.entries(byInv).filter(([, n]) => n > 1);
    ok(calls.length === invoices.length && multi.length === 0, `EXACTLY ONE charge attempt per invoice (fake Stripe saw ${calls.length} create() calls for ${invoices.length} invoices; ${multi.length} invoices charged more than once)${multi.length ? '  <- DOUBLE CHARGE' : ''}`);
    // AMOUNT charged, recomputed INDEPENDENTLY of the orders table and of the fixture plan: straight from the lots the
    // database says SOLD (winner + hammer, premium at 15%). Every check above proved charge COUNT; a 60% overcharge from
    // duplicate orders passed all of them. This is the assertion that catches it: what each buyer OWES vs the invoice
    // total AND vs every amount actually sent to Stripe for that invoice (the fake logs create() amounts).
    const owed = {};
    items.filter(i => i.status === 'sold').forEach(i => { const h = Math.round(Number(i.current_bid) * 100), pr = Math.round(h * 15 / 100); owed[i.leading_bidder] = (owed[i.leading_bidder] || 0) + h + pr; });
    const amountBad = [];
    for (const inv of invoices) {
      const want = owed[inv.buyer_username], sent = calls.filter(c => c.invoice === inv.id).map(c => c.amount);
      if (inv.total_cents !== want || sent.some(a => a !== want)) amountBad.push(`${inv.buyer_username.slice(-3)}: owes $${(want / 100).toFixed(2)}, invoice $${(inv.total_cents / 100).toFixed(2)}, sent to Stripe ${sent.map(a => '$' + (a / 100).toFixed(2)).join('/') || 'nothing'}`);
    }
    const owedTotal = Object.values(owed).reduce((a, b) => a + b, 0), invTotal = invoices.reduce((a, i) => a + i.total_cents, 0);
    ok(amountBad.length === 0 && invTotal === owedTotal && Object.keys(owed).length === invoices.length, `AMOUNT: every invoice total AND every amount sent to Stripe equals what that buyer owes for the lots that actually sold; all invoices together $${(invTotal / 100).toFixed(2)} vs owed $${(owedTotal / 100).toFixed(2)} (${owedTotal ? ((invTotal / owedTotal - 1) * 100).toFixed(1) : 0}% off)${amountBad.length ? '  <- WRONG AMOUNT: ' + amountBad.slice(0, 3).join('; ') : ''}`);
    const good = invoices.filter(i => !DECLINERS.includes(+i.buyer_username.slice(-2)) && +i.buyer_username.slice(-2) !== THROWER);
    ok(good.every(i => i.payment_status === 'paid' && i.payment_intent_id) && orders.filter(o => good.some(g => g.id === o.invoice_id)).every(o => o.payment_status === 'paid'), `all ${good.length} healthy buyers paid, incl. those AFTER the failures in the loop; their orders mirrored`);
    const failedInv = invoices.filter(i => i.payment_status === 'failed');
    ok(failedInv.length === DECLINERS.length + 1 && failedInv.every(i => i.payment_intent_id === null && i.payment_error), `the ${failedInv.length} failing buyers (2 declines + 1 error) are 'failed' with a recorded reason and no intent: ${failedInv.map(i => i.buyer_username.slice(-3) + ':"' + i.payment_error.slice(0, 22) + '"').join(', ')}`);
    const stuck = invoices.filter(i => i.payment_status === 'charging' || i.payment_status === 'unpaid');
    ok(stuck.length === 0, `no invoice left 'charging' or 'unpaid' (${stuck.length})`);

    // ---- measurements ----
    let ticks = []; tickLogs.forEach((tl, k) => { const ev = fs.readFileSync(tl, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); ev.filter(e => e.ev === 'end').forEach(e => ticks.push({ ...e, inst: k })); });
    const longest = ticks.reduce((a, b) => (b.dur > (a ? a.dur : -1) ? b : a), null);
    const work = ticks.filter(t => t.reqs > 40);
    const totalReqs = ticks.reduce((a, t) => a + t.reqs, 0);
    console.log(`\nMEASURED (${name}):`);
    console.log(`  ticks with real work: ${work.length}; idle-tick cost: ${Math.round(ticks.filter(t => t.reqs <= 40).reduce((a, t) => a + t.reqs, 0) / Math.max(1, ticks.filter(t => t.reqs <= 40).length))} requests`);
    console.log(`  longest tick: ${longest ? (longest.dur / 1000).toFixed(1) + 's, ' + longest.reqs + ' Supabase requests (instance ' + longest.inst + ')' : 'n/a'}${longest && longest.dur > 30000 ? '   <-- LONGER THAN THE 30s INTERVAL: the next tick fired while this one ran (the overlap guard makes it return at once)' : ''}`);
    console.log(`  total Supabase requests: ${totalReqs} for ${soldItems} sold + ${LOTS - soldItems} unsold lots  =>  ${(totalReqs / LOTS).toFixed(1)} per lot`);
    const closeTicks = work.filter(t => t.dur > 0).sort((a, b) => b.dur - a.dur).slice(0, 3).map(t => `${(t.dur / 1000).toFixed(1)}s/${t.reqs}req`).join(', ');
    console.log(`  three heaviest ticks: ${closeTicks}`);
    const chargeStamps = invoices.map(i => new Date(i.charging_since).getTime()).filter(Boolean).sort((a, b) => a - b);
    if (chargeStamps.length > 1) console.log(`  invoice charge loop: first claim -> last claim ${((chargeStamps[chargeStamps.length - 1] - chargeStamps[0]) / 1000).toFixed(1)}s for ${chargeStamps.length} invoices (${LATENCY}ms fake latency each)`);
    if (endedAt) console.log(`  last lot's ends_at -> auction 'ended': ${((endedAt - F.lastEnd) / 1000).toFixed(1)}s (poll granularity 5s)`);
    if (instances > 1) console.log(`  create() calls by process: ${JSON.stringify(calls.reduce((m, c) => (m[c.pid] = (m[c.pid] || 0) + 1, m), {}))}`);
  } finally {
    servers.forEach(x => x.cleanup());
    await cleanup(F);
    if (F) {
      const left = (await s.from('auctions').select('id').eq('id', F.auction.id)).data.length + (await s.from('orders').select('id').eq('auction_id', F.auction.id)).data.length + (await s.from('users').select('id').like('username', 'zztest_scale_%')).data.length + (await s.from('profiles').select('id').like('stripe_customer_id', 'cus_ZZFAKE_%')).data.length;
      console.log('leftover throwaway rows:', left);
    }
  }
}

(async () => {
  console.log(`scale-200-close: ${LOTS} lots, ${BUYERS} buyers, fake Stripe latency ${LATENCY}ms`);
  if (ONLY !== 'double') await scenario('single', 1);
  if (ONLY !== 'single') await scenario('double', 2);
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
