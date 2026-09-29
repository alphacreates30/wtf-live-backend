// Security review #11: CORS was '*' on Express and Socket.io. Now only whatthefind.live (and www) - plus the local
// Vite dev server when not running on Railway, plus CORS_EXTRA_ORIGINS - and requests with no Origin are unaffected.
// Socket.io also checks the Origin on the handshake itself (browsers don't apply CORS to WebSocket upgrades).
// OLD is PINNED to f72be77 (before the fix). Local servers on the test database; Stripe and email blanked.
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'f72be77';
const SITE = 'https://whatthefind.live', EVIL = 'https://evil.example', DEV = 'http://localhost:5173';

const acao = async (url, origin, method = 'GET') => {
  const r = await fetch(url + '/version', { method, headers: { ...(origin ? { Origin: origin } : {}), ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'POST' } : {}) } });
  return r.headers.get('access-control-allow-origin');
};
const sock = (url, origin) => new Promise(res => {
  const c = io(url, { transports: ['websocket'], reconnection: false, ...(origin ? { extraHeaders: { Origin: origin } } : {}) });
  const t = setTimeout(() => { c.close(); res('timeout'); }, 5000);
  c.on('connect', () => { clearTimeout(t); c.close(); res('connected'); });
  c.on('connect_error', () => { clearTimeout(t); c.close(); res('refused'); });
});

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    const oldSrv = await boot('cors-old', 3451, oldSrc); servers.push(oldSrv);
    ok(await acao(oldSrv.url, EVIL) === '*', `OLD: any site gets Access-Control-Allow-Origin: ${await acao(oldSrv.url, EVIL)}  <- OPEN`);
    ok(await sock(oldSrv.url, EVIL) === 'connected', 'OLD: a socket from any site connects');

    console.log('\n== FIXED code (local: the Vite dev origin is allowed) ==');
    const newSrv = await boot('cors-new', 3452, newSrc); servers.push(newSrv);
    ok(await acao(newSrv.url, EVIL) === null, 'NEW: another site gets no Access-Control-Allow-Origin');
    ok(await acao(newSrv.url, EVIL, 'OPTIONS') === null, 'NEW: its preflight gets none either');
    ok(await acao(newSrv.url, SITE) === SITE && await acao(newSrv.url, SITE, 'OPTIONS') === SITE, `NEW: ${SITE} is allowed (GET and preflight)`);
    ok(await acao(newSrv.url, 'https://www.whatthefind.live') === 'https://www.whatthefind.live', 'NEW: www.whatthefind.live is allowed');
    ok(await acao(newSrv.url, DEV) === DEV, `NEW: ${DEV} is allowed off Railway (local development)`);
    ok(await sock(newSrv.url, EVIL) === 'refused', 'NEW: a socket from another site is refused at the handshake');
    ok(await sock(newSrv.url, SITE) === 'connected', 'NEW: a socket from the site connects');
    ok(await sock(newSrv.url, null) === 'connected', 'NEW: a socket with no Origin (not a browser) connects');
    newSrv.stop();

    console.log('\n== FIXED code as on Railway ==');
    process.env.RAILWAY_ENVIRONMENT_NAME = 'zztest';
    process.env.CORS_EXTRA_ORIGINS = 'https://zztest-preview.example';
    const rw = await boot('cors-railway', 3453, newSrc); servers.push(rw);
    delete process.env.RAILWAY_ENVIRONMENT_NAME; delete process.env.CORS_EXTRA_ORIGINS;
    ok(await acao(rw.url, DEV) === null && await sock(rw.url, DEV) === 'refused', `NEW on Railway: ${DEV} is NOT allowed (REST or socket)`);
    ok(await acao(rw.url, SITE) === SITE, `NEW on Railway: ${SITE} still allowed`);
    ok(await acao(rw.url, 'https://zztest-preview.example') === 'https://zztest-preview.example', 'NEW: CORS_EXTRA_ORIGINS adds an origin');
  } finally {
    servers.forEach(x => x.stop());
  }
  console.log('\nleftover throwaway rows: 0 (this suite writes nothing)');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
