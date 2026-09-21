// Email volume guard: the window and thresholds match Resend Pro (50,000 per billing period, no daily cap). The window
// is a rolling 30 days, deliberately approximate and deliberately conservative (see the comment in server.js). OLD is
// PINNED to the commit before the change (d60b9e7: start-of-UTC-day window, outbid suppressed at 90).
//
// The REAL shouldSuppressOutbid() / sendEmail() are extracted from server.js source and run in a vm sandbox, so the
// shipped code is what is tested, not a copy. Resend's HTTP call is a stub (nothing is sent) and, for the behaviour
// checks, the supabase count is a stub that records the query and returns a forced number. One check uses the real
// database: throwaway email_send_log rows (kind 'zztest_vol') straddling the 30-day boundary, to show the
// filter excludes older rows. They are deleted afterwards.
const vm = require('vm');
const { execSync } = require('child_process');
const fs = require('fs');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
require('./guard')(__filename);
process.chdir(BE);
require(BE + '/node_modules/dotenv').config({ quiet: true });
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const real = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'd60b9e7';

const extract = (src, startMark) => {
  const a = src.indexOf(startMark), b = src.indexOf('async function sendAdminEmail');
  if (a < 0 || b < 0) throw new Error('extract markers not found: ' + startMark);
  return src.slice(a, b);
};
// Build a sandbox around the extracted code. `count` is what the (stubbed) count query returns; countError simulates a failed read.
function sandbox(code, { count = 0, countError = null, now = null } = {}) {
  const calls = { gte: [], fetch: 0, inserts: 0, errors: [] };
  const RealDate = Date;
  const FakeDate = now ? class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return new RealDate(now).getTime(); } } : RealDate;
  FakeDate.UTC = RealDate.UTC;
  const chain = { select: () => chain, gte: (col, v) => { calls.gte.push([col, v]); return Promise.resolve(countError ? { count: null, error: { message: countError } } : { count, error: null }); }, insert: async () => { calls.inserts++; return {}; } };
  const ctx = {
    supabase: { from: () => chain }, Date: FakeDate, console: { error: (...a) => calls.errors.push(a.join(' ')), log() {} },
    process: { env: { RESEND_API_KEY: 're_stub' } }, REPLY_TO: 'x@example.invalid', AbortSignal,
    fetch: async () => { calls.fetch++; return { ok: true, text: async () => '' }; },
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.__api = { sendEmail, shouldSuppressOutbid, emailWindowStart: typeof emailWindowStart === "function" ? emailWindowStart : null, startOfTodayUTC: typeof startOfTodayUTC === "function" ? startOfTodayUTC : null };', ctx);
  return { api: ctx.__api, calls };
}
const send = (env, kind) => env.api.sendEmail({ from: 'a', to: 'b@example.invalid', subject: kind + ' test', html: 'x', text: 'x', kind });

(async () => {
  const newSrc = fs.readFileSync(BE + '/server.js', 'utf8');
  const oldSrc = execSync('git show ' + OLD_COMMIT + ':server.js', { cwd: BE, maxBuffer: 50e6 }).toString();
  const NEW = extract(newSrc, 'const MONTHLY_EMAIL_CAP'), OLD = extract(oldSrc, 'const DAILY_EMAIL_CAP');
  const created = [];
  try {
    console.log(`== WHY: on ${OLD_COMMIT} (pre-change) the day-sized guard drops outbid emails with huge headroom on Pro ==`);
    let e = sandbox(OLD, { count: 90 }); await send(e, 'outbid');
    ok(e.calls.fetch === 0, `OLD: 90 emails counted today -> outbid SUPPRESSED (fetch calls: ${e.calls.fetch}) - though Pro has 49,910 left in the period`);
    const t = new Date(); const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())).toISOString();
    ok(e.calls.gte[0][1] === dayStart, `OLD: the count window starts at the UTC DAY (${e.calls.gte[0][1]})`);

    console.log('\n== NEW: the window is a rolling 30 days ==');
    const NOW = '2026-09-21T12:34:56.789Z';
    e = sandbox(NEW, { count: 0, now: NOW }); await e.api.shouldSuppressOutbid();
    const want30 = new Date(new Date(NOW).getTime() - 30 * 86400e3).toISOString();
    ok(e.calls.gte.length === 1 && e.calls.gte[0][0] === 'sent_at' && e.calls.gte[0][1] === want30, `NEW: with now = ${NOW} the count query is  sent_at >= ${e.calls.gte[0][1]}  (exactly 30 x 24h earlier)`);
    ok(want30 === '2026-08-22T12:34:56.789Z', `NEW: ... which is ${want30}: no calendar or billing-day anchor, it slides with now`);
    ok(!e.api.startOfTodayUTC && !/DAILY_EMAIL_CAP|startOfTodayUTC|startOfMonthUTC/.test(newSrc), 'NEW: no daily/month helper or DAILY_EMAIL_CAP left in server.js');
    for (const now of ['2026-01-15T10:00:00Z', '2026-03-01T00:00:00Z', '2026-12-31T23:59:59Z', '2028-03-01T00:00:00Z']) {
      const b = sandbox(NEW, { now }); const got = b.api.emailWindowStart(); const diffDays = (new Date(now) - new Date(got)) / 86400e3;
      ok(diffDays === 30, `NEW: window start at ${now} is ${got} (${diffDays} days back, across month/year/leap-year edges)`);
    }
    const before20 = sandbox(NEW, { now: '2026-09-19T23:59:59Z' }).api.emailWindowStart(), after20 = sandbox(NEW, { now: '2026-09-20T00:00:01Z' }).api.emailWindowStart();
    ok(after20 === '2026-08-21T00:00:01.000Z' && before20 === '2026-08-20T23:59:59.000Z', `NEW: nothing special happens at the 20th (Resend's current renewal day): the window just slides (${before20} -> ${after20})`);

    console.log('\n== NEW: thresholds (count forced past the boundary) ==');
    e = sandbox(NEW, { count: 90 }); await send(e, 'outbid');
    ok(e.calls.fetch === 1 && e.calls.inserts === 1, `NEW: 90 in the window -> outbid SENT (fetch ${e.calls.fetch}, logged ${e.calls.inserts})  - the case the old guard wrongly dropped`);
    e = sandbox(NEW, { count: 44999 }); await send(e, 'outbid');
    ok(e.calls.fetch === 1, `NEW: 44,999 -> outbid still sent (fetch ${e.calls.fetch})`);
    e = sandbox(NEW, { count: 45000 }); await send(e, 'outbid');
    ok(e.calls.fetch === 0 && e.calls.errors.some(x => /OUTBID EMAIL SUPPRESSED \(at 45000 of the 50000 Resend quota, rolling 30 days\)/.test(x)), `NEW: 45,000 -> outbid SUPPRESSED (fetch ${e.calls.fetch}); logged: "${(e.calls.errors[0] || '').slice(0, 110)}"`);
    for (const kind of ['won', 'failed', 'shipped', 'admin']) {
      e = sandbox(NEW, { count: 45000 }); await send(e, kind);
      const f = sandbox(NEW, { count: 49999 }); await send(f, kind);
      ok(e.calls.fetch === 1 && f.calls.fetch === 1, `NEW: '${kind}' still goes through at 45,000 and at 49,999 (fetch ${e.calls.fetch}/${f.calls.fetch}) - the 5,000 headroom is theirs`);
    }
    e = sandbox(NEW, { count: 99999 }); await send(e, 'outbid'); const w = sandbox(NEW, { count: 99999 }); await send(w, 'won');
    ok(e.calls.fetch === 0 && w.calls.fetch === 1, `NEW: even far past the quota, outbid is suppressed and won is still attempted (${e.calls.fetch}/${w.calls.fetch})`);

    console.log('\n== NEW: fails CLOSED (kept) ==');
    e = sandbox(NEW, { countError: 'connection refused' }); await send(e, 'outbid');
    ok(e.calls.fetch === 0 && e.calls.errors.some(x => /count query failed, suppressing outbid/.test(x)), `NEW: count query fails -> outbid suppressed (fetch ${e.calls.fetch})`);
    e = sandbox(NEW, { countError: 'connection refused' }); await send(e, 'won');
    ok(e.calls.fetch === 1, `NEW: count query fails -> won is unaffected (fetch ${e.calls.fetch})`);

    console.log('\n== NEW: the boundary against the REAL table (throwaway rows kind=zztest_vol, deleted after) ==');
    const winStart = sandbox(NEW, {}).api.emailWindowStart();
    const at = ms => new Date(new Date(winStart).getTime() + ms).toISOString();
    const rows = [{ kind: 'zztest_vol', sent_at: at(-60e3) }, { kind: 'zztest_vol', sent_at: at(60e3) }, { kind: 'zztest_vol', sent_at: at(29 * 86400e3) }, { kind: 'zztest_vol', sent_at: new Date().toISOString() }];
    const ins = await real.from('email_send_log').insert(rows).select('id');
    if (ins.error) throw new Error(JSON.stringify(ins.error));
    ins.data.forEach(r => created.push(r.id));
    const winCount = (await real.from('email_send_log').select('id', { count: 'exact', head: true }).eq('kind', 'zztest_vol').gte('sent_at', winStart)).count;
    const dayCount = (await real.from('email_send_log').select('id', { count: 'exact', head: true }).eq('kind', 'zztest_vol').gte('sent_at', dayStart)).count;
    ok(winCount === 3, `NEW: the window filter counted ${winCount} of 4 rows: the one 60s OUTSIDE the 30-day window is excluded; 60s inside, 29 days on, and now are included`);
    console.log(`  (for contrast, the old day filter would have counted ${dayCount})`);
  } finally {
    if (created.length) await real.from('email_send_log').delete().in('id', created);
    const left = (await real.from('email_send_log').select('id').eq('kind', 'zztest_vol')).data.length;
    console.log('\nleftover throwaway rows:', left);
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
