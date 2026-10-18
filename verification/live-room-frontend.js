// Live shows phase 2b (G1, wtf-handoff LIVE_SHOWS_PHASE2_BRIEF.md step 2b; audit §3): the viewer room's pieces that can be
// checked without a browser, plus the one number it must get from the server. Needs ../wtf-live-frontend next to this
// repo, and migrations za, zb, zd on the test database.
//   routing     AuctionRoomGate sends a live show to the host's screen (the host's account) or the viewer room; the
//               old desktop room and ItemQueue are gone; each room's CSS is imported.
//   sockets     one socket hook per room (useRoomSocket): every listener is named and removed with off(event, handler);
//               the rooms never touch the socket directly (audit finding 19).
//   amounts     the one-tap Bid amount is the server's next_bid (lot_rules), never computed in the browser: show_state
//               and new_bid carry it, and it equals lot_rules.nextBidAmounts at every step of a bid battle.
//   copy        no buyer's premium anywhere in the live room (only "no buyer's premium"); the shipping line before the
//               first bid; you're winning / outbid / you won / card declined; confetti off with reduced motion.
//   gates       logged out: Bid goes to login and back to the room; terms open on bid_error terms_required; the card
//               sheet on no_card / card_not_verified / payment_failed.
const fs = require('fs');
const path = require('path');
require('./guard')(__filename);
const K = require('./live-kit')('roomfe');
const { ok, ADMIN, mkUser, mkShow, terms, client, ask, boot, BE } = K;
process.chdir(BE);
const rules = require(BE + '/lot_rules');
const FE = path.join(BE, '..', 'wtf-live-frontend', 'src');
const read = p => fs.readFileSync(path.join(FE, p), 'utf8').replace(/\r\n/g, '\n');
const OK_STRIPE = [['const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;',
  "const stripe = { paymentIntents: { create: async () => ({ id: 'pi_ZZLIVE_' + require('crypto').randomUUID().slice(0, 12) }), retrieve: async () => ({}), cancel: async () => ({}) }, paymentMethods: { retrieve: async () => ({ card: { last4: '4242' } }) } };"]];

(async () => {
  const servers = [];
  try {
    console.log('== Routing and CSS ==');
    const gate = read('pages/AuctionRoomGate.jsx'), viewer = read('live/LiveViewerRoom.jsx'), host = read('live/LiveHostRoom.jsx');
    const hook = read('live/useRoomSocket.js'), css = read('live/LiveViewer.css'), login = read('pages/Login.jsx');
    ok(/import\('\.\.\/live\/LiveHostRoom'\)/.test(gate) && /import\('\.\.\/live\/LiveViewerRoom'\)/.test(gate) && /isHost \? <LiveHostRoom|if \(isHost\) return <LiveHostRoom/.test(gate) && /<LiveViewerRoom /.test(gate),
      'AuctionRoomGate: a live show opens the host screen for the host, the viewer room for everyone else (each loaded only when needed)');
    const all = [];
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(jsx?|css)$/.test(f.name)) all.push(p); } };
    walk(FE);
    const imports = all.map(p => fs.readFileSync(p, 'utf8')).join('\n');
    ok(!fs.existsSync(path.join(FE, 'pages/AuctionRoom.jsx')) && !fs.existsSync(path.join(FE, 'components/ItemQueue.jsx')) && !/from '\.\/AuctionRoom'|ItemQueue/.test(imports),
      'the old desktop room and ItemQueue (its CSS never imported) are gone, and nothing imports them');
    ok(/import '\.\/LiveViewer\.css'/.test(viewer) && /import '\.\/LiveHost\.css'/.test(host), 'each room imports its own CSS');

    console.log('\n== One socket hook per room ==');
    ok(!/getSocket|socket\.(on|off)\(/.test(viewer) && !/getSocket|socket\.(on|off)\(/.test(host) && /useRoomSocket\(/.test(viewer) && /useRoomSocket\(/.test(host),
      'the rooms never touch the socket directly: each uses useRoomSocket');
    ok(/socket\.on\(event, fn\)/.test(hook) && /socket\.off\(event, fn\)/.test(hook) && /socket\.off\('connect', onConnect\)/.test(hook) && !/socket\.off\('[a-z_]+'\)/.test(hook),
      'useRoomSocket registers named handlers and removes exactly those (off(event, handler), never off(event))');

    console.log('\n== Amounts come from the server ==');
    ok(/next_bid/.test(viewer) && /startBid\(nextBid, 'tap', open\)/.test(viewer) && !/bidIncrement|current_bid\s*\+|\+\s*1\b/.test(viewer),
      'the one-tap Bid uses the server\'s next_bid; the room computes no increments');
    const srv = await boot('live-roomfe', 3681, require('./guard').readSource(BE + '/server.js'), { env: { LIVE_ENABLED: 'true' }, timers: 'real', patch: OK_STRIPE });
    servers.push(srv);
    const A = await mkUser('a'), B = await mkUser('b');
    const show = await mkShow('nextbid', { lots: 1, starting_bid: 0 });
    for (const u of [A, B]) await terms(u, show.id);
    const h = await client(srv.url, show.id, ADMIN), ca = await client(srv.url, show.id, A), cb = await client(srv.url, show.id, B);
    await ask(h, 'show_lot', {}, ['host_ok', 'host_error']);
    await ask(h, 'start_clock', { seconds: 60 }, ['host_ok', 'host_error']);
    let st = await ca.waitFor('show_state', p => p.open, 4000);
    let lot = await K.lot(show.lots[0]);
    ok(st && st.payload.open.next_bid === rules.nextBidAmounts(lot)[0] && st.payload.open.next_bid === 1, `lot opens: show_state next_bid $${st && st.payload.open.next_bid} = lot_rules`);
    let good = true, steps = 0;
    for (const [c, max] of [[ca, 30], [cb, 45], [ca, 60], [cb, 120], [ca, 130]]) {
      const from = cb.mark();
      await ask(c, 'place_bid', { max_amount: max }, ['bid_ok', 'bid_error']);
      const nb = await cb.waitFor('new_bid', () => true, 4000, from);
      lot = await K.lot(show.lots[0]);
      const want = rules.nextBidAmounts(lot)[0];
      steps++;
      if (!nb || nb.payload.next_bid !== want) { good = false; console.log('  step', steps, 'price', lot.current_bid, 'next_bid', nb && nb.payload.next_bid, 'want', want); }
    }
    const st2 = await (await fetch(`${srv.url}/auction/${show.id}/show-state`)).json();
    ok(good && st2.open.next_bid === rules.nextBidAmounts(await K.lot(show.lots[0]))[0], `a bid battle (${steps} bids, across the $50 and $100 tiers): every new_bid and show_state next_bid = lot_rules (now $${st2.open.next_bid})`);
    for (const c of [h, ca, cb]) c.close();

    console.log('\n== Copy ==');
    const premium = viewer.match(/premium/gi) || [];
    const noPremiumPhrases = viewer.match(/[Nn]o buyer's premium/g) || [];
    ok(!/buyers_premium_pct|withPremium|premiumCents/.test(viewer) && premium.length === noPremiumPhrases.length, `no premium in the live room: every mention says "no buyer's premium" (${noPremiumPhrases.length})`);
    ok(/Everything you win in this show ships together in one box\. Postage is charged once, after packing\./.test(viewer) && /showShipLine && <p className="vr-ship">/.test(viewer),
      'the shipping line, before the first bid');
    ok(/You're winning/.test(viewer) && /You've been outbid/.test(viewer) && /state-outbid\.svg/.test(viewer) && /You won lot/.test(viewer) && /state-won\.svg/.test(viewer) && /Update card/.test(viewer),
      'banners: you\'re winning, outbid (the mark), you won (the Glint), card declined with Update card');
    ok(/prefers-reduced-motion: reduce\)'\)\.matches/.test(viewer) && /!still && <div className="vr-confetti"/.test(viewer) && /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vr-confetti \{ display: none; \}/.test(css),
      'confetti only without reduced motion (checked in the code and hidden by the CSS)');

    console.log('\n== Gates in the room ==');
    ok(/loginHref = `\/login\?next=\$\{encodeURIComponent\(location\.pathname \+ location\.search\)\}`/.test(viewer) && /navigate\(loginHref\)/.test(viewer) && /params\.get\('next'\)/.test(login),
      'logged out: Bid goes to login with ?next= the room (and its rehearsal key), and login returns there');
    ok(/e\.code === 'terms_required'\) \{ openTerms/.test(viewer) && /<TermsAcknowledgementModal /.test(viewer), 'the terms open when the server answers terms_required');
    ok(/CARD_CODES = \['no_card', 'card_not_verified', 'payment_failed'\]/.test(viewer) && /CARD_CODES\.includes\(e\.code\)\) \{ cardDeclined\.current = e\.code === 'payment_failed'; say\('declined', e\.message, 0\); openCard\(\)/.test(viewer) && /<CardOnFileStandalone [^>]*declined=\{cardDeclined\.current\}/.test(viewer),
      'the card form opens in a sheet on no_card / card_not_verified / payment_failed');
    const cardForm = fs.readFileSync(path.join(FE, 'components', 'CardOnFile.jsx'), 'utf8');
    ok(/declined \? <p className="error-msg">Your card was declined\./.test(cardForm) && /payment_failed: p => \{ cardDeclined\.current = true/.test(viewer),
      'after a declined charge the card sheet says so (never "on file and verified")');
    ok(/if \(!confirmed \|\| kind === 'max'\) \{ setConfirm/.test(viewer), 'the first bid in a show asks to confirm; after that, one tap');
  } catch (e) {
    console.log('ERR', e); K.state.fails++;
  } finally {
    servers.forEach(x => x.stop());
    await K.cleanup();
    K.finish();
  }
})();
