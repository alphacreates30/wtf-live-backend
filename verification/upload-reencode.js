// Security review #13: uploads were stored byte-for-byte in the PUBLIC bucket - a photo's EXIF (GPS included) went
// public whenever the browser hadn't stripped it - and any image/* was accepted, SVG included. Now every upload is
// decoded and re-encoded: format read from the bytes, JPEG/PNG/WebP only, orientation applied, size capped, no
// metadata. OLD is PINNED to 1e24469 (before the fix). Local servers on the test database; uploads are deleted.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const sharp = require(BE + '/node_modules/sharp');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '1e24469';
const stored = [];

// A JPEG with an APP1 Exif segment carrying a GPS IFD pointer (tag 0x8825) and a readable GPS marker.
function withGpsExif(jpeg) {
  const tiff = Buffer.from('4d4d002a00000008000188250004000000010000001a00000000', 'hex');
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff, Buffer.from('GPS 37.7749N 122.4194W', 'binary')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
const canvas = (w, h, alpha) => sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 60, b: 40, alpha: 0.5 } : { r: 200, g: 60, b: 40 } } });
const hasGps = b => b.includes(Buffer.from('Exif')) && b.includes(Buffer.from([0x88, 0x25]));
const upload = (url, tok, body, type) => fetch(url + '/upload-image', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': type }, body })
  .then(async r => { const j = await r.json().catch(() => ({})); if (j.url) stored.push(j.url.split('/item-images/')[1]); return { s: r.status, j }; });
const fetchStored = async u => { const r = await fetch(u); return { type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const gpsJpeg = withGpsExif(await canvas(400, 300).jpeg().toBuffer());
    const rotated = await canvas(400, 300).jpeg().withMetadata({ orientation: 6 }).toBuffer();   // "turn 90°" in EXIF
    const huge = await canvas(5000, 3000).jpeg().toBuffer();
    const pngAlpha = await canvas(200, 200, true).png().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const gif = await canvas(20, 20).gif().toBuffer();
    ok(hasGps(gpsJpeg) && (await sharp(gpsJpeg).metadata()).exif, 'fixture: the test JPEG carries an EXIF block with a GPS tag');
    const oldSrv = await boot('upload-old', 3471, oldSrc), newSrv = await boot('upload-new', 3472, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await upload(oldSrv.url, admin, gpsJpeg, 'image/jpeg');
    let f = r.j.url && await fetchStored(r.j.url);
    ok(r.s === 200 && f && f.buf.equals(gpsJpeg) && hasGps(f.buf), `OLD: stored byte-for-byte, EXIF GPS tag in the PUBLIC file (${r.s})  <- GPS PUBLISHED`);
    r = await upload(oldSrv.url, admin, svg, 'image/svg+xml');
    ok(r.s === 200, `OLD: an SVG is accepted (${r.s})`);

    console.log('\n== SAME on the FIXED code ==');
    r = await upload(newSrv.url, admin, gpsJpeg, 'image/jpeg');
    f = r.j.url && await fetchStored(r.j.url);
    const m = f && await sharp(f.buf).metadata();
    ok(r.s === 200 && f && !hasGps(f.buf) && !f.buf.includes(Buffer.from('GPS 37.77')) && !m.exif, `NEW: stored file has no EXIF at all - no GPS (${r.s}, ${f && f.type}, ${m && m.width}x${m && m.height})`);
    r = await upload(newSrv.url, admin, rotated, 'image/jpeg');
    f = r.j.url && await fetchStored(r.j.url);
    const mr = f && await sharp(f.buf).metadata();
    ok(r.s === 200 && mr.width === 300 && mr.height === 400 && !mr.orientation, `NEW: EXIF orientation applied to the pixels (400x300 tagged "rotate" -> ${mr && mr.width}x${mr && mr.height}, no tag left)`);
    r = await upload(newSrv.url, admin, huge, 'image/jpeg');
    f = r.j.url && await fetchStored(r.j.url);
    const mh = f && await sharp(f.buf).metadata();
    ok(r.s === 200 && Math.max(mh.width, mh.height) === 2400, `NEW: a 5000x3000 photo is stored at ${mh && mh.width}x${mh && mh.height}`);
    r = await upload(newSrv.url, admin, pngAlpha, 'image/jpeg');
    f = r.j.url && await fetchStored(r.j.url);
    ok(r.s === 200 && f.type === 'image/png' && r.j.url.endsWith('.png') && (await sharp(f.buf).metadata()).hasAlpha, `NEW: PNG bytes labelled image/jpeg are stored as ${f && f.type} (from the bytes), transparency kept`);
    for (const [label, body, type] of [['an SVG', svg, 'image/svg+xml'], ['a GIF', gif, 'image/gif'], ['junk bytes labelled image/png', crypto.randomBytes(2000), 'image/png']]) {
      r = await upload(newSrv.url, admin, body, type);
      ok(r.s === 400 && !r.j.url, `NEW: ${label} refused (${r.s} "${r.j.error}")`);
    }
    const buyer = jwt.sign({ id: crypto.randomUUID(), username: 'zztest_upload_buyer' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    r = await upload(newSrv.url, buyer, gpsJpeg, 'image/jpeg');
    ok(r.s === 403, `NEW: a non-admin still can't upload (${r.s})`);
  } finally {
    servers.forEach(x => x.stop());
    if (stored.length) await s.storage.from('item-images').remove(stored);
    const still = [];
    for (const p of stored) { const r = await s.storage.from('item-images').list(p.split('/')[0], { search: p.split('/')[1] }); if (r.data && r.data.length) still.push(p); }
    console.log(`\nleftover throwaway rows: ${still.length} (uploaded ${stored.length} test files, all deleted)`);
    if (still.length) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
