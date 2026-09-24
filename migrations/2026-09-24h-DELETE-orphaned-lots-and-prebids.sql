-- APPLIED on production 2026-09-24 by Albert, verified in the SQL editor. DO NOT RUN AGAIN.
-- STEP h (#44 step 1). DELETES ROWS. For Albert to run by hand in the Supabase SQL editor - NOT run by Claude.
-- Run BEFORE step i (the uuid conversion) and step j (the foreign keys): j's constraints cannot be created while
-- any of these rows exist, and would fail with 23503.
--
-- What this removes: every lot and pre-bid whose auction no longer exists, plus the images on those lots.
-- Snapshot taken 2026-09-24 (read-only, service role): the auctions table is EMPTY (0 rows), and so are orders,
-- invoices and bids. So every row below is dangling, and nothing that carries money points at any of them.
-- All of it is test debris: titles 'Phase C Retest Lot', 'Claim Test Lot', 'Auto-Charge Confirm Lot' (2026-09-11)
-- and 'ZZTEST_delatomic lot N' (2026-09-21/23, leaked by verification/delete-atomic.js's old cleanup, fixed in #44);
-- pre-bid buyers testbidder786, Test, smoketest_*, whatthefind, zztest_delatomic.
--
-- Safety: the deletes are limited to the ids listed here AND re-check that the parent is still missing, so a real
-- auction or lot created after the snapshot is never touched. The whole file is one transaction; step 0 aborts it
-- if anything that carries money references these lots.
--
-- STORAGE (for Albert to clean up by hand, optional): none of the 14 image rows points at storage - every one is
-- the fixture url https://example.invalid/zz.jpg, and no lot has an image_url. So deleting these rows orphans no
-- file. Separately, the item-images bucket holds 9 files that NO row references at all (uploaded ~2026-09-08,
-- before any of these lots existed - abandoned uploads, unrelated to #44):
--   item-images/items/1788827451801-4artg1fsfws.jpg
--   item-images/items/1788827452350-pgw7w9p8pk.jpg
--   item-images/items/1788827452628-68bnltzy2tj.jpg
--   item-images/items/1788827452902-bc453zw3kni.jpg
--   item-images/items/1788827453285-2hs8bpzn1aa.jpg
--   item-images/items/1788827453581-0ubrs7krh4f.jpg
--   item-images/items/1788827453880-x4zd7s74xvl.jpg
--   item-images/items/1788827454147-ae4vtd85ywq.jpg
--   item-images/items/1788827454440-eiogdatrovw.jpg

begin;

-- 0. The 35 lots in the snapshot (listed with titles in step 3).
create temp table zz44_lots (id uuid primary key) on commit drop;
insert into zz44_lots (id) values
  ('4900f548-c593-4a13-a23c-54740f3ef26c'),
  ('41c60602-8282-43c7-966f-738cf805f085'),
  ('dff8a716-cf2a-4760-9f9c-a9b07b11173b'),
  ('41cc3aa3-b0f0-41aa-835f-2602e6508266'),
  ('b03cf8d8-a0ca-4d06-9566-5a0f68442702'),
  ('55f4a1e6-e8c4-41c0-9ec8-c2d187b776c1'),
  ('138cf688-ff12-484c-87eb-920fb9cb8967'),
  ('0d3e937b-1e62-4fb8-b471-aa5e130cb652'),
  ('e60cb2d5-91ea-4b5d-9c7c-87b683f3055c'),
  ('1335fa74-496f-42ce-8d18-5489741de1db'),
  ('4119fb1f-c499-435a-a47d-3d020a9c8583'),
  ('ef8e9df2-ac83-4b72-9d5c-732908f90600'),
  ('71dcac5c-a12a-4a8d-82c4-42f20f537bcf'),
  ('fdcd2ecd-13a9-48be-8cd6-fc1232e3febe'),
  ('a1e8568e-4297-44e7-b42d-828f03e2cdce'),
  ('a23d0283-af71-48f4-a1b7-6682fa73e2d7'),
  ('1f45ca53-e3ec-4e67-aea4-f97aa4c83339'),
  ('743bef02-e494-47d8-9cea-d2f803e22f99'),
  ('941736f5-0171-4ace-880c-eb6202ff5bd2'),
  ('d444c1e4-bf1e-4c5d-a058-9bffb774da1b'),
  ('b840b4dd-840f-45a8-87b9-e31db7d40394'),
  ('24d4ce98-c2b4-4534-a587-42f0654ae0db'),
  ('3d26b53c-3dc7-400a-91a1-d8502aa1acd9'),
  ('8e948d53-00b8-4b0d-bd69-2f7d7c9048a6'),
  ('d4dc2788-b946-4160-a1d1-0c3695737408'),
  ('b4f228cf-597e-4bae-870e-34e66d1b245e'),
  ('d30d5e3d-d183-47e4-8cbf-8aae620c994f'),
  ('6528e397-eec5-456d-b5a2-3a651e687d5a'),
  ('c5a127f3-9c0a-4ea5-83a9-48256580bc70'),
  ('a331b7c8-21d6-4d7a-b198-70c9a684bae0'),
  ('4d025cd2-27ea-4e02-aeac-dad5c3495f5d'),
  ('efe56a57-6054-478c-8b2e-1beb45ad6ec7'),
  ('8f105613-1152-439c-91eb-5c14c0ec2159'),
  ('a37b3963-62cf-4123-aa9d-bcedff2b95c8'),
  ('40fb4202-1638-40c1-b42c-6d4cabbfa94c');

-- Gate: abort the whole transaction if anything that carries money references these lots, or if any of their
-- parent auctions has reappeared since the snapshot.
do $$
declare n int;
begin
  select count(*) into n from public.orders where item_id in (select id from zz44_lots);
  if n > 0 then raise exception 'STOP: % order(s) reference a lot in this list - not test debris, report it', n; end if;
  select count(*) into n from public.invoices v join public.orders o on o.invoice_id = v.id where o.item_id in (select id from zz44_lots);
  if n > 0 then raise exception 'STOP: % invoice(s) reference a lot in this list - report it', n; end if;
  select count(*) into n from public.bids where item_id in (select id from zz44_lots);
  if n > 0 then raise exception 'STOP: % bid(s) reference a lot in this list - report it', n; end if;
  select count(*) into n from public.auctions where id::text in (select lower(auction_id) from public.auction_items where id in (select id from zz44_lots));
  if n > 0 then raise exception 'STOP: % parent auction(s) exist again - snapshot is stale, re-run the inventory', n; end if;
end $$;

-- 1. Pre-bids (49). id | item_id | auction_id | buyer | created_at
--   afd2cfcf-1205-48db-a8be-dfb6dafa7a79 | 79421924-b135-461b-a8dc-8ebdc94c5b64 | bfde0c94-f2da-44e7-aa19-b69a5d5bc9a7 | testbidder786 | 2026-06-09T00:18:32
--   dcea0a8f-4803-48b0-b497-81e7c5ddfe2d | a3ad0e45-8e73-4e21-acb4-f3b94b43b362 | 1d42bed5-1570-4a2c-9542-7416a50926d7 | Test | 2026-06-09T02:40:55
--   aae36e49-bd24-4fee-bbe9-cd60b29bb4ca | baef8bb2-d09e-4c6b-a92e-e3a3de6f5603 | 1d42bed5-1570-4a2c-9542-7416a50926d7 | Test | 2026-06-09T02:41:07
--   eb7ff627-9216-45e5-85b3-86732f271f49 | 9942aa20-ccbb-4bac-bcb0-b29fa9b4d345 | 1d42bed5-1570-4a2c-9542-7416a50926d7 | Test | 2026-06-09T02:41:10
--   a42988ee-b553-4448-bccb-a77d7a34689c | 0acdb1e9-22da-4a59-b308-5f22acacf95a | 1d42bed5-1570-4a2c-9542-7416a50926d7 | Test | 2026-06-09T02:41:20
--   558c9d05-4526-4bae-ac79-01c35121c400 | e8e1c77f-a421-4640-89dc-e0c22d2301e7 | bb20220c-7ea3-45d3-9675-3cb7e37e2e61 | testbidder786 | 2026-06-09T21:28:39
--   56ec0f39-71ad-445b-9950-ca427dfc9d17 | 7f193039-ed60-46c0-afb4-1c9f26e9e857 | 0c41b367-7742-47aa-9794-6db0bce8039f | testbidder786 | 2026-06-09T22:20:31
--   5c333dfc-ea11-41d4-9135-6feb56a4626a | 2c659b67-bdb5-43be-8b55-4d500dc0c8b9 | 035d50c9-37af-40b8-99f2-f035005b8323 | testbidder786 | 2026-06-09T23:15:17
--   136a629d-f238-4df2-92cd-0a7bd69869f0 | a0693628-659f-4529-a679-b47eae72c8df | ddc1a69c-f33d-4fb6-8f68-28c1071ce58d | smoketest_bidder_a | 2026-08-15T03:46:16
--   121bfb0e-875a-48e5-aaba-f0b3924c4ea3 | a0693628-659f-4529-a679-b47eae72c8df | ddc1a69c-f33d-4fb6-8f68-28c1071ce58d | smoketest_bidder_b | 2026-08-15T03:46:16
--   a9ffda7a-7dc0-43ed-8c0c-f209a06988ad | cd03c96b-b455-46ea-9a54-ccd215a5b09f | be230a6e-ccca-46df-a51b-f2b97016a9cf | smoketest_bidder_a | 2026-08-15T04:05:15
--   e18eff0b-4c2c-40b8-ac36-00a124c61329 | cd03c96b-b455-46ea-9a54-ccd215a5b09f | be230a6e-ccca-46df-a51b-f2b97016a9cf | smoketest_bidder_b | 2026-08-15T04:05:16
--   8dfccbe1-a5c5-4395-a249-55acf6f8d574 | a1569e9b-852f-4efa-8a82-07a82b38be8e | 75c96888-afbb-4dc8-87c4-3f055cd4f7b0 | smoketest_1788826230937 | 2026-09-08T00:10:32
--   d0fd78da-8bc4-48a6-96b1-85d55e776551 | a1569e9b-852f-4efa-8a82-07a82b38be8e | 75c96888-afbb-4dc8-87c4-3f055cd4f7b0 | whatthefind | 2026-09-08T00:10:32
--   3d4b6fd4-2761-451e-ba13-3c5177c75f91 | 2640e71d-faab-4cb8-ad5c-dcb0c37254d3 | b93bcf53-9c02-4f20-b94f-018bf51a4e2a | smoketest_1788826751935 | 2026-09-08T00:19:14
--   f0d9e992-d79e-421f-a045-ee9a1b353255 | 2640e71d-faab-4cb8-ad5c-dcb0c37254d3 | b93bcf53-9c02-4f20-b94f-018bf51a4e2a | whatthefind | 2026-09-08T00:19:14
--   5ee9b57a-4bd7-49d5-b369-35342f478322 | 9a55072f-1aba-4feb-a913-567aa74f15c9 | bf007904-b98d-4337-a71a-b484732021a5 | smoketest_1788826952530 | 2026-09-08T00:22:33
--   2ac55126-d4e2-4667-ac58-842d0122b111 | 9a55072f-1aba-4feb-a913-567aa74f15c9 | bf007904-b98d-4337-a71a-b484732021a5 | whatthefind | 2026-09-08T00:22:34
--   02e71352-cf19-476e-a93b-92b3184f49c5 | 1e97da90-8216-4147-8c5d-1e73432adb28 | bf007904-b98d-4337-a71a-b484732021a5 | smoketest_1788826952530 | 2026-09-08T00:22:35
--   d613f905-53a4-479f-9e0f-f5e45be07214 | 1e97da90-8216-4147-8c5d-1e73432adb28 | bf007904-b98d-4337-a71a-b484732021a5 | whatthefind | 2026-09-08T00:22:35
--   7fa53b26-295e-4bf3-8633-90779d6dd179 | 41c60602-8282-43c7-966f-738cf805f085 | 8e7cc300-7565-478a-941f-6d0e7c4e88d5 | phasec_retest_1789098968 | 2026-09-11T04:01:40
--   b72a5bec-281d-438d-8323-21000979016d | dff8a716-cf2a-4760-9f9c-a9b07b11173b | 8e7cc300-7565-478a-941f-6d0e7c4e88d5 | phasec_retest_1789098968 | 2026-09-11T04:04:43
--   ec1d2832-a963-4b43-9153-bb42ea2db695 | b03cf8d8-a0ca-4d06-9566-5a0f68442702 | 171f289d-7f7b-4c75-aa40-23185b1694e8 | claimtest_1789100360 | 2026-09-11T04:19:32
--   64a6829c-dcb6-4af4-b74c-0e7b8454029d | 55f4a1e6-e8c4-41c0-9ec8-c2d187b776c1 | 1a10be68-121c-457f-839b-9ab63266d2e5 | phased_confirm_1789101104 | 2026-09-11T04:38:44
--   800ed312-2751-437d-b58a-9096c53754f1 | 138cf688-ff12-484c-87eb-920fb9cb8967 | ca6054f9-f476-4095-99e7-b1ada6e48436 | phased_confirm2_1789101764 | 2026-09-11T04:47:19
--   f608b6f8-7cc6-4e53-832a-6788903a43be | a9283fce-e38b-4acd-b762-6ddab49fb7b9 | 619a2a1b-8fbe-4334-b39e-e6a2a9d6813e | zzfulfiltest1789529804448 | 2026-09-16T03:36:44
--   94795fb7-3591-4ac0-8061-d086d51663f5 | 9ede8cf9-b961-4480-a804-3e6dff7e27e6 | 6fe53a86-f391-4b67-bca6-d41384b775e6 | zzfulfiltest1789529804448 | 2026-09-16T03:36:45
--   0d503424-6e0f-4f0f-a90a-724e99025d4c | d4d6ee2b-d2c4-46f1-87e3-fd243c36360a | a681c509-d80b-4905-a173-1a19aab9a42d | zzfulfiltest1789529804448 | 2026-09-16T03:36:47
--   bdbbfaea-035d-4d3a-a857-0e1fd4caf7a7 | 7eb27044-607e-44c6-bc30-0d20591a5f03 | 3435c2b7-0c9f-4149-b35e-dd9fea84468b | zztermstest1789531865509 | 2026-09-16T04:11:06
--   504325d1-506b-4d0a-921d-c0a11ef3bfa8 | 3a959c18-e3d7-42ea-882c-f17d1b45467f | 7569d8f5-81bb-4e25-a91d-bbae8a1b72ea | zztest_delatomic | 2026-09-21T02:50:24
--   f890031f-c7bc-4932-aa4a-0dad7409b2ed | e60cb2d5-91ea-4b5d-9c7c-87b683f3055c | 43c3d77d-9e4a-4e50-b94b-a5db9e5aa9c4 | zztest_delatomic | 2026-09-21T02:50:27
--   f67491f7-d8b5-4068-928c-4cbe5c5380cc | 4119fb1f-c499-435a-a47d-3d020a9c8583 | 1adae213-8aa3-4fd0-97d8-7e88ea6b64c0 | zztest_delatomic | 2026-09-21T02:50:29
--   f026683e-eb93-40ec-9255-d1d6e86c9a0d | 71dcac5c-a12a-4a8d-82c4-42f20f537bcf | 695283a3-b528-4fa7-90ed-bf30e776d907 | zztest_delatomic | 2026-09-21T02:50:31
--   10487d76-0ea2-4074-bf3d-c7c7c5a8741e | 6dee0b20-4a6a-4845-a6a9-33e072371ab4 | 85c34d84-7634-44db-bd7c-cfcdb67a92ae | zztest_delatomic | 2026-09-21T02:57:22
--   aa37ba46-85e8-4ce7-8283-bd46a6f72ac1 | a1e8568e-4297-44e7-b42d-828f03e2cdce | cdd107fe-035a-4978-9540-7ae7ad016a4a | zztest_delatomic | 2026-09-21T02:57:25
--   18617acd-c26b-453f-8c71-64e460ff66bb | 1f45ca53-e3ec-4e67-aea4-f97aa4c83339 | 0d6729a2-4a13-4b77-8fb3-45b1a15ca45d | zztest_delatomic | 2026-09-21T02:57:27
--   c6940d71-0251-4fe8-95f8-9ea1a60a0710 | 941736f5-0171-4ace-880c-eb6202ff5bd2 | 25c791ff-689d-467c-b96b-72466bc5e7f8 | zztest_delatomic | 2026-09-21T02:57:29
--   da996aa0-4557-407e-826b-16fa9484908c | 8eab1603-b017-4957-9216-ed85b9c6c1cd | 8e37b549-0cf6-48bc-886c-c6293dc6361a | zztest_delatomic | 2026-09-21T03:01:26
--   a360b2f7-fa4d-46e8-9139-84d9eb908133 | b840b4dd-840f-45a8-87b9-e31db7d40394 | a109763b-4271-4223-9607-eb0b09e9c641 | zztest_delatomic | 2026-09-21T03:01:29
--   83baffe1-0da0-4399-8d65-fcd834b5b1b9 | 3d26b53c-3dc7-400a-91a1-d8502aa1acd9 | b6d0ab72-2b5e-422d-a0d4-474844d49483 | zztest_delatomic | 2026-09-21T03:01:31
--   182bcfb6-9f96-47e6-a3df-285a26aef676 | ef754f75-e763-4585-b906-5363c2165ab7 | 2c8c8dd3-3751-4275-8601-c9a9df241a3d | zztest_delatomic | 2026-09-21T03:02:38
--   c095d258-d402-4916-a80e-6398d22a38f3 | d4dc2788-b946-4160-a1d1-0c3695737408 | a8525d58-9536-4af8-b96a-995d96bd832a | zztest_delatomic | 2026-09-21T03:02:42
--   71e9826d-91a3-4712-9653-111cfbeb7f82 | d30d5e3d-d183-47e4-8cbf-8aae620c994f | 00656dd7-2c89-49b9-8570-b07a3412acbe | zztest_delatomic | 2026-09-21T03:02:44
--   e8a484be-e7cd-4087-a7de-d0437929fd63 | 455c9b4c-dc8b-4ca6-b0b4-401580c86506 | 783c194c-7790-4ee2-8fa7-779b5af649f2 | zztest_delatomic | 2026-09-21T04:13:03
--   c7d4770b-dc14-4238-aff4-5aac11d00352 | c5a127f3-9c0a-4ea5-83a9-48256580bc70 | a8c0699c-6a52-4886-9220-425f607148f2 | zztest_delatomic | 2026-09-21T04:13:05
--   3f2845ca-fc89-46a9-baae-9a3faaa97414 | 4d025cd2-27ea-4e02-aeac-dad5c3495f5d | d8067b1b-04de-4327-b757-2a96d985fd1b | zztest_delatomic | 2026-09-21T04:13:07
--   eff583ce-37eb-4824-9b67-d888d5e95cd4 | adbdab71-dc61-4db6-a16c-7ceb4059b0c3 | 345a9ce2-94db-4945-856d-1791199a00b8 | zztest_delatomic | 2026-09-23T02:14:07
--   60b94ddc-557e-4f9e-9ebf-1dc870fd1738 | 8f105613-1152-439c-91eb-5c14c0ec2159 | 67867855-5c09-4b0a-b3fb-1de1a0afe16b | zztest_delatomic | 2026-09-23T02:14:10
--   54be8c99-256b-494a-a7c1-326f0196f057 | 40fb4202-1638-40c1-b42c-6d4cabbfa94c | e64d7658-6515-4ede-a2bf-dc90c2bc363b | zztest_delatomic | 2026-09-23T02:14:14
delete from public.pre_bids
where id in (
    'afd2cfcf-1205-48db-a8be-dfb6dafa7a79',
    'dcea0a8f-4803-48b0-b497-81e7c5ddfe2d',
    'aae36e49-bd24-4fee-bbe9-cd60b29bb4ca',
    'eb7ff627-9216-45e5-85b3-86732f271f49',
    'a42988ee-b553-4448-bccb-a77d7a34689c',
    '558c9d05-4526-4bae-ac79-01c35121c400',
    '56ec0f39-71ad-445b-9950-ca427dfc9d17',
    '5c333dfc-ea11-41d4-9135-6feb56a4626a',
    '136a629d-f238-4df2-92cd-0a7bd69869f0',
    '121bfb0e-875a-48e5-aaba-f0b3924c4ea3',
    'a9ffda7a-7dc0-43ed-8c0c-f209a06988ad',
    'e18eff0b-4c2c-40b8-ac36-00a124c61329',
    '8dfccbe1-a5c5-4395-a249-55acf6f8d574',
    'd0fd78da-8bc4-48a6-96b1-85d55e776551',
    '3d4b6fd4-2761-451e-ba13-3c5177c75f91',
    'f0d9e992-d79e-421f-a045-ee9a1b353255',
    '5ee9b57a-4bd7-49d5-b369-35342f478322',
    '2ac55126-d4e2-4667-ac58-842d0122b111',
    '02e71352-cf19-476e-a93b-92b3184f49c5',
    'd613f905-53a4-479f-9e0f-f5e45be07214',
    '7fa53b26-295e-4bf3-8633-90779d6dd179',
    'b72a5bec-281d-438d-8323-21000979016d',
    'ec1d2832-a963-4b43-9153-bb42ea2db695',
    '64a6829c-dcb6-4af4-b74c-0e7b8454029d',
    '800ed312-2751-437d-b58a-9096c53754f1',
    'f608b6f8-7cc6-4e53-832a-6788903a43be',
    '94795fb7-3591-4ac0-8061-d086d51663f5',
    '0d503424-6e0f-4f0f-a90a-724e99025d4c',
    'bdbbfaea-035d-4d3a-a857-0e1fd4caf7a7',
    '504325d1-506b-4d0a-921d-c0a11ef3bfa8',
    'f890031f-c7bc-4932-aa4a-0dad7409b2ed',
    'f67491f7-d8b5-4068-928c-4cbe5c5380cc',
    'f026683e-eb93-40ec-9255-d1d6e86c9a0d',
    '10487d76-0ea2-4074-bf3d-c7c7c5a8741e',
    'aa37ba46-85e8-4ce7-8283-bd46a6f72ac1',
    '18617acd-c26b-453f-8c71-64e460ff66bb',
    'c6940d71-0251-4fe8-95f8-9ea1a60a0710',
    'da996aa0-4557-407e-826b-16fa9484908c',
    'a360b2f7-fa4d-46e8-9139-84d9eb908133',
    '83baffe1-0da0-4399-8d65-fcd834b5b1b9',
    '182bcfb6-9f96-47e6-a3df-285a26aef676',
    'c095d258-d402-4916-a80e-6398d22a38f3',
    '71e9826d-91a3-4712-9653-111cfbeb7f82',
    'e8a484be-e7cd-4087-a7de-d0437929fd63',
    'c7d4770b-dc14-4238-aff4-5aac11d00352',
    '3f2845ca-fc89-46a9-baae-9a3faaa97414',
    'eff583ce-37eb-4824-9b67-d888d5e95cd4',
    '60b94ddc-557e-4f9e-9ebf-1dc870fd1738',
    '54be8c99-256b-494a-a7c1-326f0196f057'
  )
  and (not exists (select 1 from public.auctions a where a.id::text = lower(pre_bids.auction_id))
       or not exists (select 1 from public.auction_items i where i.id = pre_bids.item_id));
-- expect: DELETE 49

-- 2. Images on those lots (14). Would cascade from step 3 anyway (item_images.item_id is ON DELETE CASCADE);
--    deleted explicitly so the count is visible. id | item_id | url | created_at
--   7769b52f-4f8a-474b-9aca-bf36ff6c4b4c | 0d3e937b-1e62-4fb8-b471-aa5e130cb652 | https://example.invalid/zz.jpg | 2026-09-21T02:50:27
--   554a2e4a-1a81-4686-83bb-b6b5aae56392 | 1335fa74-496f-42ce-8d18-5489741de1db | https://example.invalid/zz.jpg | 2026-09-21T02:50:29
--   29282bd5-6b4a-4dcd-8bee-d1d2eb836890 | ef8e9df2-ac83-4b72-9d5c-732908f90600 | https://example.invalid/zz.jpg | 2026-09-21T02:50:32
--   dfdde9ce-eb0b-40a7-a8f3-e5dfbe2ed9e0 | fdcd2ecd-13a9-48be-8cd6-fc1232e3febe | https://example.invalid/zz.jpg | 2026-09-21T02:57:25
--   9e3d3656-2dac-4fa6-ab98-68920faf7d3b | a23d0283-af71-48f4-a1b7-6682fa73e2d7 | https://example.invalid/zz.jpg | 2026-09-21T02:57:27
--   22f37222-7fd7-4b79-ba32-0a9973a91e35 | 743bef02-e494-47d8-9cea-d2f803e22f99 | https://example.invalid/zz.jpg | 2026-09-21T02:57:29
--   5aa48a66-006a-4b04-ab76-cc11fe25f5e0 | d444c1e4-bf1e-4c5d-a058-9bffb774da1b | https://example.invalid/zz.jpg | 2026-09-21T03:01:29
--   91eb1088-d8b2-43b7-9f84-2e036a6a8f6c | 24d4ce98-c2b4-4534-a587-42f0654ae0db | https://example.invalid/zz.jpg | 2026-09-21T03:01:31
--   5e861ea6-59f9-4c29-a08e-70a084eceae2 | 8e948d53-00b8-4b0d-bd69-2f7d7c9048a6 | https://example.invalid/zz.jpg | 2026-09-21T03:02:42
--   15fc59c5-0be0-4de3-99f1-be6dfdf97d44 | b4f228cf-597e-4bae-870e-34e66d1b245e | https://example.invalid/zz.jpg | 2026-09-21T03:02:44
--   1439b9ee-7685-4334-b0e2-699989f9ecec | 6528e397-eec5-456d-b5a2-3a651e687d5a | https://example.invalid/zz.jpg | 2026-09-21T04:13:06
--   b2315705-0421-4da2-b555-01ee68a2b120 | a331b7c8-21d6-4d7a-b198-70c9a684bae0 | https://example.invalid/zz.jpg | 2026-09-21T04:13:07
--   c69428bd-a0dc-4bd9-b4f5-73be07d26148 | efe56a57-6054-478c-8b2e-1beb45ad6ec7 | https://example.invalid/zz.jpg | 2026-09-23T02:14:11
--   bfe4095f-26b2-4782-a3bc-efe75f28770c | a37b3963-62cf-4123-aa9d-bcedff2b95c8 | https://example.invalid/zz.jpg | 2026-09-23T02:14:14
delete from public.item_images
where id in (
    '7769b52f-4f8a-474b-9aca-bf36ff6c4b4c',
    '554a2e4a-1a81-4686-83bb-b6b5aae56392',
    '29282bd5-6b4a-4dcd-8bee-d1d2eb836890',
    'dfdde9ce-eb0b-40a7-a8f3-e5dfbe2ed9e0',
    '9e3d3656-2dac-4fa6-ab98-68920faf7d3b',
    '22f37222-7fd7-4b79-ba32-0a9973a91e35',
    '5aa48a66-006a-4b04-ab76-cc11fe25f5e0',
    '91eb1088-d8b2-43b7-9f84-2e036a6a8f6c',
    '5e861ea6-59f9-4c29-a08e-70a084eceae2',
    '15fc59c5-0be0-4de3-99f1-be6dfdf97d44',
    '1439b9ee-7685-4334-b0e2-699989f9ecec',
    'b2315705-0421-4da2-b555-01ee68a2b120',
    'c69428bd-a0dc-4bd9-b4f5-73be07d26148',
    'bfe4095f-26b2-4782-a3bc-efe75f28770c'
  )
  and item_id in (select id from public.auction_items i
                  where not exists (select 1 from public.auctions a where a.id::text = lower(i.auction_id)));
-- expect: DELETE 14

-- 3. Lots (35). id | auction_id | status | title | created_at
--   4900f548-c593-4a13-a23c-54740f3ef26c | 8e7cc300-7565-478a-941f-6d0e7c4e88d5 | unsold | Phase C Retest Lot | 2026-09-11T03:56:00
--   41c60602-8282-43c7-966f-738cf805f085 | 8e7cc300-7565-478a-941f-6d0e7c4e88d5 | sold | Phase C Retest Lot 2 | 2026-09-11T04:01:35
--   dff8a716-cf2a-4760-9f9c-a9b07b11173b | 8e7cc300-7565-478a-941f-6d0e7c4e88d5 | sold | Phase C Retest Lot 3 | 2026-09-11T04:04:37
--   41cc3aa3-b0f0-41aa-835f-2602e6508266 | 171f289d-7f7b-4c75-aa40-23185b1694e8 | unsold | Claim Test Lot | 2026-09-11T04:18:39
--   b03cf8d8-a0ca-4d06-9566-5a0f68442702 | 171f289d-7f7b-4c75-aa40-23185b1694e8 | sold | Claim Test Lot 2 | 2026-09-11T04:19:31
--   55f4a1e6-e8c4-41c0-9ec8-c2d187b776c1 | 1a10be68-121c-457f-839b-9ab63266d2e5 | sold | Auto-Charge Confirm Lot | 2026-09-11T04:38:43
--   138cf688-ff12-484c-87eb-920fb9cb8967 | ca6054f9-f476-4095-99e7-b1ada6e48436 | sold | Auto-Charge Confirm Lot 2 | 2026-09-11T04:47:19
--   0d3e937b-1e62-4fb8-b471-aa5e130cb652 | 43c3d77d-9e4a-4e50-b94b-a5db9e5aa9c4 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T02:50:27
--   e60cb2d5-91ea-4b5d-9c7c-87b683f3055c | 43c3d77d-9e4a-4e50-b94b-a5db9e5aa9c4 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T02:50:27
--   1335fa74-496f-42ce-8d18-5489741de1db | 1adae213-8aa3-4fd0-97d8-7e88ea6b64c0 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T02:50:28
--   4119fb1f-c499-435a-a47d-3d020a9c8583 | 1adae213-8aa3-4fd0-97d8-7e88ea6b64c0 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T02:50:29
--   ef8e9df2-ac83-4b72-9d5c-732908f90600 | 695283a3-b528-4fa7-90ed-bf30e776d907 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T02:50:31
--   71dcac5c-a12a-4a8d-82c4-42f20f537bcf | 695283a3-b528-4fa7-90ed-bf30e776d907 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T02:50:31
--   fdcd2ecd-13a9-48be-8cd6-fc1232e3febe | cdd107fe-035a-4978-9540-7ae7ad016a4a | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T02:57:25
--   a1e8568e-4297-44e7-b42d-828f03e2cdce | cdd107fe-035a-4978-9540-7ae7ad016a4a | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T02:57:25
--   a23d0283-af71-48f4-a1b7-6682fa73e2d7 | 0d6729a2-4a13-4b77-8fb3-45b1a15ca45d | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T02:57:27
--   1f45ca53-e3ec-4e67-aea4-f97aa4c83339 | 0d6729a2-4a13-4b77-8fb3-45b1a15ca45d | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T02:57:27
--   743bef02-e494-47d8-9cea-d2f803e22f99 | 25c791ff-689d-467c-b96b-72466bc5e7f8 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T02:57:29
--   941736f5-0171-4ace-880c-eb6202ff5bd2 | 25c791ff-689d-467c-b96b-72466bc5e7f8 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T02:57:29
--   d444c1e4-bf1e-4c5d-a058-9bffb774da1b | a109763b-4271-4223-9607-eb0b09e9c641 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T03:01:29
--   b840b4dd-840f-45a8-87b9-e31db7d40394 | a109763b-4271-4223-9607-eb0b09e9c641 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T03:01:29
--   24d4ce98-c2b4-4534-a587-42f0654ae0db | b6d0ab72-2b5e-422d-a0d4-474844d49483 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T03:01:31
--   3d26b53c-3dc7-400a-91a1-d8502aa1acd9 | b6d0ab72-2b5e-422d-a0d4-474844d49483 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T03:01:31
--   8e948d53-00b8-4b0d-bd69-2f7d7c9048a6 | a8525d58-9536-4af8-b96a-995d96bd832a | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T03:02:41
--   d4dc2788-b946-4160-a1d1-0c3695737408 | a8525d58-9536-4af8-b96a-995d96bd832a | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T03:02:41
--   b4f228cf-597e-4bae-870e-34e66d1b245e | 00656dd7-2c89-49b9-8570-b07a3412acbe | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T03:02:43
--   d30d5e3d-d183-47e4-8cbf-8aae620c994f | 00656dd7-2c89-49b9-8570-b07a3412acbe | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T03:02:43
--   6528e397-eec5-456d-b5a2-3a651e687d5a | a8c0699c-6a52-4886-9220-425f607148f2 | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T04:13:05
--   c5a127f3-9c0a-4ea5-83a9-48256580bc70 | a8c0699c-6a52-4886-9220-425f607148f2 | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T04:13:05
--   a331b7c8-21d6-4d7a-b198-70c9a684bae0 | d8067b1b-04de-4327-b757-2a96d985fd1b | unsold | ZZTEST_delatomic lot 0 | 2026-09-21T04:13:07
--   4d025cd2-27ea-4e02-aeac-dad5c3495f5d | d8067b1b-04de-4327-b757-2a96d985fd1b | unsold | ZZTEST_delatomic lot 1 | 2026-09-21T04:13:07
--   efe56a57-6054-478c-8b2e-1beb45ad6ec7 | 67867855-5c09-4b0a-b3fb-1de1a0afe16b | unsold | ZZTEST_delatomic lot 0 | 2026-09-23T02:14:10
--   8f105613-1152-439c-91eb-5c14c0ec2159 | 67867855-5c09-4b0a-b3fb-1de1a0afe16b | unsold | ZZTEST_delatomic lot 1 | 2026-09-23T02:14:10
--   a37b3963-62cf-4123-aa9d-bcedff2b95c8 | e64d7658-6515-4ede-a2bf-dc90c2bc363b | unsold | ZZTEST_delatomic lot 0 | 2026-09-23T02:14:13
--   40fb4202-1638-40c1-b42c-6d4cabbfa94c | e64d7658-6515-4ede-a2bf-dc90c2bc363b | unsold | ZZTEST_delatomic lot 1 | 2026-09-23T02:14:13
delete from public.auction_items
where id in (select id from zz44_lots)
  and not exists (select 1 from public.auctions a where a.id::text = lower(auction_items.auction_id));
-- expect: DELETE 35

-- 4. Post-check inside the transaction: if anything is still dangling, roll the whole file back rather than commit
--    a half-clean state (step j would then fail anyway).
do $$
declare n int;
begin
  select (select count(*) from public.auction_items i where not exists (select 1 from public.auctions a where a.id::text = lower(i.auction_id)))
       + (select count(*) from public.pre_bids p where not exists (select 1 from public.auctions a where a.id::text = lower(p.auction_id))
                                                   or not exists (select 1 from public.auction_items i where i.id = p.item_id))
    into n;
  if n > 0 then raise exception 'STOP: % dangling lot/pre-bid row(s) remain (created after the snapshot?) - nothing committed', n; end if;
end $$;

commit;

-- 5. (read-only) verify after commit: every count 0.
select
  (select count(*) from public.auction_items i where not exists (select 1 from public.auctions a where a.id::text = lower(i.auction_id))) as dangling_lots,
  (select count(*) from public.pre_bids p where not exists (select 1 from public.auctions a where a.id::text = lower(p.auction_id))
                                             or not exists (select 1 from public.auction_items i where i.id = p.item_id)) as dangling_pre_bids,
  (select count(*) from public.item_images m where not exists (select 1 from public.auction_items i where i.id = m.item_id)) as dangling_images;

