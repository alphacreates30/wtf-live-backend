-- ALREADY RUN on production (2026-09-20), verified, followed by notify pgrst. DO NOT RUN AGAIN.
-- STEP 1 of 4. Run on its own, first.
-- invoices.auction_id was declared "on delete cascade": deleting an auction
-- silently DESTROYS its invoices, including unpaid ones. Switch to RESTRICT so
-- an auction that has invoices can't be deleted at all (API guard or raw SQL).
-- No data problem: every invoice row currently points at an existing auction.

-- 0. (read-only) confirm the constraint's real name and current behaviour first.
--    Expect one row: invoices_auction_id_fkey ... ON DELETE CASCADE
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.invoices'::regclass and contype = 'f';

-- 1. Swap it, in one atomic statement. Deliberately NO "if exists": if the
--    name above differs, this errors and changes nothing, rather than adding a
--    second FK next to a still-cascading one. Edit the name to match step 0 if so.
alter table public.invoices
  drop constraint invoices_auction_id_fkey,
  add constraint invoices_auction_id_fkey
    foreign key (auction_id) references public.auctions(id) on delete restrict;

-- 2. (read-only) verify. Expect "ON DELETE RESTRICT".
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.invoices'::regclass and contype = 'f';

-- PostgREST caches the schema; tell it about the changed constraint.
notify pgrst, 'reload schema';
