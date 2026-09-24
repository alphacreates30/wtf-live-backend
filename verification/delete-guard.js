const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const src = require('./guard').readSource(BE + '/server.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = jwt.sign({ id: 'x', username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const other = jwt.sign({ id: 'y', username: 'someone' }, process.env.JWT_SECRET, { expiresIn: '10m' });

async function variant(name, port, mutate) {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, mutate(src));
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  await sleep(5000);
  return { child, cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
const del = (port, id, tok = admin) => fetch('http://localhost:' + port + '/auction/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).then(async r => ({ s: r.status, j: await r.json() }));

// throwaway fixtures, ZZTEST_ prefixed, always cleaned up
async function mk(label, withOrder, withItem) {
  const a = await s.from('auctions').insert({ title: 'ZZTEST_delguard_' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date().toISOString() }).select().single();
  globalThis.__mk = (globalThis.__mk || []).concat(a.data ? [a.data.id] : []);
  if (a.error) throw new Error('auction insert: ' + JSON.stringify(a.error));
  let order = null, item = null;
  if (withItem) {
    const i = await s.from('auction_items').insert({ auction_id: a.data.id, title: 'ZZTEST_delguard item', starting_bid: 0, position: 0, status: 'pending', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single();
    if (i.error) throw new Error('item insert: ' + JSON.stringify(i.error));
    item = i.data;
  }
  if (withOrder) {
    const o = await s.from('orders').insert({ auction_id: a.data.id, buyer_username: 'zztest_delguard', buyer_user_id: 'zztest-delguard', item_title: 'ZZTEST_delguard lot', final_bid: 1, status: 'pending', payment_status: 'unpaid' }).select().single();
    if (o.error) throw new Error('order insert: ' + JSON.stringify(o.error));
    order = o.data;
  }
  return { id: a.data.id, order, item };
}
const exists = async id => !!(await s.from('auctions').select('id').eq('id', id).maybeSingle()).data;
const itemExists = async id => !!(await s.from('auction_items').select('id').eq('id', id).maybeSingle()).data;
const orderRow = async id => (await s.from('orders').select('id,auction_id').eq('id', id).maybeSingle()).data;

(async () => {
  const runs = []; const made = [];
  try {
    const guarded = await variant('g', 3231, t => t); runs.push(guarded);
    const unguarded = await variant('u', 3232, t => t.replace("if (existing.length) {", "if (false) {")); runs.push(unguarded);
    // PINNED "before" server for the uppercase-id bypass: 3c6dc5a has the order guard but not the uuid normalisation (fixed in c5caa33)
    const pinned = await variant('p', 3234, () => require('./guard').sourceAt('3c6dc5a', BE)); runs.push(pinned);
    const failing = await variant('f', 3233, t => t.replace(".select('id, payment_status, shipping_payment_status')", ".select('no_such_column')")); runs.push(failing);

    // 1. Auction with orders -> 409, everything intact
    const A = await mk('with_order', true); made.push(A);
    let r = await del(3231, A.id);
    ok(r.s === 409 && /has orders/.test(r.j.error) && /1 order came from it, 1 not fully paid/.test(r.j.detail), 'auction with an order: 409 "' + r.j.error + '" / "' + r.j.detail + '"');
    ok((await exists(A.id)) && (await orderRow(A.order.id))?.auction_id === A.id, 'auction and its order both still exist after the refused delete');

    // 2. The DATABASE guard. Same fixture, straight at the table with the service key - no server, no code guard.
    //    orders_auction_id_fkey ON DELETE RESTRICT (migration d) must refuse: Postgres 23503, nothing removed.
    let d = await s.from('auctions').delete().eq('id', A.id);
    ok(d.error?.code === '23503' && /orders_auction_id_fkey/.test(d.error.message) && (await exists(A.id)) && (await orderRow(A.order.id))?.auction_id === A.id, 'DB GUARD: raw delete of an auction that has an order -> ' + d.error?.code + ' (' + (d.error?.message || 'no error') + '); auction and order intact');

    // 2b. CONTROL: the code guard removed. Before the FK this deleted the auction and orphaned the order (200). Now the
    //     DB refuses, so no orphan can be created even with the route guard gone. Its lot is a child row the route
    //     deletes first, so this also records what the route does when the final delete is refused.
    const A2 = await mk('with_order_ctl', true, true); made.push(A2);
    r = await del(3232, A2.id);
    ok((await exists(A2.id)) && (await orderRow(A2.order.id))?.auction_id === A2.id, 'CONTROL (code guard removed): auction and order STILL exist - the DB refused the delete, no orphan (route answered ' + r.s + ')');
    console.log('  note: with the code guard removed the route answered ' + r.s + '; its lot ' + ((await itemExists(A2.item.id)) ? 'survived' : 'was DELETED before the auction delete was refused'));

    // 2c. invoices.auction_id ON DELETE RESTRICT (migration a) - was CASCADE, silently destroying invoices.
    const I = await mk('with_invoice', false); made.push(I);
    const inv = await s.from('invoices').insert({ auction_id: I.id, buyer_user_id: 'zztest-delguard-inv', buyer_username: 'zztest_delguard', total_cents: 100, payment_status: 'unpaid' }).select().single();
    if (inv.error) throw new Error('invoice insert: ' + JSON.stringify(inv.error));
    I.invoice = inv.data;
    d = await s.from('auctions').delete().eq('id', I.id);
    ok(d.error?.code === '23503' && /invoices_auction_id_fkey/.test(d.error.message) && (await exists(I.id)) && !!(await s.from('invoices').select('id').eq('id', I.invoice.id).maybeSingle()).data, 'DB GUARD: raw delete of an auction that has an invoice -> ' + d.error?.code + ' (' + (d.error?.message || 'no error') + '); auction and invoice intact (was CASCADE)');

    // 2d. no orphan can be created either: an order for an auction that does not exist is refused.
    const bad = await s.from('orders').insert({ auction_id: crypto.randomUUID(), buyer_username: 'zztest_delguard', buyer_user_id: 'zztest-delguard', item_title: 'ZZTEST_delguard orphan', final_bid: 1, status: 'pending', payment_status: 'unpaid' });
    ok(bad.error?.code === '23503', 'DB GUARD: inserting an order for a non-existent auction -> ' + bad.error?.code + ' (' + (bad.error?.message || 'no error') + ')');

    // 3. Auction with no orders -> deletes normally, through the guarded server
    const B = await mk('no_order', false); made.push(B);
    r = await del(3231, B.id);
    ok(r.s === 200 && !(await exists(B.id)), 'auction with no orders: deleted normally (200)');

    // 4. Fail closed
    const C = await mk('failclosed', false); made.push(C);
    r = await del(3233, C.id);
    ok(r.s === 500 && (await exists(C.id)), 'order check errors -> 500 and the auction is NOT deleted (fail closed)');

    // 4b. UPPERCASE id bypass. orders.auction_id used to be text, so the order check compared case-sensitively and the
    //     3c6dc5a server (no uuid normalisation) missed the order and deleted the auction (200, orphan). The column is
    //     uuid now and the FK is in place: even that old server can no longer orphan the order.
    const E = await mk('upper_old', true); made.push(E);
    r = await del(3234, E.id.toUpperCase());
    ok((await exists(E.id)) && (await orderRow(E.order.id))?.auction_id === E.id, 'PINNED 3c6dc5a + UPPERCASE id: no longer orphans - auction and order both intact (uuid column matches case-insensitively; route answered ' + r.s + ')');
    const F = await mk('upper_new', true); made.push(F);
    r = await del(3231, F.id.toUpperCase());
    ok(r.s === 409 && (await exists(F.id)) && (await orderRow(F.order.id))?.auction_id === F.id, 'FIXED: the same UPPERCASE-id DELETE is refused (409), auction and order both intact');
    r = await del(3231, 'not-a-uuid');
    ok(r.s === 400, 'FIXED: a malformed id is rejected (400) before anything is deleted');

    // 5. Auth unchanged
    const D = await mk('auth', false); made.push(D);
    r = await del(3231, D.id, other);
    ok(r.s === 403 && (await exists(D.id)), 'non-admin still 403, nothing deleted');

    // 6. A full auction - lots AND orders - through the guarded route. Was a borrowed pre-existing fixture
    //    (ZZTEST_InvoiceBatch), removed by the 2026-09 test-data cleanup; now built by this run like the others.
    if (fails) throw new Error('guard checks failed - skipping the full-auction check');
    const real = await mk('full', true, true); made.push(real);
    const before = { items: (await s.from('auction_items').select('id', { count: 'exact', head: true }).eq('auction_id', real.id)).count, orders: (await s.from('orders').select('id', { count: 'exact', head: true }).eq('auction_id', real.id)).count };
    r = await del(3231, real.id);
    const after = { items: (await s.from('auction_items').select('id', { count: 'exact', head: true }).eq('auction_id', real.id)).count, orders: (await s.from('orders').select('id', { count: 'exact', head: true }).eq('auction_id', real.id)).count };
    ok(r.s === 409 && JSON.stringify(before) === JSON.stringify(after) && (await exists(real.id)), 'auction with ' + before.items + ' lot(s) and ' + before.orders + ' order(s): 409 "' + r.j.detail + '"; items/orders unchanged ' + JSON.stringify(after));
  } finally {
    for (const id of (globalThis.__mk || [])) await s.from('auctions').delete().eq('id', id);
    for (const m of made) {
      if (m.invoice) await s.from('invoices').delete().eq('id', m.invoice.id);
      if (m.item) await s.from('auction_items').delete().eq('id', m.item.id);
      if (m.order) await s.from('orders').delete().eq('id', m.order.id);
      await s.from('auctions').delete().eq('id', m.id);
    }
    runs.forEach(x => x.cleanup());
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_delguard%')).data.length + (await s.from('orders').select('id').eq('buyer_username', 'zztest_delguard')).data.length + (await s.from('invoices').select('id').eq('buyer_username', 'zztest_delguard')).data.length + (await s.from('auction_items').select('id').like('title', 'ZZTEST_delguard%')).data.length;
    console.log('leftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
