// What the public may see of an auction and a lot (wtf-handoff PRIVACY_BIDDERS_PICKUP_BRIEF.md, B6 + B7).
// ALLOW-LISTS, not deny-lists: a column added to auctions or auction_items later stays private until someone
// adds it here on purpose. Every public REST response and socket event that carries an auction or lot row goes
// through these; the admin (and an auction's host) get the full row instead.
//
// Never public: who bid or leads (leading_bidder, username, buyer_username, leader_username), anyone's max
// (top_pre_bid, max_amount), reserve_price, and the pickup street address (pickup_address) - the public gets
// pickup_town; the street goes only to the admin and to a buyer who won a lot there and chose pickup.

const AUCTION_PUBLIC = [
  'id', 'title', 'description', 'image_url', 'thumb_url', 'category', 'starting_bid', 'current_bid', 'status',
  'starts_at', 'ends_at', 'mode', 'host_username', 'created_at', 'buyers_premium_pct', 'fulfillment_mode',
  'pickup_town', 'pickup_starts_at', 'pickup_ends_at',
];
const LOT_PUBLIC = [
  'id', 'auction_id', 'position', 'title', 'description', 'condition', 'image_url', 'thumb_url', 'starting_bid',
  'current_bid', 'bid_count', 'pre_bid_count', 'status', 'ends_at', 'created_at',
];

const pick = (row, keys) => {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
};

// pickup_town is always present in a public auction (null before migration y or when not set).
const publicAuction = a => (a && typeof a === 'object' ? { pickup_town: null, ...pick(a, AUCTION_PUBLIC) } : a);
const publicLot = l => pick(l, LOT_PUBLIC);

module.exports = { AUCTION_PUBLIC, LOT_PUBLIC, publicAuction, publicLot };
