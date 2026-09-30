// The lot page's frontend pieces that can be checked without a browser (LOT_PAGE_BRIEF.md, F2):
//   - the frontend's slug (src/lot/slug.js) builds exactly the backend's (lot_rules.js), so every link resolves;
//   - lot links everywhere point at /a/<slug>/lot/<n>; the auction room redirects the old ?lot= link there;
//   - share cards (C3): index.html carries the default card for every page; for link crawlers only (vercel.json),
//     api/share-meta.js swaps in a lot's or an auction's own card (one set of tags, escaped, full photos); drafts,
//     unknown pages and bad input keep the default card. (Originally the lot-only api/lot-meta.js.) It puts the lot's title, photo and price in the page head for link
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
    const botRule = vercel.rewrites[0], auctionRule = vercel.rewrites[1];
    const uaRe = new RegExp(botRule.has[0].value.replace('(?i)', ''), 'i');
    const bots = ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) Version/17 Safari/605 facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0)'];
    const people = ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse'];
    ok(botRule.source === '/a/:slug/lot/:n' && botRule.destination === '/api/share-meta?kind=lot&slug=:slug&n=:n'
      && auctionRule.source === '/auction/:id' && auctionRule.destination === '/api/share-meta?kind=auction&id=:id' && JSON.stringify(auctionRule.has) === JSON.stringify(botRule.has)
      && bots.every(u => uaRe.test(u)) && people.every(u => !uaRe.test(u)),
      'vercel.json: link crawlers on lot and auction pages get the share-card function; browsers (and Lighthouse) get the static page');

    // START_HERE rule 9: never copy (or name) other auction houses. Site and server text, docs excluded.
    console.log('\n== No other auction house named in the site or the server ==');
    const HOUSES = /goldin|auction ?ninja|whatnot|ebay|heritage auctions|sotheby|christie|liveauctioneers|hibid|invaluable|catawiki/i;
    const scan = (dir, keep) => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f))
      .filter(f => keep.test(f) && !/node_modules|[\\/]dist[\\/]|[\\/]nul[\\/]|[\\/]verification[\\/]/.test(f) && fs.statSync(f).isFile())
      .filter(f => HOUSES.test(fs.readFileSync(f, 'utf8')));
    const named = [...scan(path.join(FE, 'src'), /\.(jsx?|md|css)$/), ...scan(path.join(FE, 'api'), /\.js$/), ...scan(path.join(FE, 'public'), /\.(html|json|webmanifest|txt|svg)$/),
      ...['index.html'].map(f => path.join(FE, f)).filter(f => HOUSES.test(fs.readFileSync(f, 'utf8'))),
      ...['server.js', 'ai_lots.js', 'lot_page.js', 'lot_rules.js', 'public_view.js', 'thumbs.js'].map(f => path.join(BE, f)).filter(f => HOUSES.test(fs.readFileSync(f, 'utf8')))];
    ok(named.length === 0, `no competitor named in page, admin, email or share text ${named.length ? named.join(', ') : '(site src/api/public, server)'}`);
    const dash = src('pages/HostDashboard.jsx');
    ok(/api\.getConfig\(\)/.test(dash) && /to \$\{softClose\} minute/.test(dash) && !/resets that lot's clock to \d/.test(dash),
      'the create form says the soft-close minutes from GET /config, not a number written in the page');

    console.log('\n== Share cards (api/share-meta.js, index.html) ==');
    const S = (await s.from('auctions').insert({ title: 'ZZTEST_lotfe Monster <Shelf> & "Co"', description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'both', pickup_address: '123 NW 4th Street, Miami, FL 33101', buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600) }).select().single()).data;
    auctionIds.push(S.id);
    const D = (await s.from('auctions').insert({ title: 'ZZTEST_lotfe Draft', description: 'x', status: 'draft', mode: 'standard', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind' }).select().single()).data;
    auctionIds.push(D.id);
    // A second auction with no cover photo: its card uses its first lot's FULL photo (never the thumbnail).
    const N = (await s.from('auctions').insert({ title: 'ZZTEST_lotfe No Cover', description: 'Forty years of tin robots from one attic. Second sentence here.', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: future(-60), ends_at: future(600) }).select().single()).data;
    auctionIds.push(N.id);
    await s.from('auction_items').insert([
      { auction_id: N.id, position: 1, title: 'Second robot', image_url: 'https://example.invalid/zztest-lotfe-second.jpg', starting_bid: 0, current_bid: 0, status: 'open', ends_at: future(90) },
      { auction_id: N.id, position: 0, title: 'First robot', image_url: 'https://example.invalid/zztest-lotfe-first.jpg', starting_bid: 0, current_bid: 0, status: 'open', ends_at: future(95) },
    ]);
    await s.from('image_thumbs').upsert({ url: 'https://example.invalid/zztest-lotfe-first.jpg', thumb_url: 'https://example.invalid/zztest-lotfe-first-THUMB.webp' }, { onConflict: 'url' });
    await s.from('auctions').update({ image_url: 'https://example.invalid/zztest-lotfe-cover.jpg', description: 'A <b>shelf</b> of monsters, kept since 1975. More text.' }).eq('id', S.id);
    const lots = (await s.from('auction_items').insert([
      { auction_id: S.id, position: 0, title: 'Resin figure <script>alert(1)</script>', image_url: 'https://example.invalid/zztest-lotfe.jpg', starting_bid: 0, current_bid: 83.5, bid_count: 4, top_pre_bid: 437.13, leading_bidder: 'zztest_lotfe_leader', status: 'open', ends_at: future(90) },
      { auction_id: S.id, position: 1, title: 'No photo lot', starting_bid: 0, current_bid: 0, bid_count: 0, status: 'open', ends_at: future(95) },
    ]).select()).data.sort((a, b) => a.position - b.position);
    await s.from('auction_items').insert({ auction_id: D.id, position: 0, title: 'ZZTEST draft lot', starting_bid: 0, current_bid: 0, status: 'open', ends_at: future(90) });
    srv = await boot('lotfe', 3362, guard.readSource(BE + '/server.js'));

    process.env.SHARE_META_API_URL = srv.url;
    const fn = await import(pathToFileURL(path.join(FE, 'api', 'share-meta.js')).href + '?t=' + Date.now());
    const indexHtml = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).endsWith('/index.html') ? Promise.resolve(new Response(indexHtml)) : realFetch(url, opts));
    const call = async query => {
      const out = { headers: {}, body: '', statusCode: 200 };
      await fn.default({ headers: { host: 'whatthefind.live' }, query },
        { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: b => { out.body = b || ''; }, set statusCode(v) { out.statusCode = v; }, get statusCode() { return out.statusCode; } });
      return out;
    };
    const run = (slugArg, n) => call({ kind: 'lot', slug: slugArg, n });
    const count = (h, re) => (h.match(re) || []).length;
    const sl = rules.auctionSlug(S);
    let r = await run(sl, '1');
    const head = r.body.slice(0, r.body.indexOf('</head>'));
    console.log('  ' + (head.match(/<meta property="og:(title|description|image)"[^>]*>/g) || []).join('\n  '));
    ok(r.statusCode === 200 && /<title>Lot 1: Resin figure &lt;script&gt;alert\(1\)&lt;\/script&gt; \| What The Find<\/title>/.test(head) && (head.match(/<title>/g) || []).length === 1,
      'one <title>: "Lot 1: <lot title> | What The Find", HTML-escaped');
    ok(['og:title', 'og:image', 'og:description', 'twitter:card', 'twitter:image'].every(t => count(head, new RegExp(`"${t}"`, 'g')) === 1) && !head.includes('og-default'),
      "one set of tags: the default card's are replaced, not added to");
    ok(head.includes('<meta property="og:image" content="https://example.invalid/zztest-lotfe.jpg" />') && head.includes('summary_large_image'), 'og:image is the lot photo (large card)');
    ok(head.includes('Current bid $83.50 ($96.03 with 15% buyer&#39;s premium)') || head.includes("Current bid $83.50 ($96.03 with 15% buyer's premium)"), 'the description has the current bid with premium ($83.50 -> $96.03)');
    ok(head.includes('Monster &lt;Shelf&gt; &amp; &quot;Co&quot;') && !head.includes('<Shelf>'), "the auction's title is escaped too");
    ok(head.includes(`<link rel="canonical" href="https://whatthefind.live/a/${sl}/lot/1" />`) && head.includes(`og:url" content="https://whatthefind.live/a/${sl}/lot/1"`), 'canonical and og:url: the lot page address');
    ok(!/437\.13|zztest_lotfe_leader|123 NW|top_pre_bid/.test(r.body), 'no max, leader or street address in the page');
    ok(r.body.includes('<div id="root"></div>') && r.body.includes('/src/main.jsx'), 'the rest of the page is the normal app page');
    r = await run(sl, '2');
    ok(/Opening bid \$1\./.test(r.body) && r.body.includes('content="https://whatthefind.live/og/og-default.png"') && r.body.includes('og:image:width" content="1200"') && r.body.includes('summary_large_image'),
      'a lot with no bids and no photo: "Opening bid $1", the default card image (with its size)');

    console.log('  -- auction pages');
    r = await call({ kind: 'auction', id: S.id });
    let h = r.body.slice(0, r.body.indexOf('</head>'));
    ok(/<title>ZZTEST_lotfe Monster &lt;Shelf&gt; &amp; &quot;Co&quot; \| What The Find<\/title>/.test(h) && h.includes('og:description" content="A shelf of monsters, kept since 1975."')
      && h.includes('og:image" content="https://example.invalid/zztest-lotfe-cover.jpg"') && h.includes(`og:url" content="https://whatthefind.live/auction/${S.id}"`) && count(h, /"og:title"/g) === 1,
      'auction card: its title (escaped), the one-line story (no HTML), its cover photo, its address');
    ok(!/437\.13|zztest_lotfe_leader|123 NW|pickup_address/.test(r.body), 'no leader, max or pickup street in the auction card');
    r = await call({ kind: 'auction', id: N.id.toUpperCase() });
    h = r.body.slice(0, r.body.indexOf('</head>'));
    ok(h.includes('og:image" content="https://example.invalid/zztest-lotfe-first.jpg"') && !h.includes('THUMB') && h.includes('og:description" content="Forty years of tin robots from one attic."'),
      "no cover: the FIRST lot's full photo (by lot number, not the thumbnail); upper-case id works");
    for (const [label, q] of [['a draft auction', { kind: 'auction', id: D.id }], ['an unknown auction', { kind: 'auction', id: '00000000-0000-4000-8000-000000000000' }], ['a bad auction id', { kind: 'auction', id: '1;drop' }], ['no kind', { id: S.id }]]) {
      r = await call(q);
      ok(r.statusCode === 200 && r.body === indexHtml && !r.body.includes('ZZTEST_lotfe Draft'), `${label}: exactly the page with its default card`);
    }

    console.log('  -- the default card (index.html, every other page)');
    const def = indexHtml.slice(0, indexHtml.indexOf('</head>'));
    ok(def.includes('og:image" content="https://whatthefind.live/og/og-default.png"') && def.includes('og:image" content="https://whatthefind.live/og/og-default-square.png"')
      && /og:image:width" content="1200"[\s\S]*og:image:height" content="630"/.test(def) && def.includes('og:image:alt') && def.includes('og:type" content="website"') && def.includes('twitter:card" content="summary_large_image"'),
      'index.html: og:title/description/type/url, both images (1200x630 and square) with size and alt, summary_large_image');
    const png = f => { const b = fs.readFileSync(path.join(FE, 'public', 'og', f)); return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
    ok(JSON.stringify(png('og-default.png')) === '[1200,630]' && JSON.stringify(png('og-default-square.png')) === '[1200,1200]', 'public/og: the two PNGs, 1200x630 and 1200x1200');
    const plainTitle = indexHtml.match(/<title>[\s\S]*?<\/title>/)[0];
    for (const [label, a, n] of [['a draft', rules.auctionSlug(D), '1'], ['an unknown lot', sl, '99'], ['a bad slug', '../../etc', '1'], ['a bad number', sl, '1;drop']]) {
      r = await run(a, n);
      ok(r.statusCode === 200 && r.body === indexHtml && r.body.includes(plainTitle), `${label}: exactly the page with its default card`);
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
    await s.from('image_thumbs').delete().like('url', '%zztest-lotfe%');
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_lotfe%')).data.length
      + (await s.from('image_thumbs').select('url').like('url', '%zztest-lotfe%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
