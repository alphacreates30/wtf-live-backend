// Security review #4: no socket message may crash the server. Handlers destructured their payload, so an event
// sent with no payload threw inside an async handler; with no unhandledRejection handler, Node exited. One
// anonymous socket.emit('place_bid') took the whole backend down.
// OLD is PINNED to 2a89576 (before the fix). Local servers on the test database; Stripe and email blanked.
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const { io } = require(require('path').resolve(BE, '..', 'wtf-live-frontend', 'node_modules', 'socket.io-client'));
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = '2a89576';
const EVENTS = ['join_auction', 'place_bid', 'send_chat', 'block_user', 'start_auction', 'end_auction', 'extend_auction', 'next_item'];
const PAYLOADS = [['nothing', []], ['null', [null]], ['a string', ['x']], ['a number', [42]], ['an array', [[1, 2]]], ['an empty object', [{}]], ['text: 5', [{ auctionId: '00000000-0000-4000-8000-000000000000', text: 5, token: 'x' }]]];
const made = [];

// Anonymous client: sends the given events, then waits a moment.
const send = (url, list) => new Promise(res => {
  const c = io(url, { transports: ['websocket'], reconnection: false });
  c.on('connect', async () => { for (const [ev, args] of list) c.emit(ev, ...args); await sleep(2500); c.close(); res(); });
  c.on('connect_error', () => res());
});
const alive = async srv => { if (!srv.alive()) return false; try { return (await fetch(srv.url + '/version')).ok; } catch { return false; } };
const joinState = (url, auctionId) => new Promise(res => {
  const c = io(url, { transports: ['websocket'], reconnection: false });
  c.on('auction_state', a => { c.close(); res(a); });
  c.on('connect', () => c.emit('join_auction', { auctionId }));
  setTimeout(() => { c.close(); res(null); }, 5000);
});

(async () => {
  const servers = [];
  try {
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE);
    const newSrc = require('./guard').readSource(BE + '/server.js');

    console.log(`== REPRODUCE on ${OLD_COMMIT}: one anonymous place_bid with no payload ==`);
    const oldSrv = await boot('sockrob-old', 3391, oldSrc, { log: true });
    servers.push(oldSrv);
    ok(await alive(oldSrv), 'OLD control: server up before the message');
    await send(oldSrv.url, [['place_bid', []]]);
    await sleep(1000);
    ok(!(await alive(oldSrv)) && /Cannot destructure/.test(oldSrv.log()), `OLD: process exited ("${(oldSrv.log().match(/TypeError[^\n]*/) || [''])[0]}")  <- ONE MESSAGE KILLS THE SERVER`);

    console.log(`\n== FIXED code: every event x ${PAYLOADS.length} bad payloads (${EVENTS.length * PAYLOADS.length} messages), anonymously ==`);
    const newSrv = await boot('sockrob-new', 3392, newSrc, { log: true });
    servers.push(newSrv);
    for (const [label, args] of PAYLOADS) {
      await send(newSrv.url, EVENTS.map(ev => [ev, args]));
      ok(await alive(newSrv), `NEW: all ${EVENTS.length} events with ${label} -> server still up`);
    }
    ok(!/Unhandled rejection/.test(newSrv.log()), 'NEW: no unhandled rejections logged (each handler caught its own error)');

    console.log('\n== FIXED code still serves a normal join ==');
    const a = await s.from('auctions').insert({ title: 'ZZTEST_sockrob live', description: 'x', status: 'live', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single();
    if (a.error) throw new Error(JSON.stringify(a.error));
    made.push(a.data.id);
    const st = await joinState(newSrv.url, a.data.id);
    ok(st && st.id === a.data.id, `NEW: anonymous join_auction still gets auction_state (${st ? st.title : 'nothing'})`);
  } finally {
    servers.forEach(x => x.stop());
    for (const id of made) await s.rpc('delete_auction_cascade', { p_auction_id: id });
    const left = (await s.from('auctions').select('id').like('title', 'ZZTEST_sockrob%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
