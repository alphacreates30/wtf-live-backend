// Security review #3: only an approved, unblocked buyer with a saved card may accept terms, pre-bid or bid, and a
// max bid must be a sane amount. The bid routes only checked login + terms, so accounts with no profile, pending,
// rejected and even blocked could take the lead, and a $99,999,999 max was accepted.
// OLD is PINNED to 528c94e (before the fix). Local servers on the test database; Stripe and email blanked.
// Bidders are token-only throwaway ids with profiles carrying placeholder card ids.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '528c94e';
const at = sec => new Date(Date.now() + sec * 1000).toISOString();
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };

// kind: null = no profile at all; otherwise a profile with that status, with or without a (placeholder) card.
const KINDS = [['no profile', null, false], ['pending', 'pending', true], ['rejected', 'rejected', true], ['blocked', 'blocked', true], ['approved, no card', 'approved', false]];
async function mkBuyer(label, status, card) {
  const u = { id: crypto.randomUUID(), username: 'zztest_bidelig_' + label.replace(/\W+/g, '_') };
  made.users.push(u.id);
  if (status) die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZTEST bidelig', email: 'zztest_bidelig@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status, ...(card ? { stripe_customer_id: 'cus_ZZFIXTURE_bidelig', stripe_payment_method_id: 'pm_ZZFIXTURE_bidelig' } : {}) }).select().single());
  return { ...u, tok: jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}
async function mkAuction(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_bidelig ' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', buyers_premium_pct: 15, ends_at: at(3600) }).select().single());
  made.auctions.push(a.id);
  const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_bidelig lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: at(3600) }).select().single());
  const pre = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_bidelig prebid lot', starting_bid: 0, position: 1, status: 'pending' }).select().single());
  return { a: a.id, lot: lot.id, pre: pre.id };
}
const call = (url, method, path, tok, body) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const lotRow = async id => die(await s.from('auction_items').select('leading_bidder, bid_count, current_bid').eq('id', id).single());

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const buyers = [];
    for (const [label, status, card] of KINDS) buyers.push([label, await mkBuyer(label, status, card)]);
    const good = await mkBuyer('approved with card', 'approved', true);
    const oldSrv = await boot('bidelig-old', 3381, oldSrc), newSrv = await boot('bidelig-new', 3382, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT}: accounts that should not bid ==`);
    const O = await mkAuction('old');
    let amount = 0;
    for (const [label, b] of buyers) {
      amount += 10;
      const t = await call(oldSrv.url, 'POST', `/auction/${O.a}/terms-acceptance`, b.tok, {});
      const r = await call(oldSrv.url, 'POST', `/auction/${O.a}/items/${O.lot}/bid`, b.tok, { max_amount: amount });
      const lot = await lotRow(O.lot);
      ok(t.s === 200 && r.s === 200 && lot.leading_bidder === b.username, `OLD ${label}: terms ${t.s}, bid ${r.s}, now leading  <- SHOULD NOT BE ABLE TO BID`);
    }
    const huge = await call(oldSrv.url, 'POST', `/auction/${O.a}/items/${O.lot}/bid`, buyers[0][1].tok, { max_amount: 99999999 });
    ok(huge.s === 200, `OLD: a $99,999,999 max is accepted (${huge.s})  <- NO CAP`);

    console.log('\n== SAME accounts on the FIXED code ==');
    const N = await mkAuction('new');
    const expect = { 'no profile': 'no_profile', pending: 'not_approved', rejected: 'not_approved', blocked: 'blocked', 'approved, no card': 'no_card' };
    for (const [label, b] of buyers) {
      const t = await call(newSrv.url, 'POST', `/auction/${N.a}/terms-acceptance`, b.tok, {});
      const r = await call(newSrv.url, 'POST', `/auction/${N.a}/items/${N.lot}/bid`, b.tok, { max_amount: 10 });
      const p = await call(newSrv.url, 'POST', `/auction/${N.a}/items/${N.pre}/prebid`, b.tok, { max_amount: 10 });
      const code = expect[label];
      ok(t.s === 403 && t.j.code === code && r.s === 403 && r.j.code === code && p.s === 403 && p.j.code === code,
        `NEW ${label}: terms ${t.s}, bid ${r.s}, pre-bid ${p.s}, all '${r.j && r.j.code}' ("${r.j && r.j.error}")`);
    }
    const lotAfter = await lotRow(N.lot);
    const terms = die(await s.from('auction_terms_acceptances').select('user_id').eq('auction_id', N.a));
    const pres = die(await s.from('pre_bids').select('id').eq('item_id', N.pre));
    ok(!lotAfter.leading_bidder && lotAfter.bid_count === 0 && terms.length === 0 && pres.length === 0, `NEW: nothing written for any of them (bid_count ${lotAfter.bid_count}, ${terms.length} terms rows, ${pres.length} pre-bids)`);

    console.log('\n== FIXED code: the legitimate buyer, and the amount rules ==');
    let r = await call(newSrv.url, 'POST', `/auction/${N.a}/terms-acceptance`, good.tok, {});
    ok(r.s === 200, `NEW approved buyer with a card accepts terms: ${r.s}`);
    for (const [v, why] of [[99999999, '$99,999,999'], [100000.01, 'just over $100,000'], ['abc', 'text'], [0.5, 'under $1'], [null, 'missing']]) {
      r = await call(newSrv.url, 'POST', `/auction/${N.a}/items/${N.lot}/bid`, good.tok, { max_amount: v });
      ok(r.s === 400, `NEW max_amount ${why}: ${r.s} "${r.j && r.j.error}"`);
    }
    r = await call(newSrv.url, 'POST', `/auction/${N.a}/items/${N.lot}/bid`, good.tok, { max_amount: '25' });
    const led = await lotRow(N.lot);
    ok(r.s === 200 && led.leading_bidder === good.username && led.bid_count === 1, `NEW approved buyer bids (max "25" as a string): ${r.s}, leading, bid_count ${led.bid_count}`);
    r = await call(newSrv.url, 'POST', `/auction/${N.a}/items/${N.pre}/prebid`, good.tok, { max_amount: 100000 });
    ok(r.s === 200, `NEW approved buyer pre-bids exactly $100,000 (the cap): ${r.s}`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) { const d = await s.rpc('delete_auction_cascade', { p_auction_id: id }); if (d.error) console.log('cleanup error', id, d.error.message); }
    await s.from('auction_terms_acceptances').delete().in('user_id', made.users);
    await s.from('profiles').delete().in('user_id', made.users);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_bidelig%')).data.length
      + (await s.from('profiles').select('id').in('user_id', made.users)).data.length
      + (await s.from('auction_terms_acceptances').select('user_id').in('user_id', made.users)).data.length
      + (await s.from('bids').select('id').like('username', 'zztest_bidelig_%')).data.length
      + (await s.from('pre_bids').select('id').like('buyer_username', 'zztest_bidelig_%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
