// Images-endpoint ownership check. OLD is PINNED to the commit before the fix (a27f899), so the reproduction assertions stay valid.
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
const OLD_COMMIT = 'a27f899';

async function boot(name, port, source) {
  const file = BE + '/server.tmp-' + name + '.js';
  fs.writeFileSync(file, source);
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; require('./server.tmp-" + name + ".js');");
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' });
  for (let i = 0; i < 25; i++) { try { await fetch('http://localhost:' + port + '/auctions'); break; } catch { await sleep(1000); } }
  return { cleanup: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} } };
}
// two hosts: the caller hosts A only; B (and its lot) belongs to a different host
const CALLER = 'zztest_imghost_a', OTHER = 'zztest_imghost_b';
const tok = jwt.sign({ id: crypto.randomUUID(), username: CALLER }, process.env.JWT_SECRET, { expiresIn: '10m' });
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const made = { auctions: [], items: [] };
const mkAuction = async (label, host) => { const r = await s.from('auctions').insert({ title: 'ZZTEST_img_' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: host, ends_at: future(48) }).select().single(); if (r.error) throw new Error(JSON.stringify(r.error)); made.auctions.push(r.data.id); return r.data.id; };
const mkItem = async (a, title) => { const r = await s.from('auction_items').insert({ auction_id: a, title, starting_bid: 0, position: 0, status: 'pending', ends_at: future(24) }).select().single(); if (r.error) throw new Error(JSON.stringify(r.error)); made.items.push(r.data.id); return r.data.id; };
const addImage = (port, auctionId, itemId) => fetch('http://localhost:' + port + `/auction/${auctionId}/items/${itemId}/images`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.invalid/zztest.jpg', position: 0 }) }).then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const images = async id => (await s.from('item_images').select('id').eq('item_id', id)).data.length;

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const A = await mkAuction('A_callers', CALLER), B = await mkAuction('B_others', OTHER);
    const lotA = await mkItem(A, 'ZZTEST img lot A'), lotB = await mkItem(B, 'ZZTEST img lot B');
    servers.push(await boot('old', 3261, oldSrc), await boot('new', 3262, newSrc));

    console.log(`== REPRODUCE on ${OLD_COMMIT} (pre-fix): caller hosts A only, targets a lot in B (hosted by someone else) ==`);
    let r = await addImage(3261, A, lotB);
    ok(r.s === 201 && (await images(lotB)) === 1, `OLD: image attached to another host's lot via /auction/A/items/<lot in B>/images: ${r.s}, images on B's lot = ${await images(lotB)}  <- HOLE REPRODUCED`);
    r = await addImage(3261, B, lotB);
    ok(r.s === 403, `OLD control: caller targeting B directly (not their auction) is refused (${r.s})`);
    await s.from('item_images').delete().eq('item_id', lotB);

    console.log('\n== SAME requests on the FIXED code ==');
    r = await addImage(3262, A, lotB);
    ok(r.s === 404 && r.j.error === 'Item not found' && (await images(lotB)) === 0, `NEW: cross-auction image refused (${r.s} ${r.j.error}), images on B's lot = ${await images(lotB)}`);
    r = await addImage(3262, B, lotB);
    ok(r.s === 403 && (await images(lotB)) === 0, `NEW: caller targeting B directly still 403 (${r.s})`);
    r = await addImage(3262, A, crypto.randomUUID());
    ok(r.s === 404, `NEW: nonexistent lot id -> ${r.s}`);

    console.log('\n== FIXED code still allows the legitimate cases ==');
    r = await addImage(3262, A, lotA);
    ok(r.s === 201 && (await images(lotA)) === 1, `NEW: caller attaches an image to their own lot: ${r.s}, images = ${await images(lotA)}`);
    r = await addImage(3262, A.toUpperCase(), lotA.toUpperCase());
    ok(r.s === 201 && (await images(lotA)) === 2, `NEW: UPPERCASE ids on their own lot still work: ${r.s}, images = ${await images(lotA)}`);
  } finally {
    servers.forEach(x => x.cleanup());
    if (made.items.length) await s.from('item_images').delete().in('item_id', made.items);
    if (made.items.length) await s.from('auction_items').delete().in('id', made.items);
    if (made.auctions.length) await s.from('auctions').delete().in('id', made.auctions);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_img_%')).data.length + (await s.from('auction_items').select('id').like('title', 'ZZTEST img lot%')).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
