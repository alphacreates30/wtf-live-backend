// Security review #15: a failed login for an unknown username answered in about half the time of one for a real
// username (bcrypt only ran for real accounts), so response time told an attacker which usernames exist. Now an
// unknown username costs the same bcrypt work (a dummy hash of the same cost).
// OLD is PINNED to 82390f5 (before the fix). Local servers on the test database. Medians of alternating attempts.
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '82390f5', USER = 'zztest_timing_' + Date.now().toString(36), N = 12;
const median = a => { const b = [...a].sort((x, y) => x - y); return (b[(b.length - 1) >> 1] + b[b.length >> 1]) / 2; };
const time = async (url, username) => {
  const t = process.hrtime.bigint();
  const r = await fetch(url + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'wrong-password' }) });
  await r.text();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, s: r.status };
};
async function measure(url) {
  const known = [], unknown = [];
  await time(url, USER); await time(url, USER + '_nobody');   // warm-up
  for (let i = 0; i < N; i++) {
    const a = await time(url, USER), b = await time(url, USER + '_nobody_' + i);
    if (a.s !== 401 || b.s !== 401) throw new Error(`unexpected status ${a.s}/${b.s}`);
    known.push(a.ms); unknown.push(b.ms);
  }
  return { known: median(known), unknown: median(unknown) };
}

(async () => {
  const servers = [];
  let id = null;
  try {
    const u = await s.from('users').insert({ username: USER, password_hash: await bcrypt.hash('the-real-password', 10), email: USER + '@example.invalid' }).select().single();
    if (u.error) throw new Error(JSON.stringify(u.error));
    id = u.data.id;
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('timing-old', 3491, oldSrc), newSrv = await boot('timing-new', 3492, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let m = await measure(oldSrv.url);
    ok(m.known - m.unknown > 25, `OLD: wrong password for a REAL username ${m.known.toFixed(0)}ms vs an UNKNOWN one ${m.unknown.toFixed(0)}ms (gap ${(m.known - m.unknown).toFixed(0)}ms)  <- TELLS WHICH EXIST`);

    console.log('\n== SAME on the FIXED code ==');
    m = await measure(newSrv.url);
    ok(Math.abs(m.known - m.unknown) < 15, `NEW: real ${m.known.toFixed(0)}ms vs unknown ${m.unknown.toFixed(0)}ms (gap ${Math.abs(m.known - m.unknown).toFixed(0)}ms)`);
    const good = await fetch(newSrv.url + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: 'the-real-password' }) });
    ok(good.status === 200, `NEW: the right password still logs in (${good.status})`);
  } finally {
    servers.forEach(x => x.stop());
    if (id) await s.from('users').delete().eq('id', id);
    const left = (await s.from('users').select('id').like('username', 'zztest_timing_%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
