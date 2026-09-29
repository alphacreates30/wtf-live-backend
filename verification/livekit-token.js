// Security review #18: GET /auction/:id/token handed any logged-in account a LiveKit room token for any auction -
// drafts and standard auctions included - with canPublishData for everyone. Now: live-mode auctions only, no
// drafts for non-admins, only the host or an approved buyer, and only the host may publish (video or data).
// OLD is PINNED to 409db0e (before the fix). Local servers on the test database. LiveKit is never contacted: the
// token is signed locally with a throwaway key/secret given to these servers only, and decoded here.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '409db0e';
const LK = { LIVEKIT_API_KEY: 'zztest_key', LIVEKIT_API_SECRET: crypto.randomBytes(24).toString('hex'), LIVEKIT_URL: 'wss://zztest.invalid' };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };
const person = async (label, status) => {
  const u = { id: crypto.randomUUID(), username: 'zztest_lk_' + label };
  made.users.push(u.id);
  if (status) die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZ', email: 'zz@example.invalid', phone: '0', address_line1: '1', city: 'X', state: 'CA', zip: '1', status }).select().single());
  return jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' });
};
const mkAuction = async (label, status, mode) => { const a = die(await s.from('auctions').insert({ title: 'ZZTEST_lk ' + label, description: 'x', status, mode, fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single()); made.auctions.push(a.id); return a.id; };
const token = async (url, id, t) => {
  const r = await fetch(`${url}/auction/${id}/token`, { headers: { Authorization: 'Bearer ' + t } });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, grants: j.token ? jwt.decode(j.token).video : null };
};

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const pending = await person('pending', 'pending'), approved = await person('approved', 'approved'), none = await person('noprofile', null);
    const host = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const draftLive = await mkAuction('draft live-mode', 'draft', 'live'), standard = await mkAuction('standard', 'live', 'standard'), live = await mkAuction('live-mode', 'live', 'live');
    const oldSrv = await boot('lk-old', 3521, oldSrc, { env: LK }), newSrv = await boot('lk-new', 3522, newSrc, { env: LK });
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let r = await token(oldSrv.url, draftLive, pending);
    ok(r.s === 200 && r.grants && r.grants.canPublishData === true, `OLD: a PENDING account gets a token for a DRAFT (${r.s}), canPublishData ${r.grants && r.grants.canPublishData}  <- TOO OPEN`);
    r = await token(oldSrv.url, standard, none);
    ok(r.s === 200, `OLD: an account with no profile gets a token for a standard auction (${r.s})`);

    console.log('\n== SAME on the FIXED code ==');
    ok((await token(newSrv.url, draftLive, pending)).s === 404, 'NEW: draft -> 404 for a buyer');
    ok((await token(newSrv.url, standard, approved)).s === 404, 'NEW: standard auction (no video) -> 404');
    ok((await token(newSrv.url, live, pending)).s === 403 && (await token(newSrv.url, live, none)).s === 403, 'NEW: live-mode auction, pending / no profile -> 403');
    r = await token(newSrv.url, live, approved);
    ok(r.s === 200 && r.grants.roomJoin && r.grants.canSubscribe && !r.grants.canPublish && !r.grants.canPublishData, `NEW: approved buyer -> 200, watch only (canPublish ${r.grants && r.grants.canPublish}, canPublishData ${r.grants && r.grants.canPublishData})`);
    r = await token(newSrv.url, live, host);
    ok(r.s === 200 && r.grants.canPublish && r.grants.canPublishData, 'NEW: the host still publishes video and data');
    ok((await token(newSrv.url, draftLive, host)).s === 200, 'NEW: the admin can still open a draft\'s room');
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('profiles').delete().in('user_id', made.users);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_lk %')).data.length + (await s.from('profiles').select('id').in('user_id', made.users)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
