// Live shows phase 5 (wtf-handoff LIVE_SHOWS_PHASE5_BRIEF.md §1; audit §5; migration ze): chat and moderation.
// Checked over sockets on a local server (wtf-test, LIVE_ENABLED=true):
//   the filters on send_chat (links, email addresses, phone numbers, the banned words): refused, never stored or
//   shown to the room, the sender told why; slow mode (per show; the host isn't held by it); the host's mute (no
//   chat, bids fine) vs block (no chat, no bid, no pre-bid, in THIS show only); delete (gone for everyone, from the
//   history too; the row stays with who deleted it); pin (one at a time; the one-tap pinned reply); only the show's
//   host or the admin can moderate; the chat rows the room gets carry no bookkeeping.
// THROWAWAY rows only (live-kit, ZZTEST_live_chatmod*), cleaned up.
require('./guard')(__filename);
const K = require('./live-kit')('chatmod');
const { s, ok, die, ADMIN, mkUser, mkShow, terms, client, ask, call, boot, BE, sleep } = K;
process.chdir(BE);
const filter = require(BE + '/chat_filter');
const HA = ['host_ok', 'host_error'];
const CHAT = ['new_chat', 'chat_error'];
const stored = async (auctionId, text) => die(await s.from('chat_messages').select('*').eq('auction_id', auctionId).eq('text', text));
// Sends a message and waits for the sender's answer: its own new_chat (sent) or chat_error (refused).
async function say(c, text, extra = {}) {
  const from = c.mark();
  c.emit('send_chat', { text, ...extra });
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const hit = c.events.slice(from).find(e => (e.event === 'new_chat' && e.payload.text === text) || e.event === 'chat_error');
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}
// A live lot may close while the suite runs: its charge goes to a stub (nothing reaches Stripe).
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];
const heard = (c, from, text) => c.events.slice(from).some(e => e.event === 'new_chat' && e.payload.text === text);

(async () => {
  const servers = [];
  try {
    const srv = await boot('live-chatmod', 3701, require('./guard').readSource(BE + '/server.js'), { env: { LIVE_ENABLED: 'true' }, timers: 'real', patch: OK_STRIPE });
    servers.push(srv);
    const u = srv.url;
    const host = await mkUser('host'), A = await mkUser('a'), B = await mkUser('b'), W = await mkUser('watcher');
    const show = await mkShow('show', { lots: 2, fields: { host_username: host.username } });
    const other = await mkShow('other', { lots: 1 });
    for (const x of [A, B]) { await terms(x, show.id); await terms(x, other.id); }
    const H = await client(u, show.id, host), ca = await client(u, show.id, A), cb = await client(u, show.id, B), cw = await client(u, show.id, W);
    const anon = await client(u, show.id);
    ok(!!(await ca.waitFor('chat_settings', p => p.slow_mode_seconds === 0 && p.pinned === null && Array.isArray(p.pinned_replies), 3000)),
      'joining a live show: chat_settings (slow mode off, nothing pinned, the built-in pinned replies)');

    console.log('\n== The filters ==');
    const cases = [
      ['a link', 'see my-shop.com for more', 'chat_link'], ['a web address', 'http://example.invalid/x', 'chat_link'], ['www.', 'www.zz-example', 'chat_link'],
      ['an email address', 'write to zz@example.invalid', 'chat_email'], ['a phone number', 'text me 415 555 0134', 'chat_phone'],
      ['a +country number', 'call +44 20 7946 0958', 'chat_phone'], ['a banned word', 'what a sh1t lot', 'chat_word'],
    ];
    for (const [label, text, code] of cases) {
      const from = cw.mark();
      const r = await say(ca, text);
      await sleep(200);
      ok(r && r.event === 'chat_error' && r.payload.code === code && r.payload.message === filter.MESSAGES[code.slice(5)] && !heard(cw, from, text) && !(await stored(show.id, text)).length,
        `${label}: refused (${r && r.payload.code}: "${r && r.payload.message}"); the room never sees it; nothing stored`);
    }
    for (const text of ['Is this real silver?', 'Lot 12 looks great, $1,250 is a steal', 'Scunthorpe class assassin']) {
      const from = cw.mark();
      const r = await say(ca, text);
      await sleep(150);
      ok(r && r.event === 'new_chat' && heard(cw, from, text), `"${text}": sent, the room hears it`);
    }

    console.log('\n== The rows the room gets ==');
    const hist = await (await client(u, show.id)).waitFor('chat_history', () => true, 3000);
    const row = hist && hist.payload.find(m => m.text === 'Is this real silver?');
    ok(row && row.type === 'msg' && row.username === A.username && row.role === 'viewer' && !('flagged' in row) && !('deleted_at' in row) && !('deleted_by' in row),
      `chat_history rows: type msg, username, role; no flagged / deleted_at / deleted_by (${row && Object.keys(row).join(',')})`);
    const live = ca.events.find(e => e.event === 'new_chat' && e.payload.text === 'Is this real silver?');
    ok(live && Object.keys(live.payload).sort().join(',') === 'auction_id,created_at,id,role,text,type,username', `new_chat: the same fields (${live && Object.keys(live.payload).sort().join(',')})`);
    const rest = await call(u, 'GET', `/auction/${show.id}/chat`);
    ok(rest.s === 200 && rest.j.some(m => m.text === 'Is this real silver?' && m.type === 'msg' && !('deleted_by' in m)), 'GET /auction/:id/chat: the same rows');

    console.log('\n== Slow mode ==');
    let r = await ask(H, 'set_slow_mode', { seconds: 5 }, HA);
    ok(r && r.event === 'host_error' && r.payload.code === 'bad_seconds', 'only off, 10 s or 30 s (5: refused)');
    let from = cw.mark();
    r = await ask(H, 'set_slow_mode', { seconds: 10 }, HA);
    ok(r && r.event === 'host_ok' && !!(await cw.waitFor('chat_settings', p => p.slow_mode_seconds === 10, 3000, from)), 'the host sets 10 s: everyone hears chat_settings');
    ok(die(await s.from('auctions').select('slow_mode_seconds').eq('id', show.id).single()).slow_mode_seconds === 10, 'auctions.slow_mode_seconds = 10');
    let r1 = await say(cb, 'first one'), r2 = await say(cb, 'second one');
    ok(r1 && r1.event === 'new_chat' && r2 && r2.event === 'chat_error' && r2.payload.code === 'slow_mode' && r2.payload.wait_seconds > 0 && r2.payload.wait_seconds <= 10,
      `a buyer's second message within 10 s: refused, slow_mode, wait ${r2 && r2.payload.wait_seconds} s`);
    r1 = await say(H, 'host one'); r2 = await say(H, 'host two');
    ok(r1 && r1.event === 'new_chat' && r2 && r2.event === 'new_chat' && r2.payload.role === 'host', 'the host is not held by slow mode (and posts as role host)');
    const cbo = await client(u, other.id, B);
    r1 = await say(cbo, 'in the other show 1'); r2 = await say(cbo, 'in the other show 2');
    ok(r1.event === 'new_chat' && r2.event === 'new_chat', 'slow mode is per show: the other show is not slowed');
    await ask(H, 'set_slow_mode', { seconds: 0 }, HA);
    r = await say(cb, 'slow mode off now');
    ok(r && r.event === 'new_chat', 'slow mode off: the buyer posts again at once');

    console.log('\n== Mute vs block ==');
    from = ca.mark();
    r = await ask(H, 'mute_user', { username: A.username }, HA);
    const told = await ca.waitFor('you_moderated', p => p.mute === true, 3000, from);
    const list = await H.waitFor('moderation_list', p => p.mute.includes(A.username), 3000);
    ok(r && r.event === 'host_ok' && r.payload.username === A.username && told && /muted/.test(told.payload.message) && list,
      `the host mutes @A: host_ok, A hears you_moderated ("${told && told.payload.message}"), the host's moderation_list has A`);
    r = await say(ca, 'can I still talk');
    ok(r && r.event === 'chat_error' && r.payload.code === 'muted' && !(await stored(show.id, 'can I still talk')).length, 'muted: chat refused (muted), nothing stored');
    await ask(H, 'show_lot', {}, HA);
    await ask(H, 'start_clock', { seconds: 60 }, HA);
    await ca.waitFor('show_state', p => p.open, 4000);
    r = await ask(ca, 'place_bid', { max_amount: 5 }, ['bid_ok', 'bid_error']);
    ok(r && r.event === 'bid_ok', `muted: still bids (${r && r.event} ${r && JSON.stringify(r.payload).slice(0, 80)})`);
    from = cb.mark();
    r = await ask(H, 'block_user_show', { username: '@' + B.username }, HA);
    const toldB = await cb.waitFor('you_moderated', p => p.block === true, 3000, from);
    ok(r && r.event === 'host_ok' && toldB && /blocked/.test(toldB.payload.message), `the host blocks @B ("@name" works too): B hears it ("${toldB && toldB.payload.message}")`);
    r = await say(cb, 'am I blocked');
    ok(r && r.event === 'chat_error' && r.payload.code === 'show_blocked', 'blocked: chat refused (show_blocked)');
    r = await ask(cb, 'place_bid', { max_amount: 50 }, ['bid_ok', 'bid_error']);
    ok(r && r.event === 'bid_error' && r.payload.code === 'show_blocked', `blocked: a bid is refused (${r && r.payload.code})`);
    r = await call(u, 'POST', `/auction/${show.id}/items/${show.lots[1]}/prebid`, B, { max_amount: 20 });
    ok(r.s === 403 && r.j.code === 'show_blocked', `blocked: a pre-bid on the next lot is refused (${r.s} ${r.j && r.j.code})`);
    ok(!!(await cb.waitFor('show_state', () => true, 3000)), 'blocked: still in the room, watching');
    r1 = await say(cbo, 'still fine over here');
    r2 = await call(u, 'POST', `/auction/${other.id}/items/${other.lots[0]}/prebid`, B, { max_amount: 20 });
    ok(r1.event === 'new_chat' && r2.s === 200, `a block is for this show only: B chats and pre-bids in another show (${r2.s})`);
    ok(die(await s.from('profiles').select('status').eq('user_id', B.id).single()).status === 'approved',
      "the site-wide standing is untouched (profile still approved; the site-wide block stays the admin's)");
    const reB = await client(u, show.id, B);
    ok(!!(await reB.waitFor('you_moderated', p => p.block === true, 3000)), 'B rejoins: told again that they are blocked');
    reB.close();
    const rows = die(await s.from('live_moderation').select('kind, by').eq('auction_id', show.id));
    ok(rows.length === 2 && rows.every(x => x.by === host.username), `live_moderation: 2 rows (mute, block), by the host (${rows.map(x => x.kind).join(',')})`);
    r = await ask(H, 'mute_user', { username: A.username, on: false }, HA);
    r1 = await say(ca, 'back again');
    ok(r && r.event === 'host_ok' && r.payload.on === false && r1 && r1.event === 'new_chat', 'unmute: A chats again');
    r = await ask(H, 'block_user_show', { username: B.username, on: false }, HA);
    r1 = await say(cb, 'unblocked now');
    ok(r1 && r1.event === 'new_chat', 'unblock: B chats again');
    r = await ask(H, 'mute_user', { username: host.username }, HA);
    const r3 = await ask(H, 'block_user_show', { username: 'whatthefind' }, HA);
    const r4 = await ask(H, 'mute_user', { username: 'zz_nobody_' + K.TAG }, HA);
    ok(r.payload.code === 'is_host' && r3.payload.code === 'is_host' && r4.payload.code === 'not_found', "the host can't mute themselves or the admin; an unknown username: not_found");

    console.log('\n== Delete ==');
    const doomed = (await say(ca, 'delete me please')).payload;
    const fromA = ca.mark(), fromW = cw.mark(), fromAnon = anon.mark();
    r = await ask(H, 'delete_message', { messageId: doomed.id }, HA);
    const gone = await Promise.all([ca, cw, anon].map((c, i) => c.waitFor('chat_deleted', p => p.id === doomed.id, 3000, [fromA, fromW, fromAnon][i])));
    ok(r && r.event === 'host_ok' && gone.every(Boolean), 'the host deletes a message: everyone (the writer, a buyer, a guest) hears chat_deleted');
    const d = (await stored(show.id, 'delete me please'))[0];
    ok(d && d.deleted_at && d.deleted_by === host.username, 'the row stays, with deleted_at and deleted_by = the host');
    const hist2 = (await (await client(u, show.id)).waitFor('chat_history', () => true, 3000)).payload;
    const rest2 = (await call(u, 'GET', `/auction/${show.id}/chat`)).j;
    ok(!hist2.some(m => m.id === doomed.id) && !rest2.some(m => m.id === doomed.id), 'gone from chat_history and GET /chat');
    r = await ask(H, 'delete_message', { messageId: doomed.id }, HA);
    ok(r && r.payload.code === 'not_found', 'deleting it again: not_found');

    console.log('\n== Pin ==');
    const m1 = (await say(ca, 'pin this one')).payload, m2 = (await say(cw, 'no, pin this one')).payload;
    from = anon.mark();
    r = await ask(H, 'pin_message', { messageId: m1.id }, HA);
    let pinned = await anon.waitFor('chat_settings', p => p.pinned && p.pinned.id === m1.id, 3000, from);
    ok(r && r.event === 'host_ok' && pinned && pinned.payload.pinned.username === A.username && !('deleted_by' in pinned.payload.pinned), 'the host pins a message: everyone hears chat_settings with it');
    from = anon.mark();
    await ask(H, 'pin_message', { messageId: m2.id }, HA);
    pinned = await anon.waitFor('chat_settings', p => p.pinned && p.pinned.id === m2.id, 3000, from);
    const pinRows = die(await s.from('chat_messages').select('id').eq('auction_id', show.id).eq('pinned', true));
    ok(pinned && pinRows.length === 1 && pinRows[0].id === m2.id, 'pinning another: it replaces the first (one pinned at a time)');
    from = anon.mark();
    await ask(H, 'pin_message', { messageId: null }, HA);
    ok(!!(await anon.waitFor('chat_settings', p => p.pinned === null, 3000, from)), 'unpin: nothing pinned');
    from = anon.mark();
    const reply = filter.PINNED_REPLIES[0];
    r = await say(H, reply, { pin: true });
    pinned = await anon.waitFor('chat_settings', p => p.pinned && p.pinned.text === reply, 3000, from);
    ok(r && r.event === 'new_chat' && pinned && pinned.payload.pinned.role === 'host', `a one-tap pinned reply ("${reply}"): posted by the host and pinned`);
    ok(filter.PINNED_REPLIES.join(' | ') === "Everything you win in this show ships together in one box. | Bids are binding: your card is charged when the lot sells. | No buyer's premium in live shows.",
      'the three built-in replies (placeholder wording)');
    from = anon.mark();
    r = await say(ca, 'buyers cannot pin', { pin: true });
    await sleep(500);
    ok(r && r.event === 'new_chat' && !anon.events.slice(from).some(e => e.event === 'chat_settings' && e.payload.pinned && e.payload.pinned.text === 'buyers cannot pin'), 'a buyer sending pin: true: the message posts, nothing is pinned');
    const pinnedMsg = (await stored(show.id, reply))[0];
    from = anon.mark();
    await ask(H, 'delete_message', { messageId: pinnedMsg.id }, HA);
    ok(!!(await anon.waitFor('chat_settings', p => p.pinned === null, 3000, from)), 'deleting the pinned message unpins it');

    console.log('\n== Only the host or the admin ==');
    const before = die(await s.from('chat_messages').select('id, deleted_at, pinned').eq('auction_id', show.id));
    const target = (await say(cw, 'try to delete me')).payload;
    for (const [ev, payload] of [['delete_message', { messageId: target.id }], ['pin_message', { messageId: target.id }], ['set_slow_mode', { seconds: 30 }],
      ['mute_user', { username: W.username }], ['block_user_show', { username: W.username }], ['get_moderation', {}]]) {
      const x = await ask(ca, ev, payload, HA);
      ok(x && x.event === 'host_error' && /Only the host/.test(x.payload.message), `a buyer: ${ev} refused ("${x && x.payload.message}")`);
    }
    const anonTry = await ask(anon, 'delete_message', { messageId: target.id }, HA);
    ok(anonTry && anonTry.event === 'host_error', 'a guest: refused too');
    const x = await ask(H, 'set_slow_mode', { auctionId: other.id, seconds: 10 }, HA);
    const y = await ask(H, 'mute_user', { auctionId: other.id, username: W.username }, HA);
    ok(x && x.event === 'host_error' && /Only the host/.test(x.payload.message) && y && y.event === 'host_error', "this show's host can't moderate another host's show");
    const hostOfOther = await client(u, show.id, ADMIN);
    const z = await ask(hostOfOther, 'set_slow_mode', { seconds: 30 }, HA);
    ok(z && z.event === 'host_ok', 'the admin can moderate any show');
    await ask(hostOfOther, 'set_slow_mode', { seconds: 0 }, HA);
    hostOfOther.close();
    const after = die(await s.from('chat_messages').select('id, deleted_at, pinned').eq('id', target.id).single());
    ok(!after.deleted_at && !after.pinned && before.length > 0, "the buyer's attempts changed nothing");

    console.log('\n== The rooms (code) ==');
    const FE = require('path').join(BE, '..', 'wtf-live-frontend', 'src', 'live');
    const hostRoom = require('fs').readFileSync(FE + '/LiveHostRoom.jsx', 'utf8'), viewer = require('fs').readFileSync(FE + '/LiveViewerRoom.jsx', 'utf8');
    ok(['delete_message', 'pin_message', 'mute_user', 'block_user_show', 'set_slow_mode'].every(e => hostRoom.includes(`'${e}'`)) && /onMod\('get_moderation'\)|emit\('get_moderation'\)/.test(hostRoom)
      && /SLOW_MODES = \[0, 10, 30\]/.test(hostRoom) && /tab === 'q'/.test(hostRoom) && /\\\?\\s\*\$/.test(hostRoom),
      'host chat sheet: Delete, Pin, Mute, Block, slow mode (off / 10 / 30), the Questions tab (messages ending in "?")');
    ok(/cfg\.pinned_replies/.test(hostRoom) && /onSend\(r, true\)/.test(hostRoom) && /OWN_REPLIES_KEY/.test(hostRoom), "host: one-tap pinned replies (the server's three, plus the host's own on this device)");
    ok(/chat_deleted: \(\{ id \}\) => setChat\(list => list\.filter/.test(viewer) && /chat_settings: c => setChatCfg\(c\)/.test(viewer) && /chat_error: e => setChatErr/.test(viewer) && /you_moderated:/.test(viewer),
      'viewer room: removes deleted messages, shows the pinned one, tells the sender why a message was refused, shows mute / block');

    for (const c of [H, ca, cb, cw, anon, cbo]) c.close();
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
