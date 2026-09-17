-- Fulfilment choice moves into the terms acknowledgement gate: the buyer
-- picks pickup or shipping before their first bid, not after the auction
-- closes. See wtf-handoff/FULFILMENT_CHOICE_AND_WEIGHTS_BRIEF.md Part 1
-- (Part 2, per-lot weights, is superseded by the weigh-at-packing model
-- shipped 2026-09-16/17 and is intentionally not part of this migration).
--
-- Run in three steps - do NOT wrap in begin/commit, it breaks silently in
-- the Supabase SQL editor.

-- Step 1: add the column nullable first (existing rows have no value yet).
alter table auction_terms_acceptances add column if not exists fulfillment_choice text;

-- Step 2: backfill unambiguous rows from each acceptance's OWN snapshotted
-- fulfillment_mode (not a fresh join to auctions.fulfillment_mode, which
-- could have changed since the buyer accepted - the snapshot on the
-- acceptance row itself is what was actually in effect when they agreed).
update auction_terms_acceptances
set fulfillment_choice = fulfillment_mode
where fulfillment_mode in ('shipping', 'pickup')
  and fulfillment_choice is null;

-- Step 3: diagnostic - run this and tell me the count. Any row still null
-- here was accepted on a 'both' auction, so there's no derivable value -
-- don't guess one into an evidentiary record. Report the count (and ideally
-- which auctions/users) before we decide how to resolve them; the
-- `not null` constraint below should NOT be run until this is 0 or you've
-- told me how to backfill the rest.
select count(*) as ambiguous_rows
from auction_terms_acceptances
where fulfillment_choice is null;

-- Step 4 (hold until step 3 is resolved): lock the column down.
-- alter table auction_terms_acceptances alter column fulfillment_choice set not null;
