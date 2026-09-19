// Slice 2 (id normalisation) proof. OLD = PINNED to 385ea56 (before id normalisation, a27f899), NEW = working tree. Throwaway rows only (ZZTEST_idnorm*), always cleaned up.
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io: ioc } = require(require('path').join(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD = 3251, NEW = 3252;

async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const U = crypto.randomUUID();
const adminTok = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const buyerTok = jwt.sign({ id: U, username: 'zztest_idnorm' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const made = { auctions: [], items: [], orders: [] };
const call = (port, method, path, tok, body) => fetch('http://localhost:' + port + path, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => { const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; });
async function mkAuction(label, status) {
  const r = await s.from('auctions').insert({ title: 'ZZTEST_idnorm_' + label, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind', ends_at: future(48) }).select().single();
  if (r.error) throw new Error(JSON.stringify(r.error)); made.auctions.push(r.data.id); return r.data.id;
}
async function mkItem(a, title, status) {
  const r = await s.from('auction_items').insert({ auction_id: a, title, starting_bid: 0, position: 0, status, ends_at: future(24) }).select().single();
  if (r.error) throw new Error(JSON.stringify(r.error)); made.items.push(r.data.id); return r.data.id;
}
const socketTry = (port, event, payload, waitFor) => new Promise(resolve => {
  const c = ioc('http://localhost:' + port, { transports: ['websocket'] });
  const got = {};
  waitFor.forEach(e => c.on(e, d => { got[e] = d; }));
  c.on('connect', () => c.emit(event, payload));
  setTimeout(() => { c.close(); resolve(got); }, 2500);
});

(async () => {
  const servers = [];
  try {
    const oldSrc = execSync('git show 385ea56:server.js', { cwd: BE, maxBuffer: 50e6 }).toString();
    const newSrc = fs.readFileSync(BE + '/server.js', 'utf8');
    const R = await s.from('auctions').select('id,title').like('title', 'ZZTEST_InvoiceBatch%').single();
    const X = R.data.id;   // real auction that has lots + orders (read-only use)

    // fixtures
    const LIVE = await mkAuction('live', 'live');
    const DRAFT = await mkAuction('draft', 'draft');
    const pendingLot = await mkItem(LIVE, 'ZZTEST idnorm pending lot', 'pending');
    const lotForDraft = await mkItem(DRAFT, 'ZZTEST idnorm draft lot', 'pending');
    const pr = await s.from('profiles').insert({ user_id: U, full_name: 'ZZTEST idnorm', email: 'zztest_idnorm@example.invalid', phone: '5555550100', address_line1: '1 Test St', city: 'Testville', state: 'CA', zip: '94000', status: 'approved' });
    if (pr.error) throw new Error(JSON.stringify(pr.error));
    const tr = await s.from('auction_terms_acceptances').insert({ auction_id: LIVE, user_id: U, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' });
    if (tr.error) throw new Error(JSON.stringify(tr.error));
    for (let i = 0; i < 2; i++) {
      const o = await s.from('orders').insert({ auction_id: LIVE, buyer_username: 'zztest_idnorm', buyer_user_id: U, item_title: 'ZZTEST idnorm order ' + i, final_bid: 1, status: 'pending', payment_status: 'unpaid' }).select().single();
      if (o.error) throw new Error(JSON.stringify(o.error)); made.orders.push(o.data.id);
    }
    servers.push(await boot('old', OLD, oldSrc), await boot('new', NEW, newSrc));

    console.log('\n== A. READ ROUTES: lowercase vs UPPERCASE vs garbage id (real auction with lots) ==');
    const reads = [`/auction/${X}`, `/auction/${X}/bids`, `/auction/${X}/chat`, `/auction/${X}/items`, `/auction/${X}/items/standard-status`];
    for (const p of reads) {
      const oLow = await call(OLD, 'GET', p, adminTok), oUp = await call(OLD, 'GET', p.replace(X, X.toUpperCase()), adminTok);
      const nLow = await call(NEW, 'GET', p, adminTok), nUp = await call(NEW, 'GET', p.replace(X, X.toUpperCase()), adminTok), nBad = await call(NEW, 'GET', p.replace(X, 'not-a-uuid'), adminTok);
      const same = JSON.stringify(nLow.j) === JSON.stringify(nUp.j);
      const oldDiff = JSON.stringify(oLow.j) !== JSON.stringify(oUp.j);
      ok(nLow.s === oLow.s && JSON.stringify(nLow.j) === JSON.stringify(oLow.j) && nUp.s === nLow.s && same && nBad.s === 400,
        `${p.replace(X, ':id').padEnd(40)} NEW lower ${nLow.s} = old lower ${oLow.s}; NEW UPPER == lower (${same}); garbage -> ${nBad.s}` + (oldDiff ? `   [old UPPER differed: ${oUp.s}, ${JSON.stringify(oUp.j).length}B vs ${JSON.stringify(oLow.j).length}B]` : ''));
    }
    const lotOfX = (await s.from('auction_items').select('id').eq('auction_id', X).limit(1)).data[0].id;
    const imgP = (a, i) => `/auction/${a}/items/${i}/images`;
    let a = await call(NEW, 'GET', imgP(X, lotOfX), null), b = await call(NEW, 'GET', imgP(X.toUpperCase(), lotOfX.toUpperCase()), null), c = await call(NEW, 'GET', imgP(X, 'zzz'), null);
    ok(a.s === 200 && b.s === 200 && JSON.stringify(a.j) === JSON.stringify(b.j) && c.s === 400, `images route (:auctionId + :itemId): lower ${a.s}, UPPER ${b.s} same body, garbage itemId -> ${c.s}`);

    console.log('\n== B. ADMIN ORDERS query id ==');
    const oLow = await call(OLD, 'GET', `/admin/orders?auction_id=${X}`, adminTok), oUp = await call(OLD, 'GET', `/admin/orders?auction_id=${X.toUpperCase()}`, adminTok);
    const nLow = await call(NEW, 'GET', `/admin/orders?auction_id=${X}`, adminTok), nUp = await call(NEW, 'GET', `/admin/orders?auction_id=${X.toUpperCase()}`, adminTok), nBad = await call(NEW, 'GET', `/admin/orders?auction_id=zzz`, adminTok);
    ok(oUp.j.total === 0 && oLow.j.total > 0, `OLD: UPPER auction_id filter silently returned ${oUp.j.total} orders vs ${oLow.j.total} for lowercase  <- fails-closed bug reproduced`);
    ok(nUp.j.total === nLow.j.total && nLow.j.total === oLow.j.total && nBad.s === 400, `NEW: UPPER returns ${nUp.j.total} = lowercase ${nLow.j.total}; garbage -> ${nBad.s}`);

    console.log('\n== C. WRITE POISONING (the stored value) ==');
    const stored = async id => (await s.from('pre_bids').select('auction_id').eq('item_id', id)).data.map(r => r.auction_id);
    let r = await call(OLD, 'POST', `/auction/${LIVE.toUpperCase()}/items/${pendingLot}/prebid`, buyerTok, { max_amount: 7 });
    let vals = await stored(pendingLot);
    ok(r.s === 200 && vals.length === 1 && vals[0] === LIVE.toUpperCase(), `OLD pre-bid with UPPERCASE auction id stored auction_id='${vals[0]}' (non-canonical, invisible to lowercase lookups)  <- poisoning reproduced`);
    await s.from('pre_bids').delete().eq('item_id', pendingLot);
    r = await call(NEW, 'POST', `/auction/${LIVE.toUpperCase()}/items/${pendingLot}/prebid`, buyerTok, { max_amount: 7 });
    vals = await stored(pendingLot);
    ok(r.s === 200 && vals.length === 1 && vals[0] === LIVE, `NEW pre-bid with UPPERCASE auction id stored auction_id='${vals[0]}' (lowercase)`);

    const itemsOf = async a => (await s.from('auction_items').select('auction_id,title').eq('auction_id', a.toLowerCase()).like('title', 'ZZTEST_idnorm_add%')).data.length;
    const rawItems = async () => (await s.from('auction_items').select('id,auction_id').like('title', 'ZZTEST_idnorm_add%')).data;
    r = await call(OLD, 'POST', `/auction/${DRAFT.toUpperCase()}/items`, adminTok, { title: 'ZZTEST_idnorm_add_old' });
    let rows = await rawItems(); rows.forEach(x => made.items.push(x.id));
    ok(r.s === 201 && rows.some(x => x.auction_id === DRAFT.toUpperCase()), `OLD admin add-item with UPPERCASE id stored auction_id='${(rows[0] || {}).auction_id}'  <- poisoning reproduced`);
    await s.from('auction_items').delete().like('title', 'ZZTEST_idnorm_add%');
    r = await call(NEW, 'POST', `/auction/${DRAFT.toUpperCase()}/items`, adminTok, { title: 'ZZTEST_idnorm_add_new' });
    rows = await rawItems(); rows.forEach(x => made.items.push(x.id));
    ok(r.s === 201 && rows.length === 1 && rows[0].auction_id === DRAFT, `NEW admin add-item with UPPERCASE id stored auction_id='${(rows[0] || {}).auction_id}' (lowercase)`);
    await s.from('auction_items').delete().like('title', 'ZZTEST_idnorm_add%');

    console.log('\n== D. FAILS-CLOSED CASES now work: publish with UPPERCASE id ==');
    const before = (await s.from('auctions').select('status').eq('id', DRAFT).single()).data.status;
    r = await call(OLD, 'POST', `/auction/${DRAFT.toUpperCase()}/publish`, adminTok, {});
    const afterOld = (await s.from('auctions').select('status').eq('id', DRAFT).single()).data.status;
    ok(before === 'draft' && r.s === 400 && afterOld === 'draft', `OLD publish with UPPERCASE id: ${r.s} "${r.j.error}" (auction has a lot, still refused)  <- reproduced`);
    r = await call(NEW, 'POST', `/auction/${DRAFT.toUpperCase()}/publish`, adminTok, {});
    const afterNew = (await s.from('auctions').select('status').eq('id', DRAFT).single()).data.status;
    ok(r.s === 200 && afterNew !== 'draft', `NEW publish with UPPERCASE id: ${r.s}, status now '${afterNew}'`);

    console.log('\n== E. BODY IDS ==');
    const grp = async ids => (await s.from('orders').select('group_id').in('id', made.orders)).data.map(x => x.group_id);
    r = await call(NEW, 'POST', '/admin/orders/group', adminTok, { order_ids: [made.orders[0], 'not-a-uuid'] });
    ok(r.s === 400 && (await grp()).every(g => g == null), `group with a garbage id -> ${r.s} ${r.j.error}, no order touched`);
    r = await call(NEW, 'POST', '/admin/orders/group', adminTok, { order_ids: made.orders.map(x => x.toUpperCase()) });
    const g = await grp();
    ok(r.s === 200 && g.every(x => x && x === g[0]), `group with UPPERCASE ids -> ${r.s}, both orders grouped together`);
    for (const [p, body] of [['/admin/orders/shipping-quote', { order_ids: ['zzz'], weight_oz: 1, length_in: 1, width_in: 1, height_in: 1 }], ['/admin/orders/label', { order_ids: ['zzz'], rate_id: 'r', amount_cents: 100 }], ['/charge-winner', { order_id: 'zzz' }], ['/charge-winner', { invoice_id: 'zzz' }], ['/charge-winner', { auction_id: 'zzz', winner_username: 'x' }]]) {
      r = await call(NEW, 'POST', p, adminTok, body);
      ok(r.s === 400 && /Invalid/.test(r.j.error), `${p} with a garbage id -> ${r.s} "${r.j.error}" (rejected before any work)`);
    }
    const chargedAny = (await s.from('orders').select('payment_status,shipping_payment_status').in('id', made.orders)).data;
    ok(chargedAny.every(o => o.payment_status === 'unpaid' && !o.shipping_payment_status), 'no throwaway order was charged or touched by the rejected calls');

    console.log('\n== F. SOCKET EVENTS ==');
    let got = await socketTry(NEW, 'join_auction', { auctionId: X.toUpperCase(), token: adminTok }, ['auction_state', 'auction_error']);
    let gotLow = await socketTry(NEW, 'join_auction', { auctionId: X, token: adminTok }, ['auction_state', 'auction_error']);
    ok(!!got.auction_state && !!gotLow.auction_state && got.auction_state.id === X, `join_auction with UPPERCASE id -> auction_state for the canonical auction (${got.auction_state && got.auction_state.id === X ? 'id lowercase' : JSON.stringify(got).slice(0, 80)})`);
    let oldUp = await socketTry(OLD, 'join_auction', { auctionId: X.toUpperCase(), token: adminTok }, ['auction_state', 'auction_error', 'bid_history']);
    console.log('   (old server, UPPERCASE join: events received =', Object.keys(oldUp).join(',') || 'none', ')');
    got = await socketTry(NEW, 'join_auction', { auctionId: 'zzz', token: adminTok }, ['auction_state', 'auction_error']);
    ok(!got.auction_state && got.auction_error && got.auction_error.code === 'not_found', `join_auction garbage id -> auction_error ${got.auction_error && got.auction_error.code}`);
    got = await socketTry(NEW, 'place_bid', { auctionId: 'zzz', amount: 5, token: buyerTok }, ['bid_error']);
    ok(got.bid_error && /Invalid auction id/.test(got.bid_error.message), `place_bid garbage id -> bid_error "${got.bid_error && got.bid_error.message}"`);
    got = await socketTry(NEW, 'start_auction', { auctionId: 'zzz', token: adminTok }, ['host_error']);
    ok(got.host_error && /Invalid auction id/.test(got.host_error.message), `start_auction garbage id -> host_error "${got.host_error && got.host_error.message}"`);
  } finally {
    servers.forEach(x => x.cleanup());
    await s.from('pre_bids').delete().eq('buyer_user_id', U);
    if (made.orders.length) await s.from('orders').delete().in('id', made.orders);
    await s.from('bids').delete().in('auction_id', made.auctions);
    await s.from('auction_terms_acceptances').delete().eq('user_id', U);
    await s.from('profiles').delete().eq('user_id', U);
    await s.from('auction_items').delete().like('title', 'ZZTEST idnorm%');
    await s.from('auction_items').delete().like('title', 'ZZTEST_idnorm%');
    if (made.items.length) await s.from('auction_items').delete().in('id', made.items);
    if (made.auctions.length) await s.from('auctions').delete().in('id', made.auctions);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_idnorm%')).data.length + (await s.from('auction_items').select('id').or('title.like.ZZTEST idnorm%,title.like.ZZTEST_idnorm%')).data.length + (await s.from('orders').select('id').eq('buyer_user_id', U)).data.length + (await s.from('pre_bids').select('id').eq('buyer_user_id', U)).data.length + (await s.from('profiles').select('id').eq('user_id', U)).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
