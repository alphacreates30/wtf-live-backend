// Account email + forgotten-password reset + password changes signing out
// existing sessions + 8-character minimum (migration 2026-09-26m). Needs that
// migration applied. Emails are NOT sent: the variant's sendEmail() writes each
// message to a local file instead, which is how this suite reads the links.
// Throwaway accounts are named zztest_pw_* and deleted afterwards.
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const src = require('./guard').readSource(BE + '/server.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = jwt.sign({ id: 'x', username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const PORT = 4621;
const MAIL = BE + '/mail.tmp-pwreset.log';
const tag = crypto.randomBytes(3).toString('hex');
const uname = n => `zztest_pw_${tag}_${n}`;
const shared = `zztest-${tag}@example.invalid`;

const SEND_SIG = "async function sendEmail({ from, to, subject, html, text, kind = 'other' }) {";
const files = [MAIL];
const children = [];
async function start(port = PORT) {
  if (!src.includes(SEND_SIG)) throw new Error('sendEmail signature marker not found');
  const out = src.replace(SEND_SIG, SEND_SIG + "\n  require('fs').appendFileSync(" + JSON.stringify(MAIL) + ", JSON.stringify({ to, subject, text, kind }) + '\\n'); return;");
  const file = BE + '/server.tmp-pwreset.js', runner = BE + '/run.tmp-pwreset-' + port + '.js';
  fs.writeFileSync(file, out);
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; require('./server.tmp-pwreset.js');");
  files.push(file, runner);
  children.push(spawn(process.execPath, [runner], { cwd: BE, stdio: 'ignore' }));
  await sleep(5000);
}
const call = (path, { method = 'POST', body, tok, port = PORT } = {}) =>
  fetch('http://localhost:' + port + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body && JSON.stringify(body) })
    .then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));
const mails = () => fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const clearMail = () => { try { fs.unlinkSync(MAIL); } catch {} };
const linkToken = m => /reset-password\?token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1];
const login = (u, p) => call('/auth/login', { body: { username: u, password: p } });
async function mkUser(n, email, password = 'oldpass1') {
  const { data, error } = await s.from('users').insert({ username: uname(n), password_hash: await bcrypt.hash(password, 10), email }).select('id, username').single();
  if (error) throw new Error('user insert: ' + JSON.stringify(error));
  return data;
}

(async () => {
  const probe = await s.from('password_resets').select('id').limit(1);
  if (probe.error) { console.error('password_resets missing (' + probe.error.code + ') - apply migration 2026-09-26m first.'); fails++; return; }
  await start();

  // --- registration requires an email ---
  const noEmail = await call('/auth/register', { body: { username: uname('r0'), password: 'secret12' } });
  const badEmail = await call('/auth/register', { body: { username: uname('r0'), password: 'secret12', email: 'not-an-email' } });
  ok(noEmail.s === 400 && badEmail.s === 400, `register without / with a bad email is refused (${noEmail.s}, ${badEmail.s})`);
  const seven = await call('/auth/register', { body: { username: uname('r0'), password: 'secret1', email: `r0-${tag}@example.invalid` } });
  ok(seven.s === 400 && /at least 8/.test(seven.j.error), 'register with a 7-character password is refused (min 8)');
  const reg = await call('/auth/register', { body: { username: uname('r1'), password: 'secret12', email: '  Buyer.' + tag + '@Example.INVALID ' } });
  ok(reg.s === 200 && reg.j.user.email === `buyer.${tag}@example.invalid` && !('password_changed_at' in reg.j.user), 'register with email: stored trimmed + lowercased');
  ok(typeof jwt.decode(reg.j.token).pca === 'number', 'a new token carries the account\'s password_changed_at (pca)');
  const li = await login(uname('r1'), 'secret12');
  ok(li.s === 200 && li.j.user.email === `buyer.${tag}@example.invalid` && !('password_hash' in li.j.user), 'login returns the email, never the hash');
  const shortOld = await mkUser('short', `short-${tag}@example.invalid`, 'six666');
  ok((await login(uname('short'), 'six666')).s === 200, 'an existing 6-character password still logs in');

  // --- accounts without an email: /auth/me + /auth/email ---
  const legacy = await mkUser('legacy', null);
  const legacyTok = jwt.sign({ id: legacy.id, username: legacy.username }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const me0 = await call('/auth/me', { method: 'GET', tok: legacyTok });
  ok(me0.s === 200 && me0.j.email === null, 'legacy account: /auth/me reports no email (the gate shows)');
  const set1 = await call('/auth/email', { body: { email: `legacy-${tag}@example.invalid` }, tok: legacyTok });
  ok(set1.s === 200, 'legacy account can add an email without a password');
  const change = await call('/auth/email', { body: { email: `other-${tag}@example.invalid` }, tok: legacyTok });
  ok(change.s === 401, 'changing an existing email without the password is refused');
  const change2 = await call('/auth/email', { body: { email: `other-${tag}@example.invalid`, current_password: 'oldpass1' }, tok: legacyTok });
  ok(change2.s === 200, 'changing it with the current password works');

  // --- forgot password: same answer whether or not the account exists ---
  const a = await mkUser('a', shared);
  const b = await mkUser('b', shared);           // two accounts, one address
  clearMail();
  const known = await call('/auth/forgot-password', { body: { identifier: uname('a') } });
  const unknown = await call('/auth/forgot-password', { body: { identifier: uname('nobody') } });
  await sleep(2500);
  ok(known.s === 200 && unknown.s === 200 && JSON.stringify(known.j) === JSON.stringify(unknown.j), 'known and unknown usernames get the identical answer');
  let m = mails();
  ok(m.length === 1 && m[0].to === shared && m[0].text.includes(uname('a')) && m[0].kind === 'password_reset', `by username: one email, to the account's address, naming the username (${m.length})`);
  const tokA1 = linkToken(m[0]);
  ok(!!tokA1 && /^https:\/\/whatthefind\.live\/reset-password\?token=/.test(/https:\S+/.exec(m[0].text)[0]), 'link points at whatthefind.live/reset-password');
  const stored = await s.from('password_resets').select('token_hash').eq('user_id', a.id);
  ok(stored.data.every(r => r.token_hash !== tokA1 && r.token_hash.length === 64), 'only a SHA-256 of the token is stored');

  clearMail();
  await call('/auth/forgot-password', { body: { identifier: shared.toUpperCase() } });
  await sleep(2500);
  m = mails();
  ok(m.length === 2 && m.some(x => x.text.includes(uname('a'))) && m.some(x => x.text.includes(uname('b'))), `by shared email: one link per account (${m.length})`);
  const tokA2 = linkToken(m.find(x => x.text.includes(uname('a'))));

  // --- reset ---
  // Sessions open before the reset: one issued by login, and one with no pca
  // claim at all (as tokens issued before this feature look).
  const preLogin = (await login(uname('a'), 'oldpass1')).j.token;
  const preLegacy = jwt.sign({ id: a.id, username: a.username }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const preMe = await call('/auth/me', { method: 'GET', tok: preLogin });
  const preMeLegacy = await call('/auth/me', { method: 'GET', tok: preLegacy });
  ok(preMe.s === 200 && preMeLegacy.s === 200, 'before the reset both sessions work (account has no recorded change yet)');
  const short = await call('/auth/reset-password', { body: { token: tokA1, new_password: 'seven77' } });
  ok(short.s === 400 && /at least 8/.test(short.j.error), 'reset to a 7-character password refused (link not consumed)');
  const [r1, r2] = await Promise.all([
    call('/auth/reset-password', { body: { token: tokA1, new_password: 'newpass1' } }),
    call('/auth/reset-password', { body: { token: tokA1, new_password: 'hijack99' } }),
  ]);
  ok([r1.s, r2.s].sort().join() === '200,400', `same link submitted twice at once: exactly one succeeds (${r1.s}, ${r2.s})`);
  const winner = r1.s === 200 ? 'newpass1' : 'hijack99';
  const post = await login(uname('a'), winner);
  ok(post.s === 200 && (await login(uname('a'), 'oldpass1')).s === 401, 'new password works, old one no longer does');
  const afterMe = await call('/auth/me', { method: 'GET', tok: preLogin });
  const afterLegacy = await call('/auth/me', { method: 'GET', tok: preLegacy });
  ok(afterMe.s === 401 && afterMe.j?.code === 'session_revoked', `token issued before the reset is rejected after it (${afterMe.s} ${afterMe.j?.code})`);
  ok(afterLegacy.s === 401 && afterLegacy.j?.code === 'session_revoked', 'token with no pca claim is rejected after the reset');
  ok((await call('/auth/me', { method: 'GET', tok: post.j.token })).s === 200, 'a session started after the reset works');
  // A second instance started now has an empty cache, so it decides from the
  // database - what any other Railway instance sees once its 60s entry lapses.
  await start(PORT + 1);
  const fresh = await call('/auth/me', { method: 'GET', tok: preLogin, port: PORT + 1 });
  const freshNew = await call('/auth/me', { method: 'GET', tok: post.j.token, port: PORT + 1 });
  ok(fresh.s === 401 && freshNew.s === 200, `another instance, deciding from the database, agrees (${fresh.s}, ${freshNew.s})`);
  const reuse = await call('/auth/reset-password', { body: { token: tokA1, new_password: 'again123' } });
  ok(reuse.s === 400 && /expired or was already used/.test(reuse.j.error), 'used link refused');
  const sibling = await call('/auth/reset-password', { body: { token: tokA2, new_password: 'again123' } });
  ok(sibling.s === 400, "the account's other outstanding link was retired by the reset");
  ok((await login(uname('b'), 'oldpass1')).s === 200, 'the other account on the shared address is untouched');

  const expiredTok = crypto.randomBytes(32).toString('base64url');
  await s.from('password_resets').insert({ user_id: b.id, token_hash: crypto.createHash('sha256').update(expiredTok).digest('hex'), expires_at: new Date(Date.now() - 1000).toISOString() });
  const exp = await call('/auth/reset-password', { body: { token: expiredTok, new_password: 'expired1' } });
  ok(exp.s === 400, 'expired link refused');
  const junk = await call('/auth/reset-password', { body: { token: 'made-up', new_password: 'whatever1' } });
  ok(junk.s === 400, 'made-up token refused');

  // --- rate limit: 3 links per account per hour (b already has 1 real + 1 expired row) ---
  clearMail();
  // All at once: count-then-insert let 4 of 4 through this way (the first run of this suite caught it).
  await Promise.all([0, 1, 2, 3].map(() => call('/auth/forgot-password', { body: { identifier: uname('b') } })));
  await sleep(4000);
  const bRows = await s.from('password_resets').select('id').eq('user_id', b.id).gte('created_at', new Date(Date.now() - 36e5).toISOString());
  ok(bRows.data.length === 3 && mails().length === 1, `rate limited at 3 per hour (rows ${bRows.data.length}, new emails ${mails().length})`);

  // --- host fallback ---
  const c = await mkUser('c', `c-${tag}@example.invalid`);
  const notAdmin = await call(`/admin/users/${c.id}/password`, { body: { new_password: 'temp1234' }, tok: legacyTok });
  ok(notAdmin.s === 403, 'non-admin cannot set passwords');
  const cBefore = (await login(uname('c'), 'oldpass1')).j.token;
  const tempShort = await call(`/admin/users/${c.id}/password`, { body: { new_password: 'temp123' }, tok: admin });
  ok(tempShort.s === 400, 'temporary password under 8 characters refused');
  const temp = await call(`/admin/users/${c.id}/password`, { body: { new_password: 'temp1234' }, tok: admin });
  ok(temp.s === 200 && (await login(uname('c'), 'temp1234')).s === 200, 'host sets a temporary password; buyer can log in with it');
  const cAfter = await call('/auth/me', { method: 'GET', tok: cBefore });
  ok(cAfter.s === 401 && cAfter.j?.code === 'session_revoked', "host temporary password signs out the buyer's existing sessions");
  const missing = await call(`/admin/users/${crypto.randomUUID()}/password`, { body: { new_password: 'temp1234' }, tok: admin });
  ok(missing.s === 404, 'unknown account: 404');

  // --- profile: email required; fills a missing account email ---
  const d = await mkUser('d', null);
  const dTok = jwt.sign({ id: d.id, username: d.username }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const base = { full_name: 'ZZTEST pw', phone: '5555550100', address_line1: '1 Test St', city: 'X', state: 'NY', zip: '10001' };
  const p0 = await call('/profile', { body: base, tok: dTok });
  ok(p0.s === 400, 'profile without an email is refused');
  const p1 = await call('/profile', { body: { ...base, email: `d-${tag}@example.invalid` }, tok: dTok });
  const dAfter = await s.from('users').select('email').eq('id', d.id).single();
  ok(p1.s === 200 && dAfter.data.email === `d-${tag}@example.invalid`, 'saving a profile gives an email-less account its email');
})().catch(e => { console.error(e); fails++; }).finally(async () => {
  for (const c of children) c.kill();
  const { data: us } = await s.from('users').select('id').like('username', `zztest_pw_${tag}_%`);
  const ids = (us || []).map(u => u.id);
  if (ids.length) {
    await s.from('profiles').delete().in('user_id', ids);
    await s.from('password_resets').delete().in('user_id', ids);
    const d = await s.from('users').delete().in('id', ids);
    console.log(d.error ? '  CLEANUP FAILED: ' + d.error.message : `  cleaned up ${ids.length} zztest_pw accounts`);
  }
  for (const f of files) try { fs.unlinkSync(f); } catch {}
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
});
