// Homepage API (wtf-handoff HOMEPAGE_REFRESH_BRIEF.md): GET /home, GET /search, POST /signup. New feature, so no
// pinned "before" server. Local servers on the test database; THROWAWAY rows only (ZZTEST_home*), always cleaned up.
//
//   /home    shape, ordering and limits of every rail; "live" includes an 'upcoming' auction whose start has passed;
//            drafts, ended auctions, closed and past-their-end lots never appear; a lot carries exactly the ten public
//            fields (no top_pre_bid, reserve_price or leading bidder, by key or by value); Most wanted is hidden below
//            3 bid-on lots; the empty-site answer; the 10 s cache (server_now still fresh).
//   /search  lot titles in live + upcoming auctions only; % and _ are literal; short/long queries.
//   /signup  one row per address (lowercased), the same answer for new / repeat / honeypot, bad address 400, rate
//            limited per IP. Needs migration u; before it, 503 is asserted and the suite exits 2.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const call = (url, path, { method = 'GET', body, headers = {} } = {}) => fetch(url + path, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

const P = 'ZZTEST_home';
const LEADER = 'zztest_home_leader';
const TOP_MAX = 913.57, RESERVE = 821.39;            // distinctive: a substring search can't hit anything else
const LOT_KEYS = ['auction_id', 'auction_title', 'bid_count', 'current_bid', 'ends_at', 'id', 'image_url', 'position', 'status', 'thumb_url', 'title'];   // thumb_url since F1a, auction_title since Design B
const min = m => new Date(Date.now() + m * 60e3).toISOString();
const made = [];
const lots = {};                                      // id -> fixture row, for computing the expected rails ourselves

async function mkAuction(label, status, extra = {}) {
  const a = die(await s.from('auctions').insert({ title: `${P} ${label}`, description: `${P} story for ${label}. Kept in one basement since 1986.`, status, mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ...extra }).select().single());
  made.push(a.id);
  return a.id;
}
async function mkLots(auctionId, rows) {
  const data = die(await s.from('auction_items').insert(rows.map(({ name, ...r }, i) => ({
    auction_id: auctionId, title: `${P} lot ${name || i}`, starting_bid: 0, position: i, status: 'open',
    top_pre_bid: TOP_MAX, reserve_price: RESERVE, leading_bidder: r.bid_count ? LEADER : null, image_url: `https://example.invalid/zz/${auctionId.slice(0, 8)}-${i}.jpg`,
    ...r,
  }))).select());
  for (const l of data) lots[l.id] = l;
  return data;
}
async function cleanup() {
  for (const id of made.splice(0)) await s.rpc('delete_auction_cascade', { p_auction_id: id });
  await s.from('drop_signups').delete().like('email', 'zztest_home%');
}

const all0 = j => Object.values(j.rails).flat();
const sorted = (arr, cmp) => arr.every((x, i) => i === 0 || cmp(arr[i - 1], x) <= 0);
const t = iso => Date.parse(iso);

(async () => {
  const servers = [];
  let tableMissing = false;
  try {
    try {
    const src = require('./guard').readSource(BE + '/server.js');
    const fresh = await boot('home-nocache', 3521, src, { patch: [['const HOME_CACHE_MS = 10_000;', 'const HOME_CACHE_MS = 0;']] });
    const cached = await boot('home-cached', 3522, src);
    const limited = await boot('home-limited', 3523, src, { env: { RATE_LIMIT_EXEMPT_LOOPBACK: '' } });
    servers.push(fresh, cached, limited);
    await sleep(2000);   // let each server's one boot-time auto-close pass finish before fixtures exist

    // ---- Empty site ----
    console.log('== Empty site ==');
    const others = die(await s.from('auctions').select('id').in('status', ['live', 'upcoming']));
    if (others.length) {
      console.log(`SKIP empty-site check: wtf-test already has ${others.length} live/upcoming auction(s)`);
    } else {
      const h = await call(fresh.url, '/home');
      ok(h.s === 200 && h.j.open_auctions.length === 0 && h.j.closing_schedule.length === 0 && h.j.upcoming.length === 0 && Object.values(h.j.rails).every(r => Array.isArray(r) && r.length === 0),
        'empty site: no open auctions, no closing schedule, every rail and upcoming empty');
      ok(Math.abs(t(h.j.server_now) - Date.now()) < 5000, `empty site: server_now is the server's ISO time (${h.j.server_now})`);
      const q = await call(fresh.url, '/search?q=anything');
      ok(q.s === 200 && q.j.lots.length === 0, 'empty site: search answers an empty list');
    }

    // ---- Fixtures ----
    // Three open auctions ending on different days: A2 in 2h, A3 in 10h, A1 in 2 days.
    // A1: 15 open lots (every 4th unbid), a sold, an unsold, a past-its-end lot, "100% mint", and a lot closing in 2 days.
    // Its description has HTML and a long first sentence, for the one-line blurb.
    const A1 = await mkAuction('A1 live', 'live', { ends_at: min(60 * 48 + 60),
      description: '<p>Forty years of <b>Universal Monsters</b>: Sideshow figures, resin statues and garage kits, all kept in one basement since 1986.</p> Second sentence.' });
    await mkLots(A1, [
      ...Array.from({ length: 15 }, (_, i) => ({ name: `a1-${i}`, ends_at: min(60 + i * 5), bid_count: i % 4 === 0 ? 0 : i, current_bid: i % 4 === 0 ? 0 : i * 3 })),
      { name: 'a1-sold', status: 'sold', ends_at: min(-30), bid_count: 50, current_bid: 500 },
      { name: 'a1-unsold', status: 'unsold', ends_at: min(-30), bid_count: 0, current_bid: 0 },
      { name: 'a1-past-end', ends_at: min(-1), bid_count: 40, current_bid: 400 },
      { name: '100% mint', ends_at: min(200), bid_count: 0, current_bid: 0 },
      { name: 'a1-late', ends_at: min(60 * 48), bid_count: 5, current_bid: 20 },
    ]);
    // A2 live, ends in 2h (soonest): 3 unbid lots ending in 30 min.
    const A2 = await mkAuction('A2 live', 'live', { ends_at: min(120), buyers_premium_pct: 12.5 });
    await mkLots(A2, [0, 1, 2].map(i => ({ name: `a2-${i}`, ends_at: min(30), bid_count: 0, current_bid: 0 })));
    // A3 'upcoming' but its start has passed: bidding is open, so it counts as live.
    const A3 = await mkAuction('A3 started', 'upcoming', { starts_at: min(-60), ends_at: min(600) });
    await mkLots(A3, [{ name: 'a3-0', ends_at: min(25), bid_count: 2, current_bid: 6 }]);
    // Seven upcoming (limit 6), each with a bid-on lot that must stay out of the rails but be searchable.
    const upcomingIds = [];
    for (let i = 0; i < 7; i++) {
      const id = await mkAuction(`U${i} upcoming`, 'upcoming', { starts_at: min(60 * 24 * (7 - i)), ends_at: min(60 * 24 * (8 - i)) });
      upcomingIds.push(id);
      await mkLots(id, [{ name: `u${i}`, ends_at: min(60 * 24 * (8 - i)), bid_count: 99, current_bid: 99 }]);
    }
    // A draft and an ended auction, each with an open, heavily bid lot ending very soon.
    const D = await mkAuction('D draft', 'draft', { ends_at: min(60) });
    await mkLots(D, [{ name: 'draft', ends_at: min(5), bid_count: 100, current_bid: 1000 }]);
    const E = await mkAuction('E ended', 'ended', { ends_at: min(-60) });
    await mkLots(E, [{ name: 'ended', ends_at: min(5), bid_count: 100, current_bid: 1000 }]);

    // What the rails should be, computed from the fixtures, not from the server.
    const liveSet = new Set([A1, A2, A3]);
    const open = Object.values(lots).filter(l => liveSet.has(l.auction_id) && !['sold', 'unsold'].includes(l.status) && t(l.ends_at) > Date.now());
    const byEnds = (a, b) => t(a.ends_at) - t(b.ends_at) || a.position - b.position;
    const expEnding = [...open].sort(byEnds).slice(0, 12).map(l => l.id);
    const expWanted = open.filter(l => l.bid_count > 0).sort((a, b) => b.bid_count - a.bid_count || t(a.ends_at) - t(b.ends_at)).slice(0, 12).map(l => l.id);
    const expFirst = open.filter(l => l.bid_count === 0).sort(byEnds).slice(0, 12).map(l => l.id);
    const excluded = Object.values(lots).filter(l => !open.includes(l)).map(l => l.id);

    // ---- /home ----
    console.log('\n== GET /home ==');
    const h = await call(fresh.url, '/home');
    ok(h.s === 200, `200 (${h.s})`);
    ok(Object.keys(h.j).sort().join() === 'closing_schedule,open_auctions,premium_pct,rails,server_now,timezone,upcoming' && Object.keys(h.j.rails).sort().join() === 'ending_soon,first_bid,most_wanted',
      'top-level shape: server_now, timezone, open_auctions, closing_schedule, premium_pct, rails { ending_soon, most_wanted, first_bid }, upcoming');
    ok(all0(h.j).every(l => typeof h.j.premium_pct[l.auction_id] === 'number') && h.j.premium_pct[A2] === 12.5 && h.j.premium_pct[A1] === 15 && !(D in h.j.premium_pct) && !(E in h.j.premium_pct),
      `premium_pct: each auction's own buyer's premium for every lot shown (A1 ${h.j.premium_pct[A1]}, A2 ${h.j.premium_pct[A2]}); nothing for the draft or ended one`);
    // Open auctions, from the fixtures: soonest ending first; counts and closing times of OPEN lots.
    const OA = h.j.open_auctions;
    ok(JSON.stringify(OA.map(a => a.id)) === JSON.stringify([A2, A3, A1]), `open_auctions: every live auction (A3 started-but-"upcoming" too), soonest ending first (${OA.map(a => ({ [A1]: 'A1', [A2]: 'A2', [A3]: 'A3' })[a.id] || '?').join(', ')})`);
    ok(OA.every(a => Object.keys(a).sort().join() === 'blurb,buyers_premium_pct,ends_at,first_lot_ends_at,id,images,last_lot_ends_at,lot_count,starts_at,title'),
      'each open auction: exactly id, title, blurb, lot_count, starts_at, ends_at, first/last_lot_ends_at, buyers_premium_pct, images');
    const oa = Object.fromEntries(OA.map(a => [a.id, a]));
    const openOf = id => open.filter(l => l.auction_id === id).map(l => t(l.ends_at));
    ok(oa[A1].lot_count === 20 && oa[A2].lot_count === 3 && oa[A3].lot_count === 1, `lot_count counts every lot (A1 ${oa[A1].lot_count}, A2 ${oa[A2].lot_count}, A3 ${oa[A3].lot_count})`);
    ok([A1, A2, A3].every(id => t(oa[id].first_lot_ends_at) === Math.min(...openOf(id)) && t(oa[id].last_lot_ends_at) === Math.max(...openOf(id))),
      'first/last_lot_ends_at: earliest and latest close among the open lots (closed and past-their-end lots ignored)');
    ok(oa[A1].blurb === 'Forty years of Universal Monsters: Sideshow figures, resin statues and garage kits, all…' && oa[A1].blurb.length <= 90 && oa[A2].blurb.endsWith('story for A2 live.'),
      `blurb: first sentence, plain text, max 90 characters ("${oa[A1].blurb}")`);
    ok(oa[A2].buyers_premium_pct === 12.5 && oa[A1].buyers_premium_pct === 15, 'buyers_premium_pct: each auction\'s own');
    ok(OA.every(a => a.images.length <= 3 && a.images.every(i => Object.keys(i).sort().join() === 'thumb_url,url' && i.url.startsWith('https://'))) && oa[A1].images.length === 3,
      `images: at most 3 per auction, each { url, thumb_url } (A1 ${oa[A1].images.length}, A2 ${oa[A2].images.length})`);
    // Closing schedule, computed here in the zone the server says it uses.
    const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: h.j.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    const expSched = [];
    for (const id of [A1, A2, A3]) {
      const days = {};
      for (const ms of openOf(id).filter(ms => ms <= Date.now() + 7 * 86400e3)) (days[dayOf(ms)] = days[dayOf(ms)] || []).push(ms);
      for (const [date, ms] of Object.entries(days)) expSched.push(`${date}|${id}|${Math.min(...ms)}|${Math.max(...ms)}`);
    }
    const gotSched = h.j.closing_schedule.map(e => `${e.date}|${e.auction_id}|${t(e.first_close)}|${t(e.last_close)}`);
    ok(h.j.timezone === 'America/New_York' && JSON.stringify([...gotSched].sort()) === JSON.stringify([...expSched].sort()) && sorted(h.j.closing_schedule, (a, b) => t(a.first_close) - t(b.first_close)),
      `closing_schedule: one entry per auction per day its lots close (site time zone ${h.j.timezone}), soonest first (${gotSched.length} entries; A1 spans ${h.j.closing_schedule.filter(e => e.auction_id === A1).length} days)`);
    ok(h.j.closing_schedule.every(e => Object.keys(e).sort().join() === 'auction_id,date,first_close,last_close,title' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.title === oa[e.auction_id].title),
      'closing_schedule entries: exactly date (YYYY-MM-DD), auction_id, title, first_close, last_close');
    const R = h.j.rails;
    ok(JSON.stringify(R.ending_soon.map(l => l.id)) === JSON.stringify(expEnding), `ending_soon: open lots in live auctions, soonest first, max 12 (${R.ending_soon.length})`);
    ok(R.ending_soon[0] && R.ending_soon[0].auction_id === A3, 'ending_soon: a started-but-still-"upcoming" auction counts as live (its lot leads)');
    ok(JSON.stringify(R.most_wanted.map(l => l.id)) === JSON.stringify(expWanted), `most_wanted: by bids desc, ties by end time, max 12, only lots with bids (${R.most_wanted.length})`);
    ok(JSON.stringify(R.first_bid.map(l => l.id)) === JSON.stringify(expFirst) && R.first_bid.every(l => l.bid_count === 0), `first_bid: unbid open lots, soonest first (${R.first_bid.length})`);
    ok(sorted(R.ending_soon, (a, b) => t(a.ends_at) - t(b.ends_at)) && sorted(R.most_wanted, (a, b) => b.bid_count - a.bid_count), 'rails are in order');
    const all = [...R.ending_soon, ...R.most_wanted, ...R.first_bid];
    ok(all.every(l => l.auction_title === oa[l.auction_id].title), 'every rail lot carries its auction\'s title');
    ok(!all.some(l => excluded.includes(l.id)), 'no sold, unsold, past-its-end, upcoming-auction, draft or ended lot in any rail');
    ok(all.every(l => Object.keys(l).sort().join() === LOT_KEYS.join()), 'every lot carries exactly: ' + LOT_KEYS.join(', '));
    ok(all.every(l => typeof l.current_bid === 'number' && Number.isInteger(l.position) && !isNaN(t(l.ends_at)) && l.ends_at.endsWith('Z')), 'money is a number, position an integer, dates ISO');
    const text = JSON.stringify(h.j);
    ok(!text.includes(String(TOP_MAX)) && !text.includes(String(RESERVE)) && !text.includes(LEADER) && !/top_pre_bid|reserve_price|leading_bidder/.test(text),
      'no max bid, reserve or leading bidder anywhere in the response (keys or values)');
    ok(!text.includes(D) && !text.includes(E) && !text.includes('D draft') && !text.includes('E ended'), 'the draft and the ended auction are nowhere in the response');
    ok(JSON.stringify(h.j.upcoming.map(a => a.id)) === JSON.stringify([...upcomingIds].reverse().slice(0, 6)) && h.j.upcoming.every(a => a.starts_at && t(a.starts_at) > Date.now()),
      `upcoming: not started yet, soonest first, max 6 (${h.j.upcoming.length}); A3 (already started) not in it`);

    // ---- Search ----
    console.log('\n== GET /search ==');
    let q = await call(fresh.url, '/search?q=' + encodeURIComponent(P + ' lot'));
    const got = new Set(q.j.lots.map(l => l.auction_id));
    ok(q.s === 200 && [A1, A2, A3, ...upcomingIds].every(id => got.has(id)) && !got.has(D) && !got.has(E), 'title search covers live and upcoming auctions, never the draft or the ended one');
    ok(q.j.lots.every(l => typeof q.j.premium_pct[l.auction_id] === 'number') && !(D in q.j.premium_pct) && q.j.lots.length <= 48 && q.j.lots.every(l => Object.keys(l).sort().join() === LOT_KEYS.join()) && !JSON.stringify(q.j).includes(String(TOP_MAX)), 'search results: same fields plus a premium for each auction, no max, max 48');
    q = await call(fresh.url, '/search?q=' + encodeURIComponent('0% mint'));
    ok(q.j.lots.length === 1 && q.j.lots[0].title.endsWith('100% mint'), `'%' is literal, not a wildcard (${q.j.lots.length} match)`);
    q = await call(fresh.url, '/search?q=' + encodeURIComponent('HOME LOT A2-1'));
    ok(q.j.lots.length === 1, 'case-insensitive');
    q = await call(fresh.url, '/search?q=x');
    ok(q.s === 200 && q.j.lots.length === 0, 'one character: empty list, no query');
    q = await call(fresh.url, '/search?q=' + 'y'.repeat(101));
    ok(q.s === 400, `over 100 characters: 400 (${q.s})`);

    // ---- Cache ----
    console.log('\n== Cache ==');
    const c1 = await call(cached.url, '/home');
    const [soonest] = await mkLots(A2, [{ name: 'late-add', position: 3, ends_at: min(10), bid_count: 0, current_bid: 0 }]);
    await sleep(1100);
    const c2 = await call(cached.url, '/home');
    ok(c2.j.rails.ending_soon[0].id !== soonest.id && t(c2.j.server_now) > t(c1.j.server_now), 'within 10 s the cached body is reused, but server_now is fresh');
    const f2 = await call(fresh.url, '/home');
    ok(f2.j.rails.ending_soon[0].id === soonest.id, 'the new lot is there on an uncached build');
    await sleep(10000);
    const c3 = await call(cached.url, '/home');
    ok(c3.j.rails.ending_soon[0].id === soonest.id, 'after 10 s the cached server picks it up');

    // ---- Most wanted hides with few bids ----
    const bidOn = open.filter(l => l.bid_count > 0);
    die(await s.from('auction_items').update({ bid_count: 0 }).in('id', bidOn.slice(2).map(l => l.id)));
    const few = await call(fresh.url, '/home');
    ok(few.j.rails.most_wanted.length === 0, 'with only 2 bid-on lots, most_wanted is sent empty (the page hides it)');
    die(await s.from('auction_items').update({ bid_count: 0 }).in('id', bidOn.slice(0, 2).map(l => l.id)));

    // ---- Upcoming only / nothing live ----
    for (const id of [A1, A2, A3]) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    made.splice(made.indexOf(A1), 3);
    const up = await call(fresh.url, '/home');
    ok(up.j.open_auctions.length === 0 && up.j.closing_schedule.length === 0 && up.j.upcoming[0] && up.j.upcoming[0].id === upcomingIds[6] && Object.values(up.j.rails).every(r => r.length === 0),
      'no live auction: no open auctions or schedule, upcoming leads with the next to open, rails empty (upcoming lots never go in them)');

    // ---- Sign-up ----
    console.log('\n== POST /signup ==');
    const probe = await s.from('drop_signups').select('id').limit(1);
    tableMissing = !!probe.error;
    if (tableMissing) {
      const r = await call(fresh.url, '/signup', { method: 'POST', body: { email: 'zztest_home_pre@example.invalid' } });
      ok(r.s === 503 && /isn't open yet/.test(r.j.error), `before migration u: 503 "not open yet", nothing else breaks (${r.s})`);
    } else {
      const post = (url, body) => call(url, '/signup', { method: 'POST', body });
      const a = await post(fresh.url, { email: '  ZZtest_home_1@Example.INVALID ' });
      const b = await post(fresh.url, { email: 'zztest_home_1@example.invalid' });
      const hp = await post(fresh.url, { email: 'zztest_home_bot@example.invalid', website: 'http://spam.invalid' });
      ok(a.s === 200 && b.s === 200 && hp.s === 200 && JSON.stringify(a.j) === JSON.stringify(b.j) && JSON.stringify(a.j) === JSON.stringify(hp.j),
        `new, repeat and honeypot all get the identical answer: ${JSON.stringify(a.j)}`);
      const rows = die(await s.from('drop_signups').select('email, confirmed_at, unsubscribed_at').like('email', 'zztest_home%'));
      ok(rows.length === 1 && rows[0].email === 'zztest_home_1@example.invalid' && !rows[0].confirmed_at && !rows[0].unsubscribed_at,
        `one row, stored trimmed + lowercased, unconfirmed; the honeypot stored nothing (${rows.map(r => r.email).join(', ')})`);
      for (const bad of ['', 'not-an-email', 'a@b', null, 42, 'x'.repeat(250) + '@e.io']) {
        const r = await post(fresh.url, { email: bad });
        if (r.s !== 400) ok(false, `bad address ${JSON.stringify(bad)} -> ${r.s}`);
      }
      ok(true, 'bad addresses -> 400');
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await post(limited.url, { email: `zztest_home_rl${i}@example.invalid` })).s);
      ok(codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, `rate limit: 5 per hour per address, then 429 (${codes.join(' ')})`);
      const anon = await s.from('drop_signups').select('id');
      ok(!anon.error, 'service_role reads the table (RLS lockdown is checked by the migration itself)');
    }
    } catch (e) { console.log('ERR', e); fails++; }
  } finally {
    servers.forEach(x => x.stop());
    await cleanup();
    const left = die(await s.from('auctions').select('id').like('title', P + '%')).length
      + die(await s.from('auction_items').select('id').like('title', P + '%')).length
      + ((await s.from('drop_signups').select('id').like('email', 'zztest_home%')).data || []).length;   // table may not exist yet
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  if (tableMissing && !fails) { console.log('\nALL PASS so far; migration u is not on this database, so sign-up was checked only for its 503. Exit 2.'); process.exit(2); }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.log('ERR', e); await cleanup().catch(() => {}); process.exit(1); });
