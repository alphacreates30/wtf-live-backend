// #48: an invoice build must not miss a sold lot's order. OLD is PINNED to the commit before the fix (9ffdcfb) -
// the commit that landed the DUPLICATE-order fix (orders_item_id_key) and the deploy-hazard README box, but before
// this one.
//
// The bug: closing a lot is two steps - flip auction_items.status to 'sold', THEN insert its order
// (createOrderOnWin). A second instance/tick can see "no open items left" for the auction (status already flipped)
// and start building+charging invoices - which only sums orders that ALREADY EXIST - before the first instance's
// createOrderOnWin call has landed. The invoice is built short by that lot's amount, the order arrives afterward
// with no invoice_id, and because the auction is now 'ended' nothing ever revisits it: the buyer is permanently
// undercharged for that lot. Not the same bug as the duplicate-order race (orders_item_id_key does nothing for
// this one - there is no duplicate here, just a missing one).
//
// The race is SIMULATED deterministically: a test-only route flips one lot to 'sold' and then, after an injected
// delay, calls the real createOrderOnWin - exactly Step 1's own sequence, just with the gap widened so a second
// test-only route (the real per-auction "is everything closed" check - maybeEndStandardAuction on NEW,
// a literal copy of the pinned OLD commit's equivalent inline block for OLD) can be driven into that gap on
// purpose. Both routes call the SAME real functions the auto-close job calls (createOrderOnWin,
// buildAndChargeInvoicesForAuction, and on NEW, maybeEndStandardAuction itself) - only the OLD "no missing-order
// check" branch is a literal, frozen copy of that pinned commit's own inline code, since it was never a separate
// function there. Throwaway auction/lot/order/invoice (ZZTEST_undercharge), borrows zztest_paid_ok as the winning
// buyer (read-only). No Stripe key is set, so nothing is charged - buildAndChargeInvoicesForAuction only builds
// the invoice row itself here (chargeInvoice hits "Stripe not configured" and marks it failed, which is fine -
// this suite is about whether the invoice/order was built at all, not whether the card went through).
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '9ffdcfb', WINNER = 'zztest_paid_ok', DELAY_MS = 2500;

const CLOSE_ITEM_ROUTE = `
app.post('/__zz/close-item/:id', async (req, res) => {
  const { data: item, error } = await supabase.from('auction_items').select('id, auction_id, bid_count, leading_bidder, current_bid, reserve_price').eq('id', req.params.id).single();
  if (error || !item) return res.status(404).json({ error: 'not found' });
  const hasWinner = !!item.leading_bidder && item.bid_count > 0;
  const reserve = item.reserve_price != null ? parseFloat(item.reserve_price) : null;
  const metReserve = reserve == null || parseFloat(item.current_bid || 0) >= reserve;
  const sold = hasWinner && metReserve;
  await supabase.from('auction_items').update({ status: sold ? 'sold' : 'unsold' }).eq('id', item.id);
  if (sold) {
    const delayMs = (req.body && req.body.delayMs) || 0;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    await createOrderOnWin(item.auction_id, item.leading_bidder, item.current_bid, item.id);
  }
  res.json({ ok: true, sold });
});`;
// Literal copy of the pinned OLD commit's own inline per-auction body (it was never a separate function there) -
// no missing-order check.
const OLD_END_AUCTION_ROUTE = `
app.post('/__zz/end-auction/:id', async (req, res) => {
  const auctionId = req.params.id;
  const { data: openItems } = await supabase.from('auction_items').select('id').eq('auction_id', auctionId).not('status', 'in', '("sold","unsold")');
  if (openItems?.length) return res.json({ ended: false });
  const { data: allItems } = await supabase.from('auction_items').select('id').eq('auction_id', auctionId);
  if (!allItems?.length) return res.json({ ended: false });
  try { await buildAndChargeInvoicesForAuction(auctionId); } catch (e) { console.error('inv err', e.message); }
  await supabase.from('auctions').update({ status: 'ended' }).eq('id', auctionId);
  res.json({ ended: true });
});`;
// NEW: calls the real (fixed) function directly - not a reimplementation.
const NEW_END_AUCTION_ROUTE = `
app.post('/__zz/end-auction/:id', async (req, res) => { res.json(await maybeEndStandardAuction(req.params.id)); });`;

const patch = (src, endAuctionRoute) => {
  const mark = "// -- Stripe webhook --\napp.post('/webhook/stripe'";
  if (!src.includes(mark)) throw new Error('patch marker not found');
  return src.replace(mark, CLOSE_ITEM_ROUTE + endAuctionRoute + '\n' + mark);
};
async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js', runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const made = { auctions: [] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
async function mkFixture(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_undercharge_' + label, description: 'x', status: 'live', mode: 'standard', buyers_premium_pct: 15, fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
  made.auctions.push(a.id);
  const item = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST undercharge lot', starting_bid: 1, position: 0, status: 'pending', ends_at: new Date().toISOString(), current_bid: 20, leading_bidder: WINNER, bid_count: 1 }).select().single());
  return { auctionId: a.id, itemId: item.id };
}
const closeItem = (port, id, delayMs) => fetch('http://localhost:' + port + '/__zz/close-item/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delayMs }) }).then(r => r.json());
const endAuction = (port, id) => fetch('http://localhost:' + port + '/__zz/end-auction/' + id, { method: 'POST' }).then(r => r.json());
const orderFor = async itemId => (await s.from('orders').select('id, invoice_id, total_cents').eq('item_id', itemId).maybeSingle()).data;
const invoiceFor = async auctionId => (await s.from('invoices').select('id, total_cents').eq('auction_id', auctionId).maybeSingle()).data;
const auctionStatus = async id => (await s.from('auctions').select('status').eq('id', id).single()).data.status;

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    servers.push(await boot('undold', 3331, patch(oldSrc, OLD_END_AUCTION_ROUTE)), await boot('undnew', 3332, patch(newSrc, NEW_END_AUCTION_ROUTE)));

    console.log(`== REPRODUCE on ${OLD_COMMIT} (pre-fix): invoice build runs while the sold lot's order is still in flight ==`);
    let fx = await mkFixture('old');
    const closingOld = closeItem(3331, fx.itemId, DELAY_MS);
    await sleep(600); // item already flipped to 'sold' server-side by now; createOrderOnWin is still sleeping
    let end1 = await endAuction(3331, fx.auctionId);
    ok(end1.ended === true, `OLD: end-auction proceeded straight to ending the auction while the order was still in flight (${JSON.stringify(end1)})`);
    let invAfterFirstEnd = await invoiceFor(fx.auctionId);
    ok(!invAfterFirstEnd, `OLD: no invoice was built for the buyer at all - the order didn't exist yet when invoices were built (buildAndChargeInvoicesForAuction saw zero orders and no-op'd)`);
    await closingOld; // let the delayed createOrderOnWin land
    const orderOld = await orderFor(fx.itemId);
    const statusOld = await auctionStatus(fx.auctionId);
    ok(!!orderOld && !orderOld.invoice_id, `OLD: the order DID arrive (${orderOld?.id}) but with no invoice_id - it can never be charged, because the auction is already '${statusOld}' and auto-close never revisits an ended auction  <- BUYER PERMANENTLY UNDERCHARGED for this lot ($${((orderOld?.total_cents || 0) / 100).toFixed(2)} never billed)`);

    console.log('\n== SAME race on the FIXED code: the invoice build must defer instead ==');
    fx = await mkFixture('new');
    const closingNew = closeItem(3332, fx.itemId, DELAY_MS);
    await sleep(600);
    let endFirst = await endAuction(3332, fx.auctionId);
    ok(endFirst.ended === false && endFirst.deferred === true, `NEW: end-auction DEFERRED instead of building short - the missing-order check caught it: ${JSON.stringify(endFirst)}`);
    let statusMid = await auctionStatus(fx.auctionId);
    ok(statusMid === 'live', `NEW: the auction is still 'live' after the deferred attempt (not falsely ended): '${statusMid}'`);
    let invMid = await invoiceFor(fx.auctionId);
    ok(!invMid, `NEW: and no invoice was built yet either (nothing to undercharge with)`);
    await closingNew; // the order lands
    const orderMidNew = await orderFor(fx.itemId);
    ok(!!orderMidNew, `NEW: the order has now landed (${orderMidNew?.id})`);

    console.log('\n== NEW: the next tick re-enters the same check and now finds every sold lot covered ==');
    let endSecond = await endAuction(3332, fx.auctionId);
    ok(endSecond.ended === true, `NEW: end-auction now proceeds: ${JSON.stringify(endSecond)}`);
    const orderNew = await orderFor(fx.itemId);
    const invNew = await invoiceFor(fx.auctionId);
    const statusNew = await auctionStatus(fx.auctionId);
    ok(statusNew === 'ended', `NEW: auction is now 'ended': '${statusNew}'`);
    ok(!!invNew && !!orderNew && orderNew.invoice_id === invNew.id, `NEW: the order is linked to a real invoice (order.invoice_id ${orderNew?.invoice_id} === invoice.id ${invNew?.id})`);
    ok(!!invNew && invNew.total_cents === orderNew.total_cents, `NEW: invoice total ($${((invNew?.total_cents || 0) / 100).toFixed(2)}) matches exactly what the order says was owed ($${((orderNew?.total_cents || 0) / 100).toFixed(2)}) - fully billed, not shorted`);
  } finally {
    servers.forEach(x => x.cleanup());
    for (const id of made.auctions) {
      await s.from('orders').delete().eq('auction_id', id);
      await s.from('invoices').delete().eq('auction_id', id);
    }
    for (const id of made.auctions) { await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_undercharge_%')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST undercharge%')).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
