// The lot page API (wtf-handoff LOT_PAGE_BRIEF.md, F2): GET /lots/:id, /lots/by-number/:slug/:n, /lots/:id/me,
// /lots/:id/bids, /lots/:id/related. THROWAWAY rows only (ZZTEST_lotpage*), always cleaned up.
//
// Proves: the endpoint's shape; the premium line uses the invoice's own maths; the two one-tap amounts are exactly
// what the server accepts (a cent less is refused) on every increment tier; the history is anonymised (Bidder A/B,
// "You"), follows who actually held each price (migration x), counts every bid like bid_count, and never carries a
// username or a max (anonymous, a buyer, the other buyer); each buyer's own status and max; related and similar
// lots (other live auctions only, hidden below 3 matches); drafts 404 everywhere and never in a rail; the pickup
// street address never leaves; slugs (renamed title, full uuid, unknown).
const crypto = require('crypto');
const guard = require('./guard');
guard(__filename);
const boot = require('./local-server');
const BE = boot.BE;
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const rules = require(BE + '/lot_rules');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const mkUser = name => ({ id: crypto.randomUUID(), username: 'zztest_lotpage_' + name });
const A = mkUser('a'), B = mkUser('b'), C = mkUser('c');
const tok = u => jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '15m' });
const future = m => new Date(Date.now() + m * 60e3).toISOString();
const auctionIds = [];
const STREET = '123 NW 4th Street';
// Distinctive maxes, so a substring search can't match anything else.
const A_MAX = 30.37, B_MAX1 = 20.41, B_MAX2 = 40.73;
const SECRETS = [String(A_MAX), String(B_MAX1), String(B_MAX2)];
const USERNAMES = [A.username, B.username, C.username];

let base;
const call = (method, path, token, body) => fetch(base + path, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null), h: r.headers }));

function leaks(body) {
  const text = JSON.stringify(body) || '';
  const found = [];
  for (const k of ['"top_pre_bid"', '"reserve_price"', '"leading_bidder"', '"username"', '"leader_username"', '"max_amount"', '"pickup_address"']) if (text.includes(k)) found.push(k);
  for (const v of [...SECRETS, ...USERNAMES, STREET, '123 NW']) if (text.includes(v)) found.push(v);
  return found;
}

async function auction(fields) {
  const r = await s.from('auctions').insert({
    description: 'A ZZTEST collection. Second sentence.', status: 'live', mode: 'standard', fulfillment_mode: 'shipping',
    buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600), ...fields,
  }).select().single();
  if (r.error) throw new Error('auction: ' + JSON.stringify(r.error));
  auctionIds.push(r.data.id);
  return r.data;
}
async function lots(auctionId, list) {
  const r = await s.from('auction_items').insert(list.map((l, i) => ({
    auction_id: auctionId, position: i, starting_bid: 0, current_bid: 0, bid_count: 0, status: 'open', ends_at: future(120 + i), ...l,
  }))).select();
  if (r.error) throw new Error('lots: ' + JSON.stringify(r.error));
  return r.data.sort((x, y) => x.position - y.position);
}

async function fixtures() {
  const S = await auction({
    title: 'ZZTEST_lotpage Monster Shelf', category: 'Horror figures', fulfillment_mode: 'both',
    pickup_address: STREET + ', Miami, FL 33101', pickup_starts_at: future(700), pickup_ends_at: future(700 + 7 * 1440),
  });
  const SL = await lots(S.id, [
    { title: 'zzlpmonster zzlpresin figure', description: 'Twelve inches.', condition: 'Paint rubs on base', ends_at: future(90) },
    { title: 'zzlpmonster bust', ends_at: future(30) },
    { title: 'zzlpsold lot', status: 'sold', current_bid: 12, bid_count: 3, ends_at: future(-10) },
    { title: 'zzlptier lot', ends_at: future(60) },
    { title: 'zzlpunbid lot', ends_at: future(45) },
  ]);
  const img = await s.from('item_images').insert([
    { item_id: SL[0].id, url: 'https://example.invalid/zztest-lotpage-1.jpg', position: 0 },
    { item_id: SL[0].id, url: 'https://example.invalid/zztest-lotpage-2.jpg', position: 1 },
  ]);
  if (img.error) throw new Error('images: ' + JSON.stringify(img.error));
  // Another live auction, same category: three open lots share "zzlpmonster" / "zzlpresin" (similar), a sold one
  // does too (never similar), a teapot shares only the category (not similar), and two share "zzlplonely" with Q.
  const O = await auction({ title: 'ZZTEST_lotpage Other Room', category: 'Horror figures' });
  const OL = await lots(O.id, [
    { title: 'zzlpmonster zzlpresin kit', ends_at: future(200) },
    { title: 'zzlpmonster mask', ends_at: future(100) },
    { title: 'zzlpresin statue', ends_at: future(150) },
    { title: 'zzlpmonster closed', status: 'sold', ends_at: future(-5) },
    { title: 'zzlpteapot', ends_at: future(80) },
    { title: 'zzlplonely stool', ends_at: future(90) },
    { title: 'zzlplonely lamp', ends_at: future(95) },
  ]);
  // A draft with a matching lot: never shown to anyone, never in a rail.
  const D = await auction({ title: 'ZZTEST_lotpage Draft', status: 'draft' });
  const DL = await lots(D.id, [{ title: 'zzlpmonster zzlpresin draft lot' }]);
  // An auction whose lot has only two similar matches elsewhere ("zzlplonely", in O): similar must be [].
  const Q = await auction({ title: 'ZZTEST_lotpage Quiet', category: null });
  const QL = await lots(Q.id, [{ title: 'zzlplonely item' }, { title: 'zzlpquiet twin' }, { title: 'zzlpquiet third' }]);
  for (const u of [A, B, C]) {
    const p = await s.from('profiles').upsert({ user_id: u.id, full_name: 'ZZTEST lotpage', email: 'zztest_lotpage@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_lotpage', stripe_payment_method_id: 'pm_ZZFIXTURE_lotpage' }, { onConflict: 'user_id' });
    if (p.error) throw new Error('profile: ' + JSON.stringify(p.error));
    const t = await s.from('auction_terms_acceptances').insert({ auction_id: S.id, user_id: u.id, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'both', fulfillment_choice: 'shipping', terms_version: '1' });
    if (t.error) throw new Error('acceptance: ' + JSON.stringify(t.error));
  }
  return { S, SL, O, OL, D, DL, Q, QL };
}

async function cleanup() {
  for (const id of auctionIds.splice(0)) {
    const r = await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (r.error) console.log('cleanup error', id, r.error.message);
  }
  const ids = [A, B, C].map(u => u.id);
  await s.from('auction_terms_acceptances').delete().in('user_id', ids);
  await s.from('profiles').delete().in('user_id', ids);
}

(async () => {
  let srv;
  try {
    // Pure rules first: no server needed.
    console.log('== lot_rules.js ==');
    ok([[0, 1], [49.99, 1], [50, 2], [99, 2], [100, 5], [199, 5], [200, 10], [499, 10], [500, 25], [999, 25], [1000, 50], [25000, 50]]
      .every(([p, inc]) => rules.bidIncrement(p) === inc), 'increment tiers: $1 <50, $2 <100, $5 <200, $10 <500, $25 <1000, $50 above');
    // The invoice maths (createOrderOnWin, before this change): Math.round(hammerCents * pct / 100). Compared on
    // every cent from $0 to $300 at three rates, and the order code now calls the same function.
    let same = true;
    for (let c = 0; c <= 30000 && same; c++) for (const pct of [15, 12.5, 0]) {
      const old = Math.round(c * pct / 100);
      const w = rules.withPremium(c / 100, pct);
      if (rules.premiumCents(c, pct) !== old || Math.round(w.premium * 100) !== old || Math.round(w.total * 100) !== c + old) { same = false; console.log('  differs at', c, pct); }
    }
    ok(same, 'premium: lot page maths = the invoice maths on every cent $0-$300 at 15%, 12.5%, 0%');
    const src = guard.readSource(BE + '/server.js');
    ok(src.includes('lotRules.premiumCents(hammerCents, auction.buyers_premium_pct)') && !/hammerCents \* premiumPct/.test(src),
      'orders (and so invoices) compute the premium with the same lotRules.premiumCents');
    ok(src.includes('lotRules.minimumBid(bidItem, isLeader)'), 'the bid route judges the minimum with the same lotRules.minimumBid the one-tap amounts come from');
    ok(rules.withPremium(83.5, 15).total === 96.03 && rules.withPremium(83, 15).total === 95.45, 'e.g. $83.50 -> $96.03, $83 -> $95.45 with 15%');
    ok(rules.pickupCity('123 NW 4th Street, Miami, FL 33101') === 'Miami, FL' && rules.pickupCity('9 Elm Rd, Suite 4, Austin, TX') === 'Austin, TX'
      && rules.pickupCity('123 NW 4th Street') === null && rules.pickupCity('') === null, 'pickup town from the address; no town part -> null (never the street)');
    ok(rules.slugIdPart('monster-shelf-3f9a1c2e') === '3f9a1c2e' && rules.slugIdPart('nothing-here') === null && rules.auctionSlug({ id: '3F9A1C2E-0000-4000-8000-000000000000', title: "Bob's Toys & Tins!" }) === 'bobs-toys-tins-3f9a1c2e',
      'slugs: title words + first 8 of the id');
    ok(rules.bidderLabel(0) === 'Bidder A' && rules.bidderLabel(25) === 'Bidder Z' && rules.bidderLabel(26) === 'Bidder AA', 'bidder labels A..Z, AA..');

    const col = await s.from('bids').select('leader_username').limit(1);
    if (col.error) { console.log('\nMigration 2026-09-30x is not applied on this database (bids.leader_username missing). Apply it on wtf-test first.'); process.exit(2); }

    const F = await fixtures();
    srv = await boot('lotpage', 3361, guard.readSource(BE + '/server.js'));
    base = srv.url;
    const [lot0, lot1, lot2, lot3, lot4] = F.SL;

    console.log('\n== GET /lots/:id: shape ==');
    let r = await call('GET', `/lots/${lot0.id}`);
    ok(r.s === 200, `200 for an open lot (${r.s})`);
    const L = r.j || {};
    ok(JSON.stringify(Object.keys(L)) === JSON.stringify(['server_now', 'lot', 'auction', 'photos', 'price', 'time', 'fulfilment', 'nav', 'contact_email']), 'top-level keys: ' + Object.keys(L).join(', '));
    ok(L.lot && L.lot.number === 1 && L.lot.status === 'open' && L.lot.condition === 'Paint rubs on base' && L.lot.description === 'Twelve inches.', 'lot: number = position + 1, status, description, condition');
    ok(L.photos && L.photos.length === 2 && L.photos[0].url.endsWith('-1.jpg') && 'thumb_url' in L.photos[0] && L.lot.image_url === L.photos[0].url, 'photos: every photo in order, url + thumb_url; lot.image_url = the first');
    ok(L.auction && L.auction.slug === rules.auctionSlug(F.S) && L.auction.lot_count === 5 && L.auction.story === 'A ZZTEST collection.' && L.auction.buyers_premium_pct === 15, 'auction summary: slug, lot count, story line, premium');
    ok(L.price && L.price.current_bid === null && L.price.opening_bid === 1 && L.price.bid_count === 0 && JSON.stringify(L.price.next_bids) === '[1,2]', `before any bid: opening $1, next [1, 2] (${JSON.stringify(L.price)})`);
    ok(L.price.premium_amount === 0.15 && L.price.total_with_premium === 1.15, 'premium on the opening bid: $0.15 -> $1.15');
    ok(L.time && L.time.soft_close_minutes === 2 && L.time.ends_at === new Date(lot0.ends_at).toISOString(), 'time: ends_at and the live soft-close minutes (2)');
    ok(L.fulfilment && L.fulfilment.pickup && L.fulfilment.pickup.city === 'Miami, FL' && L.fulfilment.pickup.free === true && L.fulfilment.shipping && L.fulfilment.shipping.priced === 'after_auction' && L.fulfilment.shipping.estimate === null,
      'fulfilment: pickup town only, shipping priced after the auction, no estimate (lots have no weight/size)');
    ok(L.nav && L.nav.prev === null && L.nav.next && L.nav.next.id === lot1.id && L.nav.next.number === 2, 'nav: first lot has no prev; next = lot 2');
    r = await call('GET', `/lots/${lot4.id}`);
    ok(r.j && r.j.nav.next === null && r.j.nav.prev.id === lot3.id, 'nav: last lot has no next; prev = lot 4');
    r = await call('GET', `/lots/${lot1.id}`);
    ok(r.j && r.j.photos.length === 0 && r.j.lot.image_url === null, 'a lot without photos: photos [] and image_url null (the page shows the placeholder)');
    r = await call('GET', `/lots/${lot2.id}`);
    ok(r.j && r.j.lot.status === 'sold' && r.j.price.current_bid === 12 && JSON.stringify(r.j.price.next_bids) === '[]', 'a sold lot: status sold, its price, no bid amounts');
    ok(leaks(L).length === 0, 'no max, reserve, leader, username or street address in /lots/:id: ' + leaks(L).join(', '));
    r = await call('GET', `/lots/${lot0.id}`, tok(A));
    ok(JSON.stringify({ ...r.j, server_now: 0 }) === JSON.stringify({ ...L, server_now: 0 }), 'the same answer logged in and out (the public part can be cached)');

    console.log('\n== one-tap amounts = what the server accepts ==');
    r = await call('POST', `/auction/${F.S.id}/items/${lot0.id}/bid`, tok(C), { max_amount: 0.99 });
    ok(r.s === 400, `opening: a cent under next_bids[0] is refused (${r.s} ${r.j && r.j.error})`);
    // A: max A_MAX. Price opens at $1 (A leads).
    r = await call('POST', `/auction/${F.S.id}/items/${lot0.id}/bid`, tok(A), { max_amount: A_MAX });
    ok(r.s === 200, `A's max bid accepted (${r.s})`);
    let P = (await call('GET', `/lots/${lot0.id}`)).j.price;
    ok(P.current_bid === 1 && P.bid_count === 1 && JSON.stringify(P.next_bids) === '[2,3]', `after A: $1, next [2, 3] (${JSON.stringify(P.next_bids)})`);
    ok(P.premium_amount === 0.15 && P.total_with_premium === 1.15, 'with premium: $1.15');
    r = await call('POST', `/auction/${F.S.id}/items/${lot0.id}/bid`, tok(B), { max_amount: P.next_bids[0] - 0.01 });
    ok(r.s === 400 && /Min bid/.test(r.j.error), `a cent under next_bids[0] refused (${r.s} ${r.j && r.j.error})`);
    // B: max B_MAX1 < A_MAX -> A stays ahead at B_MAX1 + 1.
    r = await call('POST', `/auction/${F.S.id}/items/${lot0.id}/bid`, tok(B), { max_amount: B_MAX1 });
    ok(r.s === 200, `B's max bid accepted (${r.s})`);
    P = (await call('GET', `/lots/${lot0.id}`)).j.price;
    ok(P.current_bid === 21.41 && P.bid_count === 2, `proxy: A leads at B's max + $1 = $21.41 (${P.current_bid}), bid count 2`);
    ok(P.total_with_premium === rules.withPremium(21.41, 15).total && P.total_with_premium === 24.62, `with premium $24.62 (${P.total_with_premium})`);
    ok(JSON.stringify(P.next_bids) === '[22.41,23.41]', `next [22.41, 23.41] (${JSON.stringify(P.next_bids)})`);
    // B: one-tap the SECOND amount is also valid; then raise past A.
    r = await call('POST', `/auction/${F.S.id}/items/${lot0.id}/bid`, tok(B), { max_amount: P.next_bids[1] });
    ok(r.s === 200, `next_bids[1] accepted (${r.s})`);
    r = await call('POST', `/auction/${F.S.id}/items/${lot0.id}/bid`, tok(B), { max_amount: B_MAX2 });
    ok(r.s === 200, `B raises to a max above A's (${r.s})`);
    P = (await call('GET', `/lots/${lot0.id}`)).j.price;
    // B's one-tap at $23.41 moved A (still ahead) to $24.41; B's raise then took the lead at A's max + $1.
    ok(P.current_bid === 31.37 && P.bid_count === 4, `B leads at A's max + $1 = $31.37 (${P.current_bid}), bid count 4`);

    // Every tier: set the price directly, then the server must accept next_bids[0] and refuse a cent less.
    for (const price of [0.5, 49, 50, 99, 199, 499, 999, 1500]) {
      await s.from('pre_bids').delete().eq('item_id', lot3.id);
      await s.from('auction_items').update({ current_bid: price, bid_count: 5, leading_bidder: null, top_pre_bid: null }).eq('id', lot3.id);
      const nb = (await call('GET', `/lots/${lot3.id}`)).j.price.next_bids;
      const under = await call('POST', `/auction/${F.S.id}/items/${lot3.id}/bid`, tok(C), { max_amount: Math.round((nb[0] - 0.01) * 100) / 100 });
      await s.from('auction_items').update({ current_bid: price, bid_count: 5, leading_bidder: null }).eq('id', lot3.id);
      const at = await call('POST', `/auction/${F.S.id}/items/${lot3.id}/bid`, tok(C), { max_amount: nb[0] });
      await s.from('pre_bids').delete().eq('item_id', lot3.id);
      await s.from('auction_items').update({ current_bid: price, bid_count: 5, leading_bidder: null }).eq('id', lot3.id);
      const at2 = await call('POST', `/auction/${F.S.id}/items/${lot3.id}/bid`, tok(C), { max_amount: nb[1] });
      ok(under.s === 400 && at.s === 200 && at2.s === 200 && nb[1] === nb[0] + rules.bidIncrement(nb[0]),
        `tier at $${price}: next ${JSON.stringify(nb)}; a cent under refused (${under.s}), both amounts accepted (${at.s}, ${at2.s})`);
    }

    console.log('\n== /lots/:id/me: each buyer\'s own standing ==');
    const meA = (await call('GET', `/lots/${lot0.id}/me`, tok(A))).j;
    const meB = (await call('GET', `/lots/${lot0.id}/me`, tok(B))).j;
    const meC = (await call('GET', `/lots/${lot0.id}/me`, tok(C))).j;
    ok(meA && meA.status === 'outbid' && meA.my_max === A_MAX && meA.min_bid === 32.37, `A: outbid, own max ${A_MAX}, min $32.37 (${JSON.stringify(meA)})`);
    ok(meB && meB.status === 'winning' && meB.my_max === B_MAX2 && meB.min_bid === 31.37, `B: winning, own max, may raise from the current price (${JSON.stringify(meB)})`);
    ok(meC && meC.status === 'no_bid' && meC.my_max === null, `C: no bid, no max (${JSON.stringify(meC)})`);
    ok(!JSON.stringify(meA).includes(String(B_MAX2)) && !JSON.stringify(meC).includes(String(B_MAX2)) && !JSON.stringify(meC).includes(String(A_MAX)), "nobody's /me carries another buyer's max");
    ok((await call('GET', `/lots/${lot0.id}/me`)).s === 401, '/me needs a login (401)');

    console.log('\n== /lots/:id/bids: anonymised history ==');
    const histAnon = (await call('GET', `/lots/${lot0.id}/bids`)).j;
    const histA = (await call('GET', `/lots/${lot0.id}/bids`, tok(A))).j;
    const histB = (await call('GET', `/lots/${lot0.id}/bids`, tok(B))).j;
    const histC = (await call('GET', `/lots/${lot0.id}/bids`, tok(C))).j;
    const view = h => h.bids.map(b => `${b.bidder} ${b.amount}`).join(' | ');
    console.log('  anonymous:', view(histAnon)); console.log('  A:', view(histA)); console.log('  B:', view(histB));
    ok(histAnon.bid_count === 4 && histAnon.bids.length === 4, `every bid counted like bid_count (4 rows, bid_count ${histAnon.bid_count})`);
    ok(view(histAnon) === 'Bidder B 31.37 | Bidder A 24.41 | Bidder A 21.41 | Bidder A 1', 'newest first; each price under whoever HELD it (A held $21.41 and $24.41 although B submitted those bids)');
    ok(view(histA) === 'Bidder B 31.37 | You 24.41 | You 21.41 | You 1' && view(histB) === 'You 31.37 | Bidder A 24.41 | Bidder A 21.41 | Bidder A 1' && view(histC) === view(histAnon),
      'the same letters for everyone; "You" only for the caller\'s own');
    ok(histAnon.bids[0].amount === P.current_bid, 'the newest amount is the current bid');
    for (const [who, h] of [['anonymous', histAnon], ['A', histA], ['B', histB], ['C', histC]]) ok(leaks(h).length === 0, `${who}: no username, max or leader in the history (${leaks(h).join(', ') || 'clean'})`);
    ok(histAnon.bids.every(b => JSON.stringify(Object.keys(b)) === '["amount","at","bidder","you"]'), 'each row is exactly amount, at, bidder, you');
    // A row written before migration x (no leader recorded) is shown under its submitter, still anonymised.
    await s.from('bids').insert({ auction_id: F.S.id, item_id: lot1.id, username: C.username, amount: 7 });
    await s.from('auction_items').update({ current_bid: 7, bid_count: 1 }).eq('id', lot1.id);
    const legacy = (await call('GET', `/lots/${lot1.id}/bids`)).j;
    ok(legacy.bids.length === 1 && legacy.bids[0].bidder === 'Bidder A' && leaks(legacy).length === 0, 'a pre-migration row: under its submitter, anonymised');
    ok((await call('GET', `/lots/${lot1.id}/bids`, tok(C))).j.bids[0].bidder === 'You', '... and "You" for that submitter');

    console.log('\n== /lots/:id/related ==');
    const rel = (await call('GET', `/lots/${lot0.id}/related`)).j;
    const more = rel.more_from_auction.map(l => l.id);
    ok(JSON.stringify(more) === JSON.stringify([lot1.id, lot4.id, lot3.id]), `more from this auction: open lots only, soonest ending first, this lot and the sold lot excluded (${rel.more_from_auction.map(l => l.title).join(', ')})`);
    const sim = rel.similar.map(l => l.title);
    ok(sim.join('|') === 'zzlpmonster zzlpresin kit|zzlpmonster mask|zzlpresin statue' && rel.similar.every(l => l.auction_id === F.O.id),
      `similar: other live auctions only, best match first, no sold, unrelated or draft lot (${sim.join(', ')})`);
    ok(rel.premium_pct[F.S.id] === 15 && rel.premium_pct[F.O.id] === 15 && leaks(rel).length === 0, 'premium per auction; no max, leader or username');
    ok(Object.keys(rel.more_from_auction[0] || {}).sort().join() === 'auction_id,auction_title,bid_count,current_bid,ends_at,id,image_url,position,status,thumb_url,title', 'rail lots are the homepage Lot shape');
    const quiet = (await call('GET', `/lots/${F.QL[0].id}/related`)).j;
    ok(quiet.similar.length === 0 && quiet.more_from_auction.length === 2, 'two similar matches (fewer than 3): similar is [] (the rail hides)');
    const fromOther = (await call('GET', `/lots/${F.OL[1].id}/related`)).j;
    ok(!fromOther.similar.some(l => l.auction_id === F.D.id), 'a draft\'s lot is never similar');

    console.log('\n== drafts, unknown lots, slugs ==');
    for (const p of [`/lots/${F.DL[0].id}`, `/lots/${F.DL[0].id}/bids`, `/lots/${F.DL[0].id}/related`, `/lots/by-number/${rules.auctionSlug(F.D)}/1`]) {
      const x = await call('GET', p);
      ok(x.s === 404, `draft: GET ${p.replace(F.DL[0].id, 'DL').replace(rules.auctionSlug(F.D), 'D-slug')} -> ${x.s}`);
    }
    for (const t of [tok(A), tok({ id: crypto.randomUUID(), username: 'whatthefind' })]) {
      ok((await call('GET', `/lots/${F.DL[0].id}`, t)).s === 404 && (await call('GET', `/lots/${F.DL[0].id}/me`, t)).s === 404, 'draft: 404 for a buyer and for the admin too (the public lot page never shows drafts)');
    }
    ok((await call('GET', `/lots/${crypto.randomUUID()}`)).s === 404 && (await call('GET', '/lots/not-a-uuid')).s === 400, 'unknown lot 404, malformed id 400');
    const slug = rules.auctionSlug(F.S);
    r = await call('GET', `/lots/by-number/${slug}/1`);
    ok(r.s === 200 && r.j.lot.id === lot0.id, `by number: /lots/by-number/${slug}/1 is lot 1`);
    r = await call('GET', `/lots/by-number/an-old-title-${F.S.id.slice(0, 8)}/5`);
    ok(r.s === 200 && r.j.lot.id === lot4.id && r.j.auction.slug === slug, 'an old slug (title since renamed) still finds the lot; the answer carries the current slug');
    ok((await call('GET', `/lots/by-number/${F.S.id}/2`)).j.lot.id === lot1.id, 'a full auction id works as the slug');
    ok((await call('GET', `/lots/by-number/${slug}/99`)).s === 404 && (await call('GET', `/lots/by-number/${slug}/0`)).s === 400 && (await call('GET', '/lots/by-number/nothing-00000000/1')).s === 404, 'missing lot number 404, 0 -> 400, unknown slug 404');
  } catch (e) {
    console.log('ERR', e); fails++;
  } finally {
    if (srv) srv.stop();
    await cleanup();
    const ids = [A, B, C].map(u => u.id);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_lotpage%')).data.length
      + (await s.from('bids').select('id').in('username', USERNAMES)).data.length
      + (await s.from('pre_bids').select('id').in('buyer_username', USERNAMES)).data.length
      + (await s.from('item_images').select('id').like('url', '%zztest-lotpage%')).data.length
      + (await s.from('profiles').select('id').in('user_id', ids)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
