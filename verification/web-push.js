// Phone alerts by web push (live phase 6, wtf-handoff LIVE_SHOWS_PHASE5_BRIEF.md §2). Needs migration ze (exits 2
// without it) and openssl (for the fake push service's certificate).
// A FAKE push service: an HTTPS server on this machine (a throwaway self-signed certificate) that records each push
// and DECRYPTS it with the subscription's own keys (RFC 8291 / 8188, made here), so the suite reads the alert as the
// phone would. Paths decide the answer: /ok/... 201, /gone/... 410. The local servers trust it only through
// PUSH_TEST_HOSTS and NODE_TLS_REJECT_UNAUTHORIZED=0, set for them alone; VAPID keys are made here for the run.
// Checked: subscribe / unsubscribe (login, the allowed push hosts only, valid keys, never echoed, one row per
// endpoint); Go live: one push per person per show, to followers and opted-in approved buyers, whatever the overlap,
// none for a pending account, an opted-out non-follower, a rehearsal or a second Go live; the alert's words and link;
// the VAPID header; a 410 deletes that subscription; no keys = no push (and the email still goes); endpoints and keys
// never in any API response; an account's deletion removes its subscriptions.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const webpush = require(BE + '/node_modules/web-push');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io: ioc } = require(path.resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const P = 'ZZTEST_push';
const TAG = crypto.randomBytes(3).toString('hex');
const made = { users: [], auctions: [], reserved: [] };
const MAIL = BE + '/run.tmp-push-mail.log';
const RESEND_STUB = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com')) return realFetch(url, opts);
  const b = JSON.parse(opts.body || '{}');
  require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject }) + '\\n');
  return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
};`;
const TEST_ROUTE = `app.post('/__test/pushes', async (req, res) => res.json(await runPushes()));
const PORT = process.env.PORT || 3001;`;
const mails = () => (fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const call = (url, method, p, tok, body) => fetch(url + p, {
  method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ s: r.status, text: await r.text() })).then(r => ({ ...r, j: (() => { try { return JSON.parse(r.text); } catch { return null; } })() }));

async function mkUser(label, profileStatus, liveAlerts) {
  const id = crypto.randomUUID(), username = `zztest_push_${label}_${TAG}`;
  die(await s.from('users').insert({ id, username, password_hash: 'zztest-not-a-real-hash', email: `${username}@example.invalid` }).select());
  made.users.push(id);
  if (profileStatus) die(await s.from('profiles').insert({ user_id: id, full_name: 'ZZ push', email: `${username}@example.invalid`, phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA',
    zip: '94000', status: profileStatus, ...(liveAlerts === undefined ? {} : { live_alerts: liveAlerts }) }).select());
  return { id, username, email: `${username}@example.invalid`, tok: jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '20m' }) };
}
async function mkShow(label, status, extra = {}) {
  const a = die(await s.from('auctions').insert({ title: `${P} ${label} ${TAG}`, description: 'x', status, mode: 'live', fulfillment_mode: 'shipping', host_username: 'whatthefind',
    starts_at: new Date(Date.now() - 60e3).toISOString(), ...extra }).select().single());
  made.auctions.push(a.id);
  return a.id;
}

// ---- the fake push service
function fakePushService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzpush-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', dir + '/key.pem', '-out', dir + '/cert.pem',
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const got = [];
  const server = https.createServer({ key: fs.readFileSync(dir + '/key.pem'), cert: fs.readFileSync(dir + '/cert.pem') }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url.startsWith('/gone/') ? 410 : 201;
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ got, port: server.address().port, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } })));
}
// A browser's subscription: its own P-256 key pair and auth secret (so this suite can decrypt what it receives).
function browserSub(port, kind) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, authBytes: auth, endpoint: `https://localhost:${port}/${kind}/${crypto.randomBytes(8).toString('hex')}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
// RFC 8291 (Message Encryption for Web Push) over RFC 8188 aes128gcm, the receiving side.
function decrypt(sub, body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const secret = sub.ecdh.computeSecret(asPublic);
  const prkKey = hmac(sub.authBytes, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  return JSON.parse(plain.subarray(0, end).toString('utf8'));   // plain[end] is the 0x02 delimiter
}
const goLive = (url, auctionId) => new Promise(resolve => {
  const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const c = ioc(url, { transports: ['websocket'], forceNew: true });
  const t = setTimeout(() => { c.close(); resolve(null); }, 8000);
  c.on('connect', () => c.emit('join_auction', { auctionId, token: admin }));
  c.on('auction_state', () => c.emit('go_live', { auctionId, token: admin }));
  for (const ev of ['host_ok', 'host_error']) c.on(ev, p => { clearTimeout(t); c.close(); resolve({ event: ev, payload: p }); });
});

(async () => {
  const probe = await s.from('push_subscriptions').select('id').limit(1);
  if (probe.error) { console.log('push_subscriptions is missing on this database: apply migration ze first.'); process.exitCode = 2; return; }
  try { fs.unlinkSync(MAIL); } catch {}
  const servers = [];
  let push;
  try {
    push = await fakePushService();
    const vapid = webpush.generateVAPIDKeys();
    const src = require('./guard').readSource(BE + '/server.js');
    const base = { LIVE_ENABLED: 'true', RESEND_API_KEY: 're_zztest_stub', SITE_URL: 'https://site.zztest', PUSH_TEST_HOSTS: `localhost:${push.port}` };
    const opts = { preload: RESEND_STUB, patch: [['const PORT = process.env.PORT || 3001;', TEST_ROUTE]], log: true };
    const srv = await boot('push-keys', 3551, src, { ...opts, env: { ...base, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    const nokeys = await boot('push-nokeys', 3552, src, { ...opts, env: { ...base, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' } });
    servers.push(srv, nokeys);
    await sleep(2500);
    const U = srv.url;

    console.log('== Keys ==');
    ok((await call(U, 'GET', '/config')).j.push_public_key === vapid.publicKey && (await call(nokeys.url, 'GET', '/config')).j.push_public_key === null,
      '/config: the public key with the keys set; null without (the page then shows no phone-alert button)');

    console.log('\n== Subscribe ==');
    const follower = await mkUser('fol', 'approved', false), opted = await mkUser('opt', 'approved'), both = await mkUser('both', 'approved', true);
    const outsider = await mkUser('out', 'approved', false), pending = await mkUser('pend', 'pending', true);
    const subs = { follower: browserSub(push.port, 'ok'), opted: browserSub(push.port, 'ok'), optedOld: browserSub(push.port, 'gone'), both: browserSub(push.port, 'ok'),
      outsider: browserSub(push.port, 'ok'), pending: browserSub(push.port, 'ok') };
    const sub = (u, x, url = U) => call(url, 'POST', '/push/subscribe', u.tok, { endpoint: x.endpoint, keys: x.keys });
    let r = await call(U, 'POST', '/push/subscribe', null, { endpoint: subs.opted.endpoint, keys: subs.opted.keys });
    ok(r.s === 401, `no login: 401 (${r.s})`);
    for (const [label, endpoint] of [['http://', `http://localhost:${push.port}/ok/x`], ['another site', 'https://example.com/push/x'], ['an internal address', 'https://169.254.169.254/latest'],
      ['not a URL', 'nope'], ['credentials in the URL', `https://a:b@localhost:${push.port}/ok/x`]]) {
      r = await call(U, 'POST', '/push/subscribe', opted.tok, { endpoint, keys: subs.opted.keys });
      ok(r.s === 400 && r.j.code === 'bad_endpoint', `${label}: refused (${r.s} ${r.j && r.j.code}); only the browsers' own push services`);
    }
    r = await call(U, 'POST', '/push/subscribe', opted.tok, { endpoint: subs.opted.endpoint, keys: { p256dh: 'not base64!', auth: '' } });
    ok(r.s === 400 && r.j.code === 'bad_keys', 'bad keys: 400');
    r = await sub(opted, subs.opted, nokeys.url);
    ok(r.s === 503 && r.j.code === 'push_off', 'no keys on the server: 503 push_off');
    for (const [u, x] of [[follower, subs.follower], [opted, subs.opted], [opted, subs.optedOld], [both, subs.both], [outsider, subs.outsider], [pending, subs.pending]]) {
      r = await sub(u, x);
      if (r.s !== 200 || r.text !== '{"subscribed":true}') ok(false, `subscribe ${u.username}: ${r.s} ${r.text}`);
    }
    ok(true, 'subscribe: 200 {"subscribed":true}, nothing echoed (6 subscriptions, one buyer with two devices)');
    r = await sub(opted, subs.opted);
    ok(r.s === 200 && die(await s.from('push_subscriptions').select('id').eq('endpoint', subs.opted.endpoint)).length === 1, 'the same browser again: still one row');
    const moving = browserSub(push.port, 'ok');
    await sub(outsider, moving); await sub(both, moving);
    const mv = die(await s.from('push_subscriptions').select('user_id').eq('endpoint', moving.endpoint));
    ok(mv.length === 1 && mv[0].user_id === both.id, 'a browser subscribed under another account moves to the one now logged in (one endpoint, one row)');
    r = await call(U, 'DELETE', '/push/subscribe', outsider.tok, { endpoint: moving.endpoint });
    ok(r.s === 200 && die(await s.from('push_subscriptions').select('id').eq('endpoint', moving.endpoint)).length === 1, "unsubscribe removes only your own: someone else's endpoint stays");
    r = await call(U, 'DELETE', '/push/subscribe', both.tok, { endpoint: moving.endpoint });
    ok(r.s === 200 && r.text === '{"subscribed":false}' && !die(await s.from('push_subscriptions').select('id').eq('endpoint', moving.endpoint)).length, 'unsubscribe: gone');

    console.log('\n== Go live ==');
    const show = await mkShow('show', 'upcoming');
    const rehearsal = await mkShow('rehearsal', 'draft');
    for (const u of [follower, both]) { r = await call(U, 'POST', `/follow/${show}`, u.tok); if (r.s !== 200) ok(false, `follow ${r.s}`); }
    die(await s.from('auction_follows').insert({ user_id: opted.id, auction_id: rehearsal }).select());
    let g = await goLive(U, show);
    ok(g && g.event === 'host_ok', 'Go live');
    for (let i = 0; i < 40 && push.got.length < 4; i++) await sleep(250);
    await sleep(800);
    const by = x => push.got.filter(p => p.path === new URL(x.endpoint).pathname);
    ok(by(subs.follower).length === 1 && by(subs.both).length === 1 && by(subs.opted).length === 1 && by(subs.optedOld).length === 1,
      'one push per device: the follower (opted out of live alerts, follows), the opted-in buyer (both devices), the follower who is also opted in (once, not twice)');
    ok(by(subs.outsider).length === 0 && by(subs.pending).length === 0, 'none for an opted-out buyer who doesn\'t follow, or a pending account');
    const alert = decrypt(subs.follower, by(subs.follower)[0].body);
    ok(alert.title === `We're live: ${P} show ${TAG}` && alert.url === `/auction/${show}` && alert.body === 'Tap to watch and bid.' && alert.tag === `show-${show}`,
      `the alert, decrypted with the subscription's own keys: "${alert.title}" / "${alert.body}", opens /auction/<show>`);
    const h = by(subs.follower)[0].headers;
    const vapidHdr = /^vapid t=([^,]+), k=(.+)$/.exec(h.authorization || '');
    const claims = vapidHdr ? jwt.decode(vapidHdr[1]) : null;
    ok(vapidHdr && vapidHdr[2] === vapid.publicKey && claims.aud === `https://localhost:${push.port}` && claims.sub === 'mailto:whatthefind.co@gmail.com' && h['content-encoding'] === 'aes128gcm' && Number(h.ttl) === 900 && h.urgency === 'high',
      'VAPID: signed for this push service, our public key, mailto:whatthefind.co@gmail.com; aes128gcm; TTL 15 min; urgency high');
    ok(!die(await s.from('push_subscriptions').select('id').eq('endpoint', subs.optedOld.endpoint)).length && die(await s.from('push_subscriptions').select('last_ok_at').eq('endpoint', subs.opted.endpoint).single()).last_ok_at,
      'the device that answered 410 is deleted; the one that took it has last_ok_at');
    const rows = die(await s.from('notifications').select('user_id, channel, sent_at').eq('kind', 'show_live').contains('payload', { auction_id: show }).in('user_id', made.users));
    const n = (u, ch) => rows.filter(x => x.user_id === u.id && x.channel === ch).length;
    ok([follower, opted, both].every(u => n(u, 'push') === 1 && n(u, 'email') === 1) && n(outsider, 'push') + n(outsider, 'email') + n(pending, 'push') + n(pending, 'email') === 0 && rows.every(x => x.sent_at),
      'the outbox: one push row and one email row each for the three, none for the others, all sent');
    ok([follower, opted, both].every(u => mails().filter(m => m.to === u.email).length === 1), 'the email still goes out too (push and email are channels of one alert)');
    const before = push.got.length;
    const again = await s.rpc('queue_show_live', { p_auction_id: show, p_push: true });
    g = await goLive(U, show);
    await call(U, 'POST', '/__test/pushes');
    ok(again.data.push === 0 && again.data.email === 0 && g.payload.code === 'already_on_air' && push.got.length === before, 'once per show per person: a second queue adds nothing; a second Go live is refused; no second push');
    g = await goLive(U, rehearsal);
    await sleep(1500);
    await call(U, 'POST', '/__test/pushes');
    ok(g.event === 'host_ok' && push.got.length === before && !die(await s.from('notifications').select('id').eq('kind', 'show_live').contains('payload', { auction_id: rehearsal })).length,
      'a rehearsal: no push and no email for anyone');

    console.log('\n== No keys ==');
    const show2 = await mkShow('show nokeys', 'upcoming');
    await call(nokeys.url, 'POST', `/follow/${show2}`, follower.tok);
    g = await goLive(nokeys.url, show2);
    await sleep(3000);
    const rows2 = die(await s.from('notifications').select('channel').eq('kind', 'show_live').contains('payload', { auction_id: show2 }).in('user_id', made.users));
    ok(g.event === 'host_ok' && rows2.length > 0 && rows2.every(x => x.channel === 'email') && push.got.length === before && mails().filter(m => m.to === follower.email).length === 2,
      'a server without the keys: email rows only, no push, and the email goes out');

    console.log('\n== Never in an API answer ==');
    const secretBits = [subs.follower, subs.opted, subs.both].flatMap(x => [new URL(x.endpoint).pathname, x.keys.p256dh, x.keys.auth]).concat([vapid.privateKey]);
    const answers = [];
    for (const [p, t] of [['/config', null], ['/home', null], [`/auction/${show}`, null], [`/auction/${show}/show-state`, null], ['/me/live-alerts', follower.tok], ['/me/notification-prefs', follower.tok],
      ['/me/watching', follower.tok], ['/profile', follower.tok], ['/my-profile', follower.tok]]) answers.push((await call(U, 'GET', p, t)).text);
    ok(answers.every(t => !secretBits.some(b => t.includes(b))), `no endpoint, key or the VAPID private key in ${answers.length} answers`);
    ok(!secretBits.some(b => srv.log().includes(b)), "nor in the server's log");

    console.log('\n== The site (code) ==');
    const FE = path.join(BE, '..', 'wtf-live-frontend');
    const rd = f => fs.readFileSync(path.join(FE, f), 'utf8');
    const pushJs = rd('src/push/push.js'), alerts = rd('src/push/PhoneAlerts.jsx'), sw = rd('public/sw.js'), manifest = JSON.parse(rd('public/site.webmanifest'));
    const srcFiles = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(path.join(d, f.name)); else if (/\.jsx?$/.test(f.name)) srcFiles.push(path.join(d, f.name)); } })(path.join(FE, 'src'));
    const asking = srcFiles.filter(f => /requestPermission\(/.test(fs.readFileSync(f, 'utf8')));
    ok(asking.length === 1 && asking[0].endsWith(path.join('push', 'push.js')) && /export async function turnOn\(\)[\s\S]*requestPermission/.test(pushJs) && /onClick=\{toggle\}/.test(alerts) && !/useEffect\([^)]*turnOn/.test(alerts),
      'permission is asked in one place only, turnOn(), and only from a tap (never on page load)');
    ok(/needsHomeScreen\(\)/.test(alerts) && /Add to Home Screen/.test(alerts) && /if \(!token \|\| !key\) return null/.test(alerts), 'iPhone outside the Home Screen: the how-to; no key on the server or logged out: nothing at all');
    ok(/u\.origin === self\.location\.origin/.test(sw) && !/addEventListener\('fetch'/.test(sw), 'the service worker opens only this site\'s pages and never touches loading (no fetch handler)');
    ok(manifest.display === 'standalone' && manifest.start_url === '/' && manifest.icons.length >= 2, 'the manifest: standalone from the Home Screen (iPhone needs it for phone alerts), start at /, the icons');
    ok(/<PhoneAlerts compact \/>/.test(rd('src/live/LiveViewerRoom.jsx')) && /<LiveAlertsCard \/>/.test(rd('src/pages/ProfileSetup.jsx')), 'the button: on the profile page (with the live alerts switch) and once in the room before the show');

    console.log('\n== Account deletion ==');
    made.reserved.push(crypto.createHash('sha256').update(outsider.username.toLowerCase()).digest('hex'));   // delete_account holds the old name 30 days
    const del = await s.rpc('delete_account', { p_user_id: outsider.id });
    ok(!del.error && !die(await s.from('push_subscriptions').select('id').eq('user_id', outsider.id)).length && die(await s.from('profiles').select('live_alerts').eq('user_id', outsider.id).single()).live_alerts === false,
      `delete_account removes the subscriptions and turns live alerts off (${del.error ? del.error.message : 'ok'})`);
  } catch (e) {
    console.log('ERR', e); fails++;
  } finally {
    servers.forEach(x => x.stop());
    if (push) push.close();
    for (const id of made.auctions) await s.from('notifications').delete().eq('kind', 'show_live').contains('payload', { auction_id: id });
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    for (const id of made.users) {
      await s.from('notifications').delete().eq('user_id', id);
      await s.from('auction_follows').delete().eq('user_id', id);
      await s.from('push_subscriptions').delete().eq('user_id', id);
      await s.from('profiles').delete().eq('user_id', id);
      await s.from('account_deletions').delete().eq('user_id', id);
      await s.from('users').delete().eq('id', id);
    }
    if (made.reserved.length) await s.from('reserved_usernames').delete().in('username_hash', made.reserved);
    await s.from('email_send_log').delete().eq('kind', 'reminder').like('recipient', 'zztest_push_%');
    try { fs.unlinkSync(MAIL); } catch {}
    const left = (await s.from('auctions').select('id').like('title', P + '%')).data.length
      + (await s.from('users').select('id').in('id', made.users)).data.length
      + (await s.from('push_subscriptions').select('id').in('user_id', made.users)).data.length
      + (made.reserved.length ? (await s.from('reserved_usernames').select('username_hash').in('username_hash', made.reserved)).data.length : 0);
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; });
