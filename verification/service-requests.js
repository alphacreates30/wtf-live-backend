// Service requests (F5, wtf-handoff SERVICES_BRIEF.md, migration 2026-10-16zc). Local servers on the test database;
// Resend is a stub that writes to a file (nothing is sent). Every request and photo it makes is deleted at the end.
//   send       a request with photos: stored, phone as digits, photos in the PRIVATE bucket and re-encoded (the GPS
//              EXIF is gone), not reachable by a public URL; Albert's email (reply goes to the sender, the details,
//              a link to Requests, no photo links) and the sender's short confirmation (none of their words)
//   refused    each field's check (service, name, email, US phone: 7 digits / 555-01xx / 911 / letters, details,
//              item count), 11 photos, a GIF, an SVG, a file over 8 MB: 400 and nothing stored
//   spam       the honeypot gets the normal answer and stores nothing; the 11th request in an hour from one IP: 429
//   admin      buyers 403 and logged-out 401 on every admin route; the list (filters by service and status, signed
//              photo links that work), the New count, PATCH status and notes (bad status 400), DELETE removes the
//              photos and then the request
//   site       no mailto: left in the frontend (../wtf-live-frontend); Contact shows the address as plain text
//   database   RLS on, anon/authenticated can't read or write the table; the bucket is private
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
if (process.argv.some(a => a.startsWith('--yes-'))) { console.log('service-requests.js runs on the test database only.'); process.exit(2); }
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const sharp = require(BE + '/node_modules/sharp');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { Client } = require(BE + '/node_modules/pg');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const dbUrl = require(BE + '/node_modules/dotenv').parse(fs.readFileSync(BE + '/.env.test')).TEST_DB_URL;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const TAG = crypto.randomBytes(3).toString('hex');
const MAIL = BE + '/run.tmp-service-requests-mail.log';
const BUCKET = 'service-request-photos';
const STUBS = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com')) {
    const b = JSON.parse(opts.body || '{}');
    require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, reply_to: b.reply_to, subject: b.subject, html: b.html }) + '\\n');
    return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
  }
  return realFetch(url, opts);
};`;
const ENV = { RESEND_API_KEY: 're_zztest_stub', SERVICES_EMAIL: 'zztest-inbox@example.invalid' };
const mails = () => (fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

function withGpsExif(jpeg) {
  const tiff = Buffer.from('4d4d002a00000008000188250004000000010000001a00000000', 'hex');
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff, Buffer.from('GPS 37.7749N 122.4194W', 'binary')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
const hasGps = b => b.includes(Buffer.from('Exif')) && b.includes(Buffer.from([0x88, 0x25]));
const canvas = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } });

const email = label => `zztest_sr_${label}_${TAG}@example.invalid`;
const base = label => ({ service: 'consign', name: 'ZZ Test ' + label, email: email(label), phone: '+1 (305) 444-1234', location: 'Miami 33101',
  details: `A box of old postcards ${TAG}`, item_count: '26-100', heard_from: 'A friend' });
async function send(url, fields, photos = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const p of photos) fd.append('photos', new Blob([p.buf], { type: p.type }), p.name || 'photo');
  const r = await fetch(url + '/service-requests', { method: 'POST', body: fd });
  return { s: r.status, j: await r.json().catch(() => null) };
}
const rowsFor = async label => (await s.from('service_requests').select('*').eq('email', email(label))).data || [];
const call = (url, method, p, tok, body) => fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
  body: body && method !== 'GET' ? JSON.stringify(body) : undefined }).then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

(async () => {
  const servers = [];
  try { fs.unlinkSync(MAIL); } catch {}
  try {
    if ((await s.from('service_requests').select('id').limit(1)).error) { console.log('Apply migration 2026-10-16zc first.'); process.exit(2); }
    const src = require('./guard').readSource(BE + '/server.js');
    const srv = await boot('service-requests', 3651, src, { env: ENV, preload: STUBS });
    servers.push(srv);
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const buyer = jwt.sign({ id: crypto.randomUUID(), username: 'zztest_sr_buyer_' + TAG }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const gpsJpeg = withGpsExif(await canvas(600, 400).jpeg().toBuffer());
    const png = await canvas(300, 300).png().toBuffer();
    ok(hasGps(gpsJpeg), 'fixture: the test JPEG carries a GPS EXIF tag');

    console.log('== Send a request with photos ==');
    let r = await send(srv.url, base('ok'), [{ buf: gpsJpeg, type: 'image/jpeg', name: 'a.jpg' }, { buf: png, type: 'image/png', name: 'b.png' }]);
    ok(r.s === 200 && r.j.message === "Thanks, we'll be in touch within 72 hours.", `200: "${r.j && r.j.message}"`);
    const [row] = await rowsFor('ok');
    ok(row && row.service === 'consign' && row.phone === '3054441234' && row.status === 'new' && row.item_count === '26-100' && row.photo_paths.length === 2,
      `stored: service consign, phone ${row && row.phone} (digits), status new, 2 photos`);
    const dl = row ? await s.storage.from(BUCKET).download(row.photo_paths[0]) : { data: null };
    const stored = dl.data ? Buffer.from(await dl.data.arrayBuffer()) : Buffer.alloc(0);
    ok(stored.length > 0 && !hasGps(stored) && !(await sharp(stored).metadata()).exif, 'the stored photo is re-encoded: no EXIF, no GPS');
    const pub = row ? await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${row.photo_paths[0]}`) : { status: 0 };
    ok(pub.status >= 400, `the photo has no public URL (public link -> ${pub.status})`);
    for (let i = 0; i < 20 && mails().length < 2; i++) await sleep(100);
    const inbox = mails().find(m => [].concat(m.to).includes('zztest-inbox@example.invalid'));
    const conf = mails().find(m => [].concat(m.to).includes(email('ok')));
    ok(inbox && inbox.reply_to === email('ok') && inbox.html.includes(`A box of old postcards ${TAG}`) && inbox.html.includes('(305) 444-1234')
      && inbox.html.includes(`/host/requests?id=${row && row.id}`) && !inbox.html.includes(BUCKET) && /Consign/.test(inbox.subject),
      `Albert's email: "${inbox && inbox.subject}", replies go to the sender, details + a Requests link, no photo links`);
    ok(conf && conf.subject === 'We got your request' && /within 72 hours/.test(conf.html) && !conf.html.includes('postcards') && !conf.html.includes('ZZ Test'),
      "the sender's confirmation: within 72 hours, none of their own words");

    console.log('\n== Refused: nothing stored ==');
    const bad = [
      ['service', { service: 'appraisal' }], ['name', { name: '' }], ['email', { email: 'not-an-email' }],
      ['phone', { phone: '444-1234' }], ['phone', { phone: '(305) 555-0123' }], ['phone', { phone: '911-444-1234' }], ['phone', { phone: 'call me' }],
      ['details', { details: '' }], ['details', { details: 'x'.repeat(4001) }], ['item_count', { item_count: 'lots' }],
    ];
    let refusedOk = true;
    for (const [field, change] of bad) {
      r = await send(srv.url, { ...base('bad'), ...change });
      if (!(r.s === 400 && r.j.field === field)) { refusedOk = false; console.log('   ', field, JSON.stringify(change).slice(0, 60), '->', r.s, JSON.stringify(r.j)); }
    }
    ok(refusedOk, `each field's check: ${bad.length} bad forms -> 400 with the field named`);
    const many = Array.from({ length: 11 }, (_, i) => ({ buf: png, type: 'image/png', name: `p${i}.png` }));
    r = await send(srv.url, base('bad'), many);
    ok(r.s === 400 && /up to 10 photos/.test(r.j.error), `11 photos -> ${r.s} ${r.j && r.j.error}`);
    r = await send(srv.url, base('bad'), [{ buf: await canvas(20, 20).gif().toBuffer(), type: 'image/gif' }]);
    ok(r.s === 400 && r.j.field === 'photos', `a GIF -> ${r.s} ${r.j && r.j.error}`);
    r = await send(srv.url, base('bad'), [{ buf: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), type: 'image/svg+xml' }]);
    ok(r.s === 400 && r.j.field === 'photos', `an SVG -> ${r.s} ${r.j && r.j.error}`);
    r = await send(srv.url, base('bad'), [{ buf: crypto.randomBytes(8 * 1024 * 1024 + 10), type: 'image/jpeg' }]);
    ok(r.s === 400 && /under 8 MB/.test(r.j.error), `a file over 8 MB -> ${r.s} ${r.j && r.j.error}`);
    ok((await rowsFor('bad')).length === 0, 'none of those stored a request');

    console.log('\n== Spam ==');
    r = await send(srv.url, { ...base('honey'), website: 'http://spam.example' }, [{ buf: png, type: 'image/png' }]);
    ok(r.s === 200 && r.j.message === "Thanks, we'll be in touch within 72 hours." && (await rowsFor('honey')).length === 0, 'the honeypot: the normal answer, nothing stored');
    const limited = await boot('service-requests-rl', 3652, src, { env: { ...ENV, RATE_LIMIT_EXEMPT_LOOPBACK: '0' }, preload: STUBS });
    servers.push(limited);
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await send(limited.url, { ...base('rl'), website: 'x' })).s);
    ok(codes.slice(0, 10).every(c => c === 200) && codes[10] === 429, `11 requests in an hour from one IP: the 11th -> ${codes[10]}`);

    console.log('\n== Admin -> Requests ==');
    await send(srv.url, { ...base('ok2'), service: 'sell', item_count: '' });
    const routes = [['GET', '/admin/service-requests'], ['GET', '/admin/service-requests/summary'], ['PATCH', `/admin/service-requests/${row.id}`], ['DELETE', `/admin/service-requests/${row.id}`]];
    const asBuyer = [], asNobody = [];
    for (const [m, p] of routes) { asBuyer.push((await call(srv.url, m, p, buyer, { status: 'closed' })).s); asNobody.push((await call(srv.url, m, p, null, { status: 'closed' })).s); }
    ok(asBuyer.every(c => c === 403) && asNobody.every(c => c === 401), `every admin route: buyer ${asBuyer.join('/')}, logged out ${asNobody.join('/')}`);
    let list = await call(srv.url, 'GET', '/admin/service-requests', admin);
    const mine = (list.j.requests || []).find(x => x.id === row.id);
    const photoOk = mine && mine.photos.length === 2 && mine.photos.every(p => p.url) ? (await fetch(mine.photos[0].url)).status : 0;
    ok(list.s === 200 && mine && mine.phone_display === '(305) 444-1234' && mine.service_label === 'Consign' && photoOk === 200 && !('photo_paths' in mine),
      `the list: the request, phone (305) 444-1234, its photos through signed links (${photoOk})`);
    const sum = await call(srv.url, 'GET', '/admin/service-requests/summary', admin);
    ok(sum.j.available === true && sum.j.new_count >= 2 && list.j.new_count === sum.j.new_count, `the count of New: ${sum.j.new_count}`);
    list = await call(srv.url, 'GET', '/admin/service-requests?service=sell', admin);
    ok(list.j.requests.some(x => x.email === email('ok2')) && list.j.requests.every(x => x.service === 'sell'), 'filter by service (sell)');
    r = await call(srv.url, 'PATCH', `/admin/service-requests/${row.id}`, admin, { status: 'offer_made', notes: 'Called, offer sent' });
    ok(r.s === 200 && r.j.status === 'offer_made' && r.j.notes === 'Called, offer sent', `PATCH status and notes -> ${r.j && r.j.status}`);
    r = await call(srv.url, 'PATCH', `/admin/service-requests/${row.id}`, admin, { status: 'maybe' });
    ok(r.s === 400, `a bad status -> ${r.s}`);
    list = await call(srv.url, 'GET', '/admin/service-requests?status=new', admin);
    ok(!list.j.requests.some(x => x.id === row.id) && list.j.requests.some(x => x.email === email('ok2')), 'filter by status (new): the changed one is gone from it');
    r = await call(srv.url, 'DELETE', `/admin/service-requests/${row.id}`, admin);
    const folder = (await s.storage.from(BUCKET).list(row.id)).data || [];
    ok(r.s === 204 && (await rowsFor('ok')).length === 0 && folder.length === 0, 'DELETE: the request and its photos are gone');

    console.log('\n== The site: no email links left ==');
    const FE = require('path').join(BE, '..', 'wtf-live-frontend', 'src');
    if (fs.existsSync(FE)) {
      const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(require('path').join(dir, e.name)) : [require('path').join(dir, e.name)]);
      const hits = walk(FE).filter(f => /\.(jsx?|md|css|html)$/.test(f) && /mailto:/i.test(fs.readFileSync(f, 'utf8')));
      const contact = fs.readFileSync(require('path').join(FE, 'pages', 'Contact.jsx'), 'utf8');
      ok(hits.length === 0 && contact.includes('{CONTACT_EMAIL}'), `no mailto: anywhere in the frontend (${hits.length ? hits.join(', ') : 'none'}); Contact shows the address as plain text`);
    } else console.log('(../wtf-live-frontend not found next to this repo: skipped)');

    console.log('\n== Database ==');
    const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const g = (await c.query(`select (select relrowsecurity from pg_class where oid = 'public.service_requests'::regclass) rls,
        has_table_privilege('anon', 'public.service_requests', 'SELECT') a_sel, has_table_privilege('anon', 'public.service_requests', 'INSERT') a_ins,
        has_table_privilege('authenticated', 'public.service_requests', 'SELECT') u_sel, (select public from storage.buckets where id = $1) pub`, [BUCKET])).rows[0];
    await c.end();
    ok(g.rls && !g.a_sel && !g.a_ins && !g.u_sel && g.pub === false, `RLS on; anon/authenticated can't read or write; the bucket is private (${JSON.stringify(g)})`);
  } catch (e) {
    console.log('ERR', e); fails++;
  } finally {
    servers.forEach(x => x.stop());
    const { data: left } = await s.from('service_requests').select('id, photo_paths').like('email', `zztest_sr_%_${TAG}@example.invalid`);
    const paths = (left || []).flatMap(x => x.photo_paths || []);
    if (paths.length) await s.storage.from(BUCKET).remove(paths);
    if (left?.length) await s.from('service_requests').delete().in('id', left.map(x => x.id));
    await s.from('email_send_log').delete().eq('kind', 'service_request').gte('sent_at', new Date(Date.now() - 30 * 60e3).toISOString());
    try { fs.unlinkSync(MAIL); } catch {}
    const still = (await s.from('service_requests').select('id').like('email', `zztest_sr_%_${TAG}@example.invalid`)).data || [];
    console.log(`\nleftover throwaway rows: ${still.length}`);
    if (still.length) fails++;
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
