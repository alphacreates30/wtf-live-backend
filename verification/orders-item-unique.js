// Fix 1: one order per lot, enforced by the DATABASE (migrations/2026-09-21g-orders-item-id-unique.sql). OLD is PINNED
// to the commit before the fix (670cdb5).
//
// createOrderOnWin checked "does this lot have an order?" and then inserted, with nothing unique underneath. Two callers
// (overlapping job ticks, or a second instance during a deploy) could both pass the check and both insert: measured on
// 2026-09-21, 267 orders for 150 sold lots. The invoice SUMS orders, so a duplicate order is a duplicate charge amount.
//
// The race is provoked deterministically: a test-only route in the local copies of server.js calls createOrderOnWin twice
// concurrently for the same lot (both run their existence check before either inserts).
//
// TWO PHASES, detected automatically:
//   BEFORE the migration is applied: shows that the race duplicates orders on BOTH the old and the new code (the new
//     handler is useless without the index), then exits 2 telling you to apply migration g.
//   AFTER: asserts the index refuses a raw duplicate, and that the concurrent double-call yields exactly one order and
//     the same order id from both callers.
// Borrows zztest_paid_ok as the winning buyer (read-only). Throwaway auction, lots and orders (ZZTEST_itemuniq).
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const info = m => console.log('     ' + m);
const OLD_COMMIT = '670cdb5', WINNER = 'zztest_paid_ok', RACES = 8;

const patch = src => {
  const mark = "// -- Stripe webhook --\napp.post('/webhook/stripe'";
  if (!src.includes(mark)) throw new Error('patch marker not found');
  return src.replace(mark, "app.post('/__zz/win', async (req, res) => { const { a, i, bid } = req.body; res.json(await Promise.all([createOrderOnWin(a, '" + WINNER + "', bid, i), createOrderOnWin(a, '" + WINNER + "', bid, i)])); });\n" + mark);
};
async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js', runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const made = { auctions: [], items: [] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
async function mkAuction(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_itemuniq_' + label, description: 'x', status: 'ended', mode: 'standard', buyers_premium_pct: 15, fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
  made.auctions.push(a.id);
  return a.id;
}
async function mkLots(a, n) {
  const ids = [];
  for (let k = 0; k < n; k++) { const i = die(await s.from('auction_items').insert({ auction_id: a, title: 'ZZTEST itemuniq lot ' + k, starting_bid: 1, position: k, status: 'sold', ends_at: new Date().toISOString(), current_bid: 20, leading_bidder: WINNER, bid_count: 1 }).select().single()); ids.push(i.id); made.items.push(i.id); }
  return ids;
}
const win = (port, a, i) => fetch('http://localhost:' + port + '/__zz/win', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, i, bid: 20 }) }).then(r => r.json());
const orderCount = async i => (await s.from('orders').select('id').eq('item_id', i)).data.length;
async function race(port, label) {
  const a = await mkAuction(label), lots = await mkLots(a, RACES);
  const out = [];
  for (const i of lots) { const ids = await win(port, a, i); out.push({ ids, n: await orderCount(i) }); }
  return out;
}

(async () => {
  const servers = [];
  try {
    // is the unique index there? try a raw duplicate insert (throwaway, removed either way)
    const probeA = await mkAuction('probe'); const [probeLot] = await mkLots(probeA, 1);
    const row = { auction_id: probeA, item_id: probeLot, buyer_username: WINNER, buyer_user_id: 'zztest-itemuniq', item_title: 'ZZTEST_itemuniq raw', final_bid: 1, status: 'pending', payment_status: 'unpaid' };
    die(await s.from('orders').insert(row).select().single());
    const dup = await s.from('orders').insert(row).select();
    const indexed = !!dup.error && dup.error.code === '23505';
    const oldSrc = execSync('git show ' + OLD_COMMIT + ':server.js', { cwd: BE, maxBuffer: 50e6 }).toString();
    const newSrc = fs.readFileSync(BE + '/server.js', 'utf8');
    servers.push(await boot('old', 3321, patch(oldSrc)), await boot('new', 3322, patch(newSrc)));

    if (!indexed) {
      console.log('== BEFORE migration g (no unique index): the race duplicates orders ==');
      const o = await race(3321, 'old'), n = await race(3322, 'new');
      const dO = o.filter(x => x.n > 1).length, dN = n.filter(x => x.n > 1).length;
      ok(dO > 0, `OLD code: ${dO} of ${RACES} concurrent double-calls created TWO orders for one lot  <- DUPLICATE ORDER = DUPLICATE CHARGE AMOUNT`);
      ok(dN > 0, `NEW code WITHOUT the index: ${dN} of ${RACES} still duplicated - the handler needs the index (this is why both go out together)`);
      console.error('\nmigrations/2026-09-21g-orders-item-id-unique.sql has not been applied. Apply it, then re-run this suite for the fixed-code assertions.\n');
      fails = 0; // the reproduction above is the expected outcome in this phase
      process.exitCode = 2;
    } else {
      console.log('== AFTER migration g: the database itself refuses a second order for a lot ==');
      ok(true, `raw duplicate insert refused: ${dup.error.code} ${dup.error.message.slice(0, 90)}`);
      const nullA = await mkAuction('nulls');
      const n1 = await s.from('orders').insert({ ...row, auction_id: nullA, item_id: null, item_title: 'ZZTEST_itemuniq null 1' }).select('id');
      const n2 = await s.from('orders').insert({ ...row, auction_id: nullA, item_id: null, item_title: 'ZZTEST_itemuniq null 2' }).select('id');
      ok(!n1.error && !n2.error, 'orders with NO item_id (live-auction orders) are unconstrained: two inserted fine');
      console.log('\n== the concurrent double-call, ' + RACES + ' times, on the FIXED code ==');
      const n = await race(3322, 'new');
      ok(n.every(x => x.n === 1), `NEW: exactly ONE order per lot in all ${RACES} races (counts: ${n.map(x => x.n).join(',')})`);
      ok(n.every(x => x.ids[0] && x.ids[0] === x.ids[1]), `NEW: and BOTH concurrent callers got the same order id back (the loser returned the winner's order, not null)`);
      console.log('\n== the OLD code against the same index (documenting, not a requirement) ==');
      const o = await race(3321, 'old');
      ok(o.every(x => x.n === 1), `OLD code + index: still one order per lot (the database stops the duplicate); the losing caller returned ${o.filter(x => !x.ids[0] || !x.ids[1]).length} of ${RACES} times null instead of the order`);
    }
  } finally {
    servers.forEach(x => x.cleanup());
    for (const id of made.auctions) { await s.from('orders').delete().eq('auction_id', id); }
    if (made.items.length) await s.from('auction_items').delete().in('id', made.items);
    for (const id of made.auctions) { await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_itemuniq_%')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_itemuniq %')).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  if (process.exitCode === 2) { console.log('\n(phase: BEFORE the migration - reproduction only)'); process.exit(2); }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
