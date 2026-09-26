// AI spend log (migration 2026-09-26l, /admin/ai-usage).
//
// Claude is stubbed in every variant - this suite never makes a real AI call or
// spends anything. The stub reports a fixed usage per call:
//   1000 input + 200 output + 3000 cache-write + 0 cache-read tokens
//   = (1000*2 + 200*10 + 3000*2.5) / 1e6 = $0.0115 at Sonnet 5 prices.
//
// A. Real database. The AI routes answer 200 whether or not ai_usage exists.
//    Table missing: the insert failure is logged, /admin/ai-usage says "not set
//    up" (503). Table present: one row per Claude response, attributed to the
//    auction, costed correctly - then this suite's rows are deleted.
// B. ai_usage swapped for an in-memory table (2,500 seeded rows) to check the
//    summary: paging past PostgREST's 1000-row cap, day buckets in the caller's
//    time zone, deleted / unassigned auctions, unpriced calls.
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const src = require('./guard').readSource(BE + '/server.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = jwt.sign({ id: 'x', username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const other = jwt.sign({ id: 'y', username: 'someone' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const PER_CALL = 0.0115;

const STUB = BE + '/ai_lots.tmp-stub.js';
fs.writeFileSync(STUB, `
const real = require('./ai_lots');
const resp = () => ({ model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 } });
module.exports = { ...real,
  // two calls, as a batch over GROUPING_CHUNK_SIZE would make
  groupPhotos: async (t, c, track) => { track?.('group', resp()); track?.('group', resp()); return [[0]]; },
  analyzeLot: async (i, c, track) => { track?.('analyze', resp()); return { title: 'stub' }; },
  regenerateDescription: async (t, c, track) => { track?.('regenerate', resp()); return { title: t, description: 'stub' }; },
};`);

const files = [STUB];
async function variant(name, port, mutate) {
  const file = BE + '/server.tmp-' + name + '.js';
  const out = mutate(src);
  if (!out.includes("require('./ai_lots.tmp-stub')")) throw new Error('stub not wired into variant ' + name);
  fs.writeFileSync(file, out);
  const runner = BE + '/run.tmp-' + name + '.js';
  fs.writeFileSync(runner, "global.setInterval = () => 0; process.env.PORT='" + port + "'; require('./server.tmp-" + name + ".js');");
  files.push(file, runner);
  let log = '';
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  await sleep(5000);
  return { child, log: () => log };
}
const stubbed = code => code.replace("require('./ai_lots')", "require('./ai_lots.tmp-stub')");
const call = (port, path, { method = 'GET', body, tok = admin } = {}) =>
  fetch('http://localhost:' + port + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body && JSON.stringify(body) })
    .then(async r => ({ s: r.status, j: await r.json().catch(() => null) }));

const children = [];
let testAuction = null;
(async () => {
  // ---------------- A. real database ----------------
  const A = await variant('aiusageA', 4611, stubbed); children.push(A.child);
  testAuction = crypto.randomUUID();   // no FK on ai_usage.auction_id, so any uuid is a valid tag
  const r1 = await call(4611, '/ai/analyze-lot', { method: 'POST', body: { images: ['x'], condition: 'Good', auction_id: testAuction.toUpperCase() } });
  const r2 = await call(4611, '/ai/regenerate-description', { method: 'POST', body: { title: 'ZZTEST', auction_id: testAuction } });
  const r3 = await call(4611, '/ai/group-photos', { method: 'POST', body: { thumbnails: ['x'], auction_id: testAuction } });
  ok(r1.s === 200 && r2.s === 200 && r3.s === 200, `AI routes answer 200 with tracking in place (${r1.s},${r2.s},${r3.s})`);
  const bad = await call(4611, '/ai/analyze-lot', { method: 'POST', body: { images: ['x'], auction_id: 'not-a-uuid' } });
  ok(bad.s === 400, 'malformed auction_id is refused (400), not logged as garbage');
  const forbidden = await call(4611, '/admin/ai-usage', { tok: other });
  ok(forbidden.s === 403, 'non-admin cannot read AI spend (403)');
  await sleep(1500);

  const probe = await s.from('ai_usage').select('id').limit(1);   // not head: a HEAD on a missing table returns no error
  if (probe.error) {
    console.log(`  (ai_usage table not present: ${probe.error.code} - checking the not-yet-migrated behaviour)`);
    ok(/ai_usage insert failed/.test(A.log()), 'missing table: insert failure is logged, request unaffected');
    const sum = await call(4611, '/admin/ai-usage');
    ok(sum.s === 503 && /not set up/.test(sum.j?.error) && /2026-09-26l/.test(sum.j?.detail), `missing table: /admin/ai-usage says not set up (${sum.s} ${sum.j?.error})`);
  } else {
    const { data: rows } = await s.from('ai_usage').select('*').eq('auction_id', testAuction);
    ok(rows.length === 4, `one row per Claude response, attributed to the auction (${rows.length}/4; group made 2 calls)`);
    ok(rows.every(r => near(Number(r.cost_usd), PER_CALL) && r.input_tokens === 1000 && r.cache_creation_input_tokens === 3000), 'tokens stored raw, cost_usd = $0.0115 each');
    ok(rows.map(r => r.kind).sort().join() === 'analyze,group,group,regenerate', 'kinds recorded');
    ok(rows.every(r => r.username === 'whatthefind' && r.model === 'claude-sonnet-5'), 'username and model recorded');
    const sum = await call(4611, '/admin/ai-usage');
    const mine = sum.j?.by_auction?.find(a => a.auction_id === testAuction);
    ok(sum.s === 200 && mine && near(mine.cost, 4 * PER_CALL) && mine.deleted === true, 'summary includes this auction, flagged deleted (no such auction)');
  }

  // ---------------- B. in-memory table ----------------
  const { data: realAuctions } = await s.from('auctions').select('id, title').limit(1);
  const real = realAuctions?.[0];
  const ghost = crypto.randomUUID();
  const seed = [];
  // 2,500 rows over 1,000-row pages: the total must still be exact.
  for (let i = 0; i < 2500; i++) seed.push({ id: i + 1, created_at: '2026-08-15T12:00:00Z', kind: 'analyze', auction_id: real ? real.id : ghost, cost_usd: '0.010000' });
  // 02:00 UTC on the 27th is still the 26th in New York
  seed.push({ id: 2501, created_at: '2026-09-27T02:00:00Z', kind: 'regenerate', auction_id: ghost, cost_usd: '0.500000' });
  seed.push({ id: 2502, created_at: '2026-09-26T15:00:00Z', kind: 'group', auction_id: null, cost_usd: '0.250000' });
  seed.push({ id: 2503, created_at: '2026-09-26T15:00:00Z', kind: 'analyze', auction_id: null, cost_usd: null });   // unpriced
  const fake = `(() => { const rows = ${JSON.stringify(seed)}; return { select() { return this }, order() { return this },
      range(a, b) { return Promise.resolve({ data: rows.slice(a, b + 1), error: null }) }, insert() { return Promise.resolve({ error: null }) } }; })()`;
  const B = await variant('aiusageB', 4612, code => stubbed(code).replaceAll("supabase.from('ai_usage')", fake)); children.push(B.child);
  const ny = await call(4612, '/admin/ai-usage?tz=America/New_York');
  ok(ny.s === 200, 'summary loads (' + ny.s + ')');
  ok(ny.j.total.calls === 2503 && near(ny.j.total.cost, 25 + 0.5 + 0.25), `paged past 1000 rows: 2503 calls, $25.75 (got ${ny.j.total.calls}, ${ny.j.total.cost})`);
  ok(ny.j.total.unpriced_calls === 1, 'unpriced call counted');
  ok(near(ny.j.by_day['2026-09-26']?.cost, 0.75) && !ny.j.by_day['2026-09-27'], 'New York: 02:00Z on the 27th lands on the 26th');
  const utc = await call(4612, '/admin/ai-usage?tz=Not/AZone');
  ok(utc.j.tz === 'UTC' && near(utc.j.by_day['2026-09-27']?.cost, 0.5), 'invalid tz falls back to UTC');
  const g = ny.j.by_auction.find(a => a.auction_id === ghost);
  ok(g && g.deleted === true && g.title === null, 'auction that no longer exists is flagged deleted');
  const none = ny.j.by_auction.find(a => a.auction_id === null);
  ok(none && none.calls === 2 && none.deleted === false, 'calls with no auction grouped separately');
  if (real) {
    const r = ny.j.by_auction.find(a => a.auction_id === real.id);
    ok(r && r.title === real.title && r.deleted === false && near(r.cost, 25), 'existing auction resolved to its title');
  }
  ok(ny.j.by_auction[0].cost >= ny.j.by_auction[ny.j.by_auction.length - 1].cost, 'sorted by cost, highest first');
})().catch(e => { console.error(e); fails++; }).finally(async () => {
  for (const c of children) c.kill();
  if (testAuction) { const d = await s.from('ai_usage').delete().eq('auction_id', testAuction); if (!d.error) console.log('  cleaned up this run\'s ai_usage rows'); }
  for (const f of files) try { fs.unlinkSync(f); } catch {}
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
});
