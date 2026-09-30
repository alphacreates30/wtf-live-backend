// Photo thumbnails (F1a, migration v). New feature, no pinned "before" server. Local servers on the test database;
// THROWAWAY rows and files only (ZZTEST_thumbs*, items/zztest-thumbs-*), always cleaned up.
//
//   upload    POST /upload-image stores the full photo AND a ~480px WebP beside it (items/thumbs/), records
//             full URL -> thumbnail URL, returns both. Neither file has EXIF/GPS; orientation is applied; a small
//             photo is not enlarged; a PNG still gets a WebP thumbnail.
//   before v  (server patched to a missing table): uploads still work, thumb_url null, no orphan thumbnail file.
//   API       /home (rails, open auctions' images, upcoming), /search, the auction room's lot lists and /auctions carry
//             thumb_url; a photo with no thumbnail gets thumb_url null and keeps image_url (the fallback).
//   backfill  scripts/backfill-thumbs.js: --dry-run changes nothing; a real run makes the thumbnail for a photo
//             stored raw (EXIF GPS + orientation tag) with no metadata and the orientation applied; skips links
//             outside this bucket; a missing file is reported and exits 1; re-running skips finished photos.
const crypto = require('crypto');
const { execFileSync } = require('child_process');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const sharp = require(BE + '/node_modules/sharp');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const pathOf = u => decodeURIComponent(u.split('/item-images/')[1]);
const files = new Set(), urls = new Set(), auctions = [];

function withGpsExif(jpeg) {   // same fixture as upload-reencode.js: an APP1 Exif segment with a GPS IFD pointer
  const tiff = Buffer.from('4d4d002a00000008000188250004000000010000001a00000000', 'hex');
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff, Buffer.from('GPS 37.7749N 122.4194W', 'binary')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
const canvas = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 40 } } });
const hasGps = b => b.includes(Buffer.from('GPS 37.77')) || (b.includes(Buffer.from('Exif')) && b.includes(Buffer.from([0x88, 0x25])));
const get = async u => { const r = await fetch(u); const buf = Buffer.from(await r.arrayBuffer()); return { s: r.status, type: r.headers.get('content-type'), buf, meta: r.ok ? await sharp(buf).metadata() : null }; };
const upload = async (url, tok, body, type) => {
  const r = await fetch(url + '/upload-image', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': type }, body });
  const j = await r.json().catch(() => ({}));
  if (j.url) { files.add(pathOf(j.url)); urls.add(j.url); }
  if (j.thumb_url) files.add(pathOf(j.thumb_url));
  return { s: r.status, j };
};
const call = (url, p) => fetch(url + p).then(r => r.json());
const backfill = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [BE + '/scripts/backfill-thumbs.js', ...args], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) }; }
};
const at = m => new Date(Date.now() + m * 60e3).toISOString();

(async () => {
  const probe = await s.from('image_thumbs').select('url').limit(1);
  if (probe.error) { console.log('image_thumbs is missing on this database: apply migration v (2026-09-30v-image-thumbs.sql) first.'); process.exit(2); }
  const servers = [];
  try {
    try {
      const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '15m' });
      const src = require('./guard').readSource(BE + '/server.js');
      const srv = await boot('thumbs-new', 3531, src, { patch: [['const HOME_CACHE_MS = 10_000;', 'const HOME_CACHE_MS = 0;']] });
      // "Before migration v": the same code, pointed at a table that doesn't exist.
      const pre = await boot('thumbs-pre', 3532, src.split("from('image_thumbs')").join("from('image_thumbs_zz_absent')"));
      servers.push(srv, pre);

      // ---- Upload ----
      console.log('== POST /upload-image ==');
      const gps = withGpsExif(await canvas(1600, 1200).jpeg().toBuffer());
      ok(hasGps(gps), 'fixture: the test JPEG carries EXIF with a GPS tag');
      let r = await upload(srv.url, admin, gps, 'image/jpeg');
      const full = r.j.url && await get(r.j.url), th = r.j.thumb_url && await get(r.j.thumb_url);
      ok(r.s === 200 && !!r.j.thumb_url && pathOf(r.j.thumb_url) === pathOf(r.j.url).replace(/^items\//, 'items/thumbs/').replace(/\.jpg$/, '.webp'),
        `returns url and thumb_url; the thumbnail sits beside the photo (${r.j.thumb_url && pathOf(r.j.thumb_url)})`);
      ok(th && th.s === 200 && th.type === 'image/webp' && th.meta.format === 'webp' && th.meta.width === 480 && th.meta.height === 360,
        `thumbnail: WebP, 480 wide, aspect kept (${th && th.meta.width}x${th && th.meta.height}, ${th && Math.round(th.buf.length / 1024)} KB vs full ${full && Math.round(full.buf.length / 1024)} KB)`);
      ok(full && !full.meta.exif && !hasGps(full.buf) && th && !th.meta.exif && !hasGps(th.buf), 'no EXIF / GPS in the full photo or the thumbnail');
      const row = die(await s.from('image_thumbs').select('thumb_url').eq('url', r.j.url).maybeSingle());
      ok(row && row.thumb_url === r.j.thumb_url, 'image_thumbs records full URL -> thumbnail URL');
      const withThumb = r.j.url, withThumbThumb = r.j.thumb_url;

      r = await upload(srv.url, admin, await canvas(1600, 1200).jpeg().withMetadata({ orientation: 6 }).toBuffer(), 'image/jpeg');
      let t = await get(r.j.thumb_url);
      ok(t.meta.width === 480 && t.meta.height === 640 && !t.meta.orientation, `orientation applied: a sideways-tagged photo gives a 480x640 upright thumbnail (${t.meta.width}x${t.meta.height})`);
      r = await upload(srv.url, admin, await canvas(300, 200).png().toBuffer(), 'image/png');
      t = await get(r.j.thumb_url);
      ok(r.j.url.endsWith('.png') && t.meta.format === 'webp' && t.meta.width === 300, `a small PNG keeps its size (not enlarged) and gets a WebP thumbnail (${t.meta.width}px)`);

      // ---- Before migration v ----
      console.log('\n== Before migration v ==');
      r = await upload(pre.url, admin, await canvas(800, 600).jpeg().toBuffer(), 'image/jpeg');
      await sleep(500);
      const orphan = ((await s.storage.from('item-images').list('items/thumbs', { search: pathOf(r.j.url).split('/').pop().replace(/\.jpg$/, '') })).data || []).length;
      ok(r.s === 200 && !!r.j.url && r.j.thumb_url === null && orphan === 0, `upload still works: url returned, thumb_url null, no orphan thumbnail file (${r.s}, orphans ${orphan})`);
      const h0 = await call(pre.url, '/home');
      ok(h0 && h0.rails, '/home still answers when image_thumbs is missing');

      // ---- API ----
      console.log('\n== thumb_url in the API ==');
      // Two photos stored raw, as before #13 / before thumbnails: one with EXIF GPS, one tagged "sideways".
      const putRaw = async (buf, label) => {
        const p = `items/zztest-thumbs-${label}-${crypto.randomBytes(5).toString('hex')}.jpg`;
        die(await s.storage.from('item-images').upload(p, buf, { contentType: 'image/jpeg' }));
        files.add(p);
        const u = s.storage.from('item-images').getPublicUrl(p).data.publicUrl;
        urls.add(u);
        return [p, u];
      };
      const rawGps = withGpsExif(await canvas(1200, 900).jpeg().toBuffer());
      const [rawPath, rawUrl] = await putRaw(rawGps, 'rawgps');
      const [rotPath, rotUrl] = await putRaw(await canvas(1200, 900).jpeg().withMetadata({ orientation: 6 }).toBuffer(), 'rawrot');
      const missingUrl = s.storage.from('item-images').getPublicUrl(`items/zztest-thumbs-missing-${crypto.randomBytes(5).toString('hex')}.jpg`).data.publicUrl;
      urls.add(missingUrl);
      const externalUrl = 'https://example.invalid/zztest-thumbs-external.jpg';

      const A = die(await s.from('auctions').insert({ title: 'ZZTEST_thumbs live', description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: at(600), image_url: withThumb }).select().single()).id;
      const U = die(await s.from('auctions').insert({ title: 'ZZTEST_thumbs upcoming', description: 'x', status: 'upcoming', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', starts_at: at(60 * 24 * 30), ends_at: at(60 * 24 * 31), image_url: rawUrl }).select().single()).id;
      auctions.push(A, U);
      const lots = die(await s.from('auction_items').insert([
        { image_url: withThumb }, { image_url: rawUrl }, { image_url: null }, { image_url: externalUrl }, { image_url: missingUrl },
      ].map((l, i) => ({ auction_id: A, title: `ZZTEST_thumbs lot ${i}`, starting_bid: 0, current_bid: 0, position: i, status: 'open', ends_at: at(30 + i), ...l }))).select());
      die(await s.from('item_images').insert([{ item_id: lots[0].id, url: rawUrl, position: 1 }, { item_id: lots[0].id, url: rotUrl, position: 2 }]).select());
      const byPos = arr => Object.fromEntries(arr.filter(l => l.auction_id === A).map(l => [l.position, l]));

      const h = await call(srv.url, '/home');
      const e = byPos(h.rails.ending_soon);
      ok(Object.keys(e[0]).sort().join() === 'auction_id,auction_title,bid_count,current_bid,ends_at,id,image_url,position,status,thumb_url,title', 'a /home lot is the public fields plus thumb_url (and auction_title)');
      ok(e[0].thumb_url === withThumbThumb && e[0].image_url === withThumb, 'lot with a thumbnail: thumb_url set, image_url still the full photo');
      ok(e[1].thumb_url === null && e[1].image_url === rawUrl && e[2].thumb_url === null && e[2].image_url === null && e[3].thumb_url === null && e[3].image_url === externalUrl,
        'no thumbnail yet / no photo / external link: thumb_url null, image_url unchanged (the site falls back to it)');
      const oa = (h.open_auctions || []).find(x => x.id === A) || {};
      const fimg = oa.images || [];
      ok(oa.id === A && fimg[0] && fimg[0].url === withThumb && fimg[0].thumb_url === withThumbThumb && fimg.every(i => Object.keys(i).sort().join() === 'thumb_url,url'),
        `open_auctions[].images are { url, thumb_url } (${fimg.length}; first has its thumbnail)`);
      const up = h.upcoming.find(a => a.id === U);
      ok(up && up.image_url === rawUrl && 'thumb_url' in up && up.thumb_url === null, 'upcoming auctions carry thumb_url too (null here: no thumbnail yet)');
      const q = await call(srv.url, '/search?q=' + encodeURIComponent('ZZTEST_thumbs lot'));
      const qp = byPos(q.lots);
      ok(q.lots.length === 5 && qp[0].thumb_url === withThumbThumb && qp[1].thumb_url === null, '/search lots carry thumb_url');
      const room = await call(srv.url, `/auction/${A}/items/standard-status`), items = await call(srv.url, `/auction/${A}/items`);
      ok(room[0].thumb_url === withThumbThumb && room[1].thumb_url === null && items[0].thumb_url === withThumbThumb && !('top_pre_bid' in room[0]),
        'the auction room lists (standard-status, items) carry thumb_url; maxes still stripped');
      const list = await call(srv.url, '/auctions');
      ok(list.find(a => a.id === A).thumb_url === withThumbThumb && list.find(a => a.id === U).thumb_url === null, '/auctions carries each cover\'s thumb_url');
      const gal = await call(srv.url, `/auction/${A}/items/${lots[0].id}/images`);
      ok(gal.length === 2 && gal[0].url === rawUrl && !('thumb_url' in gal[0]), 'the lot page\'s photo gallery is unchanged: full photos only');

      // ---- Backfill ----
      console.log('\n== scripts/backfill-thumbs.js ==');
      let b = backfill('--dry-run');
      const rawRowAfterDry = die(await s.from('image_thumbs').select('url').eq('url', rawUrl));
      ok(b.code === 0 && /Dry run: nothing changed/.test(b.out) && b.out.includes('would make: ' + rawPath.replace('items/', 'items/thumbs/').replace('.jpg', '.webp')) && rawRowAfterDry.length === 0,
        '--dry-run lists the photo it would do and changes nothing');
      ok(b.out.includes('skip (not in this bucket): ' + externalUrl), 'links outside this bucket are skipped and listed');
      b = backfill();
      const rawRow = die(await s.from('image_thumbs').select('thumb_url').eq('url', rawUrl).maybeSingle());
      if (rawRow) files.add(pathOf(rawRow.thumb_url));
      const bt = rawRow && await get(rawRow.thumb_url);
      ok(!!rawRow && bt.meta.format === 'webp' && bt.meta.width === 480 && bt.meta.height === 360 && !bt.meta.exif && !hasGps(bt.buf),
        `backfill: a raw photo with EXIF GPS gets a WebP thumbnail with no EXIF/GPS (${bt && bt.meta.width}x${bt && bt.meta.height})`);
      const rotRow = die(await s.from('image_thumbs').select('thumb_url').eq('url', rotUrl).maybeSingle());
      if (rotRow) files.add(pathOf(rotRow.thumb_url));
      const rt = rotRow && await get(rotRow.thumb_url);
      ok(!!rotRow && rt.meta.width === 480 && rt.meta.height === 640 && !rt.meta.orientation && !rt.meta.exif,
        `backfill: a gallery photo tagged sideways gets an upright thumbnail (${rt && rt.meta.width}x${rt && rt.meta.height}); gallery photos are covered too`);
      const rawFull = await get(rawUrl);
      ok(rawFull.buf.equals(rawGps), 'backfill never changes the full photo');
      ok(b.code === 1 && b.out.includes('FAILED ' + pathOf(missingUrl)) && !die(await s.from('image_thumbs').select('url').eq('url', missingUrl)).length,
        `a missing file is reported, recorded nowhere, and the run exits 1 (exit ${b.code})`);
      const h2 = await call(srv.url, '/home');
      ok(byPos(h2.rails.ending_soon)[1].thumb_url === rawRow.thumb_url && h2.upcoming.find(a => a.id === U).thumb_url === rawRow.thumb_url, 'after the backfill, /home serves the new thumbnail with no restart');
      b = backfill();
      ok(!b.out.includes(rawPath) && !b.out.includes(rotPath) && b.out.includes('FAILED ' + pathOf(missingUrl)), 're-running skips photos that already have a thumbnail (and retries the one that failed)');
    } catch (e) { console.log('ERR', e); fails++; }
  } finally {
    servers.forEach(x => x.stop());
    for (const id of auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    if (urls.size) await s.from('image_thumbs').delete().in('url', [...urls]);
    if (files.size) await s.storage.from('item-images').remove([...files]);
    const leftFiles = [];
    for (const f of files) { const slash = f.lastIndexOf('/'); const l = await s.storage.from('item-images').list(f.slice(0, slash), { search: f.slice(slash + 1) }); if (l.data && l.data.length) leftFiles.push(f); }
    const left = leftFiles.length + (await s.from('auctions').select('id').like('title', 'ZZTEST_thumbs%')).data.length
      + ((await s.from('image_thumbs').select('url').in('url', [...urls])).data || []).length;
    console.log(`\nleftover throwaway rows: ${left} (${files.size} test files deleted)`);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
