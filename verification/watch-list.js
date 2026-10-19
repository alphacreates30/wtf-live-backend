// Watch list, followed auctions and reminder emails (F3, WATCH_LIST_BRIEF.md). Needs migration w (exits 2 without it).
// Local servers on the test database; THROWAWAY rows only (ZZTEST_watch*, zztest_watch_*), always cleaned up.
// Resend is a stub inside the server process that records every email (to, subject, html, headers) to a file -
// nothing is sent. The reminder job runs on a FAKE clock through a test-only route added to the local server.
//
//   API       watch / unwatch / follow / unfollow (idempotent; drafts 404; closed lots and ended auctions refused;
//             bad ids 400; no login 401); following an already-open auction marks its "open" reminder done;
//             500-watch limit; rate limited like bids; preferences read/write.
//   privacy   /me/watching is only ever the caller's own and carries no leading bidder; /home, /search and the
//             auction pages carry no watch data; the admin sees counts (per lot, per auction), buyers get 403.
//   reminders one email per buyer per run, listing every watched lot closing within the hour with price and status
//             (winning / outbid / no bid); a lot that is also in a followed auction's top lots is listed once;
//             closed lots skipped; sent once (re-run and soft-close extension send nothing); "opens" and "closes
//             tomorrow" for followed auctions, merged into the same email; each preference respected; every email
//             logged in email_send_log; List-Unsubscribe headers; the unsubscribe link works with no login, GET changes
//             nothing, a tampered token is refused.
//   show_live (live phase 6) Go live on a published show emails its followers (their "auctions you follow opening"
//             switch applies) and every approved buyer with live_alerts on: one email each, at most once per show (a
//             second queue and a second Go live add nothing), never for a rehearsal or a timed auction. An opted-out
//             buyer who doesn't follow gets nothing; an opted-out follower still gets it; a follower who is also opted
//             in gets one. Following a live show whose start time passed but isn't on air leaves it pending; the old
//             reminders leave live shows out. Every show_live email has "Stop live show alerts": it works with no login
//             and a token altered to name someone else is refused. (Phone alerts: web-push.js.)
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const MAIL = BE + '/run.tmp-watch-mail.log';
const RESEND_STUB = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com')) return realFetch(url, opts);
  const b = JSON.parse(opts.body || '{}');
  require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject, html: b.html, headers: b.headers || null }) + '\\n');
  return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
};`;
const TEST_ROUTE = `app.post('/__test/reminders', async (req, res) => res.json(await runReminders(new Date(String(req.query.now)))));
const PORT = process.env.PORT || 3001;`;
const OPTS = { env: { RESEND_API_KEY: 're_zztest_stub', SITE_URL: 'https://site.zztest' }, preload: RESEND_STUB, patch: [['const PORT = process.env.PORT || 3001;', TEST_ROUTE]] };
const mails = () => (fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const T = Date.now();
const at = min => new Date(T + min * 60e3).toISOString();
const made = { users: [], auctions: [] };
const P = 'ZZTEST_watch';

async function mkUser(label) {
  const id = crypto.randomUUID(), username = `zztest_watch_${label}_${crypto.randomBytes(3).toString('hex')}`;
  die(await s.from('users').insert({ id, username, password_hash: 'zztest-not-a-real-hash', email: `${username}@example.invalid` }).select().single());
  made.users.push(id);
  return { id, username, email: `${username}@example.invalid`, tok: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '20m' }) };
}
async function mkAuction(label, status, extra = {}) {
  const a = die(await s.from('auctions').insert({ title: `${P} ${label}`, description: `${P} ${label} story. More.`, status, mode: 'standard', fulfillment_mode: 'shipping', buyers_premium_pct: 15, host_username: 'whatthefind', ...extra }).select().single());
  made.auctions.push(a.id);
  return a.id;
}
async function mkLot(auctionId, name, extra) {
  return die(await s.from('auction_items').insert({ auction_id: auctionId, title: `${P} lot ${name}`, starting_bid: 0, current_bid: 0, bid_count: 0, position: extra.position ?? 0, status: 'open', ...extra }).select().single());
}
const call = (url, method, path, tok, body) => fetch(url + path, {
  method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const count = (hay, needle) => hay.split(needle).length - 1;

(async () => {
  const probe = await s.from('lot_watches').select('item_id').limit(1);
  if (probe.error) { console.log('lot_watches is missing on this database: apply migration w (2026-09-30w-watch-list.sql) first.'); process.exitCode = 2; return; }
  try { fs.unlinkSync(MAIL); } catch {}
  const servers = [];
  try {
    try {
      const src = require('./guard').readSource(BE + '/server.js');
      const srv = await boot('watch-main', 3541, src, OPTS);
      const small = await boot('watch-limit', 3542, src, { ...OPTS, patch: [...OPTS.patch, ['const WATCH_MAX = 500;', 'const WATCH_MAX = 3;']] });
      const limited = await boot('watch-rate', 3543, src, { ...OPTS, env: { ...OPTS.env, RATE_LIMIT_EXEMPT_LOOPBACK: '' } });
      servers.push(srv, small, limited);
      await sleep(2500);   // each server's boot-time auto-close pass (with its reminder run) finishes before fixtures exist
      try { fs.unlinkSync(MAIL); } catch {}
      const U = srv.url;
      const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '20m' });

      // ---- Fixtures ----
      const b1 = await mkUser('b1'), b2 = await mkUser('b2'), b3 = await mkUser('b3');
      const L = await mkAuction('L live', 'live', { starts_at: at(-60), ends_at: at(60 * 5) });
      const A = await mkLot(L, 'A-winning', { position: 0, ends_at: at(50), bid_count: 9, current_bid: 40, leading_bidder: b1.username, top_pre_bid: 77.77 });
      const A2 = await mkLot(L, 'A2-outbid', { position: 1, ends_at: at(40), bid_count: 8, current_bid: 30, leading_bidder: b2.username });
      const A3 = await mkLot(L, 'A3-nobid', { position: 2, ends_at: at(55), bid_count: 0 });
      const Afar = await mkLot(L, 'Afar', { position: 3, ends_at: at(60 * 2 + 30), bid_count: 1, current_bid: 5, leading_bidder: b2.username });
      const Aclosed = await mkLot(L, 'Aclosed', { position: 4, ends_at: at(-5), status: 'sold', bid_count: 2, current_bid: 9, leading_bidder: b2.username });
      die(await s.from('bids').insert({ auction_id: L, item_id: A2.id, username: b1.username, amount: 25 }).select());
      const Up = await mkAuction('U upcoming', 'upcoming', { starts_at: at(120), ends_at: at(60 * 24) });
      const U1 = await mkLot(Up, 'U1', { position: 0, ends_at: at(60 * 22), bid_count: 0, image_url: 'https://example.invalid/zz-u1.jpg' });
      const D = await mkAuction('D draft', 'draft', { ends_at: at(60) });
      const Dlot = await mkLot(D, 'draft', { ends_at: at(30) });
      const E = await mkAuction('E ended', 'ended', { ends_at: at(-60) });

      // ---- API ----
      console.log('== Watch / follow API ==');
      let r = await call(U, 'POST', `/watch/${A.id}`);
      ok(r.s === 401, `no login: 401 (${r.s})`);
      r = await call(U, 'POST', `/watch/${A.id}`, b1.tok); const r2 = await call(U, 'POST', `/watch/${A.id}`, b1.tok);
      ok(r.s === 200 && r.j.watching === true && r2.s === 200, 'watch a lot: 200, and again (idempotent)');
      for (const [id, want, what] of [[Dlot.id, 404, 'a draft\'s lot'], [Aclosed.id, 400, 'a closed lot'], [crypto.randomUUID(), 404, 'an unknown lot'], ['not-a-uuid', 400, 'a bad id']]) {
        r = await call(U, 'POST', `/watch/${id}`, b1.tok);
        ok(r.s === want, `watch ${what}: ${want} (${r.s})`);
      }
      r = await call(U, 'DELETE', `/watch/${A.id}`, b1.tok);
      let w = await call(U, 'GET', '/me/watching', b1.tok);
      ok(r.s === 200 && r.j.watching === false && !w.j.ids.lots.includes(A.id), 'unwatch: gone from /me/watching');
      for (const l of [A, A2, A3, Afar]) die(await s.from('lot_watches').upsert({ user_id: b1.id, item_id: l.id }).select());   // (API path proven above)
      die(await s.from('lot_watches').insert({ user_id: b1.id, item_id: Aclosed.id }).select());   // watched before it closed
      r = await call(U, 'POST', `/follow/${Up}`, b1.tok);
      const fUp = die(await s.from('auction_follows').select('*').eq('user_id', b1.id).eq('auction_id', Up).single());
      ok(r.s === 200 && r.j.following && !fUp.open_notified_at && !fUp.closing_notified_at, 'follow an upcoming auction: its "opens" reminder is pending');
      r = await call(U, 'POST', `/follow/${L}`, b2.tok);
      const fL = die(await s.from('auction_follows').select('*').eq('user_id', b2.id).eq('auction_id', L).single());
      ok(r.s === 200 && fL.open_notified_at && fL.closing_notified_at, 'follow an already-open auction closing within 24h: both reminders marked done (no email about what they\'re looking at)');
      r = await call(U, 'POST', `/follow/${D}`, b1.tok); const rE = await call(U, 'POST', `/follow/${E}`, b1.tok);
      ok(r.s === 404 && rE.s === 400, `follow a draft: 404 (${r.s}); an ended auction: 400 (${rE.s})`);
      r = await call(U, 'DELETE', `/follow/${L}`, b2.tok);
      ok(r.s === 200 && !(await s.from('auction_follows').select('user_id').eq('user_id', b2.id).eq('auction_id', L)).data.length, 'unfollow');

      w = await call(U, 'GET', '/me/watching', b1.tok);
      const wl = Object.fromEntries(w.j.lots.map(l => [l.id, l]));
      ok(w.s === 200 && ['lots', 'auctions', 'ids'].every(k => k in w.j) && w.j.ids.lots.length === 5 && w.j.ids.auctions.includes(Up),
        `/me/watching: { lots, auctions, ids } (${w.j.ids.lots.length} lots, ${w.j.ids.auctions.length} auction)`);
      ok(wl[A.id].my_status === 'winning' && wl[A2.id].my_status === 'outbid' && wl[A3.id].my_status === 'no_bid' && wl[Aclosed.id].my_status === 'closed',
        `my_status: winning / outbid / no_bid / closed (${[A, A2, A3, Aclosed].map(l => wl[l.id].my_status).join(', ')})`);
      const wtext = JSON.stringify(w.j);
      ok(!/leading_bidder|top_pre_bid|reserve_price/.test(wtext) && !wtext.includes('77.77') && !wtext.includes(b2.username), '/me/watching carries no leader, max or other buyer');
      const w2 = await call(U, 'GET', '/me/watching', b2.tok);
      ok(w2.j.ids.lots.length === 0 && w2.j.ids.auctions.length === 0, 'another buyer sees none of it');
      ok((await call(U, 'GET', '/me/watching')).s === 401, '/me/watching needs a login');

      console.log('\n== Privacy: public pages carry no watch data; the admin sees counts ==');
      for (const p of ['/home', '/search?q=' + encodeURIComponent(P), `/auction/${L}/items`, `/auction/${L}/items/standard-status`, `/auction/${L}`, '/auctions']) {
        const x = await call(U, 'GET', p, b2.tok);
        ok(x.s === 200 && !/"[a-z_]*(watch|follow)[a-z_]*"\s*:/i.test(JSON.stringify(x.j)), `${p.split('?')[0].replace(L, ':id')}: no watch/follow fields`);
      }
      r = await call(U, 'GET', `/admin/watch-counts?auction_id=${L}`, admin);
      ok(r.s === 200 && r.j.lots[A.id] === 1 && r.j.lots[A2.id] === 1 && r.j.followers === 0, `admin: watchers per lot and followers per auction (${JSON.stringify(r.j.lots[A.id])} on A)`);
      r = await call(U, 'GET', `/admin/watch-counts?auction_id=${Up}`, admin);
      ok(r.j.followers === 1, `admin: followers of U (${r.j.followers})`);
      ok((await call(U, 'GET', `/admin/watch-counts?auction_id=${L}`, b1.tok)).s === 403, 'a buyer asking for counts: 403');

      console.log('\n== Limits ==');
      const lim = [];
      for (const l of [A, A2, A3, Afar]) lim.push((await call(small.url, 'POST', `/watch/${l.id}`, b3.tok)).s);
      const again = (await call(small.url, 'POST', `/watch/${A.id}`, b3.tok)).s;
      ok(lim.slice(0, 3).every(x => x === 200) && lim[3] === 400 && again === 200, `watch limit (500; 3 on this server): 4th refused, re-watching one already watched is fine (${lim.join(' ')}, ${again})`);
      die(await s.from('lot_watches').delete().eq('user_id', b3.id));
      const codes = [];
      for (let i = 0; i < 62; i++) codes.push((await call(limited.url, 'POST', `/watch/${A3.id}`, b3.tok)).s);
      ok(codes.includes(429) && codes.indexOf(429) >= 55, `rate limited per buyer like bids: 429 after 60 in a minute (first 429 at #${codes.indexOf(429) + 1})`);
      die(await s.from('lot_watches').delete().eq('user_id', b3.id));

      console.log('\n== Preferences ==');
      r = await call(U, 'GET', '/me/notification-prefs', b3.tok);
      ok(r.s === 200 && r.j.lot_closing && r.j.auction_open && r.j.auction_closing, 'defaults: every reminder on');
      r = await call(U, 'PUT', '/me/notification-prefs', b3.tok, { auction_open: false });
      ok(r.s === 200 && r.j.auction_open === false && r.j.lot_closing === true, 'switch one off; the others stay on');
      ok((await call(U, 'PUT', '/me/notification-prefs', b3.tok, { lot_closing: 'no' })).s === 400, 'a non-boolean: 400');
      die(await s.from('notification_prefs').upsert({ user_id: b2.id, lot_closing: false }).select());

      // ---- Reminders on a fake clock ----
      console.log('\n== Reminders (fake clock) ==');
      // b1 follows L with its "closing" reminder still pending (as if followed days ago), so run 1 has lot + auction reminders.
      die(await s.from('auction_follows').insert({ user_id: b1.id, auction_id: L, open_notified_at: at(-60) }).select());
      // b2 (lot_closing off) watches A: must get nothing. b3 follows Up with auction_open off.
      die(await s.from('lot_watches').insert({ user_id: b2.id, item_id: A.id }).select());
      die(await s.from('auction_follows').insert({ user_id: b3.id, auction_id: Up }).select());
      const logBefore = (await s.from('email_send_log').select('id', { count: 'exact', head: true }).eq('kind', 'reminder')).count;

      let run = await call(U, 'POST', `/__test/reminders?now=${encodeURIComponent(at(0))}`);
      let m = mails().filter(x => [b1, b2, b3].some(b => b.email === x.to));
      const m1 = m.filter(x => x.to === b1.email);
      ok(run.s === 200 && m1.length === 1 && m.filter(x => x.to === b2.email).length === 0,
        `run 1: ONE email to the watcher, none to the buyer who switched lot reminders off (${m1.length}, run ${JSON.stringify(run.j)})`);
      const h = (m1[0] || {}).html || '';
      ok(/3 lots you're watching close within the hour/.test(m1[0]?.subject || ''), `subject: "${m1[0]?.subject}"`);
      const withinHour = h.split('closing tomorrow')[0];
      ok([A, A2, A3].every(l => count(h, l.title) === 1) && !withinHour.includes(Afar.title) && !h.includes(Aclosed.title),
        'each watched lot closing within the hour listed exactly once in the whole email (A, A2, A3 are also L\'s top lots); the far one not in that section; the closed one nowhere');
      ok(h.includes("You're winning") && h.includes('Outbid') && h.includes('No bid yet') && h.includes('+ 15% premium') && h.includes(`https://site.zztest/auction/${L}?lot=${A.id}`),
        'each lot: price with premium, the buyer\'s status (winning / outbid / no bid), a Bid link');
      ok(/closing tomorrow/.test(h), 'the followed auction\'s "closing tomorrow" section is in the same email');
      const hdr = (m1[0] || {}).headers || {};
      ok(/^<https?:\/\/[^>]+\/unsubscribe\?token=[^>]+>$/.test(hdr['List-Unsubscribe'] || '') && hdr['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && h.includes('https://site.zztest/unsubscribe?token='),
        'List-Unsubscribe + one-click headers, and an unsubscribe link in the footer');
      const logAfter = (await s.from('email_send_log').select('id', { count: 'exact', head: true }).eq('kind', 'reminder')).count;
      ok(logAfter === logBefore + 1, `logged in email_send_log as 'reminder' (${logBefore} -> ${logAfter})`);
      const outbox = die(await s.from('notifications').select('kind, sent_at, error').eq('user_id', b1.id));
      ok(outbox.length === 4 && outbox.every(n => n.sent_at && !n.error), `outbox: 4 rows (3 lots + 1 auction) all marked sent (${outbox.map(n => n.kind).join(', ')})`);

      await call(U, 'POST', `/__test/reminders?now=${encodeURIComponent(at(1))}`);
      die(await s.from('auction_items').update({ ends_at: at(52) }).eq('id', A.id).select());   // soft close: A extended
      await call(U, 'POST', `/__test/reminders?now=${encodeURIComponent(at(10))}`);
      m = mails().filter(x => x.to === b1.email);
      ok(m.length === 1, `sent once: a re-run and a soft-close extension send nothing more (${m.length} email)`);

      // Run 2, two hours on: Up has opened (and its first lot closes within 24h), and Afar is now within the hour.
      run = await call(U, 'POST', `/__test/reminders?now=${encodeURIComponent(at(121))}`);
      m = mails().filter(x => x.to === b1.email);
      const m2 = m[1] || {};
      ok(m.length === 2 && count(m2.html || '', Afar.title) === 1 && /U upcoming is open/.test(m2.html || '') && /closing tomorrow/.test(m2.html || ''),
        `run 2: ONE email merging a lot reminder (Afar), "U is open" and "U closes tomorrow" ("${m2.subject}")`);
      const m3 = mails().filter(x => x.to === b3.email);
      ok(m3.length === 1 && !/is open/.test(m3[0].html) && /closing tomorrow/.test(m3[0].html), 'b3 (auction-open reminders off): only the "closes tomorrow" part');

      // A closed lot between queue and send is dropped: queue for b3 on a lot, close it, then let the sender run.
      const Z = await mkLot(L, 'Z-closes-mid-run', { position: 5, ends_at: at(150), bid_count: 0 });
      die(await s.from('lot_watches').insert({ user_id: b3.id, item_id: Z.id }).select());
      await s.rpc('queue_reminders', { p_now: at(125) });
      die(await s.from('auction_items').update({ status: 'unsold', ends_at: at(124) }).eq('id', Z.id).select());
      await call(U, 'POST', `/__test/reminders?now=${encodeURIComponent(at(126))}`);
      const zRow = die(await s.from('notifications').select('sent_at, error').eq('user_id', b3.id).eq('kind', 'lot_closing').single());
      ok(mails().filter(x => x.to === b3.email).length === 1 && zRow.sent_at && /nothing still open/.test(zRow.error || ''), 'a lot that closed after being queued is skipped: no email, row closed with the reason');

      console.log('\n== "Show starting now" and live show alerts (live phase 6) ==');
      {
        const { io: ioc } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
        const liveSrv = await boot('watch-live', 3544, src, { ...OPTS, env: { ...OPTS.env, LIVE_ENABLED: 'true' } });
        servers.push(liveSrv);
        // The host's Go live over a socket; resolves with host_ok / host_error.
        const goLive = auctionId => new Promise(resolve => {
          const c = ioc(liveSrv.url, { transports: ['websocket'], forceNew: true });
          const t = setTimeout(() => { c.close(); resolve(null); }, 8000);
          c.on('connect', () => c.emit('join_auction', { auctionId, token: admin }));
          c.on('auction_state', () => c.emit('go_live', { auctionId, token: admin }));
          for (const ev of ['host_ok', 'host_error']) c.on(ev, p => { clearTimeout(t); c.close(); resolve({ event: ev, payload: p }); });
        });
        // An approved buyer profile; live_alerts as given (the column's default is on).
        const profile = async (u, liveAlerts) => die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZ watch', email: u.email, phone: '0', address_line1: '1 ZZ St',
          city: 'X', state: 'CA', zip: '94000', status: 'approved', ...(liveAlerts === undefined ? {} : { live_alerts: liveAlerts }) }).select());
        const f1 = await mkUser('f1'), f2 = await mkUser('f2'), f3 = await mkUser('f3'), late = await mkUser('late');
        const alertsOn = await mkUser('alon'), optedOut = await mkUser('alout'), outFollower = await mkUser('aloutf'), both = await mkUser('alboth');
        await profile(alertsOn); await profile(optedOut, false); await profile(outFollower, false); await profile(both, true);
        ok(die(await s.from('profiles').select('live_alerts').eq('user_id', alertsOn.id).single()).live_alerts === true, 'live_alerts is on by default for a new profile');
        const mine = [f1, f2, f3, late, alertsOn, optedOut, outFollower, both];
        const Show = await mkAuction('S show', 'upcoming', { mode: 'live', starts_at: at(-2) });
        const R = await mkAuction('R rehearsal', 'draft', { mode: 'live' });
        for (const f of [f1, f2, f3, outFollower, both]) {
          const fr = await call(liveSrv.url, 'POST', `/follow/${Show}`, f.tok);
          if (fr.s !== 200) ok(false, `follow the show: ${fr.s}`);
        }
        const pend = die(await s.from('auction_follows').select('open_notified_at').eq('auction_id', Show));
        ok(pend.length === 5 && pend.every(x => !x.open_notified_at), 'following a live show whose start time passed but isn\'t on air yet: the "starting now" email stays pending');
        die(await s.from('notification_prefs').upsert({ user_id: f3.id, auction_open: false }).select());
        die(await s.from('auction_follows').insert({ user_id: f1.id, auction_id: R }).select());   // a follow from before (a rehearsal must still send nothing)
        await call(liveSrv.url, 'POST', `/__test/reminders?now=${encodeURIComponent(new Date().toISOString())}`);
        ok(!die(await s.from('notifications').select('id').eq('kind', 'auction_open').in('user_id', mine.map(u => u.id))).length,
          'before Go live, the reminder job sends no "is open" for a live show (live shows are left out of the old reminders)');
        let g = await goLive(Show);
        ok(g && g.event === 'host_ok', `Go live on the published show (${g && g.event})`);
        await sleep(3500);
        const rows = die(await s.from('notifications').select('user_id, kind, channel, payload, sent_at').eq('kind', 'show_live').in('user_id', mine.map(u => u.id)));
        const got = u => rows.filter(x => x.user_id === u.id && x.channel === 'email' && x.payload.auction_id === Show).length;
        ok(got(f1) === 1 && got(f2) === 1 && got(f3) === 0, 'followers get one each (f1, f2); f3, whose "auctions you follow opening" switch is off and who has no live alerts, none');
        ok(got(alertsOn) === 1 && got(optedOut) === 0, 'an approved buyer with live alerts on who doesn\'t follow: one; one who opted out and doesn\'t follow: nothing');
        ok(got(outFollower) === 1, 'an opted-out buyer who follows the show still gets it (they asked for that show)');
        ok(got(both) === 1 && rows.filter(x => x.user_id === both.id).length === 1, 'a follower who is also opted in: one email, not two (and no push row: no phone subscription)');
        const sm = u => mails().filter(x => x.to === u.email);
        const m1 = sm(f1)[0] || {};
        ok([f1, f2, alertsOn, outFollower, both].every(u => sm(u).length === 1) && [f3, optedOut].every(u => sm(u).length === 0)
          && m1.subject === `${P} S show is live now` && (m1.html || '').includes(`https://site.zztest/auction/${Show}`) && rows.every(x => x.sent_at),
          `the emails go out within seconds of Go live: "${m1.subject}", linking to the show; rows marked sent`);
        ok(/no buyer's premium/.test(m1.html || '') && !/premium &middot;|\+ 15%/.test(m1.html || '') && /Stop live show alerts/.test(m1.html || ''), 'its wording (placeholder), no premium line, and "Stop live show alerts"');
        const again = await s.rpc('queue_show_live', { p_auction_id: Show, p_push: false });
        g = await goLive(Show);
        await call(liveSrv.url, 'POST', `/__test/reminders?now=${encodeURIComponent(new Date().toISOString())}`);
        ok(again.data && again.data.email === 0 && g && g.payload.code === 'already_on_air' && die(await s.from('notifications').select('id').eq('kind', 'show_live').in('user_id', mine.map(u => u.id))).length === rows.length
          && sm(f1).length === 1, 'at most once per show per person: queueing again adds 0, a second Go live is refused, no second email');
        await call(liveSrv.url, 'POST', `/follow/${Show}`, late.tok);
        await call(liveSrv.url, 'POST', `/__test/reminders?now=${encodeURIComponent(new Date().toISOString())}`);
        ok(!die(await s.from('notifications').select('id').eq('user_id', late.id)).length && sm(late).length === 0, 'following while it is on air: no email (they are watching)');
        g = await goLive(R);
        await sleep(1500);
        ok(g && g.event === 'host_ok' && !die(await s.from('notifications').select('id').eq('kind', 'show_live').contains('payload', { auction_id: R })).length,
          'a rehearsal goes on air: no show_live for anyone, even a follower or an opted-in buyer');
        const timed = await s.rpc('queue_show_live', { p_auction_id: Up, p_push: false });
        ok(timed.data && timed.data.email === 0, 'a timed auction: queue_show_live adds nothing');

        // "Stop live show alerts": no login; bound to that account.
        const link = ((sm(alertsOn)[0] || {}).html || '').match(/unsubscribe\?token=([^"&]+)"[^>]*>Stop live show alerts/);
        const ltok = link ? decodeURIComponent(link[1]) : '';
        let u = await call(liveSrv.url, 'GET', `/unsubscribe?token=${encodeURIComponent(ltok)}`);
        ok(u.s === 200 && u.j.kind === 'live_alerts' && die(await s.from('profiles').select('live_alerts').eq('user_id', alertsOn.id).single()).live_alerts === true,
          `the link: GET describes it ("${u.j && u.j.what}") and changes nothing`);
        const [body, sig] = ltok.split('.');
        const other = Buffer.from(JSON.stringify({ u: both.id, k: 'live_alerts' })).toString('base64url');
        u = await call(liveSrv.url, 'POST', `/unsubscribe?token=${encodeURIComponent(other + '.' + sig)}`);
        ok(u.s === 400 && die(await s.from('profiles').select('live_alerts').eq('user_id', both.id).single()).live_alerts === true, "the same signature with someone else's id: 400, their setting untouched");
        u = await call(liveSrv.url, 'POST', `/unsubscribe?token=${encodeURIComponent(ltok)}`);
        ok(u.s === 200 && die(await s.from('profiles').select('live_alerts').eq('user_id', alertsOn.id).single()).live_alerts === false && body,
          'POST, no login: live alerts off for that buyer only');
        u = await call(liveSrv.url, 'GET', '/me/live-alerts', alertsOn.tok);
        const u2 = await call(liveSrv.url, 'PUT', '/me/live-alerts', alertsOn.tok, { live_alerts: true });
        const u3 = await call(liveSrv.url, 'PUT', '/me/live-alerts', alertsOn.tok, { live_alerts: 'yes' });
        ok(u.s === 200 && u.j.available === true && u.j.live_alerts === false && u2.s === 200 && u2.j.live_alerts === true && u3.s === 400 && (await call(liveSrv.url, 'GET', '/me/live-alerts')).s === 401,
          'the profile page switch: GET /me/live-alerts reads it, PUT turns it back on, a non-boolean is 400, no login 401');
      }

      console.log('\n== Unsubscribe (no login) ==');
      const token = decodeURIComponent((h.match(/unsubscribe\?token=([^"&]+)/) || [])[1] || '');
      r = await call(U, 'GET', `/unsubscribe?token=${encodeURIComponent(token)}`);
      const stillOn = die(await s.from('notification_prefs').select('*').eq('user_id', b1.id).maybeSingle());
      ok(r.s === 200 && r.j.kind === 'all' && (!stillOn || stillOn.lot_closing), 'GET describes the link and changes nothing (mail scanners open links)');
      const bad = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
      ok((await call(U, 'POST', `/unsubscribe?token=${encodeURIComponent(bad)}`)).s === 400 && (await call(U, 'POST', '/unsubscribe?token=abc')).s === 400, 'a tampered or junk token: 400');
      r = await call(U, 'POST', `/unsubscribe?token=${encodeURIComponent(token)}`);
      const off = die(await s.from('notification_prefs').select('*').eq('user_id', b1.id).single());
      ok(r.s === 200 && !off.lot_closing && !off.auction_open && !off.auction_closing, 'POST: every reminder off for that buyer, no login needed');
      die(await s.from('lot_watches').insert({ user_id: b1.id, item_id: U1.id }).select());
      await call(U, 'POST', `/__test/reminders?now=${encodeURIComponent(at(60 * 21 + 30))}`);
      ok(mails().filter(x => x.to === b1.email).length === 2, 'after unsubscribing: no further reminder (U1 now within the hour)');
    } catch (e) { console.log('ERR', e); fails++; }
  } finally {
    servers.forEach(x => x.stop());
    // Live show alerts reach every approved buyer with them on, so a show's show_live rows may name other test accounts.
    for (const id of made.auctions) await s.from('notifications').delete().eq('kind', 'show_live').contains('payload', { auction_id: id });
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    for (const id of made.users) {
      await s.from('notifications').delete().eq('user_id', id);
      await s.from('notification_prefs').delete().eq('user_id', id);
      await s.from('profiles').delete().eq('user_id', id);
      await s.from('auction_follows').delete().eq('user_id', id);
      await s.from('lot_watches').delete().eq('user_id', id);
      await s.from('users').delete().eq('id', id);
    }
    await s.from('email_send_log').delete().eq('kind', 'reminder').gte('sent_at', new Date(T - 60e3).toISOString());
    try { fs.unlinkSync(MAIL); } catch {}
    const left = (await s.from('auctions').select('id').like('title', P + '%')).data.length
      + (await s.from('users').select('id').like('username', 'zztest_watch_%')).data.length
      + (await s.from('lot_watches').select('user_id').in('user_id', made.users)).data.length
      + (await s.from('notifications').select('id').in('user_id', made.users)).data.length
      + (await s.from('profiles').select('id').in('user_id', made.users)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; });
