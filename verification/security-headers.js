// Security review #10 (API side): no security headers (x-powered-by: Express, no nosniff / framing / CSP / HSTS) and
// 30-day sessions held in localStorage. Now helmet() on every API response and 7-day sessions. The site's own
// headers (CSP etc.) live in the frontend's vercel.json and are checked on the deployed site.
// OLD is PINNED to 2116b90 (before the fix). Local servers on the test database; Stripe and email blanked.
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '2116b90', PW = 'correct-horse-hdr', USER = 'zztest_headers_' + Date.now().toString(36);
const DAY = 86400;

async function look(url) {
  const r = await fetch(url + '/version', { headers: { Origin: 'https://whatthefind.live' } });
  const h = k => r.headers.get(k);
  const login = await fetch(url + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PW }) }).then(x => x.json());
  const claims = login.token ? jwt.decode(login.token) : null;
  const sockOk = await new Promise(res => {
    const c = io(url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://whatthefind.live' } });
    c.on('connect', () => { c.close(); res(true); }); c.on('connect_error', () => { c.close(); res(false); });
  });
  return { poweredBy: h('x-powered-by'), nosniff: h('x-content-type-options'), frame: h('x-frame-options'), csp: h('content-security-policy'), hsts: h('strict-transport-security'), acao: h('access-control-allow-origin'), ttlDays: claims ? (claims.exp - claims.iat) / DAY : null, sockOk };
}

(async () => {
  const servers = [];
  let userId = null;
  try {
    const u = await s.from('users').insert({ username: USER, password_hash: await bcrypt.hash(PW, 10), email: USER + '@example.invalid' }).select().single();
    if (u.error) throw new Error(JSON.stringify(u.error));
    userId = u.data.id;
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('hdr-old', 3461, oldSrc), newSrv = await boot('hdr-new', 3462, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await look(oldSrv.url);
    ok(r.poweredBy === 'Express' && !r.nosniff && !r.frame && !r.csp && !r.hsts, `OLD: x-powered-by ${r.poweredBy}; nosniff ${r.nosniff}; x-frame-options ${r.frame}; CSP ${r.csp}; HSTS ${r.hsts}  <- NONE`);
    ok(r.ttlDays === 30, `OLD: a login issues a ${r.ttlDays}-day session`);

    console.log('\n== SAME on the FIXED code ==');
    r = await look(newSrv.url);
    ok(!r.poweredBy, 'NEW: no x-powered-by');
    ok(r.nosniff === 'nosniff', `NEW: x-content-type-options ${r.nosniff}`);
    ok(r.frame === 'SAMEORIGIN' || r.frame === 'DENY', `NEW: x-frame-options ${r.frame}`);
    ok(!!r.csp && r.csp.includes("default-src 'self'") && r.csp.includes("frame-ancestors 'self'"), `NEW: content-security-policy set (${(r.csp || '').slice(0, 60)}...)`);
    ok(!!r.hsts && r.hsts.includes('max-age='), `NEW: strict-transport-security ${r.hsts}`);
    ok(r.ttlDays === 7, `NEW: a login issues a ${r.ttlDays}-day session`);
    ok(r.acao === 'https://whatthefind.live' && r.sockOk, 'NEW: the site still gets CORS and its socket still connects with the headers in place');
  } finally {
    servers.forEach(x => x.stop());
    if (userId) await s.from('users').delete().eq('id', userId);
    const left = (await s.from('users').select('id').like('username', 'zztest_headers_%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
