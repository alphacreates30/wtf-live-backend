-- ALREADY RUN on production (2026-09-20), verified, followed by notify pgrst. DO NOT RUN AGAIN.
-- STEP 3 of 4. Run after step 2 (b), before step 4 (d).
-- orders.auction_id is TEXT, while auctions.id is uuid (invoices.auction_id is
-- already uuid). A foreign key between text and uuid is impossible - step d would
-- fail with "incompatible types" - so convert the column first. It is also why
-- the API delete guard needed a lowercase-uuid check: a text column compares
-- case-sensitively, a uuid column does not.

-- 0a. (read-only) every value must already be a well-formed uuid, or the
--     ALTER below fails. Expect 0.
select count(*) as not_a_uuid
from public.orders
where auction_id is not null
  and auction_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 0b. (read-only) anything in the database that mentions orders and could care
--     about the column's type: functions/RPCs and views. Skim the lists; a
--     function that compares orders.auction_id to a text parameter would need
--     a ::uuid cast. (The app itself only reads and writes this column as a
--     string through PostgREST, which is fine for uuid.)
select p.proname as function_name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosrc ilike '%orders%';

select viewname from pg_views
where schemaname = 'public' and definition ilike '%orders%';

-- 1. Convert. Takes a brief exclusive lock and rewrites the table (16 rows,
--    less once step b has run).
alter table public.orders
  alter column auction_id type uuid using auction_id::uuid;

-- 2. (read-only) verify. Expect data_type = uuid.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'orders' and column_name = 'auction_id';

-- PostgREST caches the schema; tell it about the changed column type.
notify pgrst, 'reload schema';
