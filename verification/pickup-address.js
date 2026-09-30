// The pickup street address is only for winners (wtf-handoff PRIVACY_BIDDERS_PICKUP_BRIEF.md, B6). Needs migration y
// (auctions.pickup_town). THROWAWAY rows only (ZZTEST_pickup*), always cleaned up; email goes to a local file.
//
// Anonymous callers, a bidder who didn't win, and a winner who chose SHIPPING never receive the street in any REST
// response, socket event or email; the public sees pickup_town. A winner who chose PICKUP gets it in their win
// email and on their order page; the admin sees it in the auction settings. The settings take a pickup town and
// publishing an auction that offers pickup requires one.
// OLD = PINNED to 905066d: GET /auction/:id sent the street to anyone (reproduced).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const guard = require('./guard');
guard(__filename);
const boot = require('./local-server');
const BE = boot.BE;
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io: ioc } = require(path.join(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const rules = require(BE + '/lot_rules');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };

const PINNED = '905066d';
const STREET = '77 Zzsecret Lane';
const ADDRESS = `${STREET}, Zztown, FL 33101`;
const TOWN = 'Zztown, FL';
const mk = n => ({ id: crypto.randomUUID(), username: 'zztest_pickup_' + n, email: `zztest_pickup_${n}@example.invalid` });
const W = mk('w'), Y = mk('y'), X = mk('x');
const ADMIN = { id: crypto.randomUUID(), username: 'whatthefind' };
const tok = u => jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: '15m' });
const future = m => new Date(Date.now() + m * 60e3).toISOString();
const MAIL = BE + '/run.tmp-pickup-mail.log';
const RESEND_STUB = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com')) return realFetch(url, opts);
  const b = JSON.parse(opts.body || '{}');
  require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject, html: b.html }) + '\\n');
  return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
};`;
// A test-only route on the local server: send the "you won" email for one invoice (the real function).
const TEST_ROUTE = `app.post('/__test/won-email', async (req, res) => { await notifyInvoiceWonAndCharged(String(req.query.invoice), null); res.json({ ok: true }); });
const PORT = process.env.PORT || 3001;`;
const OPTS = { env: { RESEND_API_KEY: 're_zztest_stub' }, preload: RESEND_STUB, patch: [['const PORT = process.env.PORT || 3001;', TEST_ROUTE]] };
const mails = () => (fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const auctionIds = [];

const caller = url => (method, p, token, body) => fetch(url + p, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + tok(token) } : {}), 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

async function fixtures(label) {
  const P = die(await s.from('auctions').insert({
    title: `ZZTEST_pickup_${label}`, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'both',
    pickup_address: ADDRESS, pickup_town: TOWN, pickup_starts_at: future(60 * 30), pickup_ends_at: future(60 * 200),
    buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600),
  }).select().single());
  auctionIds.push(P.id);
  const PL = die(await s.from('auction_items').insert({ auction_id: P.id, title: 'ZZTEST zzpickup lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: future(120) }).select().single());
  for (const u of [W, Y, X]) {
    die(await s.from('profiles').upsert({ user_id: u.id, full_name: 'ZZTEST pickup', email: u.email, phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'FL', zip: '33101', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_pickup', stripe_payment_method_id: 'pm_ZZFIXTURE_pickup' }, { onConflict: 'user_id' }));
    die(await s.from('auction_terms_acceptances').insert({ auction_id: P.id, user_id: u.id, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'both', fulfillment_choice: u === Y ? 'shipping' : 'pickup', terms_version: '1' }));
  }
  // W won a lot and chose pickup; Y won one and chose shipping. X bid but won nothing.
  const inv = {};
  for (const [u, choice] of [[W, 'pickup'], [Y, 'shipping']]) {
    const i = die(await s.from('invoices').insert({ auction_id: P.id, buyer_user_id: u.id, buyer_username: u.username, total_cents: 1150 }).select().single());
    die(await s.from('orders').insert({ auction_id: P.id, invoice_id: i.id, buyer_user_id: u.id, buyer_username: u.username, item_title: 'Lot 9: ZZTEST zzpickup won', final_bid: 10, hammer_cents: 1000, premium_cents: 150, total_cents: 1150, status: 'pending', payment_status: 'paid', fulfillment_choice: choice }));
    inv[u.username] = i.id;
  }
  return { P, PL: PL.id, inv };
}

function socketState(url, auctionId, token) {
  return new Promise(resolve => {
    const sock = ioc(url, { transports: ['websocket'], forceNew: true });
    const t = setTimeout(() => { sock.close(); resolve(null); }, 8000);
    sock.on('auction_state', st => { clearTimeout(t); sock.close(); resolve(st); });
    sock.on('connect', () => sock.emit('join_auction', { auctionId, token }));
  });
}

async function cleanup() {
  for (const id of auctionIds.splice(0)) {
    await s.from('orders').delete().eq('auction_id', id);
    await s.from('invoices').delete().eq('auction_id', id);
    const r = await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (r.error) console.log('cleanup error', id, r.error.message);
  }
}

(async () => {
  const servers = [];
  try {
    const col = await s.from('auctions').select('pickup_town').limit(1);
    if (col.error) { console.log('Migration 2026-09-30y is not applied on this database (auctions.pickup_town missing). Apply it on wtf-test first.'); process.exit(2); }
    try { fs.unlinkSync(MAIL); } catch {}

    const oldS = await boot('pickup-old', 3373, guard.sourceAt(PINNED, BE)); servers.push(oldS);
    console.log(`== REPRODUCE on the pinned commit (${PINNED}) ==`);
    {
      const F = await fixtures('old');
      const r = await caller(oldS.url)('GET', `/auction/${F.P.id}`);
      ok(JSON.stringify(r.j).includes(STREET), 'OLD: GET /auction/:id gives the street address to anyone  <- BUG REPRODUCED');
      await cleanup();
    }

    const srv = await boot('pickup-new', 3374, guard.readSource(BE + '/server.js'), OPTS); servers.push(srv);
    const call = caller(srv.url);
    const F = await fixtures('new');
    const { P, PL } = F;
    const slug = rules.auctionSlug(P);

    console.log('\n== The public, a losing bidder and a shipping winner: the town, never the street ==');
    const reads = ['/auctions', `/auction/${P.id}`, `/auction/${P.id}/items`, `/auction/${P.id}/items/standard-status`, `/lots/${PL}`,
      `/lots/by-number/${slug}/1`, `/lots/${PL}/related`, '/home', '/search?q=zzpickup'];
    let checked = 0;
    for (const [who, u] of [['anonymous', null], ['X (bid, lost)', X], ['Y (won, shipping)', Y]]) {
      for (const p of [...reads, ...(u ? [`/auction/${P.id}/terms-acceptance`, '/my-orders', '/my-bids', `/lots/${PL}/me`] : [])]) {
        const r = await call('GET', p, u);
        checked++;
        const t = JSON.stringify(r.j) || '';
        if (t.includes('Zzsecret') || t.includes('pickup_address')) ok(false, `${who}: GET ${p} carries the street`);
      }
      const st = await socketState(srv.url, P.id, u ? tok(u) : undefined);
      checked++;
      if (!st || JSON.stringify(st).includes('Zzsecret') || 'pickup_address' in st) ok(false, `${who}: socket auction_state carries the street (or never came)`);
    }
    ok(fails === 0, `${checked} responses and socket states to anonymous, a losing bidder and a shipping winner: no street address`);
    const pub = (await call('GET', `/auction/${P.id}`)).j, lot = (await call('GET', `/lots/${PL}`)).j;
    ok(pub.pickup_town === TOWN && lot.fulfilment.pickup.town === TOWN && !('pickup_address' in pub), `the public sees the town: "${pub.pickup_town}"`);

    console.log('\n== The winner who chose pickup, and the admin ==');
    const wOrders = (await call('GET', '/my-orders', W)).j;
    ok(wOrders.length === 1 && wOrders[0].pickup && wOrders[0].pickup.address === ADDRESS && wOrders[0].pickup.starts_at, "W's order page: the full address and the pickup window");
    const yOrders = (await call('GET', '/my-orders', Y)).j;
    ok(yOrders.length === 1 && yOrders[0].pickup === null, "Y (shipping) order page: no pickup block");
    for (const u of [W, Y]) await call('POST', `/__test/won-email?invoice=${F.inv[u.username]}`);
    const m = mails();
    const toW = m.find(x => [].concat(x.to).includes(W.email)), toY = m.find(x => [].concat(x.to).includes(Y.email));
    ok(toW && toW.html.includes(STREET) && /collect your lot/.test(toW.html), "W's win email: collect at the full address, with the window");
    ok(toY && !toY.html.includes('Zzsecret') && /pack and ship/.test(toY.html), "Y's win email (shipping): no address, the shipping wording");
    ok(!m.some(x => [].concat(x.to).includes(X.email)) && m.every(x => [].concat(x.to).includes(W.email) || !x.html.includes('Zzsecret')), 'X gets no email, and no email but W\'s has the street');
    const adm = (await call('GET', `/auction/${P.id}`, ADMIN)).j;
    ok(adm.pickup_address === ADDRESS && adm.pickup_town === TOWN, 'the admin sees the address and the town (settings)');

    console.log('\n== Settings and publishing ==');
    let r = await call('PATCH', `/auction/${P.id}`, ADMIN, { pickup_town: '  Hialeah, FL  ' });
    ok(r.s === 200 && r.j.pickup_town === 'Hialeah, FL', `the admin sets the town (trimmed): ${r.j && r.j.pickup_town}`);
    r = await call('PATCH', `/auction/${P.id}`, ADMIN, { pickup_town: 'x'.repeat(81) });
    ok(r.s === 400, 'a town over 80 characters: 400');
    ok((await call('PATCH', `/auction/${P.id}`, X, { pickup_town: 'Nope' })).s === 403, 'a buyer cannot set it (403)');
    const D = die(await s.from('auctions').insert({ title: 'ZZTEST_pickup_draft', description: 'x', status: 'draft', mode: 'standard', fulfillment_mode: 'pickup', pickup_address: ADDRESS, pickup_starts_at: future(60 * 30), pickup_ends_at: future(60 * 200), buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600) }).select().single());
    auctionIds.push(D.id);
    die(await s.from('auction_items').insert({ auction_id: D.id, title: 'ZZTEST draft lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: future(120) }));
    r = await call('POST', `/auction/${D.id}/publish`, ADMIN);
    ok(r.s === 400 && /pickup town/.test(r.j.error), `publishing pickup without a town is refused: "${r.j && r.j.error}"`);
    await call('PATCH', `/auction/${D.id}`, ADMIN, { pickup_town: TOWN });
    r = await call('POST', `/auction/${D.id}/publish`, ADMIN);
    ok(r.s === 200, 'with a town it publishes');
  } catch (e) {
    console.log('ERR', e); fails++;
  } finally {
    servers.forEach(x => x.stop());
    await cleanup();
    const ids = [W, Y, X].map(u => u.id);
    await s.from('auction_terms_acceptances').delete().in('user_id', ids);
    await s.from('profiles').delete().in('user_id', ids);
    try { fs.unlinkSync(MAIL); } catch {}
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_pickup%')).data.length
      + (await s.from('orders').select('id').in('buyer_user_id', ids)).data.length
      + (await s.from('invoices').select('id').in('buyer_user_id', ids)).data.length
      + (await s.from('profiles').select('id').in('user_id', ids)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
