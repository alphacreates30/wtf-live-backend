// What The Find's own lot rules, in one place (wtf-handoff LOT_PAGE_BRIEF.md). server.js uses them for the bid
// route and for orders; lot_page.js uses them to tell a buyer the price with premium and the next valid bids.
// Pure functions only: no database, no clock, so the suites can check them directly.

// Bid increments, by the lot's current price. Must match place_standard_bid (migration x) - the database
// applies the same tiers inside the proxy battle.
function bidIncrement(price) {
  const p = Number(price) || 0;
  return p < 50 ? 1 : p < 100 ? 2 : p < 200 ? 5 : p < 500 ? 10 : p < 1000 ? 25 : 50;
}

// Lots open at $0.00, so "current bid + increment" would allow a $0 opening bid. This is the floor for the
// first bid on a lot; every bid after it follows the tiers above.
const OPENING_BID_MIN = 1;

// The smallest max bid the server accepts on this lot from this bidder. The leader may raise (or restate)
// their own max at the current price; anyone else needs the next increment, and the first bid needs at
// least OPENING_BID_MIN.
const cents = n => Math.round(n * 100) / 100;   // 21.41 + 1 is 22.410000000000004 in floating point
function minimumBid(item, isLeader) {
  const floor = Number(item.current_bid ?? item.starting_bid ?? 0);
  if (isLeader) return cents(floor);
  return cents(item.bid_count > 0 ? floor + bidIncrement(floor) : Math.max(floor, OPENING_BID_MIN));
}

// The one-tap amounts for someone who is not leading: the minimum, then one more step from there.
// Both are ordinary max bids, so the server accepts either.
function nextBidAmounts(item) {
  const first = minimumBid(item, false);
  return [first, cents(first + bidIncrement(first))];
}

// Buyer's premium, exactly as orders and invoices compute it: integer cents, rounded half up.
const DEFAULT_PREMIUM_PCT = 15;
function premiumCents(hammerCents, pct) {
  return Math.round(hammerCents * (pct ?? DEFAULT_PREMIUM_PCT) / 100);
}
// A price in dollars -> { premium, total } in dollars, via the same cents maths.
function withPremium(dollars, pct) {
  const hammer = Math.round((Number(dollars) || 0) * 100);
  const prem = premiumCents(hammer, pct);
  return { premium: prem / 100, total: (hammer + prem) / 100 };
}

// Auction addresses: /a/<title words>-<first 8 hex of the id>. The words are only for people; the id part
// finds the auction, so renaming an auction keeps its old links working (the page redirects to the new slug).
function slugify(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
}
const SLUG_ID_LEN = 8;
function auctionSlug(auction) {
  const words = slugify(auction.title);
  const idPart = String(auction.id).toLowerCase().slice(0, SLUG_ID_LEN);
  return words ? `${words}-${idPart}` : idPart;
}
// The id part of a slug (or a whole uuid), or null.
function slugIdPart(slug) {
  const s = String(slug || '').toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
  const m = s.match(/(?:^|-)([0-9a-f]{8})$/);
  return m ? m[1] : null;
}

module.exports = {
  bidIncrement, OPENING_BID_MIN, minimumBid, nextBidAmounts,
  DEFAULT_PREMIUM_PCT, premiumCents, withPremium,
  slugify, auctionSlug, slugIdPart, SLUG_ID_LEN,
};
