// Terms-gate reproduction + fix proof. THROWAWAY rows only (ZZTEST_termsgate*), always cleaned up.
// OLD = PINNED to c5caa33, the commit before the terms-gate fix (385ea56). NEW = working tree.
const fs = require('fs');
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
const USERNAME = 'zztest_termsgate';
const tok = jwt.sign({ id: U, username: USERNAME }, process.env.JWT_SECRET, { expiresIn: '10m' });
// A second buyer, only used to challenge the leader's raised max.
const U2 = crypto.randomUUID();
const tok2 = jwt.sign({ id: U2, username: USERNAME + '2' }, process.env.JWT_SECRET, { expiresIn: '10m' });
let leaderMaxMigrated = true;
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const ids = { auctions: [], items: [] };

async function mkAuction(label, premium, fmode) {
  const r = await s.from('auctions').insert({ title: 'ZZTEST_termsgate_' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: fmode, buyers_premium_pct: premium, host_username: 'whatthefind', ends_at: future(48) }).select().single();
  if (r.error) throw new Error('auction: ' + JSON.stringify(r.error));
  ids.auctions.push(r.data.id); return r.data.id;
}
async function mkItem(auctionId, title, status) {
  const r = await s.from('auction_items').insert({ auction_id: auctionId, title, starting_bid: 0, position: 0, status, ends_at: future(24) }).select().single();
  if (r.error) throw new Error('item: ' + JSON.stringify(r.error));
  ids.items.push(r.data.id); return r.data.id;
}
const post = (port, path, body, token = tok) => fetch('http://localhost:' + port + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const bidRows = async id => (await s.from('bids').select('id').eq('item_id', id)).data;
const item = async id => (await s.from('auction_items').select('leading_bidder,bid_count,current_bid,auction_id').eq('id', id).single()).data;
const prebids = async id => (await s.from('pre_bids').select('id,auction_id,item_id').eq('item_id', id)).data;

(async () => {
  const oldSrc = require('./guard').sourceAt('c5caa33', BE);
  const newSrc = require('./guard').readSource(BE + '/server.js');
  const servers = [];
  try {
    const A = await mkAuction('A', 15, 'shipping');
    const B = await mkAuction('B', 25, 'both');
    const itemB = await mkItem(B, 'ZZTEST B open lot', 'open');
    const itemB2 = await mkItem(B, 'ZZTEST B pending lot', 'pending');
    const itemA = await mkItem(A, 'ZZTEST A open lot', 'open');
    const itemA2 = await mkItem(A, 'ZZTEST A pending lot', 'pending');
    const p = await s.from('profiles').insert({ user_id: U, full_name: 'ZZTEST termsgate', email: 'zztest_termsgate@example.invalid', phone: '5555550100', address_line1: '1 Test St', city: 'Testville', state: 'CA', zip: '94000', status: 'approved' });
    if (p.error) throw new Error('profile: ' + JSON.stringify(p.error));
    // The buyer accepted terms on auction A ONLY (15% premium, shipping). Never on B (25%, both).
    const t = await s.from('auction_terms_acceptances').insert({ auction_id: A, user_id: U, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' });
    if (t.error) throw new Error('acceptance: ' + JSON.stringify(t.error));

    const oldS = await boot('old', 3241, oldSrc); servers.push(oldS);
    const newS = await boot('new', 3242, newSrc); servers.push(newS);

    console.log('\n== REPRODUCE on the pre-fix code (c5caa33): terms accepted on A only, bid on a lot in B via the A url ==');
    let r = await post(3241, `/auction/${A}/items/${itemB}/bid`, { max_amount: 5 });
    let it = await item(itemB);
    ok(r.s === 200 && it.leading_bidder === USERNAME && it.bid_count > 0, `OLD bid via /auction/A on a lot in auction B: ${r.s}, lot now led by ${it.leading_bidder}, bid_count ${it.bid_count}  <- BUG REPRODUCED`);
    r = await post(3241, `/auction/${A}/items/${itemB2}/prebid`, { max_amount: 7 });
    let pb = await prebids(itemB2);
    ok(r.s === 200 && pb.length === 1, `OLD pre-bid via /auction/A on a lot in auction B: ${r.s}, pre_bids rows ${pb.length} (row's auction_id=${pb[0] && (pb[0].auction_id === A ? 'A (wrong auction)' : pb[0].auction_id)})  <- BUG REPRODUCED`);
    r = await post(3241, `/auction/${B}/items/${itemB}/bid`, { max_amount: 5 });
    ok(r.s === 403, `OLD control: the SAME bid via the correct /auction/B url is refused for missing terms (${r.s}) - so the gate works when the url is honest`);

    // reset B's lots so the fixed-code run starts from a clean state
    await s.from('pre_bids').delete().eq('item_id', itemB2);
    await s.from('auction_items').update({ leading_bidder: null, bid_count: 0, current_bid: 0 }).eq('id', itemB);
    await s.from('bids').delete().eq('auction_id', B);

    console.log('\n== SAME requests on the FIXED code ==');
    r = await post(3242, `/auction/${A}/items/${itemB}/bid`, { max_amount: 5 });
    it = await item(itemB);
    ok(r.s === 404 && it.leading_bidder == null && !it.bid_count, `NEW bid via /auction/A on a lot in B: refused (${r.s} ${r.j.error}), lot unchanged (leader ${it.leading_bidder}, bid_count ${it.bid_count})`);
    r = await post(3242, `/auction/${A}/items/${itemB2}/prebid`, { max_amount: 7 });
    pb = await prebids(itemB2);
    ok(r.s === 404 && pb.length === 0, `NEW pre-bid via /auction/A on a lot in B: refused (${r.s} ${r.j.error}), pre_bids rows ${pb.length}`);
    r = await post(3242, `/auction/${A.toUpperCase()}/items/${itemB}/bid`, { max_amount: 5 });
    ok(r.s === 404 && !(await item(itemB)).bid_count, `NEW uppercase A url on B's lot: still refused (${r.s})`);
    r = await post(3242, `/auction/${B}/items/${itemB}/bid`, { max_amount: 5 });
    ok(r.s === 403, `NEW honest url /auction/B without terms on B: still 403 (${r.s})`);

    console.log('\n== FIXED code must still allow the legitimate cases (terms on A, lots in A) ==');
    r = await post(3242, `/auction/${A}/items/${itemA}/bid`, { max_amount: 5 });
    it = await item(itemA);
    ok(r.s === 200 && it.leading_bidder === USERNAME && it.bid_count > 0, `NEW legit bid on A's lot via /auction/A: ${r.s}, led by ${it.leading_bidder}`);
    r = await post(3242, `/auction/${A}/items/${itemA2}/prebid`, { max_amount: 7 });
    pb = await prebids(itemA2);
    ok(r.s === 200 && pb.length === 1 && pb[0].auction_id === A, `NEW legit pre-bid on A's lot via /auction/A: ${r.s}, row auction_id=A`);
    const before = await item(itemA);
    r = await post(3242, `/auction/${A.toUpperCase()}/items/${itemA}/bid`, { max_amount: 20 });
    ok(r.s === 200, `NEW legit bid using an UPPERCASE auction id on A's own lot still works (${r.s}) - compare is case-insensitive`);

    // The leader resubmitting their max (raise, then repeat) must update the max only: no bids row, no bid_count
    // bump, price unchanged (TEST Auction lot 1 showed "Bids: 2" for one bidder). Needs migration 2026-09-27n;
    // without it the route falls back to place_standard_bid, which adds a row each time.
    console.log('\n== Leader resubmits their own max (raise $5 -> $20, then repeat $20) ==');
    const probe = await s.rpc('update_standard_leader_max', { p_item_id: crypto.randomUUID(), p_username: 'nobody', p_max_amount: 1 });
    leaderMaxMigrated = !probe.error;
    r = await post(3242, `/auction/${A}/items/${itemA}/bid`, { max_amount: 20 });
    const after = await item(itemA);
    const rows = await bidRows(itemA);
    const max = (await s.from('pre_bids').select('max_amount').eq('item_id', itemA).eq('buyer_username', USERNAME).single()).data;
    const clean = after.bid_count === before.bid_count && rows.length === before.bid_count && Number(after.current_bid) === Number(before.current_bid) && after.leading_bidder === USERNAME && Number(max.max_amount) === 20;
    const detail = `bid_count ${before.bid_count} -> ${after.bid_count}, bids rows ${rows.length}, current_bid ${before.current_bid} -> ${after.current_bid}, max ${max.max_amount}`;
    if (leaderMaxMigrated) {
      ok(r.s === 200 && clean, `NEW leader raise + repeat: max recorded, no new visible bid (${detail})`);
      // The raised max must still be the one a challenger fights: $10 < $20, so the leader keeps the lot.
      const t2 = await s.from('auction_terms_acceptances').insert({ auction_id: A, user_id: U2, accepted_at: new Date().toISOString(), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' });
      if (t2.error) throw new Error('acceptance 2: ' + JSON.stringify(t2.error));
      r = await post(3242, `/auction/${A}/items/${itemA}/bid`, { max_amount: 10 }, tok2);
      const fought = await item(itemA);
      ok(r.s === 200 && fought.leading_bidder === USERNAME && Number(fought.current_bid) >= 10 && fought.bid_count === after.bid_count + 1, `NEW challenger at $10 vs the raised $20 max: leader keeps the lot at $${fought.current_bid}, bid_count ${fought.bid_count} (the challenge is a real bid)`);
    } else {
      console.log(`SKIP migration 2026-09-27n not applied: leader resubmit still goes through place_standard_bid (${detail})${clean ? '' : '  <- BUG REPRODUCED'}`);
    }
  } finally {
    servers.forEach(x => x.cleanup());
    await s.from('pre_bids').delete().in('buyer_user_id', [U, U2]);
    await s.from('bids').delete().in('auction_id', ids.auctions);
    await s.from('auction_terms_acceptances').delete().in('user_id', [U, U2]);
    await s.from('profiles').delete().eq('user_id', U);
    if (ids.items.length) await s.from('auction_items').delete().in('id', ids.items);
    if (ids.auctions.length) await s.from('auctions').delete().in('id', ids.auctions);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_termsgate%')).data.length
      + (await s.from('auction_items').select('id').like('title', 'ZZTEST %lot')).data.length
      + (await s.from('pre_bids').select('id').in('buyer_user_id', [U, U2])).data.length
      + (await s.from('auction_terms_acceptances').select('user_id').in('user_id', [U, U2])).data.length
      + (await s.from('profiles').select('id').eq('user_id', U)).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  if (!fails && !leaderMaxMigrated) { console.log('\nALL PASS except the leader-resubmit check, skipped: apply migrations/2026-09-27n and re-run'); process.exit(2); }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
