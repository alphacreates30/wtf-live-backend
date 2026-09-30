# API contracts (public, app-ready)

The website and the planned native app read the same endpoints. Pages only render; every rule lives here, in the
backend. Conventions for everything below:

- **Dates** are ISO 8601 strings in UTC (`2026-10-04T18:00:00.000Z`).
- **Money** is a number in dollars; the currency is always USD.
- **No HTML** in any response. Descriptions are plain text.
- **Lot number** shown to people = `position + 1`. It never changes as lots close.
- **Never sent to the public:** another buyer's max bid (`top_pre_bid`), reserve prices, leading bidders on the
  homepage, draft auctions or anything in them. Suites: `verification/secret-max.js`, `draft-reads.js`, `home.js`.
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

"Open" = not `sold`/`unsold` and `ends_at` still in the future. Link a lot to `/auction/:auction_id?lot=:id`.

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

## Existing public reads the homepage links to

- `GET /auctions` — published auctions (drafts only for the admin). Each has `thumb_url` for its cover.
- `GET /auction/:id` — one auction (404 for a draft unless admin).
- `GET /auction/:id/items/standard-status` (and `/auction/:id/items`) — every lot in a standard auction, maxes and
  reserves stripped; each lot has `thumb_url` for grid cards.
- `GET /auction/:auctionId/items/:itemId/images` — a lot's photos, full size (the lot page).
