# API contracts (public, app-ready)

The website and the planned native app read the same endpoints. Pages only render; every rule lives here, in the
backend. Conventions for everything below:

- **Dates** are ISO 8601 strings in UTC (`2026-10-04T18:00:00.000Z`).
- **Money** is a number in dollars; the currency is always USD.
- **No HTML** in any response. Descriptions are plain text.
- **Lot number** shown to people = `position + 1`. It never changes as lots close.
- **Never sent to the public:** anything that identifies a bidder (B7): no username, leader (`leading_bidder`),
  `buyer_username`, `leader_username`, per-bid list, winner or "Bidder A/B"; no max (`top_pre_bid`, `max_amount`), no
  reserve price, no pickup street address (`pickup_address`: the public gets `pickup_town`), no draft or anything in
  one. The public sees a lot's current bid and bid count. Auction and lot rows go through ONE allow-list
  (`public_view.js`) on every REST route and socket event; the admin/host get full rows. A buyer's own standing,
  max and bids come only from their own authenticated calls. Suites: `verification/bidder-identity.js`,
  `pickup-address.js`, `secret-max.js`, `draft-reads.js`, `home.js`, `lot-page.js`.
- Errors are `{ "error": "<short sentence>" }` with a 4xx/5xx status, sometimes with a `code`.
- **Photos** come as `image_url` (the full photo: use it on a lot's own page) and `thumb_url` (about 480px wide
  WebP, no metadata: use it for cards, rails, lists and small tiles). `thumb_url` is `null` when a photo has no
  thumbnail yet (older uploads before the backfill, or a link outside our storage): **fall back to `image_url`**.

"Live" below means an auction whose status is `live`, or `upcoming` with `starts_at` already passed (standard
auctions open for bidding by the clock). "Upcoming" means published and `starts_at` still in the future.

## `GET /home`

No login. One call for the whole homepage. Same answer for everyone; cached per server for 10 s. Several auctions
can be open at once, ending on different days; the homepage features none of them over the others (each auction's
full story lives on its own page).

```jsonc
{
  "server_now": "2026-10-01T17:00:00.000Z",   // count down from this, not the device clock
  "timezone": "America/New_York",             // the site's zone: closing_schedule dates are days in this zone
  "open_auctions": [                          // every live auction, soonest ending first; [] = nothing open
    {
      "id": "uuid", "title": "…",
      "blurb": "First sentence of the description, plain text, max ~90 characters…",
      "lot_count": 34,                        // every lot in the auction
      "starts_at": "ISO" | null,
      "ends_at": "ISO" | null,                // the auction's end, else its last open lot's
      "first_lot_ends_at": "ISO" | null,      // earliest / latest close among its OPEN lots
      "last_lot_ends_at": "ISO" | null,
      "buyers_premium_pct": 15,
      "images": [{ "url": "https://…", "thumb_url": "https://…" | null }]   // max 3: cover first, then lots in order
    }
  ],
  "closing_schedule": [                       // next 7 days: one entry per auction per day some of its lots close,
    { "date": "2026-10-06",                   //   soonest first. date = YYYY-MM-DD in `timezone`
      "auction_id": "uuid", "title": "…",
      "first_close": "ISO", "last_close": "ISO" }
  ],
  "premium_pct": { "<auction id>": 15 },       // each live/upcoming auction's own buyer's premium (%).
                                              //   Show it beside every bid: never a bare price (BRAND.md).
  "rails": {                                  // across ALL open auctions; each rail max 12; hide an empty rail
    "ending_soon": [Lot],                     // open lots, soonest ends_at first
    "most_wanted": [Lot],                     // open lots with bids, most bids first, ties by ends_at.
                                              //   Sent empty until at least 3 lots have bids.
    "first_bid":   [Lot]                      // open lots with no bids yet, soonest ends_at first
  },
  "upcoming": [                               // not started yet, soonest first, max 6
    { "id", "title", "blurb", "starts_at", "ends_at", "image_url", "thumb_url" }
  ]
}
```

(Before Design B, `/home` had a single `featured` auction instead of `open_auctions`; it was removed.)

**Lot** (homepage and search), exactly these fields:

```jsonc
{ "id": "uuid", "auction_id": "uuid", "auction_title": "…", "position": 0, "title": "…",
  "image_url": "https://…" | null, "thumb_url": "https://…" | null,
  "current_bid": 38, "bid_count": 9, "ends_at": "ISO", "status": "open" }
```

"Open" = not `sold`/`unsold` and `ends_at` still in the future. Link a lot to its page, `/a/<auction slug>/lot/<position + 1>`
(see "The lot page" below; the older `/auction/:auction_id?lot=:id` still works and redirects there).

## `GET /search?q=`

No login. Case-insensitive match on lot titles in live and upcoming auctions; `%` and `_` are literal.

- `q` under 2 characters → `{ "server_now": "ISO", "q": "x", "lots": [], "premium_pct": {} }`
- `q` over 100 characters → 400
- otherwise `{ "server_now": "ISO", "q": "dracula", "lots": [Lot], "premium_pct": { "<auction id>": 15 } }`, soonest `ends_at` first,
  max 48.

## `POST /signup`

No login. "Wake me when the next collection opens." Stores the address only; nothing is sent yet.

Body: `{ "email": "…", "website": "" }`. `website` is a honeypot: leave the field hidden and empty.

- 200 `{ "ok": true, "message": "Thanks. We'll email you when the next collection opens." }` for a new address,
  an address already on the list, and a filled honeypot alike (the form can't be used to test who signed up).
- 400 `{ "error": "Enter a valid email address" }`
- 429 after 5 sign-ups per IP per hour.
- 503 before migration `2026-09-30u-drop-signups.sql` is applied.

## `POST /upload-image` (admin)

Raw image bytes (JPEG, PNG or WebP, 5 MB max). Re-encoded with no metadata, max 2400px; a ~480px WebP thumbnail
is stored beside it (`<folder>/thumbs/<name>.webp`) and recorded. Answers `{ "url": "…", "thumb_url": "…" | null }`
(`null` only if the thumbnail step failed; the photo itself is stored either way).

## The lot page (F2): `GET /lots/...`

A lot's own page is **`/a/<auction slug>/lot/<n>`** (n = lot number = position + 1). The slug is the auction's title
words plus the first 8 characters of its id (`monster-shelf-3f9a1c2e`); only the id part finds the auction, so a
renamed auction's old links still resolve (the answer carries the current `auction.slug`: move there). A full
auction id also works as the slug. The website builds slugs with `src/lot/slug.js`, which must match the backend's
`lot_rules.js` (suite `lot-page-frontend.js`). The old `/auction/:id?lot=:id` link redirects to the lot page.

Public rules as everywhere: drafts are 404 (for everyone, the admin included); never a max, reserve, leading
bidder or username; the pickup street address stays with winners.

### `GET /lots/:id` and `GET /lots/by-number/:slug/:n`

No login, and the same answer for everyone (no token is read), so it can be cached: `Cache-Control: public,
max-age=0, s-maxage=5` (browsers always revalidate; a shared cache may hold it 5 s). 404 unknown/draft, 400 bad id/n.

```jsonc
{
  "server_now": "ISO",                        // count down from this
  "lot": {
    "id": "uuid", "number": 12, "position": 11, "title": "…",
    "description": "plain text, may contain blank-line paragraphs", "condition": "…" | null,
    "status": "open" | "upcoming" | "closed" | "sold" | "unsold",   // closed = time up, not settled yet
    "ends_at": "ISO" | null,
    "image_url": "https://…" | null, "thumb_url": "https://…" | null  // the first photo (share previews)
  },
  "auction": {
    "id": "uuid", "slug": "monster-shelf-3f9a1c2e", "title": "…",
    "story": "the description's first sentence (link to the auction for the full story)",
    "category": "…" | null, "phase": "live" | "upcoming" | "ended",
    "starts_at": "ISO" | null, "ends_at": "ISO" | null, "lot_count": 34, "buyers_premium_pct": 15
  },
  "photos": [{ "url": "full photo", "thumb_url": "~480px WebP" | null }],   // [] = show the placeholder
  "price": {
    "current_bid": 83.5 | null,               // null before the first bid
    "opening_bid": 1 | null,                  // the first bid's minimum; null once there are bids
    "bid_count": 9,                           // every bid that moved the price (proxy steps included)
    "premium_pct": 15,
    "premium_amount": 12.53,                  // for current_bid (else opening_bid), computed exactly as
    "total_with_premium": 96.03,              //   orders and invoices do: integer cents, rounded half up
    "next_bids": [85.5, 87.5]                 // the next two valid max bids for anyone not leading ([] when not
                                              //   open). The server still judges every bid (POST .../bid).
  },
  "time": { "ends_at": "ISO", "soft_close_minutes": 2 },   // a bid inside the last N minutes moves ends_at to
                                                           //   N minutes after that bid (the live setting)
  "fulfilment": {
    "pickup": { "free": true, "town": "Miami, FL" | null, "starts_at": "ISO" | null, "ends_at": "ISO" | null } | null,
    "shipping": { "priced": "after_auction", "estimate": null, "carrier": "USPS", "country": "US" } | null
  },                                          // null = not offered by this auction. No lot has weight/size data,
                                              //   so shipping is never priced before the auction (estimate null).
  "nav": { "prev": { "id", "number", "title" } | null, "next": { … } | null },   // null at the ends: go to the auction
  "contact_email": "…"                        // "Questions about this lot?"
}
```

### `GET /lots/:id/me` (login)

The caller's own standing; never anyone else's. `no-store`.
`{ "status": "winning" | "outbid" | "no_bid" | "won" | "lost" | "closed", "my_max": 90 | null, "min_bid": 66 | null }`.
`min_bid` is what the caller may bid now (the leader may raise from the current price), null when not open.

### `GET /lots/:id/bids` (login)

There is no public bid list (B7): 401 without a login; the public sees `price.bid_count`. Newest first, `no-store`.

- A buyer gets **only their own** bids: `{ "scope": "own", "bid_count": 5, "bids": [{ "at": "ISO", "amount": 90,
  "price": 66 }] }`. `amount` is the max they entered with that bid (migration y; before it, and for older rows, the
  price the bid produced); `price` is the lot's price right after it. A leader raising their own max adds no row
  (their current max is `my_max` in `/lots/:id/me`).
- The admin gets every bid: `{ "scope": "all", "bid_count": 5, "bids": [{ "at", "price", "bidder": "username",
  "leader": "username" | null, "max": 90 | null }] }`. `leader` = who held the lead at that price (migration x).

### `GET /lots/:id/related` (no login)

`{ "server_now", "more_from_auction": [Lot], "similar": [Lot], "premium_pct": { "<auction id>": 15 } }`, Lot as for
`/home`. More from this auction: up to 8 open lots, soonest ending first, this lot excluded. Similar: open lots in
OTHER live auctions sharing at least one title word (the auction category only breaks ties), best match first, max
12; `[]` when fewer than 3 match (hide the rail). `Cache-Control: public, max-age=15`.

## Existing public reads the homepage links to

- `GET /auctions` — published auctions (drafts only for the admin). Each has `thumb_url` for its cover. Public
  auction fields: `id, title, description, image_url, thumb_url, category, starting_bid, current_bid, status,
  starts_at, ends_at, mode, host_username, created_at, buyers_premium_pct, fulfillment_mode, pickup_town,
  pickup_starts_at, pickup_ends_at` (the admin gets the full row, `pickup_address` included).
- `GET /auction/:id` — one auction, the same public fields (404 for a draft unless admin).
- `GET /auction/:id/items/standard-status` (and `/auction/:id/items`) — every lot in a standard auction. Public lot
  fields: `id, auction_id, position, title, description, condition, image_url, thumb_url, starting_bid, current_bid,
  bid_count, pre_bid_count, status, ends_at, created_at`; no leader, max or reserve (admin/host: full rows).
- `GET /auction/:id/my-standing` (login) — the caller's own standing on every lot:
  `{ "lots": { "<item id>": "winning" | "outbid" | "no_bid" | "won" | "lost" | "closed" } }`. The room's "You're
  winning" / "You've been outbid" come from here, never from comparing a leader's name.
- `GET /auction/:id/bids` — `{ "bid_count": 12 }` for everyone but the admin (who gets the rows).
- `POST /auction/:id/items/:itemId/bid` — answers the public lot plus `your_status: "winning" | "outbid"` (never who
  else leads or their max).
- `GET /my-orders` — each order has `pickup: { address, town, starts_at, ends_at } | null`: the street address,
  only on the caller's own won orders and only when they chose pickup (B6). The same address is in their win email.
- Socket (live mode, gated off): `auction_state`, `item_activated`, `new_bid` and `auction_ended` carry no bidder;
  each socket gets its own `you_lead` / `you_won`. `bid_history` goes to the admin only. Chat messages show
  usernames by design (see OPEN_ITEMS; decide before live mode returns).
- `GET /auction/:auctionId/items/:itemId/images` — a lot's photos, full size (the lot page now reads them from `GET /lots/:id`).

## Watch list, follows and reminders (login required unless noted)

Only ever the logged-in buyer's own. **No public watch counts**: `/home`, `/search` and the auction pages are the
same for everyone and carry no watch data; a page fetches `GET /me/watching` and marks its own buttons. Needs
migration `2026-09-30w-watch-list.sql`; before it, the write routes answer 503 and `/me/watching` answers empty
with `"available": false`. Rate limited per buyer (60 changes a minute).

- `POST /watch/:itemId` → `{ "watching": true }`. Idempotent. 404 for a lot in a draft (or unknown), 400
  `lot_closed` for a closed lot, 400 `watch_limit` beyond 500 watched lots.
- `DELETE /watch/:itemId` → `{ "watching": false }`.
- `POST /follow/:auctionId` → `{ "following": true }`. Idempotent. 404 for a draft, 400 `auction_ended`.
  Following an auction that is already open (or already inside its last 24 hours) marks that reminder done.
- `DELETE /follow/:auctionId` → `{ "following": false }`.
- `GET /me/watching`:

```jsonc
{
  "lots": [ Lot + {                                   // Lot as for /home (incl. auction_title, thumb_url)
      "auction_phase": "live" | "upcoming" | "ended",
      "buyers_premium_pct": 15,
      "my_status": "winning" | "outbid" | "no_bid"    // while open
                 | "won" | "lost" | "closed"          // after it closes
  } ],                                                // newest watch first
  "auctions": [ { "id", "title", "blurb", "phase", "starts_at", "ends_at", "lot_count", "image_url", "thumb_url" } ],
  "ids": { "lots": ["uuid"], "auctions": ["uuid"] }   // for marking buttons
}
```

- `GET /me/notification-prefs` → `{ "lot_closing": true, "auction_open": true, "auction_closing": true }`
  (all on by default). `PUT` the same shape (any subset, booleans) → the full set. Outbid emails are separate.
- `GET /unsubscribe?token=` (no login) → `{ "ok": true, "kind": "all", "what": "…" }`: describes the link, changes
  nothing (mail scanners open links). `POST /unsubscribe?token=` (no login) → the same, and switches those reminders
  off. The token is in every reminder's footer link (`<site>/unsubscribe?token=…`) and its `List-Unsubscribe` /
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (which POST to this route). Tokens are signed and don't
  expire; a bad one is 400.
- `GET /admin/watch-counts?auction_id=` (admin only) → `{ "followers": 3, "lots": { "<item id>": 2 } }`.

**Reminder emails** (the auto-close loop, every 30 s): one email per buyer per run covering everything due for them:
watched lots closing within the hour (price with premium, the buyer's status, a Bid link), followed auctions that
opened (3 photos, lot count, end), followed auctions whose first lot closes within 24 hours (their top 5 lots by bids,
minus any already listed). Each reminder is sent once; a soft-close extension never re-sends; closed lots are
skipped; each preference is respected. Outbox: `notifications` (channel `email` now; the app adds `push`).
