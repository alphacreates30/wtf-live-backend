// Security review #18: GET /auction/:id/token handed any logged-in account a LiveKit room token for any auction -
// drafts and standard auctions included - with canPublishData for everyone. Now: live-mode auctions only, no
// drafts for non-admins, only the host or an approved buyer, and only the host may publish (video or data).
// OLD is PINNED to 409db0e (before the fix). Local servers on the test database. LiveKit is never contacted: the
// token is signed locally with a throwaway key/secret given to these servers only, and decoded here.
//
// Live phase 2c (wtf-handoff LIVE_SHOWS_PHASE2_BRIEF.md step 2c, audit §4) extends it: who gets which rights.
//   viewers (logged out, or any logged-in account that isn't blocked; phase 5 §0): subscribe only, hidden, a random identity (never the username), ~6 h;
//   the host / admin: publish video, audio and data, identity "host"; the host's second device (?role=controller):
//   subscribe only, hidden, its own identity; only scheduled or on-air shows (ended: 404); a draft only for the admin
//   or a logged-in tester with its rehearsal key; blocked: 403; a per-IP limit on logged-out tokens; the cap of 60
//   logged-out viewers in the room (login_to_watch); and the client side (one LIVEKIT_URL, from the server).
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const K = require('./live-kit')('lktok');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '409db0e';
const LK = { LIVEKIT_API_KEY: 'zztest_key', LIVEKIT_API_SECRET: crypto.randomBytes(24).toString('hex'), LIVEKIT_URL: 'wss://zztest.invalid' };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };
const person = async (label, status) => {
  const u = { id: crypto.randomUUID(), username: 'zztest_lk_' + label };
  made.users.push(u.id);
  if (status) die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZ', email: 'zz@example.invalid', phone: '0', address_line1: '1', city: 'X', state: 'CA', zip: '1', status }).select().single());
  return jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' });
};
const mkAuction = async (label, status, mode) => { const a = die(await s.from('auctions').insert({ title: 'ZZTEST_lk ' + label, description: 'x', status, mode, fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single()); made.auctions.push(a.id); return a.id; };
const token = async (url, id, t) => {
  const r = await fetch(`${url}/auction/${id}/token`, { headers: { Authorization: 'Bearer ' + t } });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, grants: j.token ? jwt.decode(j.token).video : null };
};
// 2c: the whole answer and the decoded token. user: a live-kit user ({ tok }) or null (logged out).
const tokenFor = async (url, id, user, query = '') => {
  const r = await fetch(`${url}/auction/${id}/token${query}`, { headers: user ? { Authorization: 'Bearer ' + user.tok } : {} });
  const j = await r.json().catch(() => ({}));
  const c = j.token ? jwt.decode(j.token) : null;
  return { s: r.status, j, c, g: c ? c.video : null, id: c ? c.sub : null, ttl: c ? c.exp - (c.nbf || c.iat) : null };
};
const watchOnly = t => !!t.g && t.g.roomJoin === true && t.g.canSubscribe === true && t.g.canPublish === false && t.g.canPublishData === false && t.g.hidden === true;

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const pending = await person('pending', 'pending'), approved = await person('approved', 'approved'), none = await person('noprofile', null);
    const host = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const draftLive = await mkAuction('draft live-mode', 'draft', 'live'), standard = await mkAuction('standard', 'live', 'standard'), live = await mkAuction('live-mode', 'live', 'live');
    const oldSrv = await boot('lk-old', 3521, oldSrc, { env: LK }), newSrv = await boot('lk-new', 3522, newSrc, { env: { ...LK, LIVE_ENABLED: 'true' } });   // off = 404 (live-flag.js)
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await token(oldSrv.url, draftLive, pending);
    ok(r.s === 200 && r.grants && r.grants.canPublishData === true, `OLD: a PENDING account gets a token for a DRAFT (${r.s}), canPublishData ${r.grants && r.grants.canPublishData}  <- TOO OPEN`);
    r = await token(oldSrv.url, standard, none);
    ok(r.s === 200, `OLD: an account with no profile gets a token for a standard auction (${r.s})`);

    console.log('\n== SAME on the FIXED code ==');
    ok((await token(newSrv.url, draftLive, pending)).s === 404, 'NEW: draft -> 404 for a buyer');
    ok((await token(newSrv.url, standard, approved)).s === 404, 'NEW: standard auction (no video) -> 404');
    r = await token(newSrv.url, live, pending); const r2 = await token(newSrv.url, live, none);
    ok([r, r2].every(x => x.s === 200 && x.grants.canSubscribe && !x.grants.canPublish && !x.grants.canPublishData), 'NEW: live-mode auction, pending / no profile -> 200, watch only (phase 5 §0: they watch like guests; bidding still needs approval)');
    r = await token(newSrv.url, live, approved);
    ok(r.s === 200 && r.grants.roomJoin && r.grants.canSubscribe && !r.grants.canPublish && !r.grants.canPublishData, `NEW: approved buyer -> 200, watch only (canPublish ${r.grants && r.grants.canPublish}, canPublishData ${r.grants && r.grants.canPublishData})`);
    r = await token(newSrv.url, live, host);
    ok(r.s === 200 && r.grants.canPublish && r.grants.canPublishData, 'NEW: the host still publishes video and data');
    ok((await token(newSrv.url, draftLive, host)).s === 200, 'NEW: the admin can still open a draft\'s room');

    // ---------------------------------------------------------------- phase 2c
    console.log('\n== 2c: who gets which rights ==');
    const buyer = await K.mkUser('buyer'), seller = await K.mkUser('seller'), blocked = await K.mkUser('blocked', { status: 'blocked' });
    const key = crypto.randomBytes(16).toString('hex');
    const sched = await K.mkShow('sched', { status: 'upcoming', fields: { starts_at: new Date(Date.now() + 36e5).toISOString() } });
    const onair = await K.mkShow('onair', { status: 'live', fields: { on_air_at: new Date().toISOString(), host_username: seller.username } });
    const ended = await K.mkShow('ended', { status: 'ended', fields: { on_air_at: new Date(Date.now() - 36e5).toISOString(), ended_at: new Date().toISOString() } });
    const endedAt = await K.mkShow('endedat', { status: 'live', fields: { on_air_at: new Date(Date.now() - 36e5).toISOString(), ended_at: new Date().toISOString() } });
    const draft = await K.mkShow('draft', { status: 'draft', fields: { rehearsal_key: key } });

    let t = await tokenFor(newSrv.url, sched.id, null);
    ok(t.s === 200 && watchOnly(t) && /^v-[A-Za-z0-9_-]{8,}$/.test(t.id) && t.j.role === 'viewer' && t.j.isHost === false,
      `logged out, a scheduled show: 200, subscribe only, hidden, random identity (${t.id}), role viewer`);
    ok(Math.abs(t.ttl - 6 * 3600) <= 60, `the token lasts about 6 hours (${t.ttl} s)`);
    ok(t.j.url === LK.LIVEKIT_URL && t.g.room === 'auction-' + sched.id, 'the server says which LiveKit to use (its LIVEKIT_URL) and the room');
    const t2 = await tokenFor(newSrv.url, sched.id, null);
    ok(t2.s === 200 && t2.id !== t.id, 'two logged-out viewers get different identities');
    t = await tokenFor(newSrv.url, onair.id, buyer);
    ok(t.s === 200 && watchOnly(t) && /^v-/.test(t.id) && !t.id.includes(buyer.username) && !JSON.stringify(t.j).includes(buyer.username) && !JSON.stringify(t.c).includes(buyer.username),
      `an approved buyer, on air: the same (identity ${t.id}; the username is nowhere in the answer or the token)`);
    t = await tokenFor(newSrv.url, onair.id, seller);
    ok(t.s === 200 && t.g.canPublish === true && t.g.canPublishData === true && !t.g.hidden && t.id === 'host' && t.j.role === 'host' && t.j.isHost === true,
      'the show\'s host: publishes video, sound and data, identity "host", not hidden');
    t = await tokenFor(newSrv.url, onair.id, K.ADMIN);
    ok(t.s === 200 && t.g.canPublish === true && t.id === 'host', 'the admin: the same as the host');
    t = await tokenFor(newSrv.url, onair.id, seller, '?role=controller');
    ok(t.s === 200 && watchOnly(t) && /^ctl-/.test(t.id) && t.j.role === 'controller' && t.j.isHost === false,
      `the host's second device (?role=controller): subscribe only, hidden, its own identity (${t.id}), so the phone isn't pushed off`);
    t = await tokenFor(newSrv.url, onair.id, buyer, '?role=controller');
    ok(t.s === 200 && watchOnly(t) && t.j.role === 'viewer', 'a buyer asking for ?role=controller is just a viewer');

    console.log('\n== 2c: which shows ==');
    for (const [label, sh] of [['status ended', ended], ['ended_at set', endedAt]]) {
      const res = await Promise.all([tokenFor(newSrv.url, sh.id, null), tokenFor(newSrv.url, sh.id, buyer), tokenFor(newSrv.url, sh.id, K.ADMIN)]);
      ok(res.every(x => x.s === 404), `an ended show (${label}): 404 for a viewer, a buyer and the admin (${res.map(x => x.s)})`);
    }
    const dr = {
      anon: await tokenFor(newSrv.url, draft.id, null), anonKey: await tokenFor(newSrv.url, draft.id, null, '?rehearsal=' + key),
      noKey: await tokenFor(newSrv.url, draft.id, buyer), wrong: await tokenFor(newSrv.url, draft.id, buyer, '?rehearsal=' + key.replace(/.$/, c => (c === '0' ? '1' : '0'))),
      withKey: await tokenFor(newSrv.url, draft.id, buyer, '?rehearsal=' + key), admin: await tokenFor(newSrv.url, draft.id, K.ADMIN),
    };
    ok(dr.anon.s === 404 && dr.anonKey.s === 404 && dr.noKey.s === 404 && dr.wrong.s === 404,
      `a draft: 404 logged out (with or without the key), and for a buyer without the key or with a wrong one (${[dr.anon.s, dr.anonKey.s, dr.noKey.s, dr.wrong.s]})`);
    ok(dr.withKey.s === 200 && watchOnly(dr.withKey), 'a draft\'s rehearsal: a logged-in tester with the key watches (subscribe only)');
    ok(dr.admin.s === 200 && dr.admin.g.canPublish === true, 'a draft: the admin (the host\'s phone in the rehearsal) publishes');
    t = await tokenFor(newSrv.url, onair.id, blocked);
    ok(t.s === 403 && t.j.code === 'blocked' && !t.j.token, `a blocked account: 403 blocked, no token (${t.s} ${t.j.code})`);

    console.log('\n== Phase 5 §0: accounts without an approved profile watch like guests ==');
    const pendU = await K.mkUser('pending', { status: 'pending', card: false }), noProf = await K.mkUser('noprof', { profile: false }), rejU = await K.mkUser('rejected', { status: 'rejected', card: false });
    for (const [label, u] of [['pending', pendU], ['no profile', noProf], ['rejected', rejU]]) {
      t = await tokenFor(newSrv.url, onair.id, u);
      ok(t.s === 200 && watchOnly(t) && /^v-/.test(t.id) && t.j.role === 'viewer' && !JSON.stringify(t.j).includes(u.username) && !JSON.stringify(t.c).includes(u.username),
        `${label}: 200, the guest token (subscribe only, hidden, random identity ${t.id}, no username)`);
    }
    t = await tokenFor(newSrv.url, sched.id, pendU);
    ok(t.s === 200 && watchOnly(t), 'pending, a scheduled show: the same');
    const pendSock = await K.client(newSrv.url, onair.id, pendU).catch(e => ({ err: e.message }));
    const wo = pendSock.err ? null : await pendSock.waitFor('watch_only', () => true, 2000);
    ok(!pendSock.err && wo && wo.payload.code === 'pending' && /approv/i.test(wo.payload.message), `pending: joins the live room and is told watch_only (${pendSock.err || JSON.stringify(wo && wo.payload)})`);
    const npSock = await K.client(newSrv.url, onair.id, noProf).catch(e => ({ err: e.message }));
    const wo2 = npSock.err ? null : await npSock.waitFor('watch_only', () => true, 2000);
    ok(!npSock.err && wo2 && wo2.payload.code === 'no_profile' && wo2.payload.message === 'Finish your profile to bid.', `no profile: joins and is told "Finish your profile to bid." (${npSock.err || JSON.stringify(wo2 && wo2.payload)})`);
    const buyerSock = await K.client(newSrv.url, onair.id, buyer);
    await K.sleep(300);
    ok(!buyerSock.events.some(e => e.event === 'watch_only'), 'an approved buyer gets no watch_only');
    if (!pendSock.err) {
      const b = await K.ask(pendSock, 'place_bid', { max_amount: 5 }, ['bid_ok', 'bid_error']);
      ok(b && b.event === 'bid_error' && b.payload.code === 'not_approved', `pending: a bid is still refused (${b && b.event} ${b && b.payload.code})`);
      const c = await K.ask(pendSock, 'send_chat', { text: 'hello' }, ['chat_error', 'new_chat']);
      ok(c && c.event === 'chat_error' && /approved/.test(c.payload.message), `pending: chat is still refused (${c && c.event})`);
    }
    if (!npSock.err) {
      const b = await K.ask(npSock, 'place_bid', { max_amount: 5 }, ['bid_ok', 'bid_error']);
      ok(b && b.event === 'bid_error' && b.payload.code === 'no_profile', `no profile: a bid is still refused (${b && b.event} ${b && b.payload.code})`);
    }
    const blockedSock = await K.client(newSrv.url, onair.id, blocked).then(c => { c.close(); return null; }, e => e.message);
    ok(/"blocked"/.test(blockedSock || ''), 'blocked: still refused at the door (auction_error blocked)');
    const timedId = await mkAuction('timed for pending', 'live', 'standard');
    const timedSock = await K.client(newSrv.url, timedId, pendU).then(c => { c.close(); return null; }, e => e.message);
    ok(/"pending"/.test(timedSock || ''), 'a timed auction: unchanged (a pending account is still told it is pending)');
    for (const c of [pendSock, npSock, buyerSock]) c.close?.();
    ok((await tokenFor(newSrv.url, standard, null)).s === 404, 'logged out, a timed auction: 404 (no video)');

    console.log('\n== 2c: the per-IP limit on logged-out tokens ==');
    const limited = await boot('lk-limit', 3523, newSrc, { env: { ...LK, LIVE_ENABLED: 'true', RATE_LIMIT_EXEMPT_LOOPBACK: '' } });
    servers.push(limited);
    const anonRuns = [];
    for (let i = 0; i < 21; i++) anonRuns.push((await tokenFor(limited.url, onair.id, null)).s);
    ok(anonRuns.slice(0, 20).every(x => x === 200) && anonRuns[20] === 429, `20 logged-out tokens in 10 minutes from one address, then 429 (${anonRuns.slice(18).join(', ')})`);
    const inRuns = [];
    for (let i = 0; i < 5; i++) inRuns.push((await tokenFor(limited.url, onair.id, buyer)).s);
    ok(inRuns.every(x => x === 200), `a logged-in buyer from the same address isn't held by it (${inRuns})`);

    console.log('\n== 2c: the cap of 60 logged-out viewers (counted in the room) ==');
    ok(/const LIVE_ANON_CAP = 60;/.test(newSrc), 'the cap is 60 in the server');
    const capped = await boot('lk-cap', 3524, newSrc, { env: { ...LK, LIVE_ENABLED: 'true' }, patch: [['const LIVE_ANON_CAP = 60;', 'const LIVE_ANON_CAP = 3;']] });
    servers.push(capped);
    const guests = [];
    for (let i = 0; i < 3; i++) guests.push(await K.client(capped.url, onair.id));
    ok(guests.length === 3, 'with the cap at 3 for the test: 3 logged-out viewers join');
    let refused = null;
    try { (await K.client(capped.url, onair.id)).close(); } catch (e) { refused = e.message; }
    ok(/login_to_watch/.test(refused || ''), `the 4th logged-out viewer is asked to log in: login_to_watch (${refused && refused.slice(0, 80)})`);
    const inBuyer = await K.client(capped.url, onair.id, buyer).catch(e => ({ err: e.message }));
    ok(!inBuyer.err, 'a logged-in buyer still gets in');
    const hostSock = await K.client(capped.url, onair.id, seller).catch(e => ({ err: e.message }));
    ok(!hostSock.err, 'the host still gets in');
    const pendIn = await K.client(capped.url, onair.id, pendU).catch(e => ({ err: e.message }));
    ok(!pendIn.err, 'a pending account still gets in (logged in: not a guest)');
    let refused2 = null;
    try { (await K.client(capped.url, onair.id)).close(); } catch (e) { refused2 = e.message; }
    ok(/login_to_watch/.test(refused2 || ''), 'and it is not counted toward the cap: a 4th guest is still the one asked to log in');
    const again = await K.ask(guests[0], 'join_auction', {}, ['auction_state', 'auction_error']);
    ok(again && again.event === 'auction_state', 'a guest already in the room who joins again (a reconnect) is not turned away');
    let otherShow = await K.client(capped.url, sched.id).catch(e => ({ err: e.message }));
    ok(!otherShow.err, 'the cap is per show: a guest still gets into another show');
    guests[0].close();
    await K.sleep(500);
    const late = await K.client(capped.url, onair.id).catch(e => ({ err: e.message }));
    ok(!late.err, 'when a guest leaves, the next one gets in');
    for (const c of [...guests.slice(1), inBuyer, hostSock, pendIn, otherShow, late]) c.close?.();

    console.log('\n== 2c: the client ==');
    const FE = require('path').resolve(BE, '..', 'wtf-live-frontend');
    const lv = fs.readFileSync(FE + '/src/live/LiveVideo.jsx', 'utf8'), api = fs.readFileSync(FE + '/src/api.js', 'utf8');
    const srcFiles = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(d + '/' + f.name); else if (/\.(jsx?|mjs)$/.test(f.name)) srcFiles.push(d + '/' + f.name); } })(FE + '/src');
    const rootFiles = fs.readdirSync(FE).filter(f => /\.(jsx?|mjs)$/.test(f)).map(f => FE + '/' + f);
    ok(![...srcFiles, ...rootFiles].some(f => fs.readFileSync(f, 'utf8').includes('VITE_LIVEKIT_URL')), 'one setting: no VITE_LIVEKIT_URL anywhere in the frontend; LiveVideo connects to the url the server gives');
    ok(/room\.connect\(t\.url, t\.token/.test(lv), 'LiveVideo connects with the server\'s url and token');
    ok(/q\.set\('role', role\)/.test(api) && /role === 'controller' \? 'controller'/.test(lv), 'the controller asks for ?role=controller');
    ok(/simulcast: true/.test(lv) && /restartTrack\(\{ facingMode/.test(lv), 'simulcast on; Flip uses restartTrack (no republish)');
    const ons = [...lv.matchAll(/room\.on\((RoomEvent\.\w+), (\w+)\)/g)].map(m => m[1] + ',' + m[2]);
    const offs = new Set([...lv.matchAll(/room\.off\((RoomEvent\.\w+), (\w+)\)/g)].map(m => m[1] + ',' + m[2]));
    ok(ons.length >= 6 && ons.every(x => offs.has(x)), `every room handler is named and removed on unmount (${ons.length})`);
    ok(['Reconnecting', 'Reconnected', 'Disconnected', 'AudioPlaybackStatusChanged'].every(e => lv.includes('RoomEvent.' + e)) && /startAudio\(\)/.test(lv) && lv.includes('Tap for sound'),
      'reconnecting / disconnected notes with Reconnect, and "Tap for sound" (room.startAudio) when the browser holds the sound back');
    ok(lv.includes('Back in a moment') && /onAir && status\.phase === 'connected' && !status\.hostVideo/.test(lv), 'the "Back in a moment" slate while on air and the host\'s picture is gone');
    ok(/const listen = role === 'viewer'/.test(lv) && /Audio && listen\) (pub\.)?track\.attach/.test(lv), 'only viewers play the sound (the controller sits next to the phone: no echo)');
    const viewer = fs.readFileSync(FE + '/src/live/LiveViewerRoom.jsx', 'utf8'), hostRoom = fs.readFileSync(FE + '/src/live/LiveHostRoom.jsx', 'utf8');
    ok(/<LiveVideo [^>]*onAir=\{/.test(viewer) && /<LiveVideo [^>]*role=\{controller \? 'controller' : 'host'\}/.test(hostRoom) && /ref=\{controller \? undefined : cam\}/.test(hostRoom), 'the viewer room, the host\'s phone and the controller each mount LiveVideo with their role');
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('profiles').delete().in('user_id', made.users);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_lk %')).data.length + (await s.from('profiles').select('id').in('user_id', made.users)).data.length;
    console.log('\nleftover throwaway rows (phase 1 part):', left);
    if (left) fails++;
    await K.cleanup();
    fails += K.state.fails;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
