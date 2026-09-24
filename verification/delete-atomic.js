// DELETE /auction/:id atomicity. OLD is PINNED to the commit before the fix (80fdcd9), so the reproduction stays valid.
//
// The bug: the route checked for orders, then deleted lots, bids and chat, THEN the auction, ignoring the last error.
// Orders are created when an auction closes, so an order can appear between the check and the delete: the database
// refuses the parent (orders_auction_id_fkey RESTRICT) but the children are already gone and the route answered 200.
//
// The race is SIMULATED deterministically: the test servers are source-patched to insert an order for the auction in
// the gap after the check has passed. The assertion that matters is that the CHILD ROWS SURVIVE - lots, bids, chat,
// pre-bids, images, terms acceptances - not the status code.
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
const OLD_COMMIT = '80fdcd9';
const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });

const RACE = "await supabase.from('orders').insert({ auction_id: auctionId, buyer_username: 'zztest_delatomic', buyer_user_id: 'zztest-delatomic', item_title: 'ZZTEST_delatomic raced order', final_bid: 1, status: 'pending', payment_status: 'unpaid' });\n";
const OLD_MARK = "  await supabase.from('auction_items').delete().eq('auction_id', auctionId);";
const NEW_MARK = "  const { error: delErr } = await supabase.rpc('delete_auction_cascade', { p_auction_id: auctionId });";
const withRace = (src, mark) => { if (!src.includes(mark)) throw new Error('marker not found: ' + mark); return src.replace(mark, '  ' + RACE + mark); };

async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const made = { auctions: [] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const soon = () => new Date(Date.now() + 36e5).toISOString();
// an auction with a child row in EVERY dependent table
async function mk(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_delatomic_' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
  made.auctions.push(a.id);
  const lots = [];
  for (const p of [0, 1]) lots.push(die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_delatomic lot ' + p, starting_bid: 0, position: p, status: 'pending', ends_at: soon() }).select().single()).id);
  die(await s.from('bids').insert({ auction_id: a.id, item_id: lots[0], username: 'zztest_delatomic', amount: 5 }).select().single());
  die(await s.from('chat_messages').insert({ auction_id: a.id, username: 'zztest_delatomic', text: 'hello', role: 'viewer' }).select().single());
  die(await s.from('pre_bids').insert({ item_id: lots[1], auction_id: a.id, buyer_username: 'zztest_delatomic', buyer_user_id: 'zztest-delatomic', max_amount: 9 }).select().single());
  die(await s.from('item_images').insert({ item_id: lots[0], url: 'https://example.invalid/zz.jpg', position: 0 }).select().single());
  die(await s.from('outbid_email_log').insert({ item_id: lots[0], username: 'zztest_delatomic' }).select().single());
  die(await s.from('auction_terms_acceptances').insert({ auction_id: a.id, user_id: 'zztest-delatomic', buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: 'zz' }).select().single());
  return { id: a.id, lots };
}
const count = async (t, col, val) => (await s.from(t).select('*', { count: 'exact', head: true }).in(col, Array.isArray(val) ? val : [val])).count;
const snapshot = async A => ({
  auction: await count('auctions', 'id', A.id), lots: await count('auction_items', 'auction_id', A.id), bids: await count('bids', 'auction_id', A.id),
  chat: await count('chat_messages', 'auction_id', A.id), prebids: await count('pre_bids', 'auction_id', A.id), images: await count('item_images', 'item_id', A.lots),
  outbid: await count('outbid_email_log', 'item_id', A.lots), terms: await count('auction_terms_acceptances', 'auction_id', A.id),
});
const FULL = { auction: 1, lots: 2, bids: 1, chat: 1, prebids: 1, images: 1, outbid: 1, terms: 1 };
const GONE = { auction: 0, lots: 0, bids: 0, chat: 0, prebids: 0, images: 0, outbid: 0, terms: 0 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const del = (port, id) => fetch('http://localhost:' + port + '/auction/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin } }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));

(async () => {
  const servers = [];
  try {
    // preflight: the fixed route calls a database function (migrations/2026-09-20e); refuse to run without it
    // (a random id returns early, so also exercise it on a real row: e's first version passed this preflight and then failed on text = uuid)
    const probe = die(await s.from('auctions').insert({ title: 'ZZTEST_delatomic_preflight', description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
    made.auctions.push(probe.id);
    die(await s.from('auction_items').insert({ auction_id: probe.id, title: 'ZZTEST_delatomic preflight lot', starting_bid: 0, position: 0, status: 'pending', ends_at: soon() }).select().single());
    const pre = await s.rpc('delete_auction_cascade', { p_auction_id: probe.id });
    if (pre.error) { console.error('\nmigrations/2026-09-20e + 20f (delete-auction-cascade) not applied, or broken (' + pre.error.code + ' ' + pre.error.message + ').\n'); process.exit(2); }
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    servers.push(await boot('oldrace', 3291, withRace(oldSrc, OLD_MARK)), await boot('newrace', 3292, withRace(newSrc, NEW_MARK)), await boot('newclean', 3293, newSrc));

    console.log(`== REPRODUCE on ${OLD_COMMIT} (pre-fix): an order is created after the order check has passed ==`);
    let A = await mk('old_race'); ok(same(await snapshot(A), FULL), 'fixture has a child row in every dependent table ' + JSON.stringify(FULL));
    let r = await del(3291, A.id); let sn = await snapshot(A);
    ok(r.s === 200 && sn.auction === 1 && sn.lots === 0 && sn.bids === 0 && sn.chat === 0, `OLD: route answered ${r.s} (success), the DB refused the auction, and the children are GONE: ${JSON.stringify(sn)}  <- DATA LOSS WITH A FALSE SUCCESS`);

    console.log('\n== SAME race on the FIXED code: the assertion is that the CHILD ROWS SURVIVE ==');
    A = await mk('new_race'); r = await del(3292, A.id); sn = await snapshot(A);
    ok(same(sn, FULL), `NEW: every child row survived (lots, bids, chat, pre-bids, images, outbid log, terms) and so did the auction: ${JSON.stringify(sn)}`);
    ok(r.s === 409 && /has orders/.test(r.j.error) && /Nothing was removed/.test(r.j.detail), `NEW: and the route says so honestly: ${r.s} "${r.j.error}" / "${r.j.detail}"`);

    console.log('\n== FIXED code, other cases ==');
    A = await mk('new_invoice'); const inv = die(await s.from('invoices').insert({ auction_id: A.id, buyer_user_id: 'zztest-delatomic', buyer_username: 'zztest_delatomic', total_cents: 100, payment_status: 'unpaid' }).select().single());
    r = await del(3293, A.id); sn = await snapshot(A);
    ok(same(sn, FULL) && r.s === 409, `NEW: an auction with only an INVOICE (no orders, so the order pre-check passes) is refused by the DB with nothing removed: ${r.s}, ${JSON.stringify(sn)}`);
    await s.from('invoices').delete().eq('id', inv.id);
    A = await mk('new_clean'); r = await del(3293, A.id); sn = await snapshot(A);
    ok(r.s === 200 && r.j.success && same(sn, GONE), `NEW: a deletable auction goes in ONE statement, every dependent removed with it: ${r.s}, ${JSON.stringify(sn)}`);
    // rows poisoned with an UPPERCASE auction id (text columns; the id-normalisation bug used to store them) must not be orphaned
    A = await mk('new_upper');
    await s.from('auction_items').update({ auction_id: A.id.toUpperCase() }).eq('auction_id', A.id);
    await s.from('pre_bids').update({ auction_id: A.id.toUpperCase() }).eq('auction_id', A.id);
    const upperLots = (await s.from('auction_items').select('id').eq('auction_id', A.id.toUpperCase())).data.length;
    r = await del(3293, A.id); sn = await snapshot(A);
    const upperLeft = (await s.from('auction_items').select('id').eq('auction_id', A.id.toUpperCase())).data.length + (await s.from('pre_bids').select('item_id').eq('auction_id', A.id.toUpperCase())).data.length;
    ok(upperLots === 2 && r.s === 200 && upperLeft === 0 && sn.auction === 0 && sn.images === 0 && sn.outbid === 0, `NEW: lots and pre-bids stored with an UPPERCASE auction id are removed too, not orphaned (${upperLots} such lots before, ${upperLeft} rows left): ${r.s}`);
    r = await del(3293, A.id);
    ok(r.s === 200, `NEW: deleting an already-deleted auction is still a harmless ${r.s} (unchanged behaviour)`);
  } finally {
    servers.forEach(x => x.cleanup());
    for (const id of made.auctions) { await s.from('orders').delete().eq('auction_id', id); await s.from('invoices').delete().eq('auction_id', id); await s.from('auctions').delete().eq('id', id); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_delatomic_%')).data.length + (await s.from('orders').select('id').eq('buyer_username', 'zztest_delatomic')).data.length + (await s.from('invoices').select('id').eq('buyer_username', 'zztest_delatomic')).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
