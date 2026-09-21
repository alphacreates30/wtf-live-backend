-- ALREADY RUN on production (2026-09-20), verified, followed by notify pgrst. DO NOT RUN AGAIN.
-- STEP 4 of 4. Run ONLY after steps 2 (b) and 3 (c): orphan count 0 AND orders.auction_id is uuid.
-- orders.auction_id has no foreign key at all (and, before step c, was TEXT, so a foreign key to auctions.id could not even be created), which is how deleting an auction
-- could leave its orders behind. Add one with ON DELETE RESTRICT so an auction
-- that has orders can't be deleted (API guard or raw SQL). Because no orphans
-- remain this validates normally - no NOT VALID needed.

-- 0. (read-only) gate: must return 0, otherwise the ALTER below will fail.
select count(*) as orphaned_orders
from public.orders o
where not exists (select 1 from public.auctions a where a.id = o.auction_id);

-- 1. Add the constraint.
alter table public.orders
  add constraint orders_auction_id_fkey
    foreign key (auction_id) references public.auctions(id) on delete restrict;

-- 2. (read-only) verify. Expect a row ending "ON DELETE RESTRICT".
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.orders'::regclass and contype = 'f' and conname = 'orders_auction_id_fkey';

-- PostgREST caches the schema; tell it about the changed constraint.
notify pgrst, 'reload schema';
