-- ALREADY RUN on production (2026-09-20), verified, followed by notify pgrst. DO NOT RUN AGAIN.
-- STEP 2 of 4. DESTRUCTIVE - read before running. Deliberately separate from the
-- schema migrations.
-- Deletes the 9 orders whose auction no longer exists. All are old
-- testbidder* rows: payment_status 'unpaid', total_cents null, no invoice.
-- Listed by exact id (not by a pattern):
--
--   bd0df88b-a596-410a-a8fa-6b771bae37c2  testbidder401  "Test 5"        label_created
--   aa88c81f-2f9f-4969-b15e-b0cd51848eaa  testbidder809  "Test008"       pending
--   c1f79f9b-f859-4f76-9344-b37c4f1ec360  testbidder786  "Test0071"      pending
--   54a09504-8101-4c28-8359-93500fe73d4f  testbidder786  "TESTSHOWJOEL"  pending
--   bb231a22-2b31-43ed-a515-310e8fa8f06a  testbidder786  "TestRun"       pending
--   0ff41d68-5d54-4380-8e40-9a2ab5b00908  testbidder786  "TEST978"       pending
--   4cfa2ad9-b509-474c-9172-db2699c36f90  testbidder786  "Test305"       pending
--   b1fd5a47-46a6-47dc-b01d-f12a7c4ac370  testbidder786  "Test411"       label_created
--   2ec7a852-bdb8-4a31-89d1-5fcc4f74f46d  testbidder_x1  "Test 10000"    pending
--
-- DECISION: delete all nine. "Test411" (b1fd5a47...) and "Test 5" (bd0df88b...) hold
-- test-mode labels and were the old shipping fixture; a better one is being built
-- on a succeeding card (#39), so nothing here is worth keeping.

-- 0. (read-only) preview exactly what will go. Expect 9 rows.
select id, auction_id, buyer_username, item_title, payment_status, total_cents, status
from public.orders
where id in (
  'bd0df88b-a596-410a-a8fa-6b771bae37c2',
  'aa88c81f-2f9f-4969-b15e-b0cd51848eaa',
  'c1f79f9b-f859-4f76-9344-b37c4f1ec360',
  '54a09504-8101-4c28-8359-93500fe73d4f',
  'bb231a22-2b31-43ed-a515-310e8fa8f06a',
  '0ff41d68-5d54-4380-8e40-9a2ab5b00908',
  '4cfa2ad9-b509-474c-9172-db2699c36f90',
  'b1fd5a47-46a6-47dc-b01d-f12a7c4ac370',
  '2ec7a852-bdb8-4a31-89d1-5fcc4f74f46d'
);

-- 1. The delete. The extra conditions are a safety net: a listed id is only
--    removed if it is STILL unpaid, has no charge amount, no invoice, AND its
--    auction is still gone. If anything changed since this was written, that row
--    is skipped rather than deleted. Expect "DELETE 9".
delete from public.orders
where id in (
  'bd0df88b-a596-410a-a8fa-6b771bae37c2',
  'aa88c81f-2f9f-4969-b15e-b0cd51848eaa',
  'c1f79f9b-f859-4f76-9344-b37c4f1ec360',
  '54a09504-8101-4c28-8359-93500fe73d4f',
  'bb231a22-2b31-43ed-a515-310e8fa8f06a',
  '0ff41d68-5d54-4380-8e40-9a2ab5b00908',
  '4cfa2ad9-b509-474c-9172-db2699c36f90',
  'b1fd5a47-46a6-47dc-b01d-f12a7c4ac370',
  '2ec7a852-bdb8-4a31-89d1-5fcc4f74f46d'
)
  and payment_status = 'unpaid'
  and total_cents is null
  and invoice_id is null
  and auction_id not in (select id::text from public.auctions);  -- id::text: orders.auction_id is still TEXT at this step (converted in c)

-- 2. (read-only) confirm no orphans remain. Expect 0.
select count(*) as orphaned_orders
from public.orders o
where not exists (select 1 from public.auctions a where a.id::text = o.auction_id);  -- ::text: column is TEXT until step c
