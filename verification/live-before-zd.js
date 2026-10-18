// Live shows phase 2a: the backend runs on production BEFORE migration zd (live shows off there) exactly as before.
// wtf-test has zd, so the suite fakes its absence: every zd column and function name in the server's source is renamed
// to one that doesn't exist (zz_nozd_*). A query that names one then fails the way it would on production
// (PostgREST 42703 / PGRST202), and rows read with '*' simply lack them, as on production.
// LIVE_ENABLED unset (production). Checked: the server boots and its 30-second job runs with nothing in the log; the
// everyday paths of a timed auction (auction, lots, bids, chat, terms, a bid, a pre-bid on a draft refused, /home,
// /config, publish); drafts stay hidden (lots, bids, chat, terms); live socket events answer live_off.
// REPRODUCE: the same with the explicit-column read of an auction's lots that 2a first had (it named rehearsal_key):
// before zd that read fails, the draft check is skipped and a draft's lots are served to anyone.
// THROWAWAY rows only (live-kit, ZZTEST_live_nozd*), cleaned up.
require('./guard')(__filename);
const K = require('./live-kit')('nozd');
const { s, ok, die, ADMIN, mkUser, call, boot, BE, sleep } = K;
process.chdir(BE);
const ZD = ['clock_seconds', 'auto_pace', 'on_hold', 'shown_item_id', 'autostart_at', 'last_host_activity_at', 'ended_at', 'rehearsal_key',
  'sudden_death', 'run_order', 'run_again_of', 'run_again_live_lot'];
const withoutZd = src => ZD.reduce((t, name) => t.replace(new RegExp(`\\b${name}\\b`, 'g'), 'zz_nozd_' + name), src);
// The first 2a version of GET /auction/:id/items (the bug this suite was written for).
const OLD_ITEMS_READ = [[`  const { data: auction } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();   // '*': zz_nozd_rehearsal_key (zd)`,
  `  const { data: auction } = await supabase.from('auctions').select('status, host_username, mode, zz_nozd_rehearsal_key').eq('id', req.params.id).single();`]];
// A log line that means something went wrong (the boot banner and the suite's own requests are fine).
const BAD = /error|failed|unhandled|exception|does not exist|PGRST|42703/i;

(async () => {
  const servers = [];
  try {
    const src = withoutZd(require('./guard').readSource(BE + '/server.js'));
    ok(ZD.every(n => !new RegExp(`\\b${n}\\b`).test(src)) && src.includes('zz_nozd_rehearsal_key'), `every zd name renamed in the server's source (${ZD.length} names)`);
    const B = await mkUser('b');
    const mk = async (label, status) => {
      const a = die(await s.from('auctions').insert({ title: `${K.P} ${label} ${K.TAG}`, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping',
        host_username: 'whatthefind', buyers_premium_pct: 15, starts_at: new Date(Date.now() - 60e3).toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString() }).select().single());
      K.made.auctions.push(a.id);
      const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: `${K.P} lot ${K.TAG}`, starting_bid: 0, current_bid: 0, position: 0, status: 'open',
        ends_at: new Date(Date.now() + 3600e3).toISOString() }).select().single());
      return { id: a.id, lot: lot.id };
    };
    const timed = await mk('timed', 'live'), draft = await mk('draft', 'draft'), toPublish = await mk('publish', 'draft');

    console.log('== The new backend before migration zd (live shows off) ==');
    const srv = await boot('nozd', 3691, src, { log: true });   // timers stubbed: the 30-second job runs once at boot
    servers.push(srv);
    await sleep(6000);   // the boot-time job (close, invoices, reminders, points, live housekeeping)
    const u = srv.url;
    ok((await call(u, 'GET', '/config')).j.live_enabled === false, '/config: live_enabled false');
    for (const p of [`/auction/${timed.id}`, `/auction/${timed.id}/items`, `/auction/${timed.id}/bids`, `/auction/${timed.id}/chat`, '/home', '/auctions', `/lots/${timed.lot}`]) {
      const r = await call(u, 'GET', p);
      ok(r.s === 200, `anonymous GET ${p.replace(timed.id, 'TIMED').replace(timed.lot, 'LOT')} -> ${r.s}`);
    }
    let r = await call(u, 'POST', `/auction/${timed.id}/terms-acceptance`, B, {});
    ok(r.s === 200 && r.j.accepted, `a buyer accepts a timed auction's terms -> ${r.s}`);
    r = await call(u, 'POST', `/auction/${timed.id}/items/${timed.lot}/bid`, B, { max_amount: 5 });
    ok(r.s === 200 && r.j.your_status === 'winning', `and bids -> ${r.s} (${r.j && r.j.your_status})`);
    for (const p of [`/auction/${draft.id}`, `/auction/${draft.id}/items`, `/auction/${draft.id}/bids`, `/auction/${draft.id}/chat`]) {
      ok((await call(u, 'GET', p, B)).s === 404, `a draft stays hidden: GET ${p.replace(draft.id, 'DRAFT')} -> 404`);
    }
    ok((await call(u, 'POST', `/auction/${draft.id}/terms-acceptance`, B, {})).s === 404, 'a draft\'s terms -> 404');
    ok((await call(u, 'GET', `/auction/${draft.id}/items`, ADMIN)).s === 200, 'the admin still reads a draft\'s lots');
    r = await call(u, 'POST', `/auction/${toPublish.id}/publish`, ADMIN);
    ok(r.s === 200 && r.j.status === 'live', `the admin publishes a timed auction -> ${r.s} '${r.j && r.j.status}'`);
    const c = await K.client(u, timed.id, B);
    for (const ev of ['go_live', 'show_lot', 'start_clock', 'end_show']) {
      const e = await K.ask(c, ev, {}, ['host_error', 'host_ok']);
      ok(e && e.payload.code === 'live_off', `live socket event ${ev}: live_off`);
    }
    c.close();
    const bad = srv.log().split('\n').filter(l => BAD.test(l));
    ok(bad.length === 0, `the server's log: ${bad.length ? bad.length + ' bad lines: ' + bad.slice(0, 5).join(' | ') : 'nothing went wrong (boot, the 30-second job, every request above)'}`);
    srv.stop(); servers.length = 0;

    console.log('\n== REPRODUCE: the first 2a read of an auction\'s lots ==');
    const old = await boot('nozd-old', 3692, src, { log: true, patch: OLD_ITEMS_READ });
    servers.push(old);
    r = await call(old.url, 'GET', `/auction/${draft.id}/items`);
    ok(r.s === 200 && Array.isArray(r.j) && r.j.length === 1, `OLD: anonymous GET a draft's lots -> ${r.s}, ${Array.isArray(r.j) ? r.j.length : '?'} lot(s)  <- A DRAFT LEAKS before zd`);
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
