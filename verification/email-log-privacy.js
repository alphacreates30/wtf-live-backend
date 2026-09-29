// Security review #21: two log lines carried buyers' email addresses into Railway's logs - the outbid-suppression
// notice printed the recipient, and a Resend error body (which can echo the address) was logged verbatim. Both now
// redact addresses. OLD is PINNED to e4e4f8f (before the fix). Local servers on the test database.
// Resend is a stub inside the server process that rejects every send with a body echoing the recipient (nothing is
// sent), and the outbid suppression threshold is patched to 0 so an outbid email is suppressed on demand.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'e4e4f8f';
const RESEND_STUB = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com')) return realFetch(url, opts);
  const to = JSON.parse(opts.body || '{}').to;
  return new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid \\'to\\' field: ' + to }), { status: 422 });
};`;
const OPTS = { log: true, env: { RESEND_API_KEY: 're_zztest_stub' }, preload: RESEND_STUB, patch: [['const OUTBID_SUPPRESS_AT = 45000;', 'const OUTBID_SUPPRESS_AT = 0;']] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };
const tag = Date.now().toString(36);

async function buyer(label, auctionId) {
  const email = `zz-${label}-${tag}@mail.example.com`;
  const u = die(await s.from('users').insert({ username: `zztest_elog_${label}_${tag}`, password_hash: 'x', email }).select().single());
  made.users.push(u.id);
  die(await s.from('profiles').insert({ user_id: String(u.id), full_name: 'ZZ', email, phone: '0', address_line1: '1', city: 'X', state: 'CA', zip: '1', status: 'approved', stripe_customer_id: 'cus_ZZFIXTURE_elog', stripe_payment_method_id: 'pm_ZZFIXTURE_elog' }).select().single());
  die(await s.from('auction_terms_acceptances').insert({ auction_id: auctionId, user_id: String(u.id), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' }).select().single());
  return { ...u, email, tok: jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}
async function scenario(label, srv) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_elog ' + label, description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  made.auctions.push(a.id);
  const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_elog lot', starting_bid: 0, current_bid: 0, position: 0, status: 'open', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  const A = await buyer(label + 'a', a.id), B = await buyer(label + 'b', a.id);
  const bid = (u, amt) => fetch(`${srv.url}/auction/${a.id}/items/${lot.id}/bid`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + u.tok }, body: JSON.stringify({ max_amount: amt }) }).then(r => r.status);
  const bids = [await bid(A, 5), await bid(B, 10)];   // B outbids A -> outbid email to A, suppressed at threshold 0
  await fetch(srv.url + '/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: A.username }) });   // reset email to A -> Resend stub 422
  for (let i = 0; i < 20 && !(/OUTBID EMAIL SUPPRESSED/.test(srv.log()) && /Email send error/.test(srv.log())); i++) await sleep(500);
  return { bids, log: srv.log(), email: A.email };
}

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('elog-old', 3551, oldSrc, OPTS); servers.push(oldSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await scenario('old', oldSrv);
    const sup = (r.log.match(/OUTBID EMAIL SUPPRESSED[^\n]*/) || [''])[0], err = (r.log.match(/Email send error[^\n]*/) || [''])[0];
    ok(r.bids.join() === '200,200' && sup.includes(r.email), 'OLD: the outbid-suppression log line contains the buyer\'s email address  <- PII IN LOGS');
    ok(err.includes(r.email), 'OLD: the Resend error log line echoes the buyer\'s email address  <- PII IN LOGS');
    oldSrv.stop();

    console.log('\n== SAME on the FIXED code ==');
    const newSrv = await boot('elog-new', 3552, newSrc, OPTS); servers.push(newSrv);
    r = await scenario('new', newSrv);
    const sup2 = (r.log.match(/OUTBID EMAIL SUPPRESSED[^\n]*/) || [''])[0], err2 = (r.log.match(/Email send error[^\n]*/) || [''])[0];
    ok(r.bids.join() === '200,200' && !!sup2 && !sup2.includes(r.email), `NEW: suppression still logged, no address: ${sup2.slice(0, 110)}`);
    ok(!!err2 && !err2.includes(r.email) && err2.includes('[email]'), `NEW: Resend error still logged, address redacted: ${err2}`);
    ok(!r.log.includes(r.email), 'NEW: the buyer\'s address appears nowhere in the server log');
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('profiles').delete().in('user_id', made.users.map(String));
    await s.from('outbid_email_log').delete().like('username', 'zztest_elog_%');
    await s.from('users').delete().in('id', made.users);
    const left = (await s.from('users').select('id').like('username', 'zztest_elog_%')).data.length + (await s.from('auctions').select('id').like('title', 'ZZTEST_elog %')).data.length + (await s.from('outbid_email_log').select('item_id').like('username', 'zztest_elog_%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
