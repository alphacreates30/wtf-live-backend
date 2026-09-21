-- STEP g. NOT YET RUN. Run in the Supabase SQL editor, then `notify pgrst, 'reload schema';`.
--
-- RUN THIS BEFORE PUSHING THE MATCHING server.js. The bug is LIVE until this index exists.
-- The server.js change (createOrderOnWin treating a unique violation as "order already exists") is NOT a fix on its
-- own: verification/orders-item-unique.js shows the race still duplicates orders 8 of 8 times on the new code
-- WITHOUT the index. The handler only makes the index's refusal graceful; the index is what prevents the
-- duplicate. (The code is harmless if deployed first - without the index it behaves exactly as before - but that is
-- a worse order, since it looks fixed while the hazard remains.)
--
-- Two overlapping ticks of the auto-close job (a tick outlasting its 30s interval, or a second instance during a
-- deploy) could both pass createOrderOnWin's "does this lot have an order?" check and both insert one. Measured on
-- 2026-09-21 with 200 lots and two instances: 267 orders for 150 sold lots, 117 lots duplicated, buyers' invoices
-- inflated (one $607.20 against an expected $381.80). The invoice sums orders, so a duplicate order is a
-- duplicate charge amount.
--
-- One order per lot, enforced by the database, so it holds across processes. Partial: orders with no item_id
-- (live-auction orders, which are per-auction rather than per-lot) are unconstrained, as before.

-- 0. (read-only) GATE: any lot with more than one order? Expect 0 rows. Checked on production 2026-09-21 by the
--    backend before writing this (9 orders, 0 duplicates); re-run it, since the index cannot build over duplicates.
select item_id, count(*) as orders, array_agg(id) as order_ids
from public.orders
where item_id is not null
group by item_id
having count(*) > 1;

-- 1. The index. Deliberately NOT "if not exists": if an index by this name is somehow already there, fail loudly.
create unique index orders_item_id_key on public.orders (item_id) where item_id is not null;

-- 2. (read-only) confirm. Expect one row with "UNIQUE" and "WHERE (item_id IS NOT NULL)".
select indexname, indexdef from pg_indexes where tablename = 'orders' and indexname = 'orders_item_id_key';

notify pgrst, 'reload schema';

-- NOTE - what this forecloses: ONE ORDER PER LOT, FOR EVER. It rules out re-offering a forfeited lot in place. The
-- terms of sale carry a 7-day forfeit; if that ever becomes a "re-offer the SAME lot to the next bidder" workflow
-- (a second order row on the same auction_items row) rather than "relist as a NEW lot", this index has to be
-- revisited - e.g. made partial on a status that excludes cancelled/forfeited orders. Not a problem today: orders
-- have no cancelled state, so nothing can currently produce a second legitimate order for a lot. It should not be a
-- surprise later.
