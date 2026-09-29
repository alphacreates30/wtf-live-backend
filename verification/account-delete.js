// A5 "Delete my account" (DELETE_ACCOUNT_BRIEF.md): a clean deletion, end to end.
// Personal fields empty; old session rejected; login impossible; Stripe cards detached and customer deleted;
// orders/invoices intact with totals unchanged; username replaced everywhere; old username blocked for 30 days (only
// a hash kept); audit row; confirmation email to the address that was on file; the buyer's data in no API response
// (anonymous, another buyer, admin); admin sees "Deleted account" and can't bring it back.
// Needs migration 2026-09-30t on the test database. Local server; Stripe is an in-process fake that records calls,
// and Resend a stub inside the server process that records sends - nothing leaves the machine.
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE, sleep } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const PW = 'correct-horse-delete', tag = Date.now().toString(36);
const CALLS = BE + '/run.tmp-del-stripe.log', MAIL = BE + '/run.tmp-del-mail.log';
const STRIPE_LINE = 'const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;';
const FAKE_STRIPE = `const __log = (op, id) => require('fs').appendFileSync(${JSON.stringify(CALLS)}, op + ' ' + id + '\\n');
const stripe = { paymentMethods: { list: async (q) => { __log('list', q.customer); return { data: [{ id: 'pm_ZZFAKE_1' }, { id: 'pm_ZZFAKE_2' }] }; }, detach: async (id) => { __log('detach', id); return {}; } },
  customers: { del: async (id) => { __log('del', id); return { deleted: true }; } } };`;
const RESEND_STUB = `
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.resend.com')) return realFetch(url, opts);
  const b = JSON.parse(opts.body || '{}');
  require('fs').appendFileSync(${JSON.stringify(MAIL)}, JSON.stringify({ to: b.to, subject: b.subject }) + '\\n');
  return new Response(JSON.stringify({ id: 'zztest' }), { status: 200 });
};`;
const OPTS = { env: { RESEND_API_KEY: 're_zztest_stub' }, preload: RESEND_STUB, patch: [[STRIPE_LINE, FAKE_STRIPE]] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { users: [], auctions: [] };
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
const sha = v => crypto.createHash('sha256').update(v).digest('hex');

async function buyer(label, extra = {}) {
  const u = die(await s.from('users').insert({ username: `zzdel_${label}_${tag}`, password_hash: await bcrypt.hash(PW, 10), email: `zzdel-${label}-${tag}@mail.example.com` }).select().single());
  made.users.push(u.id);
  const prof = { user_id: String(u.id), full_name: `Zelda Deletable ${label}`, email: u.email, phone: label === 'd' ? '5555550199' : '5555550288', address_line1: `42 Private Lane ${label}`, address_line2: 'Apt 7', city: 'Secretville', state: 'CA', zip: '94999', status: 'approved', payment_status: 'ok', stripe_customer_id: `cus_ZZFIXTURE_del_${label}_${tag}`, stripe_payment_method_id: 'pm_ZZFIXTURE_del', ...extra };
  die(await s.from('profiles').insert(prof).select().single());
  return { ...u, prof, tok: jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}
const call = (url, method, p, tok, body) => fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ s: r.status, text: await r.text() }));

// D's history: a finished sale (paid invoice, delivered order with its shipping address), bids, a max bid and the
// lead on a now-closed lot, chat, an outbid-log row, a reset link, a terms acceptance. E is another buyer.
async function history(D, E) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_del sold', description: 'x', status: 'ended', mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', leading_bidder: D.username, current_bid: 10 }).select().single());
  made.auctions.push(a.id);
  const lot = die(await s.from('auction_items').insert({ auction_id: a.id, title: 'ZZTEST_del lot', starting_bid: 0, current_bid: 10, bid_count: 2, leading_bidder: D.username, position: 0, status: 'sold' }).select().single());
  die(await s.from('bids').insert([{ auction_id: a.id, item_id: lot.id, username: D.username, amount: 10 }, { auction_id: a.id, item_id: lot.id, username: E.username, amount: 9 }]).select());
  die(await s.from('pre_bids').insert({ item_id: lot.id, auction_id: a.id, buyer_username: D.username, buyer_user_id: String(D.id), max_amount: 12 }).select().single());
  die(await s.from('chat_messages').insert({ auction_id: a.id, username: D.username, text: 'ZZTEST hello from D', role: 'bidder' }).select().single());
  die(await s.from('outbid_email_log').insert({ item_id: lot.id, username: D.username, last_sent_at: new Date().toISOString() }).select().single());
  die(await s.from('password_resets').insert({ user_id: D.id, token_hash: 'zz_' + D.id, expires_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  die(await s.from('auction_terms_acceptances').insert({ auction_id: a.id, user_id: String(D.id), buyers_premium_pct: 15, fulfillment_mode: 'shipping', fulfillment_choice: 'shipping', terms_version: '1' }).select().single());
  const inv = die(await s.from('invoices').insert({ auction_id: a.id, buyer_user_id: String(D.id), buyer_username: D.username, total_cents: 1150, payment_status: 'paid', payment_intent_id: 'pi_ZZTEST_del' }).select().single());
  const ord = die(await s.from('orders').insert({ auction_id: a.id, item_id: lot.id, invoice_id: inv.id, buyer_username: D.username, buyer_user_id: String(D.id), item_title: 'ZZTEST_del order', final_bid: 10, hammer_cents: 1000, premium_cents: 150, total_cents: 1150, status: 'delivered', payment_status: 'paid', payment_intent_id: 'pi_ZZTEST_del', ship_name: D.prof.full_name, ship_address1: D.prof.address_line1, ship_city: 'Secretville', ship_state: 'CA', ship_zip: '94999' }).select().single());
  return { a: a.id, lot: lot.id, inv: inv.id, ord: ord.id };
}

(async () => {
  let srv;
  try {
    for (const f of [CALLS, MAIL]) { try { fs.unlinkSync(f); } catch {} }
    const D = await buyer('d'), E = await buyer('e');
    const H = await history(D, E);
    const before = { orders: die(await s.from('orders').select('id, total_cents, hammer_cents, premium_cents').eq('buyer_user_id', String(D.id))), invoices: die(await s.from('invoices').select('id, total_cents, payment_status').eq('buyer_user_id', String(D.id))) };
    srv = await boot('delete-new', 3571, require('./guard').readSource(BE + '/server.js'), OPTS);
    ok((await call(srv.url, 'GET', '/profile', D.tok)).s === 200, 'before: D\'s session works');

    console.log('== D deletes their account ==');
    let r = await call(srv.url, 'POST', '/account/delete', D.tok, { password: PW, confirm: 'DELETE' });
    ok(r.s === 200 && JSON.parse(r.text).deleted === true, `POST /account/delete -> ${r.s} ${r.text}`);
    const newName = 'deleted_' + String(D.id).replace(/-/g, '').slice(0, 12);

    console.log('\n== personal data gone ==');
    const u = die(await s.from('users').select('*').eq('id', D.id).single());
    ok(u.username === newName && u.email === null && u.deleted_at && u.password_hash === 'account-deleted' && Date.now() - Date.parse(u.password_changed_at) < 60e3, `users row: username ${u.username}, email ${u.email}, unusable password, deleted_at set, sessions ended`);
    const p = die(await s.from('profiles').select('*').eq('user_id', String(D.id)).single());
    ok(!p.full_name && !p.phone && !p.address_line1 && !p.address_line2 && !p.city && !p.state && !p.zip && p.email === null && !p.stripe_customer_id && !p.stripe_payment_method_id && p.status === 'blocked', `profile: every personal field empty, no card, status '${p.status}' (can't bid)`);
    ok(!(await s.from('password_resets').select('id').eq('user_id', D.id)).data.length && !(await s.from('outbid_email_log').select('item_id').eq('username', D.username)).data.length, 'reset links and outbid-log rows removed');
    const calls = lines(CALLS);
    ok(calls.join('|') === [`list ${D.prof.stripe_customer_id}`, 'detach pm_ZZFAKE_1', 'detach pm_ZZFAKE_2', `del ${D.prof.stripe_customer_id}`].join('|'), `Stripe: both saved cards detached, then the customer deleted (${calls.length} calls)`);

    console.log('\n== signed out, can\'t come back ==');
    r = await call(srv.url, 'GET', '/profile', D.tok);
    ok(r.s === 401, `the old session is rejected (${r.s})`);
    ok((await call(srv.url, 'POST', '/auth/login', null, { username: D.username, password: PW })).s === 401 && (await call(srv.url, 'POST', '/auth/login', null, { username: newName, password: PW })).s === 401, 'login impossible: old username and the placeholder both 401');
    ok((await call(srv.url, 'POST', '/auth/forgot-password', null, { identifier: D.email })).s === 200 && !(await s.from('password_resets').select('id').eq('user_id', D.id)).data.length, 'a reset request for the old email sends nothing (no account has it)');

    console.log('\n== sale records kept, username replaced everywhere ==');
    const after = { orders: die(await s.from('orders').select('id, total_cents, hammer_cents, premium_cents, buyer_username, ship_name, ship_address1').eq('buyer_user_id', String(D.id))), invoices: die(await s.from('invoices').select('id, total_cents, payment_status, buyer_username').eq('buyer_user_id', String(D.id))) };
    ok(after.orders.length === before.orders.length && after.invoices.length === before.invoices.length && after.orders.every(o => before.orders.some(b => b.id === o.id && b.total_cents === o.total_cents && b.hammer_cents === o.hammer_cents && b.premium_cents === o.premium_cents)) && after.invoices.every(i => before.invoices.some(b => b.id === i.id && b.total_cents === i.total_cents && b.payment_status === i.payment_status)), `orders (${after.orders.length}) and invoices (${after.invoices.length}) intact, totals unchanged`);
    ok(after.orders[0].ship_name === D.prof.full_name && after.orders[0].ship_address1 === D.prof.address_line1, 'the completed order keeps its shipping address (accounting/tax record, as the brief says)');
    const where = { bids: (await s.from('bids').select('username').eq('auction_id', H.a)).data.map(x => x.username), pre: (await s.from('pre_bids').select('buyer_username').eq('item_id', H.lot)).data[0].buyer_username, chat: (await s.from('chat_messages').select('username').eq('auction_id', H.a)).data[0].username, lot: die(await s.from('auction_items').select('leading_bidder').eq('id', H.lot).single()).leading_bidder, auction: die(await s.from('auctions').select('leading_bidder').eq('id', H.a).single()).leading_bidder };
    ok(where.bids.includes(newName) && where.bids.includes(E.username) && !where.bids.includes(D.username) && where.pre === newName && where.chat === newName && where.lot === newName && where.auction === newName && after.orders.every(o => o.buyer_username === newName) && after.invoices.every(i => i.buyer_username === newName), `"${D.username}" replaced by "${newName}" in bids, pre-bids, chat, lot and auction leader, orders, invoices; E's bid untouched`);
    ok((await s.from('auction_terms_acceptances').select('user_id').eq('user_id', String(D.id))).data.length === 1, 'the terms acceptance (no personal fields) stays as the record of what was agreed');
    const audit = (await s.from('account_deletions').select('user_id, deleted_at').eq('user_id', D.id)).data;
    ok(audit.length === 1 && Object.keys(audit[0]).length === 2, 'audit trail: one account_deletions row, user id and time only');

    console.log('\n== old username held for 30 days (only a hash) ==');
    const held = (await s.from('reserved_usernames').select('*').eq('username_hash', sha(D.username.toLowerCase()))).data;
    const days = held.length ? (Date.parse(held[0].reserved_until) - Date.now()) / 864e5 : 0;
    ok(held.length === 1 && days > 29.9 && days <= 30.01 && !JSON.stringify(held).includes(D.username), `reserved for ${days.toFixed(2)} days, stored as a SHA-256 (no plain username)`);
    for (const name of [D.username, D.username.toUpperCase()]) {
      r = await call(srv.url, 'POST', '/auth/register', null, { username: name, password: PW, email: 'zz@example.invalid' });
      ok(r.s === 409, `re-register "${name}" -> ${r.s} ${r.text}`);
    }
    r = await call(srv.url, 'POST', '/auth/register', null, { username: 'deleted_abc123', password: PW, email: 'zz@example.invalid' });
    ok(r.s === 400, `nobody can register a "deleted_" name (${r.s})`);

    console.log('\n== confirmation email ==');
    for (let i = 0; i < 10 && !lines(MAIL).length; i++) await sleep(300);
    const mail = lines(MAIL).map(JSON.parse);
    ok(mail.length === 1 && mail[0].to === D.email && /deleted/.test(mail[0].subject), `sent to the address that was on file: ${mail[0] && mail[0].subject}`);

    console.log('\n== D\'s data in no API response ==');
    const pii = [D.username, D.email, D.prof.phone, D.prof.full_name, D.prof.address_line1, D.prof.stripe_customer_id];
    const found = text => pii.filter(v => text.includes(v));
    const admin = jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const reads = ['/auctions', `/auction/${H.a}`, `/auction/${H.a}/items`, `/auction/${H.a}/items/standard-status`, `/auction/${H.a}/bids`, `/auction/${H.a}/chat`];
    for (const [who, tok, extra] of [['anonymous', null, []], ['another buyer (E)', E.tok, ['/my-bids', '/my-orders', '/profile']], ['admin', admin, ['/admin/buyers']]]) {
      const leaks = [];
      for (const p of [...reads, ...extra]) { const x = await call(srv.url, 'GET', p, tok); const f = found(x.text); if (f.length) leaks.push(`${p}: ${f.join(', ')}`); }
      ok(!leaks.length, `${who}: none of D's details in ${reads.length + extra.length} responses${leaks.length ? ' - ' + leaks.join(' | ') : ''}`);
    }
    const ao = await call(srv.url, 'GET', `/admin/orders?auction_id=${H.a}`, admin);
    ok(!found(ao.text).some(v => v !== D.prof.full_name && v !== D.prof.address_line1) && ao.text.includes(newName), 'admin orders: no username, email, phone or Stripe id - shows the placeholder; the completed order\'s shipping name/address is the kept tax record');

    console.log('\n== admin side ==');
    const buyers = JSON.parse((await call(srv.url, 'GET', '/admin/buyers', admin)).text);
    const row = buyers.find(b => b.user_id === String(D.id));
    ok(row && row.deleted === true && !row.full_name && !row.email && !row.phone, 'the buyers list marks D as deleted, with no personal data');
    r = await call(srv.url, 'PATCH', `/admin/buyers/${D.id}`, admin, { status: 'approved' });
    ok(r.s === 409 && die(await s.from('profiles').select('status').eq('user_id', String(D.id)).single()).status === 'blocked', `admin can't re-approve it (${r.s})`);
    r = await call(srv.url, 'POST', `/admin/users/${D.id}/password`, admin, { new_password: 'a-new-password-1' });
    ok(r.s === 409 && die(await s.from('users').select('password_hash').eq('id', D.id).single()).password_hash === 'account-deleted', `admin can't give it a temporary password (${r.s})`);
    r = await call(srv.url, 'POST', '/account/delete', D.tok, { password: PW, confirm: 'DELETE' });
    ok(r.s === 401, `deleting again with the old session -> ${r.s}`);
    ok(die(await s.from('profiles').select('full_name').eq('user_id', String(E.id)).single()).full_name === E.prof.full_name, 'E\'s own account is untouched');
  } finally {
    if (srv) srv.stop();
    for (const f of [CALLS, MAIL]) { try { fs.unlinkSync(f); } catch {} }
    for (const id of made.auctions) { await s.from('orders').delete().eq('auction_id', id); await s.from('invoices').delete().eq('auction_id', id); await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    await s.from('account_deletions').delete().in('user_id', made.users);
    await s.from('password_resets').delete().in('user_id', made.users);
    await s.from('profiles').delete().in('user_id', made.users.map(String));
    await s.from('users').delete().in('id', made.users);
    await s.from('reserved_usernames').delete().in('username_hash', ['d', 'e'].map(l => sha(`zzdel_${l}_${tag}`)));
    const left = (await s.from('users').select('id').in('id', made.users)).data.length + (await s.from('auctions').select('id').like('title', 'ZZTEST_del %')).data.length
      + (await s.from('account_deletions').select('id').in('user_id', made.users)).data.length + (await s.from('reserved_usernames').select('username_hash')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
