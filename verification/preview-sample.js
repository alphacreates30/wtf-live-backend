// Admin-only "Preview with sample auctions" (wtf-handoff PREVIEW_MODE_BRIEF.md) never touches real data.
// The sample auctions are built in the browser from ../wtf-live-frontend/src/preview/sampleData.js; this suite proves:
//   - every sample auction and lot title starts with "Sample:" (a screenshot can't pass for a real listing), ids are
//     "sample-..." (never a real uuid), there are no photos (placeholders only), and 1/3/5/0 open auctions build;
//   - the sample module is only ever loaded lazily (import()), so it isn't in what the public downloads first, and
//     preview is only active for the admin;
//   - no sample data exists in the database, and none is in any public API response (/home, /search, /auctions) on a
//     local server over the test database.
// Needs ../wtf-live-frontend checked out next to this repo.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const FE = path.join(BE, '..', 'wtf-live-frontend', 'src');

(async () => {
  let srv;
  try {
    console.log('== The sample data ==');
    const mod = await import(pathToFileURL(path.join(FE, 'preview', 'sampleData.js')).href);
    for (const n of [0, 1, 3, 5]) {
      const h = mod.sampleHome(n);
      const lots = Object.values(h.rails).flat();
      const titles = [...h.open_auctions.map(a => a.title), ...h.upcoming.map(a => a.title), ...lots.map(l => l.title)];
      const ids = [...h.open_auctions.map(a => a.id), ...h.upcoming.map(a => a.id), ...lots.map(l => l.id), ...lots.map(l => l.auction_id)];
      ok(h.sample === true && h.open_auctions.length === n && h.upcoming.length === 1 && titles.every(t => t.startsWith('Sample: ')) && ids.every(id => id.startsWith('sample-'))
        && lots.every(l => !l.image_url && !l.thumb_url) && h.open_auctions.every(a => a.images.length === 0),
        `${n} open: marked sample, every title "Sample: ...", every id "sample-...", no photos (${titles.length} titles)`);
    }
    const three = mod.sampleHome(3), now = Date.now();
    ok(three.rails.ending_soon.some(l => Date.parse(l.ends_at) - now < 3600e3) && three.rails.first_bid.length > 0 && three.rails.most_wanted.length >= 3,
      '3 open: a lot closing within the hour, lots with no bids, enough bids for Most wanted');
    ok(new Set(three.open_auctions.map(a => new Date(a.ends_at).toDateString())).size === 3, '3 open: ending on three different days');
    const list = mod.sampleAuctions(3);
    ok(list.length === 4 && list.every(a => a.title.startsWith('Sample: ') && a.id.startsWith('sample-') && !a.image_url), '/auctions sample: 3 open + 1 upcoming, all "Sample:"');

    console.log('\n== Loaded only for the admin, only on demand ==');
    const grepSrc = (dir, re) => {
      const hits = [];
      for (const f of fs.readdirSync(dir, { recursive: true })) {
        const p = path.join(dir, f);
        if (!/\.(jsx?|mjs)$/.test(p) || p.includes(path.join('preview', 'sampleData.js'))) continue;
        const t = fs.readFileSync(p, 'utf8');
        if (re.test(t)) hits.push(path.relative(FE, p));
      }
      return hits;
    };
    ok(grepSrc(FE, /import\s[^;]*from\s+['"][^'"]*sampleData['"]/).length === 0, 'no file imports sampleData statically');
    const lazy = grepSrc(FE, /import\(['"][^'"]*preview\/sampleData['"]\)/);
    ok(lazy.length === 2 && lazy.some(p => p.endsWith('Home.jsx')) && lazy.some(p => p.endsWith('Listings.jsx')), `only Home and Listings load it, with import() (${lazy.join(', ')})`);
    const ctx = fs.readFileSync(path.join(FE, 'preview', 'PreviewContext.jsx'), 'utf8');
    ok(/const active = isAdmin && state\.on/.test(ctx) && /localStorage\.getItem\('wtf_username'\) === 'whatthefind'/.test(ctx) && /params\.get\('preview'\) === 'sample' && isAdminNow\(\)/.test(ctx),
      'preview is active only for the admin; ?preview=sample does nothing for anyone else');
    ok(!/api\.|fetch\(|request\(/.test(fs.readFileSync(path.join(FE, 'preview', 'sampleData.js'), 'utf8') + ctx), 'the preview code makes no API call');

    console.log('\n== Nothing in the database or the API ==');
    const [a1, a2] = await Promise.all([
      s.from('auctions').select('id', { count: 'exact', head: true }).ilike('title', 'Sample:%'),
      s.from('auction_items').select('id', { count: 'exact', head: true }).ilike('title', 'Sample:%'),
    ]);
    ok(a1.count === 0 && a2.count === 0, `no "Sample:" auctions or lots in the database (${a1.count}, ${a2.count})`);
    srv = await boot('preview-sample', 3571, require('./guard').readSource(BE + '/server.js'));
    for (const p of ['/home', '/search?q=Sample', '/auctions']) {
      const t = await (await fetch(srv.url + p)).text();
      ok(!/Sample:|sample-/.test(t), `${p.split('?')[0]}: no sample data`);
    }
  } catch (e) { console.log('ERR', e); fails++; } finally {
    if (srv) srv.stop();
  }
  console.log('\nleftover throwaway rows: 0 (this suite writes nothing)');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exitCode = fails ? 1 : 0;
})();
