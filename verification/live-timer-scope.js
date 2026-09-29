// Security review #2: the live-MODE auction timer must never end a STANDARD auction.
// resumeLiveAuctions (every boot) and join_auction (anyone) used to arm it on standard auctions; at the auction's
// own ends_at it set status 'ended' while lots were still open, and those lots then sold with no invoice (a buyer
// never charged). Also covers the recovery sweep for orders left without an invoice: auto-billed only when the
// auction's last lot closed within 24 hours; older ones, or a buyer who already has an invoice, email the admin only.
// OLD is PINNED to a928646 (before the fix). Local servers on the test database; Stripe and email blanked.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'a928646', BUYER = 'zztest_paid_ok';
const at = sec => new Date(Date.now() + sec * 1000).toISOString();
const made = [];
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };

const mkAuction = async (label, fields) => {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_ltimer ' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', buyers_premium_pct: 15, ends_at: at(3600), ...fields }).select().single());
  made.push(a.id); return a.id;
};
const mkLot = async (auctionId, fields) => die(await s.from('auction_items').insert({ auction_id: auctionId, title: 'ZZTEST_ltimer lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: at(3600), ...fields }).select().single()).id;
const status = async id => die(await s.from('auctions').select('status').eq('id', id).single()).status;
const joinAnonymously = (url, auctionId) => new Promise(res => {
  const c = io(url, { transports: ['websocket'] });
  c.on('connect', () => { c.emit('join_auction', { auctionId }); setTimeout(() => { c.close(); res(); }, 1000); });
  c.on('connect_error', () => res());
});

// One standard auction exists before boot (the boot-time resume arms it), one is armed by an anonymous
// join_auction after boot. Both have their auction-level ends_at 3s away and a lot open for another hour.
async function timerPhase(label, port, source) {
  const beforeBoot = await mkAuction(label + ' armed at boot', { ends_at: at(3) });
  await mkLot(beforeBoot, {});
  const srv = await boot('ltimer-' + label, port, source, { timers: 'real' });
  try {
    const byJoin = await mkAuction(label + ' armed by join', { ends_at: at(3) });
    await mkLot(byJoin, {});
    await joinAnonymously(srv.url, byJoin);
    await sleep(7000);
    return { boot: await status(beforeBoot), join: await status(byJoin) };
  } finally { srv.stop(); }
}

// Stranded orders as the bug left them: an ENDED standard auction, a sold lot, an order with no invoice.
async function strandedCase(label, lotClosedSecAgo, buyerId, { existingInvoice = false } = {}) {
  const a = await mkAuction(label, { status: 'ended', ends_at: at(-lotClosedSecAgo - 60) });
  const lot = await mkLot(a, { status: 'sold', current_bid: 10, bid_count: 1, leading_bidder: BUYER, ends_at: at(-lotClosedSecAgo) });
  let invoice = null;
  if (existingInvoice) {
    invoice = die(await s.from('invoices').insert({ auction_id: a, buyer_user_id: buyerId, buyer_username: BUYER, total_cents: 500, payment_status: 'paid', payment_intent_id: 'pi_ZZTESTFAKE_ltimer' }).select().single()).id;
  }
  const order = die(await s.from('orders').insert({ auction_id: a, item_id: lot, buyer_username: BUYER, buyer_user_id: buyerId, item_title: 'ZZTEST_ltimer ' + label, final_bid: 10, hammer_cents: 1000, premium_cents: 150, total_cents: 1150, status: 'pending', payment_status: 'unpaid' }).select().single()).id;
  return { auction: a, order, invoice };
}
const orderRow = async id => die(await s.from('orders').select('invoice_id, payment_status').eq('id', id).single());
const invoicesOf = async a => die(await s.from('invoices').select('id, total_cents, payment_status, payment_intent_id').eq('auction_id', a));

(async () => {
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const buyerId = String(die(await s.from('users').select('id').eq('username', BUYER).single()).id);

    console.log(`== REPRODUCE on ${OLD_COMMIT}: live-mode timer on standard auctions (auction ends_at +3s, lot open 1h) ==`);
    let r = await timerPhase('old', 3361, oldSrc);
    ok(r.boot === 'ended', `OLD: auction armed at boot is '${r.boot}' with its lot still open  <- ENDED EARLY (no invoice will ever be built)`);
    ok(r.join === 'ended', `OLD: auction armed by an anonymous join_auction is '${r.join}'  <- ENDED EARLY`);

    console.log('\n== SAME on the FIXED code ==');
    r = await timerPhase('new', 3362, newSrc);
    ok(r.boot === 'live', `NEW: auction present at boot is still '${r.boot}'`);
    ok(r.join === 'live', `NEW: auction joined anonymously is still '${r.join}'`);

    console.log('\n== Recovery sweep for orders left without an invoice ==');
    const recent = await strandedCase('recent', 3600, buyerId);
    const stale = await strandedCase('older than 24h', 48 * 3600, buyerId);
    const hasInv = await strandedCase('recent, buyer already invoiced', 3600, buyerId, { existingInvoice: true });

    let srv = await boot('ltimer-sweep-old', 3363, oldSrc);
    await sleep(8000); srv.stop();
    ok((await invoicesOf(recent.auction)).length === 0 && !(await orderRow(recent.order)).invoice_id, `OLD control: nothing bills the recent stranded order (no invoice after a boot-time auto-close run)`);

    srv = await boot('ltimer-sweep-new', 3364, newSrc, { log: true });
    let inv = [];
    for (let i = 0; i < 20 && !inv.length; i++) { await sleep(1000); inv = await invoicesOf(recent.auction); }
    for (let i = 0; i < 20 && !(srv.log().includes(stale.order) && srv.log().includes(hasInv.order)); i++) await sleep(1000);
    const log = srv.log(); srv.stop();
    if (process.env.ZZ_DEBUG) console.log('--- server log ---\n' + log);
    inv = await invoicesOf(recent.auction);
    const ro = await orderRow(recent.order);
    ok(inv.length === 1 && inv[0].total_cents === 1150 && ro.invoice_id === inv[0].id, `NEW recent (<24h): one invoice created, total ${inv[0] && inv[0].total_cents} cents = the order's 1150, order linked`);
    ok(inv[0] && inv[0].payment_status === 'failed' && ro.payment_status === 'failed', `NEW recent: the charge was attempted (Stripe blanked here, so it records '${inv[0] && inv[0].payment_status}'; nothing charged)`);
    const so = await orderRow(stale.order);
    ok((await invoicesOf(stale.auction)).length === 0 && !so.invoice_id && so.payment_status === 'unpaid', `NEW older than 24h: no invoice, order untouched ('${so.payment_status}')`);
    ok(log.includes(stale.order) && log.includes('Older than 24 hours'), `NEW older than 24h: reported for the admin instead ("Older than 24 hours: not charged automatically")`);
    const ho = await orderRow(hasInv.order), hi = await invoicesOf(hasInv.auction);
    ok(!ho.invoice_id && hi.length === 1 && hi[0].payment_status === 'paid' && hi[0].payment_intent_id === 'pi_ZZTESTFAKE_ltimer' && hi[0].total_cents === 500, `NEW buyer already invoiced: order NOT linked, existing paid invoice unchanged`);
    ok(log.includes(hasInv.order) && log.includes('Existing invoice'), `NEW buyer already invoiced: reported for the admin instead`);
  } finally {
    for (const id of made) {
      await s.from('orders').delete().eq('auction_id', id);
      await s.from('invoices').delete().eq('auction_id', id);
      const d = await s.rpc('delete_auction_cascade', { p_auction_id: id });
      if (d.error) console.log('cleanup error', id, d.error.message);
    }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_ltimer%')).data.length
      + (await s.from('orders').select('id').like('item_title', 'ZZTEST_ltimer%')).data.length
      + (await s.from('auction_items').select('id').like('title', 'ZZTEST_ltimer%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
