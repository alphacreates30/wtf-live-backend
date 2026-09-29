// Security review #7: chat needs the same standing as joining the room. send_chat checked the token only, so a
// blocked (or never-approved) user kept posting into any auction - drafts included - by emitting the event.
// OLD is PINNED to 05db001 (before the fix). Local servers on the test database; Stripe and email blanked.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '05db001';
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { auctions: [], users: [] };

async function mkUser(label, status) {
  const u = { id: crypto.randomUUID(), username: 'zztest_chat_' + label };
  made.users.push(u.id);
  if (status) die(await s.from('profiles').insert({ user_id: u.id, full_name: 'ZZTEST chat', email: 'zz@example.invalid', phone: '0', address_line1: '1 ZZ St', city: 'X', state: 'CA', zip: '94000', status }).select().single());
  return { ...u, tok: jwt.sign(u, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}
async function mkAuction(label, status) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_chat ' + label, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  made.auctions.push(a.id); return a.id;
}
// Sends one chat message; returns the chat_error message if one came back.
const chat = (url, user, auctionId, text) => new Promise(res => {
  const c = io(url, { transports: ['websocket'], reconnection: false }); let err = null;
  c.on('chat_error', e => { err = e.message; });
  c.on('connect', () => { c.emit('send_chat', { auctionId, text, token: user.tok }); setTimeout(() => { c.close(); res(err); }, 1500); });
  c.on('connect_error', () => res('connect_error'));
});
const stored = async (auctionId, username) => die(await s.from('chat_messages').select('id').eq('auction_id', auctionId).eq('username', username)).length;

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');
    const blocked = await mkUser('blocked', 'blocked'), pending = await mkUser('pending', 'pending'), none = await mkUser('noprofile', null), good = await mkUser('approved', 'approved');
    const oldSrv = await boot('chat-old', 3411, oldSrc), newSrv = await boot('chat-new', 3412, newSrc);
    servers.push(oldSrv, newSrv);

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    let live = await mkAuction('old live', 'live'), draft = await mkAuction('old draft', 'draft');
    await chat(oldSrv.url, blocked, live, 'ZZTEST blocked live'); await chat(oldSrv.url, blocked, draft, 'ZZTEST blocked draft');
    await chat(oldSrv.url, pending, live, 'ZZTEST pending live');
    ok(await stored(live, blocked.username) === 1 && await stored(draft, blocked.username) === 1, 'OLD: a BLOCKED user posts into a live auction and a draft  <- NOT BLOCKED');
    ok(await stored(live, pending.username) === 1, 'OLD: a never-approved user posts too');

    console.log('\n== SAME on the FIXED code ==');
    live = await mkAuction('new live', 'live'); draft = await mkAuction('new draft', 'draft');
    for (const [label, u] of [['blocked', blocked], ['pending', pending], ['no profile', none]]) {
      const e = await chat(newSrv.url, u, live, 'ZZTEST ' + label);
      ok(e && await stored(live, u.username) === 0, `NEW: ${label} user refused ("${e}"), nothing stored`);
    }
    let e = await chat(newSrv.url, good, draft, 'ZZTEST approved into a draft');
    ok(e === 'Auction not found' && await stored(draft, good.username) === 0, `NEW: even an approved user can't post into a draft ("${e}")`);
    e = await chat(newSrv.url, good, live, 'ZZTEST approved live');
    ok(!e && await stored(live, good.username) === 1, 'NEW: an approved user still chats in a live auction');
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made.auctions) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    await s.from('profiles').delete().in('user_id', made.users);
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_chat %')).data.length
      + (await s.from('chat_messages').select('id').like('username', 'zztest_chat_%')).data.length
      + (await s.from('profiles').select('id').in('user_id', made.users)).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
