-- STEP j (#44 step 2.3). Run in the Supabase SQL editor AFTER step i (uuid conversion), BEFORE step k.
-- Adds the three missing foreign keys, so a lot or pre-bid can never again point at an auction or lot that does not
-- exist. Fails with 23503 if any dangling row remains - that means step h was not run (or new debris appeared since):
-- stop and re-run the inventory rather than working around it.
--
-- ON DELETE rule (decided 2026-09-24): CASCADE only for rows that mean nothing without their parent AND carry no
-- money; RESTRICT for anything money-adjacent.
--
--   auction_items.auction_id -> auctions      RESTRICT. A lot is money-adjacent: it is what an order is for, it
--                                             carries the sold price. Deleting an auction must never quietly take
--                                             its lots with it; the only sanctioned path is delete_auction_cascade,
--                                             which deletes lots explicitly first and is refused as a whole if any
--                                             order/invoice exists. A bare `delete from auctions` with lots left is
--                                             now refused (23503) instead of orphaning them.
--   pre_bids.item_id         -> auction_items CASCADE. A pre-bid is meaningless without its lot and carries no money
--                                             (nothing is charged from a pre-bid; winning creates an order).
--   pre_bids.auction_id      -> auctions      CASCADE. Same reasoning. delete_auction_cascade removes pre-bids
--                                             explicitly anyway; this only matters for a bare auction delete, which
--                                             the lot RESTRICT above already blocks while any lot exists.
--
-- Already in place and unchanged (Step 0 catalog, 2026-09-24): orders.item_id -> auction_items is NO ACTION, so a
-- lot that has an order already cannot be deleted - the brief's "add RESTRICT to orders.item_id if missing" is not
-- needed. item_images, outbid_email_log and bids -> auction_items are CASCADE; bids, chat_messages and
-- auction_terms_acceptances -> auctions are CASCADE; orders/invoices -> auctions are RESTRICT.

-- 0. (read-only) GATE. Expect 0 / 0 / 0 and data_type uuid for both auction_id columns (step i ran).
select
  (select count(*) from public.auction_items i where not exists (select 1 from public.auctions a where a.id = i.auction_id)) as lots_dangling,
  (select count(*) from public.pre_bids p where not exists (select 1 from public.auctions a where a.id = p.auction_id)) as prebids_dangling_auction,
  (select count(*) from public.pre_bids p where not exists (select 1 from public.auction_items i where i.id = p.item_id)) as prebids_dangling_lot;

begin;

alter table public.auction_items
  add constraint auction_items_auction_id_fkey
    foreign key (auction_id) references public.auctions(id) on delete restrict;

alter table public.pre_bids
  add constraint pre_bids_item_id_fkey
    foreign key (item_id) references public.auction_items(id) on delete cascade;

alter table public.pre_bids
  add constraint pre_bids_auction_id_fkey
    foreign key (auction_id) references public.auctions(id) on delete cascade;

-- Postgres does not index the referencing side of a foreign key. Without these, every delete of an auction or lot
-- scans auction_items / pre_bids to check the constraint. Created only if no index already leads with the column,
-- so an existing index (whatever its name) is not duplicated.
do $$
declare
  c record;
begin
  for c in select * from (values ('auction_items', 'auction_id'), ('pre_bids', 'item_id'), ('pre_bids', 'auction_id')) v(tbl, col) loop
    if not exists (
      select 1 from pg_index x
      join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
      where x.indrelid = ('public.' || c.tbl)::regclass and a.attname = c.col
    ) then
      execute format('create index %I on public.%I (%I)', c.tbl || '_' || c.col || '_idx', c.tbl, c.col);
      raise notice 'created index %_%_idx', c.tbl, c.col;
    end if;
  end loop;
end $$;

commit;

-- 1. (read-only) verify. Expect the three new rows with the ON DELETE rules above.
select conrelid::regclass as child_table, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'f' and conrelid in ('public.auction_items'::regclass, 'public.pre_bids'::regclass)
order by 1, 2;

notify pgrst, 'reload schema';
