// A5 "Delete my account" (DELETE_ACCOUNT_BRIEF.md): every case where deletion must be refused - and change nothing.
// Refused while the buyer leads an open lot, has a max bid on an open lot, has an unpaid/failed invoice, or has an
// order not yet shipped/collected; also on a wrong password, without the typed DELETE, and for the admin.
// OLD is PINNED to c96a5a1 (before A5): the route doesn't exist (404). Needs migration 2026-09-30t on the test
// database. Local servers; Stripe is an in-process fake that records calls (none may happen here); no email is sent.
const crypto = require('crypto');
const fs = require('fs');
require('./guard')(__filename);
const boot = require('./local-server');
const { BE } = boot;
process.chdir(BE);
const jwt = require(BE + '/node_modules/jsonwebtoken');
const bcrypt = require(BE + '/node_modules/bcryptjs');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OLD_COMMIT = 'c96a5a1', PW = 'correct-horse-delete';
const CALLS = BE + '/run.tmp-delrefuse-stripe.log';
const STRIPE_LINE = 'const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;';
const FAKE_STRIPE = `const __log = (op, id) => require('fs').appendFileSync(${JSON.stringify(CALLS)}, op + ' ' + id + '\\n');
const stripe = { paymentMethods: { list: async (q) => { __log('list', q.customer); return { data: [{ id: 'pm_ZZFAKE_1' }] }; }, detach: async (id) => { __log('detach', id); return {}; } },
  customers: { del: async (id) => { __log('del', id); return { deleted: true }; } } };`;
const OPTS = { patch: [[STRIPE_LINE, FAKE_STRIPE]] };
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const made = { users: [], auctions: [] };
const tag = Date.now().toString(36);
const stripeCalls = () => fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : [];

async function buyer(label) {
  const u = die(await s.from('users').insert({ username: `zzdel_${label}_${tag}`, password_hash: await bcrypt.hash(PW, 10), email: `zzdel-${label}-${tag}@mail.example.com` }).select().single());
  made.users.push(u.id);
  die(await s.from('profiles').insert({ user_id: String(u.id), full_name: 'ZZ Delete ' + label, email: u.email, phone: '5555550100', address_line1: '1 ZZ St', city: 'Testville', state: 'CA', zip: '94000', status: 'approved', payment_status: 'ok', stripe_customer_id: 'cus_ZZFIXTURE_del_' + label, stripe_payment_method_id: 'pm_ZZFIXTURE_del' }).select().single());
  return { ...u, tok: jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}
async function auction(label, status) {
  const a = die(await s.from('auctions').insert({ title: 'ZZTEST_delrefuse ' + label, description: 'x', status, mode: 'standard', fulfillment_mode: 'shipping', host_username: 'whatthefind', ends_at: new Date(Date.now() + 36e5).toISOString() }).select().single());
  made.auctions.push(a.id); return a.id;
}
const lot = async (a, fields) => die(await s.from('auction_items').insert({ auction_id: a, title: 'ZZTEST_delrefuse lot', starting_bid: 0, current_bid: 5, position: 0, status: 'open', ends_at: new Date(Date.now() + 36e5).toISOString(), ...fields }).select().single()).id;
const del = (url, u, body) => fetch(url + '/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + u.tok }, body: JSON.stringify(body) })
  .then(async r => ({ s: r.status, j: await r.json().catch(() => ({})) }));
// "Nothing changed": the account and profile still hold their personal data, not deleted, password still works.
async function untouched(u) {
  const row = die(await s.from('users').select('username, email, password_hash, deleted_at').eq('id', u.id).single());
  const p = die(await s.from('profiles').select('full_name, email, stripe_customer_id, status').eq('user_id', String(u.id)).single());
  return row.username === u.username && row.email === u.email && !row.deleted_at && await bcrypt.compare(PW, row.password_hash)
    && p.full_name.startsWith('ZZ Delete') && p.email === u.email && p.stripe_customer_id && p.status === 'approved';
}

(async () => {
  const servers = [];
  try {
    try { fs.unlinkSync(CALLS); } catch {}
    const oldSrc = require('./guard').sourceAt(OLD_COMMIT, BE), newSrc = require('./guard').readSource(BE + '/server.js');
    const oldSrv = await boot('delrefuse-old', 3561, oldSrc, OPTS), srv = await boot('delrefuse-new', 3562, newSrc, OPTS);
    servers.push(oldSrv, srv);

    console.log(`== CONTROL on ${OLD_COMMIT}: there is no way to delete an account ==`);
    const plain = await buyer('plain');
    ok((await del(oldSrv.url, plain, { password: PW, confirm: 'DELETE' })).s === 404, 'OLD: POST /account/delete -> 404 (the feature did not exist)');

    console.log('\n== FIXED code: each "not yet" case refuses and changes nothing ==');
    const other = await buyer('other');
    // leads an open lot
    const lead = await buyer('leading'), aLive = await auction('leading', 'live');
    await lot(aLive, { leading_bidder: lead.username, bid_count: 1 });
    // has a max bid on an open lot someone else leads
    const maxb = await buyer('maxbid'), aMax = await auction('maxbid', 'live');
    const lMax = await lot(aMax, { leading_bidder: other.username, bid_count: 1 });
    die(await s.from('pre_bids').insert({ item_id: lMax, auction_id: aMax, buyer_username: maxb.username, buyer_user_id: String(maxb.id), max_amount: 4 }).select().single());
    // an invoice whose payment failed
    const unpaid = await buyer('unpaid'), aEnd = await auction('unpaid', 'ended');
    const inv = die(await s.from('invoices').insert({ auction_id: aEnd, buyer_user_id: String(unpaid.id), buyer_username: unpaid.username, total_cents: 1150, payment_status: 'failed' }).select().single());
    die(await s.from('orders').insert({ auction_id: aEnd, invoice_id: inv.id, buyer_username: unpaid.username, buyer_user_id: String(unpaid.id), item_title: 'ZZTEST_delrefuse order', final_bid: 10, status: 'pending', payment_status: 'failed' }).select().single());
    // paid, but not yet shipped or collected
    const toShip = await buyer('toship'), aShip = await auction('toship', 'ended');
    const inv2 = die(await s.from('invoices').insert({ auction_id: aShip, buyer_user_id: String(toShip.id), buyer_username: toShip.username, total_cents: 1150, payment_status: 'paid', payment_intent_id: 'pi_ZZTEST_delrefuse' }).select().single());
    die(await s.from('orders').insert({ auction_id: aShip, invoice_id: inv2.id, buyer_username: toShip.username, buyer_user_id: String(toShip.id), item_title: 'ZZTEST_delrefuse order', final_bid: 10, status: 'label_created', payment_status: 'paid', payment_intent_id: 'pi_ZZTEST_delrefuse' }).select().single());

    for (const [label, u, code] of [['leads an open lot', lead, 'leading_open_lot'], ['max bid on an open lot', maxb, 'max_bid_open_lot'], ['unpaid (failed) invoice', unpaid, 'unpaid_invoice'], ['order not yet shipped', toShip, 'order_not_shipped']]) {
      const r = await del(srv.url, u, { password: PW, confirm: 'DELETE' });
      ok(r.s === 409 && (r.j.codes || []).includes(code) && r.j.reasons && r.j.reasons.length && await untouched(u), `NEW ${label}: ${r.s} "${(r.j.reasons || [])[0]}" - nothing changed`);
    }
    let r = await del(srv.url, plain, { password: 'not-my-password', confirm: 'DELETE' });
    ok(r.s === 401 && await untouched(plain), `NEW wrong password: ${r.s} "${r.j.error}" - nothing changed`);
    for (const c of [undefined, 'delete', 'yes']) {
      r = await del(srv.url, plain, { password: PW, ...(c === undefined ? {} : { confirm: c }) });
      ok(r.s === 400 && await untouched(plain), `NEW confirm ${JSON.stringify(c)} instead of "DELETE": ${r.s} "${r.j.error}" - nothing changed`);
    }
    const admin = { tok: jwt.sign({ id: crypto.randomUUID(), username: 'whatthefind' }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
    r = await del(srv.url, admin, { password: 'anything', confirm: 'DELETE' });
    ok(r.s === 403, `NEW the host (admin) account: ${r.s} "${r.j.error}"`);
    ok(stripeCalls().length === 0, `NEW: Stripe was never called in any refused case (${stripeCalls().length} calls)`);
    const anon = await fetch(srv.url + '/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW, confirm: 'DELETE' }) });
    ok(anon.status === 401, `NEW: without a login -> ${anon.status}`);
  } finally {
    servers.forEach(x => x.stop());
    try { fs.unlinkSync(CALLS); } catch {}
    for (const id of made.auctions) { await s.from('orders').delete().eq('auction_id', id); await s.from('invoices').delete().eq('auction_id', id); await s.rpc('delete_auction_cascade', { p_auction_id: id }); }
    await s.from('profiles').delete().in('user_id', made.users.map(String));
    await s.from('users').delete().in('id', made.users);
    const left = (await s.from('users').select('id').like('username', 'zzdel_%')).data.length + (await s.from('auctions').select('id').like('title', 'ZZTEST_delrefuse%')).data.length;
    console.log('\nleftover throwaway rows:', left);
    if (left) fails++;
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
