-- APPLIED on production 2026-09-27 in Albert's Supabase SQL editor - run by a Claude session there, not by Albert (per Albert; the session that wrote this file had no SQL access and did not run it). Verified: update_standard_leader_max exists, security_definer false, ACL postgres + service_role only. DO NOT RUN AGAIN.
-- Was: NOT YET APPLIED. Run once in the Supabase SQL editor. Safe to run before or after the backend deploy: until this
-- function exists, POST /auction/:id/items/:itemId/bid falls back to place_standard_bid for every bid (the old
-- behaviour, phantom bid rows included), so nothing breaks either way.
--
-- STEP n. A buyer who is already leading a standard lot and resubmits their max (same, higher, or lower but still
-- >= the current bid) must only have their max updated. place_standard_bid, called for the leader, upserts the max
-- AND inserts a bids row at the unchanged price and increments bid_count (TEST Auction lot 1: "Bids: 2", two $1 rows,
-- one bidder). Measured on throwaway rows 2026-09-27: for a leader it never changes current_bid, leading_bidder or
-- ends_at, and does not lift current_bid to a reserve - so recording the max alone loses nothing.
--
-- place_standard_bid itself is left untouched (its source is not in this repo). This function takes the same lot row
-- lock (FOR UPDATE on auction_items) so it serialises against place_standard_bid: a challenger's bid either runs
-- first (the leader has changed -> this returns no row and the server falls back to place_standard_bid, which runs
-- the proxy battle with the new max) or runs after (and sees the new max). A plain pre_bids update from the server
-- could not guarantee that: a challenger could read the old max, then lose to it.
--
-- Returns the lot row (same shape as place_standard_bid's result) when the max was recorded, or no row when the
-- caller is not the leader / the lot is not open / it has closed / they have no max on it.

create or replace function public.update_standard_leader_max(p_item_id uuid, p_username text, p_max_amount numeric)
returns setof public.auction_items
language plpgsql
as $$
declare
  v_item public.auction_items;
begin
  select * into v_item from public.auction_items where id = p_item_id for update;
  if not found
     or v_item.leading_bidder is distinct from p_username
     or v_item.status <> 'open'
     or (v_item.ends_at is not null and v_item.ends_at <= now())
     or p_max_amount < coalesce(v_item.current_bid, 0) then
    return;
  end if;

  update public.pre_bids set max_amount = p_max_amount
  where item_id = p_item_id and buyer_username = p_username;
  if not found then
    return;
  end if;

  update public.auction_items
  set top_pre_bid = (select max(max_amount) from public.pre_bids where item_id = p_item_id)
  where id = p_item_id
  returning * into v_item;

  return next v_item;
end;
$$;

revoke all on function public.update_standard_leader_max(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.update_standard_leader_max(uuid, text, numeric) to service_role;

-- (read-only) confirm. Expect one row, security_definer = false, ACL {postgres=X/postgres,service_role=X/postgres}.
select proname, prosecdef as security_definer, proacl from pg_proc where proname = 'update_standard_leader_max';

notify pgrst, 'reload schema';
