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

## `GET /config`

No login. The auction rules a page may put into words, so none are hard-coded:
`{ "soft_close_minutes": 2 }` (a bid in a lot's last N minutes moves its end to N minutes after that bid; the same
value as `time.soft_close_minutes` on `GET /lots/:id`). `Cache-Control: public, max-age=300`. Also `points` (G2, see
"Points and promotions" below) and `live_enabled` (G1: `true` only when the backend runs with `LIVE_ENABLED=true`; a page
hides every live-show control while it is `false`).

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
- Socket (live shows, see "Live shows (G1)" below): `auction_state`, `item_activated`, `new_bid`, `lot_closed` and
  `auction_ended` carry no bidder; each socket gets its own `you_lead` / `you_won`. `bid_history` goes to the admin
  only. Chat messages show usernames by design. (Usernames on live bids and wins come with live phase 5.)
- `GET /auction/:auctionId/items/:itemId/images` — a lot's photos, full size (the lot page now reads them from `GET /lots/:id`).

## Who may bid (every auction)

A bid, a pre-bid and accepting an auction's terms all need: logged in, a buyer profile, `approved`, not `blocked`, a
saved card **that passed the $1 check** (`profiles.card_verified_at`), and not the host/admin account (Albert, Oct 15,
2026). A refusal is 403 `{ error, code }` with `code` one of `no_profile`, `blocked`, `not_approved`, `no_card`,
`card_not_verified`, `host_cannot_bid` (a lookup failure is 503). `POST /save-payment-method` answers
`{ success: true, card_verified: true | false }`; an approved buyer replaces a failed card on their profile page.
A pre-bid can be withdrawn (`DELETE …/prebid`) only while its lot is `pending`: on an open lot the same row is that
bidder's live max (400).

## Live shows (G1)

Brief: wtf-handoff `LIVE_SHOWS_BRIEF.md`. **Switched off** unless the backend runs with `LIVE_ENABLED=true`: then
`POST /auction` with `mode: "live"` is 400, every live socket event below answers `live_off`, live pre-bids are 400
`{ code: "live_off" }` and `GET /auction/:id/token` is 404. Needs migration `2026-10-15za-live-bidding.sql`.

- A live show is an auction with `mode: "live"`. It has **no buyer's premium** (created at 0; `PATCH` with any other
  value is 400; the database forces 0) and **no reserve** (bulk lots with one are refused; the database drops one).
  Its lots wait as `pending` (no clock) until the host offers them.
- Lot status: `pending` → `open` (with `ends_at`, the database clock) → `sold` | `unsold`.
- `POST /auction/:id/items/:itemId/bid` refuses a live lot: 400 `{ code: "live_lot" }` (bid in the show).
  `POST …/prebid` works on a live lot while it is `pending` (same gates as a bid).

Socket events (payloads always include `auctionId` and the buyer's/host's `token`):

| Event (client → server) | Who | What |
|---|---|---|
| `place_bid { itemId?, max_amount }` | buyer | A max bid on the open lot (no `itemId` = the lot open now). Same engine as timed lots (`place_standard_bid`: proxy/max, tiers, row lock). Answers `bid_ok` (the public lot + `your_status`, `max_only: true` when the leader only raised their max) or `bid_error { message, code }`: the "Who may bid" codes, or `live_off`, `login_required`, `terms_required`, `payment_failed` (their card was declined for a lot in this show and isn't fixed yet), `not_on_air`, `bad_amount`, `not_found`, `lot_not_open`, `below_minimum`, `refused`, `rate_limited`. |
| `start_auction` | host | On air (`upcoming` → `live`; sets `on_air_at`). |
| `next_item { timerSeconds = 30, suddenDeath = false }` | host | Offers the next `pending` lot (a lot re-run "next" first, `offer_next`; then by position) and starts its clock: **60, 30, 15 or 5 s** (any other value is refused). Pre-bids from buyers whose card was declined in this show are dropped first. Refused while a lot is open. |
| `extend_auction { extraSeconds }` | host | Adds 1–120 s to the open lot's clock. |
| `pass_lot` | host | Closes the open lot with **no sale** (`unsold`, no order), whatever its bids. |
| `rerun_lot { orderId, next = true }` | host | **"Re-run now"** on a declined-card alert, while the show is on air: a copy of the lot goes back in this show's lineup, offered next (`next: true`) or at the end (`false`), with the next free lot number. The declined order is cancelled (kept, `reoffered_item_id` = the copy) and is never charged, even if the buyer fixes their card later; a points reward spent on it is given back. Answers `rerun_ok { order_id, item_id, lot_number, next }` or `host_error` (code `rerun_refused`: not a declined lot, show not on air). |
| `end_auction` | host | Ends the show. **Refused while a lot is open** (`host_error` code `lot_open`): let its clock finish or Pass it. Then the after-show emails. |

| Event (server → client) | Payload |
|---|---|
| `item_activated` | `{ item (public lot), you_lead, pre_bid_count, timer_seconds, sudden_death, ends_at, server_now }` (also sent to a viewer who joins mid-lot) |
| `item_timer_tick` | every second: `{ auctionId, item_id, seconds, ends_at, server_now }`. Time left = `ends_at − server_now` (the database's clock). |
| `new_bid` | `{ auction_id, item_id, amount, bid_count, ends_at, server_now, you_lead }` |
| `item_extended` | `{ auctionId, item_id, ends_at, server_now }` (the host's +N s) |
| `lot_closed` | `{ auctionId, item_id, status: "sold" \| "unsold", amount, you_won, passed? }` |
| `payment_failed` / `payment_ok` | to the buyer only: `{ auctionId, item_id, order_id, amount_cents, lot_number, message }` (declined at the hammer / charged after they saved a new card). `payment_ok { auctionId, charged: false, message }`: their declined lots were all re-run, and the new card lets them bid again |
| `lot_payment_failed` / `lot_payment_fixed` | to the host only: `{ auctionId, item_id, order_id, amount_cents, lot_number, buyer, item_title, reason?, can_rerun? }` (`can_rerun`: the show is on air, so "Re-run now" works) |
| `lot_rerun` | to the room: `{ auctionId, item (public lot, `offer_next`), lot_number, next, rerun_of: { item_id, lot_number, status: "unsold" } }`. The buyer also gets `you: true, message: "Your card was declined, so lot N was offered again."`; the host gets `order_id, buyer` (clears the alert). Nobody else learns who it was |
| `items_finished`, `auction_started`, `auction_ended` | `{ auctionId }` |
| `host_error` | `{ message, code? }` |

How a lot sells: the opening price applies the pre-bids by the proxy rule and **never** shows the top max (one
pre-bid: the opening minimum, $1 or the starting bid; two or more: `least(top, second + increment)`, the top pre-bidder
leading). A bid with 5 s or less left adds 5 s (Sudden death: nothing). At 0 the database closes the lot
(`close_live_lot`, one closer only), the order is created (one per lot), `lot_closed` goes out, and **then** the card
is charged in the background (`chargeOrder`, with the lot's G2 discount): the hammer price, no premium. No per-lot
win email; a declined card emails the buyer and the admin at once.

After a decline (phase 1b, migration `2026-10-16zb`): the buyer can't bid or pre-bid in that show (`payment_failed`)
until they save a card that passes the $1 check (`POST /save-payment-method`); that charges their declined live lots
at once. **Re-run now** (`rerun_lot`): the host can put a declined lot straight back in the show instead of waiting;
the buyer is told in the room and by email ("Lot N was offered again"), that order is never charged, and the buyer
still can't bid in the show until they save a new card. **One box per buyer per show:** every lot a buyer wins in a show (not pickup) joins one `orders.group_id`,
so the label and postage go through the existing group flow once. **After the show:** one "Your wins from …" email
per buyer (lots, declined ones marked, the one-box or pickup note), sent once every charge has settled
(`auctions.live_summary_sent_at`). **Pre-bid expiry:** a live show with no `on_air_at` 24 h after its `starts_at`
releases its pre-bids (deleted; one email per bidder; a `notifications` row of kind `prebid_released` is the record;
once per show, `prebids_released_at`); `POST …/prebid` on it is then 400 `{ code: "prebids_released" }`.

Admin (403 for anyone else):
- `GET /admin/live/:id/unpaid` → `{ show, can_rerun (on air), can_reoffer (the show has ended), lots: [ { id (order), item_id, item_title,
  buyer_username, buyer_user_id, total_cents, payment_error, created_at } ] }`: lots whose card was declined and not fixed.
- `POST /admin/live/orders/:orderId/reoffer { auction_id, next? }` → `{ item_id, auction_id, lot_number }`. Only an
  unpaid lot. `auction_id` = **the same show while it is on air** (= `rerun_lot`; `next`, default true), or, only after
  the show, a later live show (the copy waits there, `pending`) or a timed auction that hasn't ended
  (the copy is `open` until that auction's `ends_at`). Title, description, condition, photos and starting bid are
  copied; the order becomes `cancelled` (kept as the record) and leaves the box; a points reward spent on it is given
  back. 400 with the reason otherwise.
- `GET /admin/live/failed-payments` → `[ { buyer_user_id, username, failed, reoffered, last_at } ]`: per buyer, live lots
  still unpaid and lots re-offered after a decline (no automatic strike; block a repeat non-payer as usual).

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

## Points and promotions (G2)

Rules: wtf-handoff `POINTS_BRIEF.md`. Code: `rewards.js` (the maths and the one shared discount decision) and the
"Buyer points + promotions" block in `server.js`. Needs migration `2026-10-15z-points.sql`. **Switched off** unless
`POINTS_ENABLED=true` (Railway) **and** the admin switch (`points_settings.enabled`) are both on; promotions follow
`POINTS_ENABLED` alone. While off, every buyer route below answers `{ "enabled": false }` / `[]` / 404 and no money
changes. Only ever the logged-in buyer's own points.

- `GET /config` (no login) gains `"points": { "enabled": true, "points_per_dollar": 1, "points_per_reward": 250,
  "reward_cents": 2500 }` (or `{ "enabled": false }`), for "Earn a point for every dollar you win. Every 250 points is
  $25 off." and the lot page's "This win earns about N points" (floor(price) × points_per_dollar).
- `GET /me/points`:

```jsonc
{
  "enabled": true,
  "balance": 198, "toward_next": 198, "per_reward": 250, "rewards_ready": 0,
  "reward_cents": 2500, "points_per_dollar": 1,
  "saved_cents": 2875,                 // points rewards used on paid invoices (incl. the premium saved)
  "auto_apply": true,                  // default ON: timed auctions charge automatically
  "expires_at": "ISO" | null,          // last paid win + expiry_months; null with no points
  "expiry_months": 12,
  "history": [ { "kind": "earn" | "redeem" | "expire" | "reverse" | "adjust", "points": 52, "note": "…",
                 "created_at": "ISO", "item_title": "Lot 3: …" | null } ]   // newest first, up to 100
}
```

- `PUT /me/points/settings` `{ "auto_apply": false }` → `{ "auto_apply": false }`. 404 while points are off.
- `GET /auction/:id/promotions` (no login) → `[ { "kind": "percent_code" | "free_shipping" | "bundle_free_shipping",
  "percent": 20 | null, "starts_at", "ends_at", "bundle_min_lots": 3 | null } ]`: running or upcoming, this auction or
  site-wide. **Never the code itself.** 404 for a draft.
- `GET /checkout/code?auction_id=` → `{ "entered": { "code", "percent", "applied" } | null, "note" }`.
- `POST /checkout/apply-code` `{ "auction_id", "code" }` → the same. One code per buyer per auction (a new one
  replaces it). 400 not valid for this auction; 409 the auction has closed, or this buyer's invoice already exists;
  404 promotions off / draft. Rate limited like bids.
- `DELETE /checkout/apply-code?auction_id=` → `{ "entered": null }` (until it has been used).
- `GET /my-orders` rows gain `invoice: { total_cents, discount_kind: "points_reward" | "promo_code" | null,
  discount_cents, discount_premium_cents } | null`, `points_earned` (that lot) and `shipping_promo`. A live-show lot
  (charged on its own, no invoice) carries `discount: { kind, cents } | null` instead; its `total_cents` is after it.
  `payment_status` can also be `cancelled` (a live lot re-offered after a decline).

How a discount applies (timed auctions): when the invoice is built, **one** discount is decided, once: the points
reward (if auto-apply is on and the balance has `points_per_reward`) or the entered code, whichever saves more (a tie
uses the code, so the points are kept). It comes off the winning bids (never below $0), the premium is worked out on
the lower amount (`discount_premium_cents`), and `invoices.total_cents` is lowered before the charge. A total under
Stripe's 50c minimum goes to $0; a $0 invoice is marked paid with `payment_intent_id = 'no_charge_discount'` and no
Stripe call. Points are earned per lot (floor of the winning bid × points_per_dollar) when the invoice is paid,
including a $0 one. A full Stripe refund (`charge.refunded`, which the Stripe webhook must send) takes those points
back, never below 0; a partial refund changes nothing and emails the admin. Postage: a `free_shipping` promo, or
`bundle_free_shipping` when the buyer won 3+ lots in that auction, makes `/admin/orders/label` buy the label without
charging the buyer (`buyer_paid_cents: 0`, `orders.shipping_promo`); the quote shows `buyer_pays_cents`.

**Live shows (G1, wired in phase 1):** each hammer charge calls `rewards.applyOrderDiscount(orderId)`, which asks
`discountsForCharge({ scope: 'lot', … premiumCents: 0 })` and records the result once with `apply_order_discount`
(migration za): at most one points reward per lot, or the show's % code (an entered code covers every lot the buyer
wins in that show), the bigger saving; never below $0 and never 1–49c left. `orders.discount_kind / discount_cents`
show it and `orders.total_cents` is what is charged; a $0 lot is paid with `payment_intent_id = 'no_charge_discount'`.
Points are earned per paid lot (`chargeOrder`). The live "one box per show" postage goes through the same label
route, so the shipping promos already apply.

Admin (403 for anyone else):
- `GET /admin/points-settings` → `{ admin_enabled, env_enabled, migrated, enabled, points_per_dollar,
  points_per_reward, reward_cents, expiry_months }`. `PUT` any of `enabled`, `points_per_dollar` (0–100),
  `points_per_reward` (1–100000), `reward_cents` (1–100000), `expiry_months` (1–120), whole numbers.
- `GET /admin/promotions[?auction_id=]` → promotions with `uses: { entered, applied }`. `POST` `{ kind, auction_id |
  null, code + percent (percent_code only), starts_at, ends_at, active? }` → 201. `PATCH /admin/promotions/:id`
  `{ active, starts_at, ends_at, auction_id }` (kind/code/percent can't change). `DELETE` → 409 once a code was used.
- `GET /admin/points/:userId` → `/me/points` for that buyer plus `username` (history up to 1000).
- `POST /admin/points/:userId/adjust` `{ points: ±int, note }` → `{ balance }`. 409 below 0; a note is required.
- `GET /admin/points-summary` → `{ points_outstanding, buyers, rewards_ready, value_cents, ready_value_cents, enabled }`.

Expiry: the close loop runs `runPointsHousekeeping` at most hourly: a reminder email ~30 days before
(`points_reminders_due`, once per expiry date) and expiry after `expiry_months` with no paid win
(`points_expire_due`). Deleting an account (A5) removes the buyer's ledger, account and entered codes.
