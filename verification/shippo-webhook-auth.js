// Security review #9: the Shippo tracking webhook accepted anyone's POST, so knowing a tracking number was enough
// to mark an order delivered (or shipped, which emails the buyer). It now needs ?key=<SHIPPO_WEBHOOK_SECRET> and
// refuses everything when no secret is configured.
// OLD is PINNED to 28457dc (before the fix). Local servers on the test database; Stripe and email blanked.
// The secret is generated here for the local server only and never printed.
const crypto = require('crypto');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '28457dc';
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = [];
const SECRET = crypto.randomBytes(32).toString('hex');

async function mkOrder(label) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_shippo ' + label, description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind' }).select().single());
  made.push(a.id);
  const trk = 'ZZTESTTRK' + crypto.randomBytes(6).toString('hex');
  const o = die(await s.from('orders').insert({ auction_id: a.id, buyer_username: 'zztest_shippo', buyer_user_id: 'zztest-shippo', item_title: 'ZZTEST_shippo order', final_bid: 1, status: 'label_created', tracking_number: trk }).select().single());
  return { id: o.id, trk };
}
const post = (url, query, trk) => fetch(`${url}/webhook/shippo${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'track_updated', data: { tracking_number: trk, tracking_status: { status: 'DELIVERED' } } }) }).then(r => r.status);
const status = async id => die(await s.from('orders').select('status').eq('id', id).single()).status;

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');

    console.log(`== REPRODUCE on ${OLD_COMMIT} ==`);
    const oldSrv = await boot('shippo-old', 3431, oldSrc); servers.push(oldSrv);
    let o = await mkOrder('old');
    let r = await post(oldSrv.url, '', o.trk);
    ok(r === 200 && await status(o.id) === 'delivered', `OLD: an unsigned POST from anyone -> ${r}, order label_created -> ${await status(o.id)}  <- FORGED`);

    console.log('\n== FIXED code, no secret configured: refuses everything ==');
    delete process.env.SHIPPO_WEBHOOK_SECRET;
    const bare = await boot('shippo-nosecret', 3432, newSrc); servers.push(bare);
    o = await mkOrder('no secret');
    r = await post(bare.url, '?key=' + SECRET, o.trk);
    ok(r === 401 && await status(o.id) === 'label_created', `NEW without SHIPPO_WEBHOOK_SECRET: even a keyed call -> ${r}, order untouched`);
    bare.stop();

    console.log('\n== FIXED code with the secret ==');
    process.env.SHIPPO_WEBHOOK_SECRET = SECRET;
    const srv = await boot('shippo-new', 3433, newSrc); servers.push(srv);
    delete process.env.SHIPPO_WEBHOOK_SECRET;
    o = await mkOrder('new');
    for (const [label, q] of [['no key', ''], ['wrong key', '?key=' + crypto.randomBytes(32).toString('hex')], ['empty key', '?key='], ['key as an array', '?key=' + SECRET + '&key=x']]) {
      r = await post(srv.url, q, o.trk);
      ok(r === 401 && await status(o.id) === 'label_created', `NEW ${label}: ${r}, order untouched`);
    }
    r = await post(srv.url, '?key=' + SECRET, o.trk);
    ok(r === 200 && await status(o.id) === 'delivered', `NEW the right key: ${r}, order -> ${await status(o.id)} (Shippo's real updates still work)`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made) { await s.from('orders').delete().eq('auction_id', id); await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_shippo %')).data.length + (await s.from('orders').select('id').like('item_title', 'ZZTEST_shippo%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
