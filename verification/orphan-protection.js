// #44: lots and pre-bids can no longer orphan. OLD is PINNED to a836135, the last commit before #44.
//
// auction_items.auction_id and pre_bids.auction_id were uuids in TEXT columns and pre_bids.item_id had no foreign key,
// so nothing stopped a lot or pre-bid from pointing at an auction or lot that did not exist: by 2026-09-24 the database
// held 35 lots and 49 pre-bids whose auctions were gone (migration h). Migrations i (text -> uuid) and j (foreign keys:
// lot -> auction RESTRICT, pre-bid -> lot CASCADE, pre-bid -> auction CASCADE) close it; k switches
// delete_auction_cascade to plain uuid equality.
//
// Separately, DELETE /auction/:id/items/:itemId ignored its error and always answered { success: true }. A lot with an
// order cannot be deleted (orders.item_id NO ACTION - already true before #44), so the route claimed success for a lot
// that was still there. Now 409 on 23503, 500 on anything else.
//
// TWO PHASES, detected automatically from the live schema (PostgREST's column formats):
//   BEFORE migrations i+j: runs the CONTROLS - a raw lot insert for a non-existent auction, a raw pre-bid insert for a
//     non-existent lot and a bare auction delete all SUCCEED (and orphan rows) - plus the schema-independent route
//     and cascade checks, then exits 2 telling you to apply h-k. Record that output: once migrated, the controls
//     cannot be reproduced.
//   AFTER: asserts the database refuses each of those (23503), and the route/cascade checks again.
// Throwaway rows only (ZZTEST_orphanprot), always cleaned up through delete_auction_cascade.
const fs = require('fs');
const { spawn } = require('child_process');
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
const OLD_COMMIT = 'a836135';
const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const BUYER = crypto.randomUUID();

async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js', runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}

// Schema phase, read from PostgREST's OpenAPI description (no SQL access from here).
async function schema() {
  const j = await (await fetch(process.env.SUPABASE_URL + '/rest/v1/', { headers: { apikey: process.env.SUPABASE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_KEY, Accept: 'application/openapi+json' } })).json();
  const col = (t, c) => j.definitions[t].properties[c];
  const fk = p => /Foreign Key/.test(p.description || '');
  return {
    lotAuction: col('auction_items', 'auction_id'), preAuction: col('pre_bids', 'auction_id'), preItem: col('pre_bids', 'item_id'),
    get migrated() { return this.lotAuction.format === 'uuid' && fk(this.lotAuction) && this.preAuction.format === 'uuid' && fk(this.preAuction) && fk(this.preItem); },
    get partial() { return !this.migrated && (this.lotAuction.format === 'uuid' || fk(this.lotAuction) || fk(this.preItem) || fk(this.preAuction)); },
  };
}

const made = { auctions: [], lots: [], strays: { lots: [], pre_bids: [] } };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const soon = () => new Date(Date.now() + 36e5).toISOString();
async function mkAuction(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_orphanprot_' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single());
  made.auctions.push(a.id); return a.id;
}
async function mkLot(auctionId, n) {
  const l = die(await s.from('auction_items').insert({ auction_id: auctionId, title: 'ZZTEST_orphanprot lot ' + n, starting_bid: 0, position: n, status: 'pending', ends_at: soon() }).select().single());
  made.lots.push(l.id); return l.id;
}
// a lot with a row in every table that hangs off a lot
async function dress(auctionId, lotId) {
  die(await s.from('pre_bids').insert({ item_id: lotId, auction_id: auctionId, buyer_username: 'zztest_orphanprot', buyer_user_id: BUYER, max_amount: 9 }).select().single());
  die(await s.from('item_images').insert({ item_id: lotId, url: 'https://example.invalid/zz.jpg', position: 0 }).select().single());
  die(await s.from('outbid_email_log').insert({ item_id: lotId, username: 'zztest_orphanprot' }).select().single());
  die(await s.from('bids').insert({ auction_id: auctionId, item_id: lotId, username: 'zztest_orphanprot', amount: 5 }).select().single());
}
const n = async (t, col, ids) => ids.length ? (await s.from(t).select('*', { count: 'exact', head: true }).in(col, ids)).count : 0;
const hanging = async lots => ({ pre_bids: await n('pre_bids', 'item_id', lots), images: await n('item_images', 'item_id', lots), outbid: await n('outbid_email_log', 'item_id', lots), bids: await n('bids', 'item_id', lots) });
const zero = o => Object.values(o).every(v => v === 0);
const delLot = (port, a, i) => fetch(`http://localhost:${port}/auction/${a}/items/${i}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin } }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));

(async () => {
  const servers = [];
  const sc = await schema();
  console.log(`schema: auction_items.auction_id ${sc.lotAuction.format}, pre_bids.auction_id ${sc.preAuction.format}, pre_bids.item_id ${sc.preItem.format}; phase = ${sc.migrated ? 'AFTER migrations i+j' : sc.partial ? 'PARTIAL (!)' : 'BEFORE migrations i+j'}\n`);
  if (sc.partial) { console.error('Schema is part-way through #44 (some of i/j applied, not all). Finish h-k in order, then re-run.'); process.exit(2); }
  try {
    const ghostAuction = crypto.randomUUID(), ghostLot = crypto.randomUUID();

    console.log('== Raw inserts that point at nothing ==');
    const rl = await s.from('auction_items').insert({ auction_id: ghostAuction, title: 'ZZTEST_orphanprot stray lot', starting_bid: 0, position: 0, status: 'pending' }).select('id').maybeSingle();
    if (rl.data) made.strays.lots.push(rl.data.id);
    const rp = await s.from('pre_bids').insert({ item_id: ghostLot, auction_id: ghostAuction, buyer_username: 'zztest_orphanprot', buyer_user_id: BUYER, max_amount: 1 }).select('id').maybeSingle();
    if (rp.data) made.strays.pre_bids.push(rp.data.id);
    if (sc.migrated) {
      ok(rl.error?.code === '23503' && /auction_items_auction_id_fkey/.test(rl.error.message), `a lot for a non-existent auction is refused: ${rl.error?.code} ${rl.error?.message}`);
      ok(rp.error?.code === '23503' && /pre_bids_(item|auction)_id_fkey/.test(rp.error.message), `a pre-bid for a non-existent lot is refused: ${rp.error?.code} ${rp.error?.message}`);
    } else {
      ok(!rl.error && !!rl.data, `CONTROL (pre-migration): a lot for a non-existent auction is ACCEPTED: ${rl.error ? rl.error.code + ' ' + rl.error.message : 'inserted ' + rl.data.id}  <- ORPHAN CREATED`);
      ok(!rp.error && !!rp.data, `CONTROL (pre-migration): a pre-bid for a non-existent lot (and auction) is ACCEPTED: ${rp.error ? rp.error.code + ' ' + rp.error.message : 'inserted ' + rp.data.id}  <- ORPHAN CREATED`);
    }

    console.log('\n== A bare `delete from auctions` on an auction that still has lots ==');
    const B = await mkAuction('bare'); const bl = await mkLot(B, 0); await dress(B, bl);
    const bd = await s.from('auctions').delete().eq('id', B);
    const bLeft = await n('auction_items', 'id', [bl]);
    if (sc.migrated) {
      ok(bd.error?.code === '23503' && /auction_items_auction_id_fkey/.test(bd.error.message) && bLeft === 1 && (await n('auctions', 'id', [B])) === 1, `refused (lot -> auction is RESTRICT), auction and lot both still there: ${bd.error?.code} ${bd.error?.message}`);
    } else {
      ok(!bd.error && bLeft === 1 && (await n('auctions', 'id', [B])) === 0, `CONTROL (pre-migration): the auction is deleted and its lot is left behind pointing at nothing (${bLeft} lot, ${JSON.stringify(await hanging([bl]))} hanging off it)  <- ORPHAN CREATED`);
    }

    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    servers.push(await boot('orphold', 3341, oldSrc), await boot('orphnew', 3342, newSrc));

    console.log('\n== DELETE /auction/:id/items/:itemId on a lot that has an ORDER ==');
    const O = await mkAuction('order');
    const ol = await mkLot(O, 0), ol2 = await mkLot(O, 1);
    for (const l of [ol, ol2]) die(await s.from('orders').insert({ auction_id: O, item_id: l, buyer_username: 'zztest_orphanprot', buyer_user_id: BUYER, item_title: 'ZZTEST_orphanprot order', final_bid: 1, status: 'pending', payment_status: 'unpaid' }).select().single());
    let r = await delLot(3341, O, ol);
    ok(r.s === 200 && r.j.success === true && (await n('auction_items', 'id', [ol])) === 1, `OLD (${OLD_COMMIT}): answers ${r.s} ${JSON.stringify(r.j)} but the lot is STILL THERE (the database refused it)  <- FALSE SUCCESS`);
    r = await delLot(3342, O, ol2);
    ok(r.s === 409 && /has an order/.test(r.j.error) && /Nothing was removed/.test(r.j.detail) && (await n('auction_items', 'id', [ol2])) === 1, `NEW: ${r.s} "${r.j.error}" / "${r.j.detail}", lot still there`);

    console.log('\n== DELETE /auction/:id/items/:itemId on a lot with pre-bids, images, outbid log and bids ==');
    const C = await mkAuction('cascade'); const cl = await mkLot(C, 0); await dress(C, cl);
    const before = await hanging([cl]);
    r = await delLot(3342, C, cl);
    const after = await hanging([cl]);
    if (sc.migrated) {
      ok(r.s === 200 && r.j.success && (await n('auction_items', 'id', [cl])) === 0 && zero(after) && !zero(before), `NEW: ${r.s}, lot gone and everything hanging off it went with it: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    } else {
      ok(r.s === 200 && (await n('auction_items', 'id', [cl])) === 0 && after.pre_bids === 1 && after.images === 0 && after.outbid === 0 && after.bids === 0, `CONTROL (pre-migration): lot deleted; images, outbid log and bids cascade, but its PRE-BID is left pointing at nothing (pre_bids.item_id has no FK): before ${JSON.stringify(before)}, after ${JSON.stringify(after)}  <- ORPHAN CREATED`);
    }

    console.log('\n== delete_auction_cascade on a fixture auction with lots, pre-bids, images, outbid log and bids ==');
    const D = await mkAuction('fn'); const dl = [await mkLot(D, 0), await mkLot(D, 1), await mkLot(D, 2)];
    for (const l of dl) await dress(D, l);
    const dBefore = { lots: await n('auction_items', 'auction_id', [D]), ...(await hanging(dl)) };
    const fr = await s.rpc('delete_auction_cascade', { p_auction_id: D });
    const dAfter = { auction: await n('auctions', 'id', [D]), lots: await n('auction_items', 'id', dl), pre_bids_by_auction: await n('pre_bids', 'auction_id', [D]), ...(await hanging(dl)), bids_by_auction: await n('bids', 'auction_id', [D]) };
    ok(!fr.error && zero(dAfter) && dBefore.lots === 3 && dBefore.pre_bids === 3, `${fr.error ? 'ERROR ' + fr.error.code + ' ' + fr.error.message : 'ok'}; before ${JSON.stringify(dBefore)}, after ${JSON.stringify(dAfter)} - zero orphans`);
  } finally {
    servers.forEach(x => x.cleanup());
    // stray rows only exist on the pre-migration schema (the controls); they have no auction, so remove them directly
    if (made.strays.pre_bids.length) await s.from('pre_bids').delete().in('id', made.strays.pre_bids);
    if (made.strays.lots.length) await s.from('auction_items').delete().in('id', made.strays.lots);
    for (const id of made.auctions) {
      await s.from('orders').delete().eq('auction_id', id);
      const r = await s.rpc('delete_auction_cascade', { p_auction_id: id });
      if (r.error) console.log('  cleanup: delete_auction_cascade', id, r.error.code, r.error.message);
    }
    // the bare-delete control removes its auction and leaves the lot: clean the lot and what hangs off it by id
    await s.from('pre_bids').delete().in('item_id', made.lots); await s.from('item_images').delete().in('item_id', made.lots);
    await s.from('outbid_email_log').delete().in('item_id', made.lots); await s.from('bids').delete().in('item_id', made.lots);
    await s.from('auction_items').delete().in('id', made.lots);
    const leftBy = {
      auctions: await n('auctions', 'id', made.auctions), orders: (await s.from('orders').select('id').eq('buyer_username', 'zztest_orphanprot')).data.length,
      lots: await n('auction_items', 'id', [...made.lots, ...made.strays.lots]), pre_bids: (await s.from('pre_bids').select('id').eq('buyer_username', 'zztest_orphanprot')).data.length,
      images: await n('item_images', 'item_id', made.lots), outbid: await n('outbid_email_log', 'item_id', made.lots), bids: (await s.from('bids').select('id').eq('username', 'zztest_orphanprot')).data.length,
    };
    const left = Object.values(leftBy).reduce((a, b) => a + b, 0);
    console.log('\nleftover throwaway rows:', left, left ? JSON.stringify(leftBy) : '');
    if (left) fails++;
  }
  if (!sc.migrated) {
    console.log(fails ? '\n' + fails + ' FAILED' : '\nCONTROLS RECORDED (pre-migration). Apply migrations h, i, j, k in order, then re-run for the real assertions.');
    process.exit(fails ? 1 : 2);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
