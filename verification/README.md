# Verification suites

Behavioural proofs for the five security fixes of 2026-09-19/20. Each one
**reproduces the bug on an older commit, then shows the fix refuses it**, and
also checks the legitimate path still works. Run them after touching any of the
routes below.

> ## ⚠ These run against the REAL database
>
> They use the Supabase project in your `.env`, not a test copy. Each creates
> clearly-named throwaway rows (`ZZTEST_…` auctions, lots, orders, a throwaway
> buyer) and deletes them afterwards, and each ends by printing
> `leftover throwaway rows: 0`. But it is still the real database: real
> `insert`s and `delete`s, on the same project production uses.
>
> So they refuse to run unless you pass the flag, and they print the database
> host first:
>
> ```
> node verification/terms-gate.js --yes-run-against-the-real-database
> ```
>
> Do not wire these into CI or a pre-commit hook. If one crashes mid-run, look
> for leftover `ZZTEST_` rows (`select * from auctions where title like 'ZZTEST_%'`).

They start local copies of the server on ports 3231-3234, 3241-3242, 3251-3252
and 3261-3262 with the background jobs (`setInterval`) stubbed out, so nothing
auto-closes or charges. They write temporary `server.tmp-*.js` / `run.tmp-*.js`
files next to `server.js` and delete them on exit (both are git-ignored).

**Credentials:** none are stored here. Everything is read from `.env`
(`SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`), which stays untracked. Tokens
are minted in-process with `JWT_SECRET` and expire in minutes. `id-normalisation.js`
also needs `../wtf-live-frontend` checked out next to this repo (for
`socket.io-client`).

## The five suites

Each suite's "before" server is pinned to a commit, not to `HEAD`, so its
reproduction assertions stay valid however far `main` moves on. A suite that is
always red teaches people to ignore red.

| Suite | Proves | "Before" server pinned to | Fixed in |
|---|---|---|---|
| `delete-guard.js` | `DELETE /auction/:id` refuses (409) when the auction has orders and fails closed (500) if the check errors; auth still 403; a real auction with orders is untouched. **Uppercase-id bypass:** on the pinned commit an UPPERCASE uuid deleted an auction that had orders (text column compared case-sensitively) and orphaned them; now 409. Malformed id → 400. | Order guard: the same source with the guard removed at runtime (`if (false)`). Uppercase bypass: **`3c6dc5a`** | `3c6dc5a` (guard), `c5caa33` (uppercase) |
| `terms-gate.js` | Terms accepted on auction A could be used to bid and pre-bid on a lot in auction B (no acceptance, no fulfilment choice, wrong premium snapshot). Now 404, nothing written; honest URL still 403; legitimate bids/pre-bids still work, including uppercase ids. | **`c5caa33`** | `385ea56` |
| `id-normalisation.js` | Every client-supplied id is validated as a uuid and lowercased at the edge. Reads with an UPPERCASE id match lowercase; `/admin/orders?auction_id=` no longer silently returns nothing; pre-bid and admin add-item no longer store a non-canonical id in a text column; publish with an uppercase id works; garbage ids → 400 on URL, body (`order_ids`, `/charge-winner`) and query, before any work; socket `auctionId` normalised, bad ids get the event's own error. | **`385ea56`** | `a27f899` |
| `images-ownership.js` | `POST /auction/:auctionId/items/:itemId/images` checked that the caller hosts `:auctionId` but not that the lot is in it, so any host could attach an image to a lot in someone else's auction. Now 404, nothing written; own lots (and uppercase ids) still work. Uses two throwaway hosts. | **`a27f899`** | `1b5f994` |
| `charge-scope.js` | `/charge-winner` authorised against the body's `auction_id` but acted on `invoice_id` / `order_id`, so the host of auction A could charge an invoice or order in auction B (on the pinned commit: 402 and B's invoice flipped to `failed`). Now authorised against the target's own auction; a disagreeing body `auction_id`, or an `order_id` not on the given `invoice_id`, is 404, B untouched. Own invoice/order (incl. what the UI sends, uppercase ids) still reach the charge path. No Stripe key or email is used: the fixture buyer has no card. | **`a1b2dd5`** | _this slice (#39)_ |

## Not covered

- The DB-level guards in `migrations/2026-09-19a…d` (foreign keys, the
  `orders.auction_id` text → uuid conversion). **Applied to production on
  2026-09-20; do not run them again.** Re-run after them: `terms-gate`,
  `images-ownership`, `charge-scope` all pass. In `delete-guard` and
  `id-normalisation` every *fixed-code* assertion passes, but their "reproduce
  the old bug" assertions now FAIL by design - the database itself refuses
  what the code bug used to allow (FK RESTRICT; uuid column). `delete-guard`
  also aborts before its real-auction check as a result. Those reproductions
  need re-pinning to a pre-migration schema or converting to "DB refuses"
  assertions.
