// Sends ONE real "closing within the hour" reminder email to the host's own address, from wtf-test data, so the
// email can be checked in a real inbox (F3, WATCH_LIST_BRIEF.md). wtf-test only; it refuses production.
//
//   node scripts/send-test-reminder.js
//   node scripts/send-test-reminder.js --to-file out.html   nothing sent: the email is written to a file to look at
//
// Needs, in .env (Albert adds them himself; never paste keys into chat):
//   RESEND_API_KEY   the Resend key (the same one Railway uses)
//   ADMIN_EMAIL      where the test email goes (the host's own inbox)
// Everything else comes from .env.test (wtf-test). It makes a throwaway buyer whose email is ADMIN_EMAIL, a live
// auction with three lots closing within the hour that the buyer watches, runs the real reminder code once, and
// deletes all of it again. The address and the key are never printed.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const BE = path.resolve(__dirname, '..');
if (process.argv.includes('--yes-production') || process.argv.includes('--yes-run-against-the-real-database')) { console.log('This script is for wtf-test only.'); process.exit(2); }
const prodEnv = require(BE + '/node_modules/dotenv').parse(fs.readFileSync(BE + '/.env'));
const toFileAt = process.argv.indexOf('--to-file');
const TO_FILE = toFileAt > 0 ? path.resolve(process.argv[toFileAt + 1]) : null;
if (TO_FILE) Object.assign(prodEnv, { RESEND_API_KEY: 're_zztest_stub', ADMIN_EMAIL: 'zztest_preview@example.invalid' });
if (!prodEnv.RESEND_API_KEY || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(prodEnv.ADMIN_EMAIL || '')) {
  console.log('Add RESEND_API_KEY and ADMIN_EMAIL to .env first (see the top of this file).'); process.exit(2);
}
require(BE + '/verification/guard')(__filename);   // SUPABASE_* and JWT_SECRET now point at wtf-test
const boot = require(BE + '/verification/local-server');
const { createClient } = require(BE + '/node_modules/@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const die = r => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
const at = m => new Date(Date.now() + m * 60e3).toISOString();

(async () => {
  let srv, userId, auctionId;
  try {
    userId = crypto.randomUUID();
    die(await s.from('users').insert({ id: userId, username: 'zztest_reminder_' + crypto.randomBytes(3).toString('hex'), password_hash: 'zztest-not-a-real-hash', email: prodEnv.ADMIN_EMAIL.trim().toLowerCase() }).select().single());
    auctionId = die(await s.from('auctions').insert({ title: 'TEST: The Fall Horror Collection', description: 'Test reminder from wtf-test.', status: 'live', mode: 'standard', fulfillment_mode: 'both', buyers_premium_pct: 15, host_username: 'whatthefind', starts_at: at(-60), ends_at: at(58) }).select().single()).id;
    const titles = [['The Mummy, Boris Karloff 1932 statue', 26, 83], ['Christopher Lee Dracula 8-inch figure', 21, 68], ['Bride of Frankenstein, Elsa Lanchester', 0, 0]];
    for (const [i, [title, bids, price]] of titles.entries()) {
      const lot = die(await s.from('auction_items').insert({ auction_id: auctionId, title, position: i, status: 'open', starting_bid: 0, bid_count: bids, current_bid: price, ends_at: at(35 + i * 5) }).select().single());
      die(await s.from('lot_watches').insert({ user_id: userId, item_id: lot.id }).select());
    }
    const src = require(BE + '/verification/guard').readSource(BE + '/server.js')
      .replace('const PORT = process.env.PORT || 3001;', "app.post('/__test/reminders', async (req, res) => res.json(await runReminders(new Date())));\nconst PORT = process.env.PORT || 3001;");
    const stub = TO_FILE ? `const realFetch = global.fetch; global.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://api.resend.com')) return realFetch(url, opts);
      const b = JSON.parse(opts.body); require('fs').writeFileSync(${JSON.stringify(TO_FILE)}, '<!-- Subject: ' + b.subject + ' | List-Unsubscribe: ' + (b.headers || {})['List-Unsubscribe'] + ' -->\\n' + b.html);
      return new Response('{"id":"zztest"}', { status: 200 }); };` : '';
    srv = await boot('test-reminder', 3561, src, { env: { RESEND_API_KEY: prodEnv.RESEND_API_KEY }, preload: stub });
    await new Promise(r => setTimeout(r, 3000));   // the boot-time pass may already have sent it
    const r = await (await fetch(srv.url + '/__test/reminders', { method: 'POST' })).json();
    const sent = die(await s.from('notifications').select('sent_at, error').eq('user_id', userId));
    console.log(TO_FILE ? `Written to ${TO_FILE} (nothing sent).` : sent.some(n => n.sent_at && !n.error) ? 'Sent: check the host inbox for "3 lots you\'re watching close within the hour".' : `Not sent: ${JSON.stringify(sent)} ${JSON.stringify(r)}`);
  } catch (e) {
    console.log('ERR', e.message);
  } finally {
    if (srv) srv.stop();
    if (auctionId) await s.rpc('delete_auction_cascade', { p_auction_id: auctionId });
    if (userId) { await s.from('notifications').delete().eq('user_id', userId); await s.from('users').delete().eq('id', userId); }
    console.log('cleaned up');
  }
})();
