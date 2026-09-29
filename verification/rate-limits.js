// Security review #5: rate limits. There were none - 30 wrong passwords in under 5s with no lockout, and nothing
// slowing registration, reset emails, password checks, bids or chat.
// OLD is PINNED to 7e8e352 (before the fix). Local servers on the test database; Stripe and email blanked.
// The suites' loopback exemption is switched OFF here so the limits are really exercised. Client IPs are simulated
// with X-Forwarded-For, which is exactly how Railway's one trusted proxy hands the server the client address.
const crypto = require('crypto');
require('./guard')(__filename);
delete process.env.RATE_LIMIT_EXEMPT_LOOPBACK;
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '7e8e352', PW = 'correct-horse-rl';
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { users: [], profiles: [], auctions: [] };
const tag = 'zztest_rl_' + Date.now().toString(36);
let ipSeq = 0;
const newIp = () => `203.0.113.${(++ipSeq % 250) + 1}`;   // TEST-NET-3: documentation addresses, never real
const call = (url, method, path, { ip, tok, body } = {}) => fetch(url + path, {
  method, headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const tally = arr => arr.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});

async function fixtures(label) {
  const u = die(await s.from('users').insert({ username: `${tag}_${label}`, password_hash: await bcrypt.hash(PW, 10), email: `${tag}_${label}@example.invalid` }).select().single());
  made.users.push(u.id);
  die(await s.from('profiles').insert({ user_id: String(u.id), full_name: 'ZZTEST rl', email: 'zz@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_rl', stripe_payment_method_id: 'pm_ZZFIXTURE_rl' }).select().single());
  made.profiles.push(String(u.id));
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_rl ' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  made.auctions.push(a.id);
  const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_rl lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  return { u, tok: jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: '10m' }), a: a.id, lot: lot.id };
}

async function scenario(label, url) {
  const f = await fixtures(label), r = {};
  // failed logins from one address, then the right password from that address
  const ipA = newIp(); const la = [];
  for (let i = 0; i < 12; i++) la.push((await call(url, 'POST', '/auth/login', { ip: ipA, body: { username: f.u.username, password: 'wrong' + i } })).s);
  r.loginIp = la; r.loginIpThenCorrect = (await call(url, 'POST', '/auth/login', { ip: ipA, body: { username: f.u.username, password: PW } })).s;
  // failed logins for another account (typed in UPPERCASE: the key ignores case), spread over many addresses (3 each, under the per-address limit)
  const lu = [];
  for (let i = 0; i < 31; i++) lu.push((await call(url, 'POST', '/auth/login', { ip: i % 3 === 0 ? newIp() : `203.0.113.${ipSeq % 250 + 1}`, body: { username: (f.u.username + '_spread').toUpperCase(), password: 'spread' + i } })).s);
  r.loginUser = lu;
  // registrations, reset emails, current-password checks, bids - each from one address or one account
  const ipR = newIp(); r.register = [];
  for (let i = 0; i < 6; i++) {
    const x = await call(url, 'POST', '/auth/register', { ip: ipR, body: { username: `${tag}_${label}_r${i}`, password: PW, email: 'zz@example.invalid' } });
    if (x.s === 200) made.users.push(x.j.user.id);
    r.register.push(x.s);
  }
  const ipF = newIp(); r.forgot = [];
  for (let i = 0; i < 6; i++) r.forgot.push((await call(url, 'POST', '/auth/forgot-password', { ip: ipF, body: { identifier: `${tag}_nobody_${i}` } })).s);
  r.pwCheck = [];
  for (let i = 0; i < 11; i++) r.pwCheck.push((await call(url, 'POST', '/auth/email', { ip: newIp(), tok: f.tok, body: { email: `other${i}@example.invalid`, current_password: 'wrong' } })).s);
  r.bids = [];
  for (let i = 0; i < 31; i++) r.bids.push((await call(url, 'POST', `/auction/${f.a}/items/${f.lot}/bid`, { ip: newIp(), tok: f.tok, body: { max_amount: 0 } })).s);
  // chat over one socket: 8 messages at once
  await new Promise(res => {
    const c = io(url, { transports: ['websocket'], reconnection: false });
    c.on('connect', async () => { for (let i = 0; i < 8; i++) c.emit('send_chat', { auctionId: f.a, text: 'ZZTEST rl chat ' + i, token: f.tok }); await sleep(2500); c.close(); res(); });
    c.on('connect_error', () => res());
  });
  r.chatStored = die(await s.from('chat_messages').select('id').eq('auction_id', f.a)).length;
  return r;
}

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');

    console.log(`== REPRODUCE on ${OLD_COMMIT}: no limits anywhere ==`);
    const oldSrv = await boot('rl-old', 3401, oldSrc); servers.push(oldSrv);
    let r = await scenario('old', oldSrv.url);
    ok(!r.loginIp.includes(429) && r.loginIpThenCorrect === 200, `OLD: 12 wrong passwords from one address ${JSON.stringify(tally(r.loginIp))}, right one straight after: ${r.loginIpThenCorrect}  <- NO LIMIT`);
    ok(!r.loginUser.includes(429), `OLD: 31 wrong passwords for one account from 11 addresses ${JSON.stringify(tally(r.loginUser))}  <- NO LIMIT`);
    ok(!r.register.includes(429) && !r.forgot.includes(429) && !r.pwCheck.includes(429) && !r.bids.includes(429), `OLD: 6 registrations ${JSON.stringify(tally(r.register))}, 6 reset requests ${JSON.stringify(tally(r.forgot))}, 11 password checks ${JSON.stringify(tally(r.pwCheck))}, 31 bids ${JSON.stringify(tally(r.bids))}  <- NO LIMIT`);
    ok(r.chatStored === 8, `OLD: 8 chat messages in one burst, ${r.chatStored} stored  <- NO LIMIT`);
    oldSrv.stop();

    console.log('\n== SAME on the FIXED code ==');
    const newSrv = await boot('rl-new', 3402, newSrc); servers.push(newSrv);
    r = await scenario('new', newSrv.url);
    ok(r.loginIp.slice(0, 10).every(x => x === 401) && r.loginIp.slice(10).every(x => x === 429), `NEW: failed logins from one address: first 10 -> 401, then 429 (${JSON.stringify(tally(r.loginIp))})`);
    ok(r.loginIpThenCorrect === 429, `NEW: that address is paused even with the right password (${r.loginIpThenCorrect}) - 15 minutes`);
    ok(r.loginUser.slice(0, 30).every(x => x === 401) && r.loginUser[30] === 429, `NEW: one account, failures spread over 11 addresses: 30 -> 401, 31st -> ${r.loginUser[30]}`);
    ok(r.register.slice(0, 5).every(x => x === 200) && r.register[5] === 429, `NEW: registrations from one address: 5 allowed, 6th -> ${r.register[5]}`);
    ok(r.forgot.slice(0, 5).every(x => x === 200) && r.forgot[5] === 429, `NEW: reset requests from one address: 5 allowed, 6th -> ${r.forgot[5]}`);
    ok(r.pwCheck.slice(0, 10).every(x => x === 401) && r.pwCheck[10] === 429, `NEW: current-password checks for one account (any address): 10 -> 401, 11th -> ${r.pwCheck[10]}`);
    ok(r.bids.slice(0, 30).every(x => x === 400) && r.bids[30] === 429, `NEW: bids from one account (any address): 30 handled, 31st -> ${r.bids[30]}`);
    ok(r.chatStored === 5, `NEW: 8 chat messages in one burst, ${r.chatStored} stored (5 per 10 seconds per connection)`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('password_resets').delete().in('user_id', made.users);
    await s.from('profiles').delete().in('user_id', made.users.map(String));
    await s.from('users').delete().in('id', made.users);
    const left = (await s.from('users').select('id').like('username', tag + '%')).data.length
      + (await s.from('auctions').select('id').like('title', 'ZZTEST_rl %')).data.length
      + (await s.from('chat_messages').select('id').like('text', 'ZZTEST rl%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
