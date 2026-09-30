# Verification suites

Behavioural proofs for the eleven checks of 2026-09-19/20. Each one
**reproduces the bug on an older commit, then shows the fix refuses it**, and
also checks the legitimate path still works. Run them after touching any of the
routes below.

> ## ✅ Close-path races (duplicate orders, under-billing): both closed
>
> Two races used to make deploying the backend during an auction close window unsafe. Both are now
> closed - kept here as a record, not a live warning.
>
> **Duplicate orders (over-billing).** Two instances could both pass `createOrderOnWin`'s "does this lot
> have an order?" check and both insert one - measured 2026-09-21 at 267 orders for 150 sold lots, one
> buyer's invoice inflated to $607.20 against $381.80 owed. Closed by migration
> `2026-09-21g-orders-item-id-unique.sql` (partial unique index on `orders.item_id`, live on production,
> confirmed present as `orders_item_id_key`) plus `createOrderOnWin` treating the resulting `23505` as
> "exists" rather than erroring. Re-verified post-migration at 200 lots / 20 buyers, two instances, 3
> runs: one order per sold lot every time, every invoice total / Stripe charge amount matching what was
> actually owed exactly (0.0% off; pre-migration this was 80.2% off).
>
> **Under-billing (#48).** Two instances could reach "no open items left" and start building invoices at
> the exact moment another had just flipped a lot to `sold` but hadn't yet inserted its order - invoice
> build only summed orders that already existed, so it silently skipped that lot, and because the auction
> was already `ended` afterward, nothing ever revisited it: a permanent undercharge. Closed in code (no
> migration needed) by `maybeEndStandardAuction`, which now verifies every `sold` lot has an order before
> building invoices and defers to the next tick if any are missing. Reproduced and fixed deterministically
> in `verification/undercharge-race.js`. Live on production as of `9322fde`.
>
> Both fixes are per-instance (in the actual code, not just a migration), so an ordinary Railway deploy -
> old and new instance briefly side by side - is no longer a hazard either way.

> ## ✅ Deploy check: `GET /version` (#49)
>
> After every push, confirm the pushed commit is the one serving traffic. Production backend:
> **`https://wtf-live-backend-production.up.railway.app`** (Railway project "clever-quietude", production).
>
> ```
> git rev-parse HEAD
> curl -s https://wtf-live-backend-production.up.railway.app/version
> # {"commit":"<sha>","started_at":"<ISO time the process booted>"}
> ```
>
> Poll `/version` until `commit` equals `git rev-parse HEAD`. A changed `started_at` proves a new process;
> the matching SHA proves it's the *right* one. "`/` responds 200" is **not** a deploy check. `commit` comes
> from Railway's `RAILWAY_GIT_COMMIT_SHA` and is `null` locally, which is correct. The route returns those two
> fields and nothing else: keep it that way, so it never becomes a place where config leaks.
>
> **Line endings.** Both repos have a `.gitattributes` (`* text=auto eol=lf`), so the working tree is LF
> whatever the local `core.autocrlf` says. When you check line endings, use `file` or a byte-level read.
> Git Bash's `grep`/`cat` strip `\r` and will show you LF when the file is CRLF. The suites also read
> source through `guard.readSource()` / `guard.sourceAt()`, which normalise `\r\n` to `\n`, so a CRLF
> checkout can't produce a false "marker not found" any more.

> ## Which database: wtf-test by default (2026-09-28)
>
> The suites run against **wtf-test**, a separate Supabase project with
> production's schema, functions, grants and `item-images` bucket but none of its
> data. No flag needed:
>
> ```
> node verification/terms-gate.js
> # Target database: <ref>.supabase.co  (test project, from .env.test)
> ```
>
> `guard.js` loads `SUPABASE_URL`, `SUPABASE_KEY` and `JWT_SECRET` from
> **`.env.test`** before anything else. dotenv never overwrites a key that's already
> set, so the suite's own later `.env` load and the local servers it spawns keep
> the test values. The guard refuses to run if `.env.test` is missing, lacks one
> of those three keys, or points at the same host as `.env` (production).
> **`.env.test` holds test credentials only** (wtf-test service-role key, a
> test-only `JWT_SECRET`, pooler URLs). It is git-ignored (`.env.*`). Never put
> production values in it.
>
> **Production, deliberately.** Pass `--yes-production` (the old
> `--yes-run-against-the-real-database` still works and means the same). The
> guard then loads `.env` and prints `** PRODUCTION **` next to the host. This
> should almost never be needed now. Non-draft `ZZTEST_` auctions show on the
> public homepage while they exist.
>
> Either way each suite creates clearly-named throwaway rows (`ZZTEST_…`
> auctions, lots, orders, throwaway buyers), deletes them afterwards and ends by
> printing `leftover throwaway rows: 0`. Do not wire these into CI or a
> pre-commit hook. If one crashes mid-run, look for leftover `ZZTEST_` rows
> (`select * from auctions where title like 'ZZTEST_%'`).
>
> **wtf-test pauses when idle.** Free Supabase projects pause after about a week
> without activity. If a suite can't connect (timeouts, `ECONNRESET`,
> `fetch failed`), unpause wtf-test in the Supabase dashboard first, then re-run.
>
> **Keeping wtf-test in step.** A migration applied to production must also be
> applied to wtf-test (test first is better). The 2026-09-28 copy was a
> `pg_dump --schema-only -n public` of production, then a catalog diff of both
> (tables, columns and types, constraints, FK on-delete rules, indexes, function
> bodies, table/function/sequence grants, RLS, default ACLs, extensions,
> buckets): 0 differences. `pg_dump` doesn't emit revokes against Supabase's
> default privileges, so the `anon`/`authenticated` EXECUTE revokes on
> `delete_auction_cascade` and `update_standard_leader_max` had to be applied to
> wtf-test by hand. Check those after any re-copy.
>
> **Production's connection string is not kept.** `PROD_DB_URL` was in
> `.env.test` only for that one-time copy and was removed afterwards. No suite
> uses it. A future re-copy needs it added back **temporarily** (session pooler
> string, password URL-encoded), used only for the read-only `pg_dump`, then
> removed again. `TEST_DB_URL` stays.

They start local copies of the server on ports 3231-3234, 3241-3242, 3251-3252,
3261-3262, 3271-3272, 3281-3285, 3291-3293, 3301-3312, 3321-3322, 3331-3332, 3341-3342 and 3351-3352 with the background jobs (`setInterval`) stubbed out, so nothing
auto-closes or charges. They write temporary `server.tmp-*.js` / `run.tmp-*.js`
files next to `server.js` and delete them on exit (both are git-ignored).

**Credentials:** none are stored here. `SUPABASE_URL`, `SUPABASE_KEY` and
`JWT_SECRET` come from `.env.test` (or `.env` with `--yes-production`); other
keys still come from `.env`. Both files stay untracked. Tokens
are minted in-process with `JWT_SECRET` and expire in minutes. `id-normalisation.js`
also needs `../wtf-live-frontend` checked out next to this repo (for
`socket.io-client`).

## The suites

Each suite's "before" server is pinned to a commit, not to `HEAD`, so its
reproduction assertions stay valid however far `main` moves on. A suite that is
always red teaches people to ignore red.

| Suite | Proves | "Before" server pinned to | Fixed in |
|---|---|---|---|
| `delete-guard.js` | `DELETE /auction/:id` refuses (409) when the auction has orders and fails closed (500) if the check errors; auth still 403; a real auction with orders is untouched. **Uppercase-id bypass:** on the pinned commit an UPPERCASE uuid deleted an auction that had orders (text column compared case-sensitively) and orphaned them; now 409. Malformed id → 400. | Order guard: the same source with the guard removed at runtime (`if (false)`). Uppercase bypass: **`3c6dc5a`** | `3c6dc5a` (guard), `c5caa33` (uppercase) |
| `terms-gate.js` | Terms accepted on auction A could be used to bid and pre-bid on a lot in auction B (no acceptance, no fulfilment choice, wrong premium snapshot). Now 404, nothing written; honest URL still 403; legitimate bids/pre-bids still work, including uppercase ids. **Leader resubmit (2026-09-27):** the lot's leader raising or repeating their max must update the max only - `place_standard_bid` added a `bids` row at the unchanged price and bumped `bid_count` each time (TEST Auction lot 1: "Bids: 2", one bidder). Asserts no new row, same `bid_count` and price, max recorded, and a $10 challenger still loses to the raised $20 max. Needs migration `2026-09-27n` (applied 2026-09-27; without it the check is skipped with the bug shown as reproduced and the suite exits 2). Green 2026-09-27. | **`c5caa33`** | `385ea56`; leader resubmit: _this slice_ |
| `id-normalisation.js` | Every client-supplied id is validated as a uuid and lowercased at the edge. Reads with an UPPERCASE id match lowercase; `/admin/orders?auction_id=` no longer silently returns nothing; pre-bid and admin add-item no longer store a non-canonical id (**since migration 2026-09-24i the columns are uuid, so the pinned server's uppercase pre-bid / add-item / publish no longer reproduce either: the database canonicalises the id. Those three assertions now record that**); publish with an uppercase id works; garbage ids → 400 on URL, body (`order_ids`, `/charge-winner`) and query, before any work; socket `auctionId` normalised, bad ids get the event's own error. | **`385ea56`** | `a27f899` |
| `images-ownership.js` | `POST /auction/:auctionId/items/:itemId/images` checked that the caller hosts `:auctionId` but not that the lot is in it, so any host could attach an image to a lot in someone else's auction. Now 404, nothing written; own lots (and uppercase ids) still work. Uses two throwaway hosts. | **`a27f899`** | `1b5f994` |
| `charge-scope.js` | `/charge-winner` authorised against the body's `auction_id` but acted on `invoice_id` / `order_id`, so the host of auction A could charge an invoice or order in auction B (on the pinned commit: 402 and B's invoice flipped to `failed`). Now authorised against the target's own auction; a disagreeing body `auction_id`, or an `order_id` not on the given `invoice_id`, is 404, B untouched. Own invoice/order (incl. what the UI sends, uppercase ids) still reach the charge path. No Stripe key or email is used: the fixture buyer has no card. | **`a1b2dd5`** | _this slice (#39)_ |
| `paid-stays-paid.js` | #37: `chargeInvoice` ran the won-and-charged email inside the same `try` as the charge, after marking the invoice paid, so anything throwing there made the `catch` flip a PAID invoice (and its orders) to `failed` and email the buyer "payment failed". Reproduced on the pinned commit for both the fresh-charge and the already-charged (re-click) paths. Fixed in two layers: the notify call is wrapped, and the failure handler only writes `failed` where `payment_intent_id is null`; each layer is tested alone. Genuine declines still record `failed`, retries still reach the charge. **Stripe is faked in-process and the email step is forced to throw** (in real code it swallows its own errors, so this is a structural hazard, not a live failure); nothing is charged or sent. Borrows the `zztest_paid_ok` profile read-only. | **`1ffce81`** | _this slice (#37)_ |
| `delete-atomic.js` | `DELETE /auction/:id` deleted lots, bids and chat one statement at a time, then the auction, ignoring the last error. An order created in the gap (an auction closing creates them) made the DB refuse the auction AFTER the children were gone, and the route still answered 200. The race is simulated by source-patching an order insert into the gap. Asserts the **child rows survive** (lots, bids, chat, pre-bids, images, outbid log, terms), not just the status; also an invoice-only auction, a clean delete removing every dependent, and idempotent re-delete. **Requires `migrations/2026-09-20e-delete-auction-cascade.sql`** (the route calls that function; the suite refuses to run without it). Only `bids`, `chat_messages` and `auction_terms_acceptances` cascade from `auctions` - lots and pre-bids do not, hence the explicit transactional function. **Cleanup (#44):** used to end with a bare `delete from auctions`, which left every surviving fixture's lots, pre-bids and images behind (9 rows a run) while printing `leftover: 0` because it only counted auctions/orders/invoices - the source of most of the 35 lots / 49 pre-bids removed by migration h. Now cleans up through `delete_auction_cascade` and counts lots, pre-bids and images for this run's ids; leftovers fail the run. | **`80fdcd9`** | _this slice_ |
| `email-volume-guard.js` | Resend Pro (50,000 per billing period, no daily cap): the outbid-suppression guard counted from the start of the UTC DAY and suppressed at 90, so on Pro it dropped outbid emails with ~49,900 of headroom. Now a rolling 30 days, suppress at 45,000; won/failed/shipped/admin always go through; fails closed. The window is deliberately approximate and conservative (Resend renews on the billing day - the 20th today - not the 1st; a rolling window over-counts just after a reset, so it errs early, never late except ~1 day on a 31-day cycle). The REAL functions are extracted from `server.js` into a vm with Resend's HTTP call stubbed - nothing is sent; one check uses throwaway `email_send_log` rows (`zztest_vol`) against the real table. | **`d60b9e7`** | _this slice_ |
| `scale-200-close.js` (**slow, ~15 min, not part of the quick run**) | The whole close path at 200 lots / 20 buyers (`autoCloseStandardItems` -> `createOrderOnWin` -> `buildAndChargeInvoicesForAuction` -> `chargeInvoice`), real code and real database, Stripe an in-process fake (800ms latency, 2 declines, 1 error). Scenarios: `single` and `double` (two servers running the job at once). Asserts one order per sold lot; invoice totals vs an independently computed figure; **AMOUNT: every invoice total and every amount sent to Stripe equals what each buyer owes, recomputed from the lots the database says sold** (every earlier check proved charge *count*; a 60% overcharge passed all of them); exactly one charge attempt per invoice; failures mid-loop don't stall later buyers. Measures tick duration and requests per lot. The fixture stays `draft` so the production job skips it, and the local job is patched to touch only it. The `double` scenario needs migration g to pass. | n/a (current code) | _this slice_ |
| `charge-auto-vs-manual.js` | The auto-close job re-attempted FAILED invoices when a tick re-entered an auction it had already charged (23 charge attempts for 20 invoices in the 200-lot run): an automatic retry of a declined card. `chargeInvoice(id, { auto: true })` (used only by `buildAndChargeInvoicesForAuction`) now claims only `unpaid` (plus stale-`charging` crash recovery); a human's `/charge-winner` still claims `failed`. Proves both directions, plus that the job still charges unpaid invoices and leaves a fresh `charging` one alone. Stripe is faked in-process. | **`670cdb5`** | _this slice_ |
| `orders-item-unique.js` | One order per lot, enforced by the database (`migrations/2026-09-21g`). Provokes the race deterministically (two concurrent `createOrderOnWin` calls for one lot): BEFORE the migration it shows 8 of 8 races duplicate an order on both old and new code, then exits 2; AFTER, asserts the index refuses a raw duplicate, live orders with no `item_id` are unconstrained, and each race yields exactly one order with both callers getting the same id. | **`670cdb5`** | _this slice_ |
| `undercharge-race.js` | #48: an invoice build must not run while a sold lot's order is still in flight - the residual risk flagged after the 200-lot double-instance runs. A test-only route flips one lot to `sold` and, after an injected delay, calls the real `createOrderOnWin` (Step 1's own sequence, gap widened on purpose); a second test-only route drives the real per-auction "everything closed?" check (`maybeEndStandardAuction` on NEW; a frozen copy of the pinned commit's own inline equivalent on OLD) into that gap. On the pinned commit: the auction ends with the order still missing, no invoice is ever built for it, and the order arrives afterward permanently unlinked (`invoice_id` null) - undercharged for good, since an `ended` auction is never revisited. Fixed: `maybeEndStandardAuction` checks every `sold` lot has an order before building invoices and defers (leaves the auction `live`) if any are missing; the next call finds it covered and completes normally, invoice total matching the order exactly. No DB migration involved - pure code, unlike the duplicate-order fix. | **`9ffdcfb`** | _this slice (#48)_ |
| `orphan-protection.js` | #44: lots and pre-bids could point at auctions/lots that no longer exist (text `auction_id` columns, no foreign keys) - 35 lots and 49 pre-bids had by 2026-09-24. **Two phases, detected from the live schema.** BEFORE migrations i+j it records the controls: a raw lot insert for a non-existent auction, a raw pre-bid insert for a non-existent lot, and a bare auction delete all succeed and orphan rows, and deleting a lot leaves its pre-bid behind; then exits 2. AFTER: each of those is refused (23503, `auction_items_auction_id_fkey` / `pre_bids_*_fkey`), deleting a lot cascades to its pre-bids, images, outbid log and bids, and `delete_auction_cascade` on a fixture with lots/pre-bids/images/bids leaves zero orphans. Both phases: `DELETE /auction/:id/items/:itemId` on a lot with an order - pinned commit answers `{ success: true }` with the lot still there (the database refused it), now 409. Controls recorded on the pre-migration schema 2026-09-24 (all four reproduced); AFTER phase green on 2026-09-24 once h-k were applied. | **`a836135`** | _this slice (#44)_ |
| `ai-usage.js` | AI spend log (migration `2026-09-26l`): one `ai_usage` row per Claude response from `/ai/group-photos`, `/ai/analyze-lot`, `/ai/regenerate-description`, attributed to the body's `auction_id`, raw tokens + `cost_usd`; a failed log insert never fails the AI call; malformed `auction_id` 400; `/admin/ai-usage` admin-only, pages past 1000 rows, buckets days in the caller's time zone (invalid tz -> UTC), flags deleted/unassigned auctions and unpriced calls; 503 "not set up" when the table is missing. **Claude is stubbed - no AI spend.** Summary checks run against an in-memory table. | n/a (new feature) | `c0876a5` |
| `password-reset.js` | Account email + forgotten password (migration `2026-09-26m`): registration requires an email (stored lowercased) and 8+ characters, existing short passwords still log in; `/auth/forgot-password` answers identically for unknown accounts, emails one single-use 1-hour link per matching account (shared address -> one each), stores only a SHA-256; the same link submitted twice at once succeeds exactly once; a reset retires the account's other links; **rate limit 3 per account per hour holds when 4 requests arrive at once** (count-then-insert let 4 of 4 through - caught by this suite's first run, fixed insert-first); **a token issued before a reset (with or without the `pca` claim) is refused after it**, also by a second instance deciding from the database; a host temporary password signs out the buyer; changing an account email needs the current password; `/profile` requires an email and fills a missing account email. Emails are written to a local file, never sent. | n/a (new feature) | _this slice_ |
| `secret-max.js` | A standard lot's leading max is secret: `auction_items.top_pre_bid` (the highest max - on a standard lot, the leader's proxy ceiling) went out on the public `GET /auction/:id/items` and `/items/standard-status` (no login needed; TEST Auction showed 5 / 10 / 12, exactly the maxes), in the lot row a losing challenger got back from `POST .../bid`, and in the `item_activated` socket broadcast. Pinned commit: 10 leaking responses. Now stripped for everyone but the admin / the auction's host (`hideLotMax`). As anonymous and as a non-leading buyer, every REST read, the bid and pre-bid responses and every socket event on join/activation are searched for the leader's max values and the key; controls: admin still sees it, the leader still sees their OWN max (`GET .../prebid`, `/my-bids`). Needs `../wtf-live-frontend` (socket.io-client). **Known, not fixed:** live mode (gated off, v2) opens a lot at the top pre-bid max, so `item_activated`'s `current_bid` equals it; the suite prints this as a NOTE; parked with the other live-mode item under **Not covered**. | **`18b79c5`** | _this slice_ |

### Security review fixes (2026-09-29)

One suite per finding in the wtf-handoff `SECURITY_PRIVACY_REVIEW_PHASE1_REPORT.md`. Each has a control on the
commit before its fix. The newer suites boot their local servers through `verification/local-server.js`.

| Suite | Finding | Proves | Control pinned to |
|---|---|---|---|
| `live-timer-scope.js` | #2 Critical | The live-MODE auction timer (armed at every boot and by an anonymous `join_auction`) ended STANDARD auctions at the auction-level `ends_at` with lots still open, so those lots sold with no invoice. Now it never touches them. Also the recovery sweep: stranded orders are invoiced and charged only if the auction's last lot closed within 24h; older ones, or a buyer who already has an invoice, email the admin only. | `a928646` |
| `live-socket-scope.js` | #6 High | Socket `place_bid` / `end_auction` acted on a standard auction's row. Now refused; a real live-mode auction still takes socket bids. | `a928646` |
| `bid-eligibility.js` | #3 Critical | Accounts with no profile, pending, rejected, blocked, or no saved card could accept terms, pre-bid and bid. Now 403 with a `code`, nothing written. Max bid $1 to $100,000. | `528c94e` |
| `socket-robustness.js` | #4 High | One anonymous `socket.emit('place_bid')` with no payload killed the process. Now 8 events × 7 bad payloads leave the server up. | `2a89576` |
| `rls-lockdown.js` | #1 Critical | Acts as `anon`/`authenticated` exactly as PostgREST does (`SET ROLE`, rolled back). BEFORE migration `p` it records the controls and exits 2; AFTER, every table, sequence and function is refused, new objects start closed, and service_role still works. Test database only (needs `TEST_DB_URL`). | the live schema |
| `rate-limits.js` | #5 High | Failed logins (per address, per account), register, reset, current-password checks, bids, chat. Switches the suites' loopback exemption off and simulates client IPs with `X-Forwarded-For`. | `7e8e352` |
| `chat-standing.js` | #7 | Blocked or unapproved users could chat, drafts included. | `05db001` |
| `reserve-hidden.js` | #8 | `reserve_price` went to everyone; now admin/host only. | `6db2e29` |
| `shippo-webhook-auth.js` | #9 | Anyone could POST a tracking update. Now needs `?key=<SHIPPO_WEBHOOK_SECRET>`; refuses everything with no secret set. | `28457dc` |
| `body-limit.js` | #12 | 60MB JSON on every route. Now 100kb, except the admin's photo and bulk routes; errors are short JSON, never a stack trace. | `6ff4d7d` |
| `cors-origins.js` | #11 | CORS `*`. Now the site (plus local dev off Railway, plus `CORS_EXTRA_ORIGINS`), REST and the socket handshake. | `f72be77` |
| `security-headers.js` | #10 | API headers (helmet) and 7-day sessions. The site's CSP is in the frontend's `vercel.json`. | `2116b90` |
| `upload-reencode.js` | #13 | Uploads were stored byte-for-byte (EXIF GPS in the public bucket; SVG accepted). Now re-encoded: no metadata, orientation applied, JPEG/PNG/WebP only, 2400px max. | `1e24469` |
| `username-rules.js` | #14 | Host lookalikes registered. Now lowercase `a-z 0-9 _`, no `whatthefind`/staff names, unique by case (migration `q`). | `8d21f1e` |

Low findings, fixed 2026-09-29. Where a suite needs Stripe, Shippo or Resend, it stubs them inside the local server
process (`local-server.js` options `env`, `preload`, `patch`), so nothing leaves the machine:

| Suite | Finding | Proves | Control pinned to |
|---|---|---|---|
| `login-timing.js` | #15 | A failed login for an unknown username took ~half the time of a real one (bcrypt only for real accounts). Now the same (dummy hash). | `82390f5` |
| `db-errors.js` | #16 | With the database unreachable, public routes sent the raw error object. Now a generic message; the bid function's own messages still reach the bidder. | `be6509e` |
| `draft-reads.js` | #17 | A draft's bids and chat were readable anonymously by id. Now 404 except for the admin. | `a99a549` |
| `livekit-token.js` | #18 | LiveKit tokens for any account, any auction, drafts included, data-publish for all. Now live-mode only, host or approved buyer, only the host publishes. | `409db0e` |
| `stripe-webhook-failed.js` | #19 | A late `payment_failed` event relabelled a PAID invoice/order as failed. Now only unpaid rows. | `e8711c7` |
| `shipping-label-amount.js` | #20 | The label route charged the browser's `amount_cents`. Now Shippo's re-read rate; mismatch -> 409, nothing charged. | `18002ac` |
| `email-log-privacy.js` | #21 | Buyers' email addresses in two log lines. Now redacted. | `e4e4f8f` |

**A5 "Delete my account"** (wtf-handoff `DELETE_ACCOUNT_BRIEF.md`, 2026-09-30). Needs migration
`2026-09-30t-delete-account.sql`, applied on wtf-test and production.

| Suite | Proves |
|---|---|
| `account-delete-refusals.js` | Refused and nothing changed (no Stripe call) while the buyer leads an open lot, has a max bid on an open lot, has an unpaid/failed invoice, or has an order not yet shipped/collected; also a wrong password, no typed `DELETE`, the admin, no login. Control on `c96a5a1`: the route didn't exist. |
| `account-delete.js` | A clean deletion end to end: personal fields empty, old session rejected, login impossible, Stripe cards detached + customer deleted, orders/invoices intact (totals unchanged), username -> `deleted_<12 hex>` everywhere, old username held 30 days (SHA-256 only), audit row, confirmation email to the old address, nothing of the buyer's in any API response (anonymous, another buyer, admin; the completed order's shipping address stays as the tax record), admin can't re-approve or re-password it. |
| `account-delete-premigration.js` | The new code on a database without migration t: registration, login and admin screens work; the delete route answers 503 and changes nothing. |

**Homepage refresh (F1)** (wtf-handoff `HOMEPAGE_REFRESH_BRIEF.md`, 2026-09-30). `GET /home`, `GET /search`,
`POST /signup`; contracts in `API.md`. Sign-up needs migration `2026-09-30u-drop-signups.sql` (applied on wtf-test, and on production by Cowork 2026-09-29;
without it `/signup` answers 503 and the rest of the homepage works).

| Suite | Proves |
|---|---|
| `home.js` | `/home`: shape; featured = live auction ending soonest, else next upcoming, else null; every rail's order and 12-limit computed independently from the fixtures; an `upcoming` auction past its start counts as live; sold, unsold, past-its-end, upcoming-auction, draft and ended lots never in a rail; each lot exactly the nine public fields and no max/reserve/leader by key or value; Most wanted empty below 3 bid-on lots; upcoming max 6; the empty-site answer; the 10 s cache with a fresh `server_now`. `/search`: live + upcoming only, `%` literal, short/long queries. `/signup`: one lowercased row, identical answer for new / repeat / honeypot, 400 on bad addresses, 429 after 5 per IP per hour. Before migration u: 503 asserted, exit 2. |
| `secret-max.js`, `draft-reads.js` | Extended: `/home` and `/search` carry the bid-on lot but never the leader's max, and never a draft's lot (anonymous, buyer, admin). |

**Photo thumbnails (F1a)** (2026-09-30). Every upload also stores a ~480px WebP beside the photo and records it in
`image_thumbs` (migration `2026-09-30v-image-thumbs.sql`: applied on wtf-test; **not yet on production**; before it,
uploads work and every `thumb_url` is null, so the site shows full photos as before). Recipe in `thumbs.js`, shared with
`scripts/backfill-thumbs.js` for photos uploaded earlier.

| Suite | Proves |
|---|---|
| `thumbnails.js` | Upload: full photo + WebP thumbnail beside it, 480 wide, aspect kept, orientation applied, small photos not enlarged, PNG gets a WebP thumbnail, no EXIF/GPS in either file, mapping row written. Before migration v (server patched to a missing table): upload still works, `thumb_url` null, no orphan file. API: `thumb_url` on /home lots, featured images (`{ url, thumb_url }`), upcoming, /search, standard-status, items, /auctions; null with `image_url` unchanged when there's no thumbnail (fallback); the lot gallery stays full size. Backfill: `--dry-run` changes nothing; a raw GPS photo and a sideways-tagged gallery photo get clean, upright thumbnails; the full photo is never changed; external links skipped; a missing file reported and exit 1; /home picks the new thumbnail up with no restart; re-runs skip finished photos. Exits 2 without migration v. |
| `upload-reencode.js`, `home.js` | Updated: clean up thumbnails and mapping rows too; a homepage lot is ten fields (plus `thumb_url`). |

**Watch list + reminders (F3)** (wtf-handoff `WATCH_LIST_BRIEF.md`, 2026-09-30). Needs migration
`2026-09-30w-watch-list.sql` (applied on wtf-test; **not yet on production**). Contracts in `API.md`.

| Suite | Proves |
|---|---|
| `watch-list.js` | API: watch/unwatch/follow/unfollow, idempotent; drafts 404, closed lots and ended auctions refused, bad ids 400, no login 401; following an open auction marks its "open" reminder done; the 500 limit (3 on a patched server); 429 after 60 changes a minute. Privacy: `/me/watching` is the caller's own with no leader, max or other buyer; /home, /search and the auction reads carry no watch fields; admin counts per lot and auction, buyers 403. Preferences. Reminders on a fake clock (a test-only route on the local server; Resend stubbed to a file): one email per buyer per run; every watched lot closing within the hour, each listed once even when it is also in a followed auction's top lots; status winning / outbid / no bid; premium; closed lots skipped (also one that closed after being queued); sent once (re-run, soft-close extension); "opens" + "closes tomorrow" + a lot reminder merged into one email; each preference respected; logged in `email_send_log`; List-Unsubscribe headers; unsubscribe with no login (GET changes nothing, tampered token 400, POST switches all off, nothing sent after). Exits 2 without migration w. |
| `account-delete.js` | Extended: the deleted buyer's watches, follows, reminder settings and unsent reminders go; a sent one stays as history; another buyer's are untouched. |

`scripts/send-test-reminder.js` sends ONE real reminder to the host's own address from wtf-test data (needs
`RESEND_API_KEY` and `ADMIN_EMAIL` in `.env`); `--to-file out.html` writes it to a file instead.

**Admin preview with sample auctions** (wtf-handoff `PREVIEW_MODE_BRIEF.md`, 2026-09-30). Frontend only: the samples
are built in the browser for the admin; nothing is sent or stored.

| Suite | Proves |
|---|---|
| `preview-sample.js` | The frontend's sample data (`../wtf-live-frontend/src/preview/sampleData.js`): every auction and lot title starts "Sample:", ids are "sample-..." (never a uuid), no photos, 0/1/3/5 open auctions build (one lot inside the hour, unbid lots, enough bids for Most wanted, three different end days). It is only loaded with `import()` by Home and Listings, preview is active only for the admin, and the preview code makes no API call. No "Sample:" auction or lot in the database, and no sample data in /home, /search or /auctions. Writes nothing. |

**Lot page (F2)** (wtf-handoff `LOT_PAGE_BRIEF.md`, 2026-09-30). `GET /lots/:id`, `/lots/by-number/:slug/:n`,
`/lots/:id/me`, `/lots/:id/bids`, `/lots/:id/related` (`lot_page.js`); increments, premium, slugs and the pickup town
in `lot_rules.js` (the bid route and orders use the same functions). Needs migration `2026-09-30x-bid-history-leader.sql`
(applied on wtf-test; **not yet on production**; before it the history attributes each row to the bidder who
submitted it, everything else works).

| Suite | Proves |
|---|---|
| `lot-page.js` | Shape; the premium line equals the invoice maths on every cent $0-$300 at three rates, and orders call the same function; the two one-tap amounts are exactly what the server accepts (a cent less refused) on every increment tier, cents included; proxy battles; each buyer's own status and max (`/me`), nobody else's; bids (since B7): no public list (401), each buyer only their own (their max), the admin every bid with bidder, leader and max; a pre-migration row shows its price; related (open lots, soonest first) and similar (other live auctions, title words, `[]` below 3); drafts 404 on every route for everyone; pickup town only; slugs (renamed title, full id, unknown). Exits 2 without migration x. |
| `lot-page-frontend.js` | The frontend's slug equals the backend's; every lot link goes to the lot page; the room redirects `?lot=` (replace) and the old modal is gone; vercel.json sends link crawlers (not browsers or Lighthouse) to `api/lot-meta.js`, which adds the lot's title/photo/price (escaped) and nothing else, and the plain page for drafts, unknown lots and bad input; sample auctions end at 8:00 PM local and the sample lot page has the `/lots` shape. |
| `secret-max.js` | Extended: `/lots/:id`, `/bids`, `/related` and the challenger's `/me` never carry the leader's max; the lot page and its history carry no username; the leader's own `/me` shows their own max. |
| `preview-sample.js` | Updated: sample auctions end at 8:00 PM local (not "a lot inside the hour"); the lot page is the third file that lazy-loads the sample data. |

**Hide bidders and the pickup address (B6 + B7)** (wtf-handoff `PRIVACY_BIDDERS_PICKUP_BRIEF.md`, 2026-09-30). One
allow-list for public auction and lot rows (`public_view.js`) on every REST route and socket event. Needs migration
`2026-09-30y-pickup-town-own-bid-max.sql` (after x; applied on wtf-test; **not yet on production**; before it
everything works, the public simply sees no pickup town and a buyer's own bids show prices instead of their max).

| Suite | Proves |
|---|---|
| `bidder-identity.js` | As anonymous and as a buyer who never bid, 14 public REST reads (x2), 7 of the other buyer's own reads and every socket event of a live-mode auction (state, activation, a bid, the end) are searched for both bidders' usernames and user ids, their maxes and every bidder key: none (54 payloads). The pinned commit `905066d` named them in 22 (auction rows, the bid list, lot rows, socket `new_bid`/`auction_ended`, the losing bid's answer). Each bidder sees only their own status, max and bids; sockets tell each viewer `you_lead`/`you_won` about themselves; the admin gets rows with names, the full lot history and the socket bid list. |
| `pickup-address.js` | Anonymous, a losing bidder and a shipping winner never get the street (38 responses/socket states incl. terms, orders, bids); the public sees `pickup_town`. The pickup winner gets it on their order page and in their win email (Resend stubbed to a file); the shipping winner's email has the shipping wording; the loser gets none. Admin settings: town set/trimmed/80-char limit, buyers 403; publishing pickup needs a town. Pinned `905066d`: `/auction/:id` gave the street to anyone. Exits 2 without migration y. |
| `lot-page.js`, `secret-max.js`, `lot-page-frontend.js` | Updated for the rules above (own bids only; the town column; no sample bid list). |

**Rate limits and the suites.** `guard.js` sets `RATE_LIMIT_EXEMPT_LOOPBACK=1`, which the suites' local servers
inherit, because a suite fires many logins and bids from localhost. The server honours it only for loopback
addresses. Production never sets it, and Railway traffic never arrives from loopback. `rate-limits.js` clears it.

**Production settings these fixes need** (Railway, backend service):
- `SHIPPO_WEBHOOK_SECRET`: a long random value (32+ chars). The webhook URL registered in Shippo must end in
  `?key=<that value>`. Until both are set, Shippo tracking updates are refused (401), and order status can still
  be set by hand.
- `CORS_EXTRA_ORIGINS` (optional): extra browser origins, comma-separated (e.g. a Vercel preview URL).
- Migration `2026-09-29p-rls-lockdown.sql`: **applied on production 2026-09-29** (Cowork; all checks 0). Its
  sequence check is now guarded with CASE, after it threw "saml_providers_pkey is not a sequence" there.
- Migration `2026-09-29q-username-unique-lower.sql`: **applied on production 2026-09-29** (Cowork), after Albert
  deleted the two case-duplicate June test accounts in the same transaction (migration r was not needed).
  Verified: 0 leftovers, `users_username_lower_key` present, 28 users. Security Advisor: 0 errors.
- Migration `2026-09-30t-delete-account.sql` (A5): **applied on production 2026-09-30** (Cowork, SQL editor; all 39
  columns the functions use checked first; after: `users.deleted_at`, both tables RLS on, both functions
  service_role-only). "Delete my account" is on: the route checks on every request, no restart needed.
- Migration `2026-09-29s-function-search-path.sql` (review #27, the Advisor's 5 "function search path mutable"
  warnings): **applied on production 2026-09-29** (Cowork; bodies matched exactly beforehand; after: 5/5 pinned,
  grants unchanged). Security Advisor: 0 errors, 0 warnings. Suite: `function-search-path.js`
  (BEFORE: records the controls, including a real shadowing through a caller's temp tables, and exits 2).

## Not covered

- **Before live mode is turned back on (parked 2026-09-27, do both together).**
  Live mode is gated off (v2); neither of these is reachable while it is.
  1. *Opening price leaks the top pre-bid max.* `next_item` opens a lot at
     `max(starting_bid, top pre-bid max)`, so `item_activated`'s `current_bid`
     IS the leader's secret max, even though `top_pre_bid` itself is now
     stripped. `secret-max.js` prints it as a NOTE. Open at second-highest max
     + increment instead, as the standard auction's proxy logic does.
  2. *`ItemQueue.css` is never imported* (frontend: `src/components/ItemQueue.jsx`
     has no `import './ItemQueue.css'`), so the live-mode lot queue - hosts
     AND buyers - renders unstyled. The file itself is on the cream palette
     (admin restyle, frontend `2b7fa3e`), ready to import; importing it changes
     that room's layout, so check the live room at phone width when you do.
- **Follow-up (parked 2026-09-28): outbid alert in the auction room.** A buyer
  who loses the lead finds out only by email (`notifyOutbidIfNeeded`) or on
  My Bids; the standard auction room shows nothing when it happens. The mark's
  outbid expression is ready for it (frontend `public/brand/state-outbid.svg`,
  copied but not placed, see frontend `8c019a2`). Needs: detect that the viewer
  WAS the leader and no longer is (poll result or a socket event), then a
  dismissible banner/toast with the state. Leading/won checks must use
  `isViewerLeader` (frontend `be87022`) so a logged-out viewer never gets it.
- The DB-level guards are now covered: `delete-guard.js` asserts that a raw
  delete of an auction with orders / invoices is refused by Postgres (23503,
  `orders_auction_id_fkey` / `invoices_auction_id_fkey`), that an order for a
  non-existent auction cannot be inserted, and that the pre-migration server can
  no longer orphan an order (even with an UPPERCASE id). The migrations
  themselves (`migrations/2026-09-19a…d`) were applied to production on
  2026-09-20 and must not be run again.
- Some "reproduce the old bug" assertions became "the database refuses it" (or
  "the database canonicalises it") once the schema changed: `delete-guard`'s
  control and uppercase bypass (migrations c+d); `id-normalisation`'s uppercase
  `/admin/orders` filter (c) and its pre-bid poisoning, add-item poisoning and
  uppercase publish (2026-09-24i); `delete-atomic`'s uppercase-id case, which
  now asserts an uppercase write is stored canonical (i).
- `delete-guard` and `id-normalisation` used to borrow a pre-existing auction
  (`ZZTEST_InvoiceBatch…`) read-only. The 2026-09 test-data cleanup removed it,
  so both now build that fixture themselves (2026-09-24). Suites still borrow
  the `zztest_paid_ok` buyer read-only; if that user is ever cleaned up,
  `charge-auto-vs-manual`, `orders-item-unique`, `paid-stays-paid` and
  `undercharge-race` will fail at setup. **On wtf-test (created 2026-09-28)** it
  is a `users` row (password hash `zztest-not-a-real-hash`, so it can't log in;
  email `zztest_paid_ok@example.invalid`) plus an approved profile with
  `payment_status` `ok` and placeholder Stripe ids `cus_ZZFIXTURE_paid_ok` /
  `pm_ZZFIXTURE_paid_ok`. None of the four sends anything to Stripe (each fakes
  it or blanks the key), but `paid-stays-paid` refuses to start without both ids
  set. Don't rename those ids to `cus_ZZFAKE_…`: `scale-200-close` counts that
  prefix as its own leftovers. It is the only user on wtf-test; don't delete it.
- **Low priority, open:** `pre_bids.buyer_user_id` (and the other user-id
  columns: `orders`/`invoices.buyer_user_id`, `profiles.user_id`,
  `auction_terms_acceptances.user_id`) are TEXT with no foreign key to `users`.
  Out of #44's scope by decision. Some suites deliberately write non-uuid
  values there (`zztest-delatomic`, `zztest-delguard`), so converting them
  means changing those fixtures first.
- The `DELETE /auction/:id` atomicity gap is fixed (`delete-atomic.js`).
