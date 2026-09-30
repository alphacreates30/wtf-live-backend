// The lot page's frontend pieces that can be checked without a browser (LOT_PAGE_BRIEF.md, F2):
//   - the frontend's slug (src/lot/slug.js) builds exactly the backend's (lot_rules.js), so every link resolves;
//   - lot links everywhere point at /a/<slug>/lot/<n>; the auction room redirects the old ?lot= link there;
//   - the share-preview function (api/lot-meta.js) puts the lot's title, photo and price in the page head for link
//     crawlers only (vercel.json), escapes what it inserts, never carries a max, username or street address, and
//     falls back to the plain page for a draft, an unknown lot or a bad address;
//   - preview mode's sample lots: every sample auction ends at 8:00 PM local, and the sample lot page is the
//     /lots shape with no real ids.
// THROWAWAY rows only (ZZTEST_lotfe*), always cleaned up. Needs ../wtf-live-frontend next to this repo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const guard = require('./guard');
guard(__filename);
const boot = require('./local-server');
const BE = boot.BE;
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const rules = require(BE + '/lot_rules');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FE = path.join(BE, '..', 'wtf-live-frontend');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const future = m => new Date(Date.now() + m * 60e3).toISOString();
const auctionIds = [];

(async () => {
  let srv;
  try {
    console.log('== Slugs: frontend = backend ==');
    const slug = await import(pathToFileURL(path.join(FE, 'src', 'lot', 'slug.js')).href);
    const titles = ['Horror collection', "Bob's Toys & Tins!", 'Café Crème — 1970s', '   ', '12" singles, lot of 10', 'A'.repeat(90), 'Ümlaut Über Straße', 'Sample: Tin toys'];
    const ids = [crypto.randomUUID(), crypto.randomUUID().toUpperCase()];
    let same = true;
    for (const t of titles) for (const id of ids) {
      const a = slug.auctionSlug({ id, title: t }), b = rules.auctionSlug({ id, title: t });
      if (a !== b) { same = false; console.log('  differs:', JSON.stringify(t), a, b); }
      if (rules.slugIdPart(a) !== id.toLowerCase().slice(0, 8)) { same = false; console.log('  id part not found in', a); }
    }
    ok(same, `the frontend's auctionSlug is the backend's for ${titles.length * ids.length} titles, and the backend finds the id in each`);
    ok(slug.lotPath('0f3e2a1b-0000-4000-8000-000000000000', 'Monster Shelf', 11) === '/a/monster-shelf-0f3e2a1b/lot/12', 'lotPath: lot number = position + 1');
    ok(slug.auctionSlug({ id: 'sample-horror', title: 'Sample: Horror collection' }) === 'sample-horror', "a sample auction's slug is its sample id");

    console.log('\n== Links and the old ?lot= redirect ==');
    const src = f => fs.readFileSync(path.join(FE, 'src', f), 'utf8');
    ok(/lotPath\(lot\.auction_id, lot\.auction_title, lot\.position\)/.test(src('components/home/clock.js')), 'lotHref (homepage, search, Watching, rails) links to the lot page');
    const room = src('pages/StandardAuctionRoom.jsx');
    ok(/navigate\(lotPath\(auction\.id, auction\.title, lot\.position\), \{ replace: true \}\)/.test(room) && /searchParams\.get\('lot'\)/.test(room),
      'the auction room redirects /auction/:id?lot=<id> to the lot page (replace, so Back skips it)');
    ok(!/ItemDetailModal/.test(room), 'the old lot modal is gone (one lot view, not two)');
    ok(/path="\/a\/:slug\/lot\/:n"/.test(src('App.jsx')), 'route /a/:slug/lot/:n');
    const vercel = JSON.parse(fs.readFileSync(path.join(FE, 'vercel.json'), 'utf8'));
    const botRule = vercel.rewrites[0];
    const uaRe = new RegExp(botRule.has[0].value.replace('(?i)', ''), 'i');
    const bots = ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) Version/17 Safari/605 facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0)'];
    const people = ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse'];
    ok(botRule.source === '/a/:slug/lot/:n' && botRule.destination.startsWith('/api/lot-meta') && bots.every(u => uaRe.test(u)) && people.every(u => !uaRe.test(u)),
      'vercel.json: link crawlers on /a/:slug/lot/:n get the share-preview function; browsers (and Lighthouse) get the static page');

    console.log('\n== Share preview (api/lot-meta.js) ==');
    const S = (await s.from('auctions').insert({ title: 'ZZTEST_lotfe Monster <Shelf> & "Co"', description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'both', pickup_address: '123 NW 4th Street, Miami, FL 33101', buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600) }).select().single()).data;
    auctionIds.push(S.id);
    const D = (await s.from('auctions').insert({ title: 'ZZTEST_lotfe Draft', description: 'x', status: 'draft', mode: 'standard', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind' }).select().single()).data;
    auctionIds.push(D.id);
    const lots = (await s.from('auction_items').insert([
      { auction_id: S.id, position: 0, title: 'Resin figure <script>alert(1)</script>', image_url: 'https://example.invalid/zztest-lotfe.jpg', starting_bid: 0, current_bid: 83.5, bid_count: 4, top_pre_bid: 437.13, leading_bidder: 'zztest_lotfe_leader', status: 'open', ends_at: future(90) },
      { auction_id: S.id, position: 1, title: 'No photo lot', starting_bid: 0, current_bid: 0, bid_count: 0, status: 'open', ends_at: future(95) },
    ]).select()).data.sort((a, b) => a.position - b.position);
    await s.from('auction_items').insert({ auction_id: D.id, position: 0, title: 'ZZTEST draft lot', starting_bid: 0, current_bid: 0, status: 'open', ends_at: future(90) });
    srv = await boot('lotfe', 3362, guard.readSource(BE + '/server.js'));

    process.env.LOT_META_API_URL = srv.url;
    const fn = await import(pathToFileURL(path.join(FE, 'api', 'lot-meta.js')).href + '?t=' + Date.now());
    const indexHtml = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).endsWith('/index.html') ? Promise.resolve(new Response(indexHtml)) : realFetch(url, opts));
    const run = async (slugArg, n) => {
      const out = { headers: {}, body: '', statusCode: 200 };
      await fn.default({ headers: { host: 'whatthefind.live' }, query: { slug: slugArg, n } },
        { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: b => { out.body = b || ''; }, set statusCode(v) { out.statusCode = v; }, get statusCode() { return out.statusCode; } });
      return out;
    };
    const sl = rules.auctionSlug(S);
    let r = await run(sl, '1');
    const head = r.body.slice(0, r.body.indexOf('</head>'));
    console.log('  ' + (head.match(/<meta property="og:(title|description|image)"[^>]*>/g) || []).join('\n  '));
    ok(r.statusCode === 200 && /<title>Lot 1: Resin figure &lt;script&gt;alert\(1\)&lt;\/script&gt; \| What The Find<\/title>/.test(head) && (head.match(/<title>/g) || []).length === 1,
      'one <title>: "Lot 1: <lot title> | What The Find", HTML-escaped');
    ok(head.includes('<meta property="og:image" content="https://example.invalid/zztest-lotfe.jpg" />') && head.includes('summary_large_image'), 'og:image is the lot photo (large card)');
    ok(head.includes('Current bid $83.50 ($96.03 with 15% buyer&#39;s premium)') || head.includes("Current bid $83.50 ($96.03 with 15% buyer's premium)"), 'the description has the current bid with premium ($83.50 -> $96.03)');
    ok(head.includes('Monster &lt;Shelf&gt; &amp; &quot;Co&quot;') && !head.includes('<Shelf>'), "the auction's title is escaped too");
    ok(head.includes(`<link rel="canonical" href="https://whatthefind.live/a/${sl}/lot/1" />`) && head.includes(`og:url" content="https://whatthefind.live/a/${sl}/lot/1"`), 'canonical and og:url: the lot page address');
    ok(!/437\.13|zztest_lotfe_leader|123 NW|top_pre_bid/.test(r.body), 'no max, leader or street address in the page');
    ok(r.body.includes('<div id="root"></div>') && r.body.includes('/src/main.jsx'), 'the rest of the page is the normal app page');
    r = await run(sl, '2');
    ok(/Opening bid \$1\./.test(r.body) && !r.body.includes('og:image') && r.body.includes('content="summary"'), 'a lot with no bids and no photo: "Opening bid $1", no og:image, small card');
    const plainTitle = indexHtml.match(/<title>[\s\S]*?<\/title>/)[0];
    for (const [label, a, n] of [['a draft', rules.auctionSlug(D), '1'], ['an unknown lot', sl, '99'], ['a bad slug', '../../etc', '1'], ['a bad number', sl, '1;drop']]) {
      r = await run(a, n);
      ok(r.statusCode === 200 && r.body.includes(plainTitle) && !r.body.includes('og:title'), `${label}: the plain page, nothing added`);
    }
    global.fetch = realFetch;

    console.log('\n== Preview: sample lots ==');
    const sample = await import(pathToFileURL(path.join(FE, 'src', 'preview', 'sampleData.js')).href);
    const home = sample.sampleHome(5);
    ok(home.open_auctions.every(a => { const d = new Date(a.ends_at); return d.getHours() === 20 && d.getMinutes() === 0; }) && new Date(home.upcoming[0].starts_at).getHours() === 10,
      'every sample auction ends at 8:00 PM local (upcoming opens 10:00 AM)');
    ok(Object.values(home.rails).flat().every(l => Date.parse(l.ends_at) > Date.now()), 'every sample lot is still open (after 8 PM the days move to tomorrow)');
    const late = new Date(); late.setHours(21, 30, 0, 0);
    const lateHome = sample.sampleHome(1, late.getTime());
    ok(new Date(lateHome.open_auctions[0].ends_at).getDate() === new Date(late.getTime() + 86400e3).getDate(), 'at 9:30 PM the soonest sample auction ends at 8:00 PM tomorrow');
    const page = sample.sampleLotPage('sample-horror', 1);
    const real = await (await realFetch(`${srv.url}/lots/${lots[0].id}`)).json();
    const keys = o => Object.keys(o).sort().join();
    ok(page && keys(page.lot) === keys(real) && ['lot', 'auction', 'price', 'time', 'fulfilment', 'nav'].every(k => keys(page.lot[k]).split(',').every(x => x === 'placeholder_label' || x in real[k])),
      'the sample lot page has the /lots/:id shape');
    ok(page.lot.lot.title.startsWith('Sample: ') && page.lot.auction.id.startsWith('sample-') && page.lot.photos.length === 0 && !('bids' in page),
      'sample lot: "Sample:" title, sample id, no photos, no bid list (the public never sees one, B7)');
    ok(sample.sampleLotPage('sample-horror', 99) === null && sample.sampleLotPage('not-a-sample', 1) === null, 'no sample page for a missing lot or a real slug');
    const lotPageSrc = src('pages/LotPage.jsx');
    ok(/if \(isSample\) \{ say\('Bidding is disabled in preview'\); return \}/.test(lotPageSrc) && /if \(!preview\.active\) \{ setMissing\(true\); return \}/.test(lotPageSrc),
      'the lot page never bids on a sample lot, and shows sample lots only while preview is on (the admin)');
  } catch (e) {
    console.log('ERR', e); fails++;
  } finally {
    if (srv) srv.stop();
    for (const id of auctionIds) { const r = await s.rpc('delete_auction_cascade', { p_auction_id: id }); if (r.error) console.log('cleanup error', r.error.message); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_lotfe%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
