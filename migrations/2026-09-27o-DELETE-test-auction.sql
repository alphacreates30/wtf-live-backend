-- APPLIED on production 2026-09-27 in Albert's Supabase SQL editor - run by Albert himself (per Albert). Verified: all counts 0. DO NOT RUN AGAIN.
-- Was: STEP o. DELETES ROWS. For Albert to run by hand in the Supabase SQL editor - NOT run by Claude.
-- Removes the ended "TEST Auction" (d8f605a0-345f-4a89-ad9b-78b4d6b8c16a, 34 horror-figure lots, 2026-09-26/27 live
-- test) and everything under it, so it no longer shows on the homepage.
--
-- Why by hand: the auction has orders and invoices, and orders/invoices -> auctions are RESTRICT on purpose, so the
-- app's Delete button refuses it (409). This deletes the orders and invoices first, then uses the same
-- delete_auction_cascade the app uses for everything else (lots, images, bids, pre-bids, chat, terms, outbid log).
--
-- Kept on purpose:
--   - testbuyer1 / testbuyer2 accounts and their saved Stripe test cards (useful for the next test)
--   - ai_usage rows for this auction's cataloguing (a spend log must outlive the auction; the dashboard shows
--     "Deleted auction")
--   - email_send_log rows (volume history)
--   - Stripe's own record of the $2.30 test payment and the declined $10.35 (Stripe test mode, not ours to delete)
--   - the lot photos in the item-images storage bucket (delete by hand in Storage if wanted)
--
-- One transaction. The gate aborts everything if the auction isn't exactly what was tested.

begin;

do $$
declare
  a record;
  n_orders int; n_invoices int; n_foreign int; n_lots int;
begin
  select * into a from public.auctions where id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a';
  if not found then raise exception 'STOP: auction not found - already deleted?'; end if;
  if a.title <> 'TEST Auction' then raise exception 'STOP: title is "%", expected "TEST Auction"', a.title; end if;
  if a.status <> 'ended' then raise exception 'STOP: status is %, expected ended', a.status; end if;

  select count(*) into n_lots     from public.auction_items where auction_id = a.id;
  select count(*) into n_orders   from public.orders        where auction_id = a.id;
  select count(*) into n_invoices from public.invoices      where auction_id = a.id;
  select count(*) into n_foreign  from public.orders        where auction_id = a.id
                                    and buyer_username not in ('testbuyer1', 'testbuyer2');
  if n_lots <> 34 then raise exception 'STOP: % lots, expected 34', n_lots; end if;
  if n_orders <> 3 then raise exception 'STOP: % orders, expected 3', n_orders; end if;
  if n_invoices <> 2 then raise exception 'STOP: % invoices, expected 2', n_invoices; end if;
  if n_foreign > 0 then raise exception 'STOP: % order(s) from a buyer other than testbuyer1/2', n_foreign; end if;
end $$;

-- 1. Orders (3). They point at the invoices, so they go first.
delete from public.orders where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a';

-- 2. Invoices (2).
delete from public.invoices where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a';

-- 3. Everything else, and the auction itself, the same way the app deletes an auction.
select public.delete_auction_cascade('d8f605a0-345f-4a89-ad9b-78b4d6b8c16a');

commit;

-- 4. (read-only) verify. Expect every count 0.
select
  (select count(*) from public.auctions      where id         = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a') as auction,
  (select count(*) from public.auction_items where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a') as lots,
  (select count(*) from public.orders        where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a') as orders,
  (select count(*) from public.invoices      where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a') as invoices,
  (select count(*) from public.bids          where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a') as bids,
  (select count(*) from public.pre_bids      where auction_id = 'd8f605a0-345f-4a89-ad9b-78b4d6b8c16a') as pre_bids;
