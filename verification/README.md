# Verification suites

Behavioural proofs for the eleven checks of 2026-09-19/20. Each one
**reproduces the bug on an older commit, then shows the fix refuses it**, and
also checks the legitimate path still works. Run them after touching any of the
routes below.

> ## ⚠ DEPLOY HAZARD: no Railway deploys during an auction close window (until #48 ships)
>
> **Duplicate orders (over-billing) are closed.** Migration `2026-09-21g-orders-item-id-unique.sql`
> (partial unique index on `orders.item_id`) is applied on production - confirmed present
> (`orders_item_id_key`) - and `createOrderOnWin` treats the resulting `23505` as "exists" instead of
> erroring. Two instances can no longer both insert an order for the same lot. Re-verified post-migration
> at 200 lots / 20 buyers, two instances, 3 runs: one order per sold lot every time, and every invoice
> total / Stripe charge amount matched what was actually owed exactly (0.0% off; pre-migration this was
> 80.2% off - $13203.53 charged against $7325.71 owed). The in-process overlap guard
> (`autoCloseRunningSince`) never closed this by itself - it's per-process - the unique index is what
> makes it impossible across instances.
>
> **Under-billing (#48) is fixed in code, NOT YET DEPLOYED.** With two instances running the close job
> at once, one could reach "no open items left" and start building invoices for the auction at the exact
> moment the other had just flipped a lot to `sold` but hadn't yet inserted its order. Invoice build only
> summed orders that already existed, so it silently skipped that lot: the buyer stayed undercharged and
> the order arrived afterward with no `invoice_id`, never to be charged (the auction was already `ended`
> and nothing revisits it). No DB migration needed - unlike the duplicate-order fix, this is a pure code
> check: `maybeEndStandardAuction` now verifies every `sold` lot has an order before building invoices,
> deferring to the next tick if any are missing. Reproduced and fixed deterministically
> (`verification/undercharge-race.js`) - the old commit ends the auction with the order still in flight
> and no invoice ever built; the new code defers, then completes correctly once the order lands. **Once
> this ships to production, delete this entire hazard box - both halves are closed.** Until then, **do
> not deploy the backend while any standard auction is closing** (its lots' `ends_at` passing, up to
> when it flips to `ended`).

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

They start local copies of the server on ports 3231-3234, 3241-3242, 3251-3252,
3261-3262, 3271-3272, 3281-3285, 3291-3293, 3301-3312, 3321-3322 and 3331-3332 with the background jobs (`setInterval`) stubbed out, so nothing
auto-closes or charges. They write temporary `server.tmp-*.js` / `run.tmp-*.js`
files next to `server.js` and delete them on exit (both are git-ignored).

**Credentials:** none are stored here. Everything is read from `.env`
(`SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`), which stays untracked. Tokens
are minted in-process with `JWT_SECRET` and expire in minutes. `id-normalisation.js`
also needs `../wtf-live-frontend` checked out next to this repo (for
`socket.io-client`).

## The twelve suites

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
| `paid-stays-paid.js` | #37: `chargeInvoice` ran the won-and-charged email inside the same `try` as the charge, after marking the invoice paid, so anything throwing there made the `catch` flip a PAID invoice (and its orders) to `failed` and email the buyer "payment failed". Reproduced on the pinned commit for both the fresh-charge and the already-charged (re-click) paths. Fixed in two layers: the notify call is wrapped, and the failure handler only writes `failed` where `payment_intent_id is null`; each layer is tested alone. Genuine declines still record `failed`, retries still reach the charge. **Stripe is faked in-process and the email step is forced to throw** (in real code it swallows its own errors, so this is a structural hazard, not a live failure); nothing is charged or sent. Borrows the `zztest_paid_ok` profile read-only. | **`1ffce81`** | _this slice (#37)_ |
| `delete-atomic.js` | `DELETE /auction/:id` deleted lots, bids and chat one statement at a time, then the auction, ignoring the last error. An order created in the gap (an auction closing creates them) made the DB refuse the auction AFTER the children were gone, and the route still answered 200. The race is simulated by source-patching an order insert into the gap. Asserts the **child rows survive** (lots, bids, chat, pre-bids, images, outbid log, terms), not just the status; also an invoice-only auction, a clean delete removing every dependent, and idempotent re-delete. **Requires `migrations/2026-09-20e-delete-auction-cascade.sql`** (the route calls that function; the suite refuses to run without it). Only `bids`, `chat_messages` and `auction_terms_acceptances` cascade from `auctions` - lots and pre-bids do not, hence the explicit transactional function. | **`80fdcd9`** | _this slice_ |
| `email-volume-guard.js` | Resend Pro (50,000 per billing period, no daily cap): the outbid-suppression guard counted from the start of the UTC DAY and suppressed at 90, so on Pro it dropped outbid emails with ~49,900 of headroom. Now a rolling 30 days, suppress at 45,000; won/failed/shipped/admin always go through; fails closed. The window is deliberately approximate and conservative (Resend renews on the billing day - the 20th today - not the 1st; a rolling window over-counts just after a reset, so it errs early, never late except ~1 day on a 31-day cycle). The REAL functions are extracted from `server.js` into a vm with Resend's HTTP call stubbed - nothing is sent; one check uses throwaway `email_send_log` rows (`zztest_vol`) against the real table. | **`d60b9e7`** | _this slice_ |
| `scale-200-close.js` (**slow, ~15 min, not part of the quick run**) | The whole close path at 200 lots / 20 buyers (`autoCloseStandardItems` -> `createOrderOnWin` -> `buildAndChargeInvoicesForAuction` -> `chargeInvoice`), real code and real database, Stripe an in-process fake (800ms latency, 2 declines, 1 error). Scenarios: `single` and `double` (two servers running the job at once). Asserts one order per sold lot; invoice totals vs an independently computed figure; **AMOUNT: every invoice total and every amount sent to Stripe equals what each buyer owes, recomputed from the lots the database says sold** (every earlier check proved charge *count*; a 60% overcharge passed all of them); exactly one charge attempt per invoice; failures mid-loop don't stall later buyers. Measures tick duration and requests per lot. The fixture stays `draft` so the production job skips it, and the local job is patched to touch only it. The `double` scenario needs migration g to pass. | n/a (current code) | _this slice_ |
| `charge-auto-vs-manual.js` | The auto-close job re-attempted FAILED invoices when a tick re-entered an auction it had already charged (23 charge attempts for 20 invoices in the 200-lot run): an automatic retry of a declined card. `chargeInvoice(id, { auto: true })` (used only by `buildAndChargeInvoicesForAuction`) now claims only `unpaid` (plus stale-`charging` crash recovery); a human's `/charge-winner` still claims `failed`. Proves both directions, plus that the job still charges unpaid invoices and leaves a fresh `charging` one alone. Stripe is faked in-process. | **`670cdb5`** | _this slice_ |
| `orders-item-unique.js` | One order per lot, enforced by the database (`migrations/2026-09-21g`). Provokes the race deterministically (two concurrent `createOrderOnWin` calls for one lot): BEFORE the migration it shows 8 of 8 races duplicate an order on both old and new code, then exits 2; AFTER, asserts the index refuses a raw duplicate, live orders with no `item_id` are unconstrained, and each race yields exactly one order with both callers getting the same id. | **`670cdb5`** | _this slice_ |
| `undercharge-race.js` | #48: an invoice build must not run while a sold lot's order is still in flight - the residual risk flagged after the 200-lot double-instance runs. A test-only route flips one lot to `sold` and, after an injected delay, calls the real `createOrderOnWin` (Step 1's own sequence, gap widened on purpose); a second test-only route drives the real per-auction "everything closed?" check (`maybeEndStandardAuction` on NEW; a frozen copy of the pinned commit's own inline equivalent on OLD) into that gap. On the pinned commit: the auction ends with the order still missing, no invoice is ever built for it, and the order arrives afterward permanently unlinked (`invoice_id` null) - undercharged for good, since an `ended` auction is never revisited. Fixed: `maybeEndStandardAuction` checks every `sold` lot has an order before building invoices and defers (leaves the auction `live`) if any are missing; the next call finds it covered and completes normally, invoice total matching the order exactly. No DB migration involved - pure code, unlike the duplicate-order fix. | **`9ffdcfb`** | _this slice (#48)_ |

## Not covered

- The DB-level guards are now covered: `delete-guard.js` asserts that a raw
  delete of an auction with orders / invoices is refused by Postgres (23503,
  `orders_auction_id_fkey` / `invoices_auction_id_fkey`), that an order for a
  non-existent auction cannot be inserted, and that the pre-migration server can
  no longer orphan an order (even with an UPPERCASE id). The migrations
  themselves (`migrations/2026-09-19a…d`) were applied to production on
  2026-09-20 and must not be run again.
- Some "reproduce the old bug" assertions became "the database refuses it" once
  the schema changed (`delete-guard`'s control and uppercase bypass;
  `id-normalisation`'s uppercase `/admin/orders` filter). The pre-bid and
  add-item poisoning reproductions still hold: `auction_items.auction_id` and
  pre-bid rows are still text columns.
- The `DELETE /auction/:id` atomicity gap is fixed (`delete-atomic.js`).
