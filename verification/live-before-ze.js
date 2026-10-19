// Live shows phase 5/6: the backend runs on production BEFORE migration ze (live shows off there) exactly as before.
// Same method as live-before-zd.js: wtf-test has ze, so the suite fakes its absence by renaming every ze name in the
// server's source to one that doesn't exist (zz_noze_*): a query that names one fails the way it would before ze, and
// rows read with '*' simply lack the columns. (chat_messages.deleted_at is renamed only where the chat uses it:
// users.deleted_at is older and stays.)
// LIVE_ENABLED unset (production). Checked: the server boots and its 30-second job (with the reminders) runs with
// nothing in the log; a timed auction's chat works (sent, heard by the room, stored, in GET /chat and in the history
// on join) and the new filters apply to it; a timed bid; /home and /config; the new host chat events answer live_off.
// THROWAWAY rows only (live-kit, ZZTEST_live_noze*), cleaned up.
require('./guard')(__filename);
const K = require('./live-kit')('noze');
const { s, ok, die, ADMIN, mkUser, mkStandard, terms, client, ask, call, boot, BE, sleep } = K;
process.chdir(BE);
const WORDS = ['live_moderation', 'slow_mode_seconds', 'deleted_by', 'pinned', 'queue_show_live', 'show_live'];
// [text in the source, how many times, its replacement]: the chat's own uses of deleted_at.
const CHAT_DELETED_AT = [[".is('deleted_at', null)", 3, ".is('zz_noze_deleted_at', null)"], ['{ deleted_at: new Date().toISOString(), deleted_by', 1, '{ zz_noze_deleted_at: new Date().toISOString(), deleted_by'],
  ['m.deleted_at', 1, 'm.zz_noze_deleted_at']];
function withoutZe(src) {
  let t = src;
  for (const [a, n, b] of CHAT_DELETED_AT) { if (t.split(a).length - 1 !== n) throw new Error(`expected ${n}x ${a}`); t = t.split(a).join(b); }
  return WORDS.reduce((x, name) => x.replace(new RegExp(`\\b${name}\\b`, 'g'), 'zz_noze_' + name), t);
}
const BAD = /error|failed|unhandled|exception|does not exist|PGRST|42703|42P01/i;

(async () => {
  const servers = [];
  try {
    const src = withoutZe(require('./guard').readSource(BE + '/server.js'));
    ok(WORDS.every(n => !new RegExp(`\\b${n}\\b`).test(src)) && !/\.is\('deleted_at', null\)/.test(src) && src.includes('zz_noze_live_moderation'),
      `every ze name renamed in the server's source (${WORDS.length} names, and the chat's deleted_at)`);
    const B = await mkUser('b'), W = await mkUser('w');
    const timed = await mkStandard('timed');
    const lot = die(await s.from('auction_items').insert({ auction_id: timed, title: `${K.P} lot ${K.TAG}`, starting_bid: 0, current_bid: 0, position: 0, status: 'open',
      ends_at: new Date(Date.now() + 3600e3).toISOString() }).select().single()).id;
    await terms(B, timed, 15);

    console.log('== The new backend before migration ze (live shows off) ==');
    const srv = await boot('noze', 3693, src, { log: true });   // timers stubbed: the 30-second job runs once at boot
    servers.push(srv);
    await sleep(6000);   // the boot-time job (close, invoices, reminders, points, live housekeeping)
    const u = srv.url;
    ok((await call(u, 'GET', '/config')).j.live_enabled === false, '/config: live_enabled false');
    for (const p of [`/auction/${timed}`, `/auction/${timed}/items`, `/auction/${timed}/chat`, '/home', '/auctions']) {
      const r = await call(u, 'GET', p);
      ok(r.s === 200, `anonymous GET ${p.replace(timed, 'TIMED')} -> ${r.s}`);
    }
    const cb = await client(u, timed, B), cw = await client(u, timed, W);
    let from = cw.mark();
    cb.emit('send_chat', { text: 'ZZ before ze hello' });
    ok(!!(await cw.waitFor('new_chat', p => p.text === 'ZZ before ze hello' && p.type === 'msg', 4000, from)), "a timed auction's chat: the room hears the message");
    ok(die(await s.from('chat_messages').select('id').eq('auction_id', timed).eq('text', 'ZZ before ze hello')).length === 1, 'and it is stored');
    const r = await ask(cb, 'send_chat', { text: 'see zz-shop.com' }, ['chat_error', 'new_chat']);
    ok(r && r.event === 'chat_error' && r.payload.code === 'chat_link', 'the filters apply to timed chat too (a link: refused)');
    const rest = await call(u, 'GET', `/auction/${timed}/chat`);
    ok(rest.s === 200 && rest.j.some(m => m.text === 'ZZ before ze hello'), 'GET /auction/:id/chat has it');
    const again = await client(u, timed, W);
    const hist = await again.waitFor('chat_history', () => true, 3000);
    ok(hist && hist.payload.some(m => m.text === 'ZZ before ze hello'), 'the chat history on join has it');
    again.close();
    const bid = await call(u, 'POST', `/auction/${timed}/items/${lot}/bid`, B, { max_amount: 5 });
    ok(bid.s === 200 && bid.j.your_status === 'winning', `a timed bid -> ${bid.s}`);
    for (const ev of ['mute_user', 'block_user_show', 'delete_message', 'pin_message', 'set_slow_mode', 'get_moderation']) {
      const e = await ask(cb, ev, { username: W.username, messageId: null, seconds: 10 }, ['host_error', 'host_ok']);
      ok(e && e.payload.code === 'live_off', `host chat event ${ev}: live_off`);
    }
    cb.close(); cw.close();
    const bad = srv.log().split('\n').filter(l => BAD.test(l));
    ok(bad.length === 0, `the server's log: ${bad.length ? bad.length + ' bad lines: ' + bad.slice(0, 5).join(' | ') : 'nothing went wrong (boot, the 30-second job, every request above)'}`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
