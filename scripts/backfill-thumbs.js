// Makes thumbnails for photos stored before thumbnails existed (F1a, migration v).
//
//   node scripts/backfill-thumbs.js                    wtf-test (default, from .env.test)
//   node scripts/backfill-thumbs.js --dry-run          list what it would do, change nothing
//   node scripts/backfill-thumbs.js --limit 20         stop after 20 photos (a first careful run)
//   node scripts/backfill-thumbs.js --yes-production   production (.env) - Cowork runs this with Albert
//
// What it does, for every photo URL the site uses (lot main photos, lot gallery photos, auction covers):
//   - skips it if it already has a thumbnail (a row in image_thumbs), or if it isn't a file in THIS project's
//     item-images bucket (an external link can't get a thumbnail here; the site keeps showing it full size);
//   - downloads the full photo, makes the same 480px WebP the upload route makes (thumbs.js, no metadata),
//     stores it at <folder>/thumbs/<name>.webp in the same bucket, and records full URL -> thumbnail URL.
// It never changes, moves or deletes a full photo, and never touches a lot, auction or order row.
// Safe to stop and re-run at any time: finished photos are skipped. Needs migration v first.
const path = require('path');
const BE = path.resolve(__dirname, '..');
require(BE + '/verification/guard')(__filename);   // wtf-test unless --yes-production; prints which project
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { makeThumb, thumbPathFor } = require(BE + '/thumbs');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const BUCKET = 'item-images';
const PREFIX = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/`;
const CONCURRENCY = 4;

async function allRows(table, column) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await s.from(table).select(column).not(column, 'is', null).range(from, from + 999);
    if (error) throw new Error(`${table}.${column}: ${error.message}`);
    out.push(...data.map(r => r[column]));
    if (data.length < 1000) return out;
  }
}

(async () => {
  const probe = await s.from('image_thumbs').select('url').limit(1);
  if (probe.error) { console.log('image_thumbs is not there: apply migration v (2026-09-30v-image-thumbs.sql) first.'); process.exitCode = 2; return; }

  const used = new Set([...await allRows('auction_items', 'image_url'), ...await allRows('item_images', 'url'), ...await allRows('auctions', 'image_url')]);
  const done = new Set(await allRows('image_thumbs', 'url'));
  const external = [], todo = [];
  for (const url of used) {
    if (done.has(url)) continue;
    if (!url.startsWith(PREFIX) || url.includes('/thumbs/')) { external.push(url); continue; }
    todo.push(url);
  }
  const work = todo.slice(0, LIMIT);
  console.log(`Photos in use: ${used.size}. Already have a thumbnail: ${[...used].filter(u => done.has(u)).length}. ` +
    `Not in this bucket (left full size): ${external.length}. To do: ${todo.length}${work.length < todo.length ? ` (this run: ${work.length})` : ''}.`);
  for (const u of external) console.log('  skip (not in this bucket):', u);
  if (DRY) { for (const u of work) console.log('  would make:', thumbPathFor(decodeURIComponent(u.slice(PREFIX.length)))); console.log('\nDry run: nothing changed.'); return; }

  let made = 0; const failed = [];
  const queue = [...work];
  async function worker() {
    for (let url; (url = queue.shift()); ) {
      const file = decodeURIComponent(url.slice(PREFIX.length));
      try {
        const { data: blob, error: dlErr } = await s.storage.from(BUCKET).download(file);
        if (dlErr) throw new Error('download: ' + (dlErr.message || 'not found'));
        const thumb = await makeThumb(Buffer.from(await blob.arrayBuffer()));
        const thumbPath = thumbPathFor(file);
        const { error: upErr } = await s.storage.from(BUCKET).upload(thumbPath, thumb, { contentType: 'image/webp', upsert: true });
        if (upErr) throw new Error('upload: ' + upErr.message);
        const thumbUrl = s.storage.from(BUCKET).getPublicUrl(thumbPath).data.publicUrl;
        const { error } = await s.from('image_thumbs').upsert({ url, thumb_url: thumbUrl }, { onConflict: 'url' });
        if (error) throw new Error('record: ' + error.message);
        made++;
        console.log(`  ok ${made}/${work.length}  ${file}  (${Math.round(thumb.length / 1024)} KB)`);
      } catch (e) {
        failed.push([file, e.message]);
        console.log(`  FAILED ${file}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\nMade ${made} thumbnail(s), ${failed.length} failed.` + (failed.length ? ' Failed photos keep showing full size; re-run to retry.' : ''));
  // exitCode, not process.exit(): exiting with fetch sockets still open trips a libuv assertion on Windows and
  // replaces the exit code.
  process.exitCode = failed.length ? 1 : 0;
})().catch(e => { console.log('ERR', e.message); process.exitCode = 1; });
