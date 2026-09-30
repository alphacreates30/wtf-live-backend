// The lot page (wtf-handoff LOT_PAGE_BRIEF.md): one public read with everything a buyer needs to bid, the
// buyer's own standing and own bids in separate authenticated reads (so the public one can be cached), and
// related lots. Contracts in API.md. The website and the planned app both read these.
//
// Public rules as everywhere else (PRIVACY_BIDDERS_PICKUP_BRIEF.md): drafts are 404; bidders are never
// identified - no username, no leader, no per-bid list, no max, no reserve; the public sees the current bid and
// the bid count. The pickup street address stays with winners: the public gets pickup_town.
const rules = require('./lot_rules');

const RELATED_MORE_MAX = 8;
const RELATED_SIMILAR_MAX = 12;
const SIMILAR_MIN = 3;            // fewer matches than this: send none (the page hides the rail)
const HISTORY_MAX = 500;
const SLUG_CACHE_MS = 30_000;
// Words that say nothing about what a lot is.
const STOP = new Set(('the and for with from this that into over under set lot lots of in on a an to by or ' +
  'inch inches in. cm mm new used vintage old rare original boxed box sealed complete working tested ' +
  'good very fair mint near pair lot sample').split(' '));

module.exports = function registerLotPage(app, d) {
  const { supabase, requireAuth, dbFailure, ADMIN_USERNAME, thumbsFor, homeLot, premiumMap, blurbOf, auctionPhase,
    isoOrNull, standingFor, SOFT_CLOSE_MINUTES, CONTACT_EMAIL } = d;

  const LOT_COLUMNS = 'id, auction_id, position, title, description, condition, image_url, starting_bid, current_bid, bid_count, ends_at, status';
  // '*': pickup_town only exists after migration y. Only the fields picked into lotBody ever leave the server.
  const AUCTION_COLUMNS = '*';

  // Slug -> auction id. Auctions are few; a short cache of (id, status) is enough to match the id part.
  let slugCache = { at: 0, rows: null };
  async function auctionIdForSlug(slug) {
    const part = rules.slugIdPart(slug);
    if (!part) return null;
    if (part.length === 36) return part;
    if (!slugCache.rows || Date.now() - slugCache.at > SLUG_CACHE_MS) {
      const { data, error } = await supabase.from('auctions').select('id, status').neq('status', 'draft');
      if (error) throw error;
      slugCache = { at: Date.now(), rows: data || [] };
    }
    const hits = slugCache.rows.filter(a => a.id.startsWith(part));
    return hits.length === 1 ? hits[0].id : null;
  }

  // One lot and its (published) auction, or null.
  async function loadLot(itemId) {
    const { data: lot, error } = await supabase.from('auction_items').select(LOT_COLUMNS).eq('id', itemId).maybeSingle();
    if (error) throw error;
    if (!lot) return null;
    const { data: auction, error: aErr } = await supabase.from('auctions').select(AUCTION_COLUMNS).eq('id', lot.auction_id).maybeSingle();
    if (aErr) throw aErr;
    if (!auction || auction.status === 'draft') return null;
    return { lot, auction };
  }

  // Biddable: what place_standard_bid itself requires (status 'open', end not passed).
  const isOpen = (lot, nowMs) => lot.status === 'open' && !(lot.ends_at && Date.parse(lot.ends_at) <= nowMs);

  // Everything the page needs in as few database round trips as possible (it is the lot page's largest paint that
  // waits on this): the lot with its photos embedded, its auction and the auction's lot list, in parallel when the
  // auction is already known (by number), else lot first, then the other two. Null for a draft or no such lot.
  async function loadPage({ itemId, auctionId, position }) {
    const LOT = `${LOT_COLUMNS}, item_images(url, position)`;
    const lotQ = itemId
      ? supabase.from('auction_items').select(LOT).eq('id', itemId).maybeSingle()
      : supabase.from('auction_items').select(LOT).eq('auction_id', auctionId).eq('position', position).maybeSingle();
    const rest = id => Promise.all([
      supabase.from('auctions').select(AUCTION_COLUMNS).eq('id', id).maybeSingle(),
      supabase.from('auction_items').select('id, position, title').eq('auction_id', id).order('position', { ascending: true }),
    ]);
    let lotR, aR, sR;
    if (auctionId) [lotR, [aR, sR]] = await Promise.all([lotQ, rest(auctionId)]);
    else { lotR = await lotQ; if (lotR.data) [aR, sR] = await rest(lotR.data.auction_id); }
    for (const r of [lotR, aR, sR]) if (r && r.error) throw r.error;
    const lot = lotR.data, auction = aR && aR.data;
    if (!lot || !auction || auction.status === 'draft') return null;
    const images = (lot.item_images || []).sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    return { lot, auction, siblings: sR.data || [], images };
  }

  async function lotBody({ lot, auction, siblings, images }) {
    const nowMs = Date.now();
    const photoUrls = images.map(i => i.url).filter(Boolean);
    if (!photoUrls.length && lot.image_url) photoUrls.push(lot.image_url);
    const thumb = await thumbsFor(photoUrls);

    const phase = auctionPhase(auction, nowMs);                // 'live' | 'upcoming' | null (ended)
    const open = phase === 'live' && isOpen(lot, nowMs);
    const pct = auction.buyers_premium_pct == null ? rules.DEFAULT_PREMIUM_PCT : Number(auction.buyers_premium_pct);
    const bidCount = lot.bid_count || 0;
    const current = Number(lot.current_bid ?? 0);
    const opening = rules.minimumBid(lot, false);
    // The price the "with premium" line is about: the current bid once there is one, else the opening bid.
    const shown = bidCount > 0 ? current : opening;
    const prem = rules.withPremium(shown, pct);
    const lotStatus = lot.status === 'sold' ? 'sold' : lot.status === 'unsold' ? 'unsold' : open ? 'open' : phase === 'upcoming' ? 'upcoming' : 'closed';

    const idx = (siblings || []).findIndex(s => s.id === lot.id);
    const nav = s => (s ? { id: s.id, number: s.position + 1, title: s.title } : null);
    const slug = rules.auctionSlug(auction);

    const mode = auction.fulfillment_mode || 'shipping';
    const pickup = mode === 'pickup' || mode === 'both';
    const shipping = mode === 'shipping' || mode === 'both';

    return {
      server_now: new Date(nowMs).toISOString(),
      lot: {
        id: lot.id, number: lot.position + 1, position: lot.position, title: lot.title,
        description: lot.description || '', condition: lot.condition || null,
        status: lotStatus, ends_at: isoOrNull(lot.ends_at),
        image_url: photoUrls[0] || null, thumb_url: thumb(photoUrls[0]),
      },
      auction: {
        id: auction.id, slug, title: auction.title, story: blurbOf(auction.description),
        category: auction.category || null, phase: phase || 'ended',
        starts_at: isoOrNull(auction.starts_at), ends_at: isoOrNull(auction.ends_at),
        lot_count: (siblings || []).length, buyers_premium_pct: pct,
      },
      photos: photoUrls.map(url => ({ url, thumb_url: thumb(url) })),
      price: {
        current_bid: bidCount > 0 ? current : null,
        opening_bid: bidCount > 0 ? null : opening,     // before the first bid only
        bid_count: bidCount,
        premium_pct: pct,
        // premium and total for `current_bid` (or the opening bid before any bid), in the invoice's cents maths.
        premium_amount: prem.premium,
        total_with_premium: prem.total,
        // The next two valid max bids for anyone not leading. [] once the lot is closed.
        next_bids: open ? rules.nextBidAmounts(lot) : [],
      },
      time: { ends_at: isoOrNull(lot.ends_at), soft_close_minutes: SOFT_CLOSE_MINUTES },
      fulfilment: {
        pickup: pickup ? {
          free: true,
          town: auction.pickup_town || null,     // never pickup_address (B6)
          starts_at: isoOrNull(auction.pickup_starts_at), ends_at: isoOrNull(auction.pickup_ends_at),
        } : null,
        // No lot has weight or size data (parcels are weighed at packing), so there is no price to show:
        // postage is quoted from the buyer's address and the packed parcel after the auction.
        shipping: shipping ? { priced: 'after_auction', estimate: null, carrier: 'USPS', country: 'US' } : null,
      },
      nav: { prev: nav(siblings[idx - 1]), next: nav(siblings[idx + 1]) },
      contact_email: CONTACT_EMAIL,
    };
  }

  async function sendLot(req, res, where) {
    try {
      const found = await loadPage(where);
      if (!found) return res.status(404).json({ error: 'Lot not found' });
      // Same answer for every caller (no login is read here), so a shared cache may keep it 5 s; bids move it.
      res.set('Cache-Control', 'public, max-age=0, s-maxage=5');   // browsers always revalidate (a bidder must see their bid at once)
      res.json(await lotBody(found));
    } catch (e) {
      dbFailure(req, res, e);
    }
  }

  app.get('/lots/:itemId', (req, res) => sendLot(req, res, { itemId: req.params.itemId }));

  // The same answer by address: /a/<slug>/lot/<n>. n = position + 1.
  app.get('/lots/by-number/:slug/:n', async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1 || n > 100000) return res.status(400).json({ error: 'Invalid lot number' });
    try {
      const auctionId = await auctionIdForSlug(req.params.slug);
      if (!auctionId) return res.status(404).json({ error: 'Lot not found' });
      return sendLot(req, res, { auctionId, position: n - 1 });
    } catch (e) {
      dbFailure(req, res, e);
    }
  });

  // The buyer's own standing: status and their own max. Never anyone else's.
  app.get('/lots/:itemId/me', requireAuth, async (req, res) => {
    try {
      const found = await loadLot(req.params.itemId);
      if (!found) return res.status(404).json({ error: 'Lot not found' });
      const { data: row, error } = await supabase.from('auction_items').select('id, status, ends_at, bid_count, leading_bidder').eq('id', found.lot.id).single();
      if (error) throw error;
      const [standing, { data: mine, error: pErr }] = await Promise.all([
        standingFor(req.user, [row]),
        supabase.from('pre_bids').select('max_amount').eq('item_id', found.lot.id).eq('buyer_user_id', String(req.user.id)).maybeSingle(),
      ]);
      if (pErr) throw pErr;
      const status = standing[row.id];
      const open = status === 'winning' || status === 'outbid' || status === 'no_bid';
      res.set('Cache-Control', 'no-store');
      res.json({
        status,                                            // winning | outbid | no_bid | won | lost | closed
        my_max: mine ? Number(mine.max_amount) : null,     // the caller's own max only
        // What the caller may bid now: the leader may raise their max from the current price.
        min_bid: open ? rules.minimumBid(found.lot, status === 'winning') : null,
      });
    } catch (e) {
      dbFailure(req, res, e);
    }
  });

  // Bids on this lot, login only (B7: the public sees the count on the lot, never a list). A buyer gets only
  // THEIR OWN bids: what they bid (their max, after migration y; before it, the price the bid produced) and when.
  // The admin gets everything: who submitted each bid, who held the lead at that price (migration x) and each max.
  app.get('/lots/:itemId/bids', requireAuth, async (req, res) => {
    try {
      const found = await loadLot(req.params.itemId);
      if (!found) return res.status(404).json({ error: 'Lot not found' });
      const isAdmin = req.user.username === ADMIN_USERNAME;
      const base = cols => {
        let q = supabase.from('bids').select(cols).eq('item_id', found.lot.id);
        if (!isAdmin) q = q.eq('username', req.user.username);
        return q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(HISTORY_MAX);
      };
      // Newest columns first; older databases (before migrations y / x) lack them.
      let q;
      for (const cols of ['amount, created_at, username, leader_username, max_amount', 'amount, created_at, username, leader_username', 'amount, created_at, username']) {
        q = await base(cols);
        if (!q.error || !(q.error.code === '42703' || /does not exist|leader_username|max_amount/.test(q.error.message || ''))) break;
      }
      if (q.error) throw q.error;
      const num = v => (v == null ? null : Number(v));
      res.set('Cache-Control', 'no-store');
      if (isAdmin) {
        return res.json({
          scope: 'all', bid_count: found.lot.bid_count || 0,
          bids: (q.data || []).map(b => ({ at: isoOrNull(b.created_at), price: num(b.amount), bidder: b.username,
            leader: b.leader_username ?? null, max: num(b.max_amount) })),
        });
      }
      res.json({
        scope: 'own', bid_count: found.lot.bid_count || 0,
        bids: (q.data || []).map(b => ({ at: isoOrNull(b.created_at), amount: num(b.max_amount) ?? num(b.amount), price: num(b.amount) })),
      });
    } catch (e) {
      dbFailure(req, res, e);
    }
  });

  // More from this auction (open lots, soonest ending first) and similar open lots from OTHER live auctions:
  // a similar lot shares at least one title word; a shared auction-category word only breaks ties (a category
  // alone would make every lot of a same-category auction "similar"). Similar is [] below SIMILAR_MIN matches.
  app.get('/lots/:itemId/related', async (req, res) => {
    try {
      const found = await loadLot(req.params.itemId);
      if (!found) return res.status(404).json({ error: 'Lot not found' });
      const { lot, auction } = found;
      const nowMs = Date.now(), now = new Date(nowMs).toISOString();
      const FIELDS = 'id, auction_id, position, title, image_url, current_bid, bid_count, ends_at, status';

      const { data: more, error: mErr } = await supabase.from('auction_items').select(FIELDS)
        .eq('auction_id', auction.id).neq('id', lot.id).not('status', 'in', '("sold","unsold")').gt('ends_at', now)
        .order('ends_at', { ascending: true }).order('position', { ascending: true }).limit(RELATED_MORE_MAX);
      if (mErr) throw mErr;

      const { data: auctions, error: aErr } = await supabase.from('auctions').select('id, title, status, starts_at, category, buyers_premium_pct').in('status', ['live', 'upcoming']);
      if (aErr) throw aErr;
      const others = (auctions || []).filter(a => a.id !== auction.id && auctionPhase(a, nowMs) === 'live');
      const words = w => [...new Set(String(w || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !STOP.has(x) && !/^\d+$/.test(x)))];
      const mine = words(lot.title).slice(0, 8), myCat = words(auction.category);
      let similar = [];
      if (others.length && mine.length) {
        const catOf = Object.fromEntries(others.map(a => [a.id, new Set(words(a.category))]));
        // Words are [a-z0-9] only, so they are safe inside the filter.
        const { data: cands, error: cErr } = await supabase.from('auction_items').select(FIELDS)
          .in('auction_id', others.map(a => a.id)).not('status', 'in', '("sold","unsold")').gt('ends_at', now)
          .or(mine.map(w => `title.ilike.%${w}%`).join(',')).limit(400);
        if (cErr) throw cErr;
        similar = (cands || []).map(c => {
          const theirs = new Set(words(c.title));
          const title = mine.filter(w => theirs.has(w)).length;
          return { c, title, score: title * 10 + myCat.filter(w => catOf[c.auction_id].has(w)).length };
        }).filter(x => x.title > 0)
          .sort((x, y) => y.score - x.score || Date.parse(x.c.ends_at) - Date.parse(y.c.ends_at))
          .slice(0, RELATED_SIMILAR_MAX).map(x => x.c);
        if (similar.length < SIMILAR_MIN) similar = [];
      }

      const titles = Object.fromEntries([[auction.id, auction.title], ...others.map(a => [a.id, a.title])]);
      const thumb = await thumbsFor([...(more || []), ...similar].map(l => l.image_url));
      const toLot = homeLot(thumb, titles);
      res.set('Cache-Control', 'public, max-age=15');
      res.json({
        server_now: now,
        more_from_auction: (more || []).map(toLot),
        similar: similar.map(toLot),
        premium_pct: premiumMap([{ id: auction.id, buyers_premium_pct: auction.buyers_premium_pct }, ...others]),
      });
    } catch (e) {
      dbFailure(req, res, e);
    }
  });
};
