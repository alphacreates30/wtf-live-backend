// Security review #6: live-MODE socket events must not act on a STANDARD auction. The old place_bid handler (and
// its SQL function) never checked the mode, so an approved buyer could set a standard auction's auction-level
// leading_bidder/current_bid, and end_auction ended a standard auction with no invoices.
// OLD is PINNED to a928646 (before the fix). Local servers on the test database; Stripe and email blanked.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'a928646', BUYER = 'zztest_paid_ok';
const at = sec => new Date(Date.now() + sec * 1000).toISOString();
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = [];
const mkAuction = async (label, mode) => {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_lsock ' + label, description: 'x', status: 'live', mode, fulfillment_mode: 'shipping', host_username: 'whatthefind', starting_bid: 0, current_bid: 0, ends_at: at(3600) }).select().single());
  made.push(a.id); return a.id;
};
const row = async id => die(await s.from('auctions').select('status, leading_bidder, current_bid').eq('id', id).single());
// Emits one event and collects what the server sends back for a moment.
const emit = (url, event, payload) => new Promise(res => {
  const c = io(url, { transports: ['websocket'] }); const got = [];
  c.onAny((e, p) => got.push(e + ' ' + JSON.stringify(p)));
  c.on('connect', () => { c.emit(event, payload); setTimeout(() => { c.close(); res(got); }, 2000); });
  c.on('connect_error', () => res(got));
});

async function phase(label, port, source) {
  const srv = await boot('lsock-' + label, port, source);
  try {
    const buyer = die(await s.from('users').select('id, username').eq('username', BUYER).single());
    const buyerTok = jwt.sign({ id: buyer.id, username: buyer.username }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const adminTok = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const std = await mkAuction(label + ' standard (bid)', 'standard');
    const stdEnd = await mkAuction(label + ' standard (end)', 'standard');
    const live = await mkAuction(label + ' live-mode control', 'live');
    const bidEvents = await emit(srv.url, 'place_bid', { auctionId: std, amount: 50, token: buyerTok });
    const endEvents = await emit(srv.url, 'end_auction', { auctionId: stdEnd, token: adminTok });
    const liveEvents = await emit(srv.url, 'place_bid', { auctionId: live, amount: 7, token: buyerTok });
    return { bid: await row(std), bidEvents, end: await row(stdEnd), endEvents, live: await row(live), liveEvents };
  } finally { srv.stop(); }
}

(async () => {
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');

    console.log(`== REPRODUCE on ${OLD_COMMIT}: live-mode socket events on a STANDARD auction ==`);
    let r = await phase('old', 3371, oldSrc);
    ok(r.bid.leading_bidder === BUYER && Number(r.bid.current_bid) === 50, `OLD: socket place_bid on a standard auction set its auction-level leader to ${r.bid.leading_bidder} at $${r.bid.current_bid}  <- WRITTEN`);
    ok(r.end.status === 'ended', `OLD: admin end_auction on a standard auction -> '${r.end.status}'  <- ENDED WITHOUT INVOICES`);

    console.log('\n== SAME on the FIXED code ==');
    r = await phase('new', 3372, newSrc);
    ok(!r.bid.leading_bidder && Number(r.bid.current_bid) === 0 && r.bidEvents.some(e => e.startsWith('bid_error')), `NEW: place_bid on a standard auction refused (${r.bidEvents.find(e => e.startsWith('bid_error'))}), auction unchanged`);
    ok(r.end.status === 'live' && r.endEvents.some(e => e.startsWith('host_error')), `NEW: end_auction on a standard auction refused (${r.endEvents.find(e => e.startsWith('host_error'))}), still '${r.end.status}'`);
    ok(r.live.leading_bidder === BUYER && Number(r.live.current_bid) === 7, `NEW control: a real live-mode auction still takes a socket bid (leader ${r.live.leading_bidder} at $${r.live.current_bid})`);
  } finally {
    for (const id of made) { const d = await s.rpc('delete_auction_cascade', { p_auction_id: id }); if (d.error) console.log('cleanup error', id, d.error.message); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_lsock%')).data.length
      + (await s.from('bids').select('id').in('auction_id', made.length ? made : ['00000000-0000-0000-0000-000000000000'])).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
