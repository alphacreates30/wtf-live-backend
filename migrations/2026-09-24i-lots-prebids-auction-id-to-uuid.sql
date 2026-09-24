-- STEP i (#44 step 2.1 + 2.2). Run in the Supabase SQL editor AFTER step h (orphan delete), BEFORE step j (FKs).
-- auction_items.auction_id and pre_bids.auction_id hold auction uuids in TEXT columns (auctions.id is uuid), exactly
-- as orders.auction_id did before migration c. Consequences: no foreign key is possible (text vs uuid), comparisons
-- are case-sensitive (the root of the uppercase-id bugs id-normalisation patched at the edge), and
-- delete_auction_cascade has to compare lower(col::text), which defeats indexes. Same fix as c: convert the column.
--
-- pre_bids.item_id is NOT in this file: it is already uuid (Step 0 inventory, 2026-09-24) and only needs its FK (j).
--
-- Brief step 2.1 ("lower() any uppercase values") is deliberately omitted: the inventory found 0 uppercase values
-- in either column, and a text->uuid cast is case-insensitive anyway ('ABC…'::uuid yields the canonical lowercase
-- form), so the update would change nothing. The gate below still counts them, for the record.
--
-- Safe against the running server: PostgREST sends and receives these as strings, which is the same on the wire for
-- uuid. Every client-supplied id is validated as a uuid at the edge (id-normalisation), so a malformed id is a 400
-- before it reaches the database - after this, a malformed id that slipped through would be a 22P02 error instead
-- of silently matching nothing. The functions that touch these columns were checked (Step 0 catalog, 2026-09-24):
-- get_expired_standard_items casts ai.auction_id::uuid (a no-op on uuid), place_standard_bid copies
-- auction_items.auction_id into pre_bids.auction_id (uuid -> uuid after this), place_bid does not touch them, and
-- delete_auction_cascade (f) compares lower(col::text), which still works on uuid until k replaces it. No views,
-- no triggers.

-- 0a. (read-only) GATE. Every count must be 0, or the ALTERs below fail (non_uuid) or step j fails (dangling).
select
  (select count(*) from public.auction_items where auction_id is not null and auction_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as lots_non_uuid,
  (select count(*) from public.pre_bids      where auction_id is not null and auction_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as prebids_non_uuid,
  (select count(*) from public.auction_items where auction_id <> lower(auction_id)) as lots_uppercase,
  (select count(*) from public.pre_bids      where auction_id <> lower(auction_id)) as prebids_uppercase,
  (select count(*) from public.auction_items i where not exists (select 1 from public.auctions a where a.id::text = lower(i.auction_id))) as lots_dangling,
  (select count(*) from public.pre_bids p where not exists (select 1 from public.auctions a where a.id::text = lower(p.auction_id))) as prebids_dangling;

-- 0b. (read-only) indexes on the two columns: the ALTER rebuilds them. One using a text-only operator class
--     (text_pattern_ops, gin_trgm_ops) would make the ALTER fail; if you see one, stop and report it.
select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename in ('auction_items', 'pre_bids') and indexdef ilike '%auction_id%';

-- 1. Convert. One transaction: both columns or neither. Brief exclusive lock + table rewrite (tiny tables after h).
begin;
alter table public.auction_items alter column auction_id type uuid using auction_id::uuid;
alter table public.pre_bids      alter column auction_id type uuid using auction_id::uuid;
commit;

-- 2. (read-only) verify. Expect data_type = uuid on both rows.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and column_name = 'auction_id' and table_name in ('auction_items', 'pre_bids');

-- PostgREST caches the schema; tell it about the changed column types.
notify pgrst, 'reload schema';
