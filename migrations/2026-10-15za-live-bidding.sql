-- STEP za: live shows, phase 1 (G1, wtf-handoff LIVE_SHOWS_BRIEF.md §1.1-1.4, LIVE_SHOWS_PHASE0_REVIEW.md).
-- APPLIED on production by Cowork 2026-10-16 (SQL editor; byte-identical to this file; place_standard_bid matched
-- migration y before; after: old place_bid gone, 4 new functions, 2 triggers, no table with RLS off). Applied and verified on wtf-test 2026-10-15. Runs after migration z. Idempotent.
--
-- One bidding engine for timed lots and live lots. Live bids go through the same place_standard_bid (row lock,
-- proxy/max bids, tiered increments, the same pre_bids table); the only difference is the clock rule, which the
-- live LOT carries itself:
--
--   auction_items.extend_window_seconds  null on timed lots (they keep the 2-minute soft close the caller passes).
--   auction_items.extend_by_seconds      On a live lot: a bid with <= window seconds left adds extend_by seconds
--                                        (default 5 / 5). extend_by = 0 is "sudden death": no extension.
--   place_standard_bid                   identical to migration y, plus that one live clock rule. Same signature,
--                                        so every timed caller is unchanged.
--   open_live_lot(item, seconds, window, by, opening_min)
--                                        the host opens the next lot: under the lot's row lock (and the show's, so
--                                        only one lot is open at a time) it applies the pre-bids with the proxy
--                                        rule and starts the clock. It NEVER opens at the top max: one pre-bidder
--                                        opens at the opening minimum; two or more open at
--                                        least(top, second + increment), with the top pre-bidder leading.
--   live_db_now()                        the database clock (the backend counts lots down by it, not its own).
--   close_live_lot(item, force)          the hammer: open -> sold (a leader with a bid) or unsold, decided under the
--                                        row lock against the database clock, so a last-second bid that extended
--                                        the lot wins against a closer that read the old time. Only one caller
--                                        gets the row back. Live lots have no reserve: it is never consulted.
--   orders.discount_kind / discount_cents / discount_decided_at, apply_order_discount(...)
--                                        G2 on a live lot: the points reward or % code comes off that lot's winning
--                                        bid before it is charged (same rules as an invoice; no premium in live).
--   auctions_live_no_premium (trigger)   a live-mode auction always has buyers_premium_pct = 0 (set, not refused,
--                                        so nothing can create or edit one with a premium).
--   auction_items_live_no_reserve (trigger)
--                                        a lot in a live-mode auction never keeps a reserve_price.
--   place_bid(uuid, text, integer)       DROPPED: the old auction-row bid function the live socket used. Nothing
--                                        calls it any more (Albert/Cowork, review question 10).
--
-- Before this is applied: live shows stay off (LIVE_ENABLED is unset on production), so none of these is called;
-- timed auctions are unchanged (place_standard_bid behaves exactly as in migration y on lots with no live clock).

begin;

alter table public.auction_items add column if not exists extend_window_seconds integer
  check (extend_window_seconds is null or extend_window_seconds between 0 and 60);
alter table public.auction_items add column if not exists extend_by_seconds integer
  check (extend_by_seconds is null or extend_by_seconds between 0 and 60);

alter table public.orders add column if not exists discount_kind text check (discount_kind in ('points_reward', 'promo_code'));
alter table public.orders add column if not exists discount_cents integer not null default 0;
alter table public.orders add column if not exists discount_decided_at timestamptz;

-- ---------------------------------------------------------------------------------------------------------------
-- place_standard_bid: migration y's body; the only change is the ends_at rule (live lots carry their own).
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_standard_bid(p_item_id uuid, p_user_id text, p_username text, p_max_amount numeric, p_opening_min numeric DEFAULT 1, p_soft_close_minutes integer DEFAULT 2)
 RETURNS public.auction_items
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_item public.auction_items;
  v_increment numeric;
  v_leader_user_id text;
  v_leader_amount numeric;
  v_second_amount numeric;
  v_new_current_bid numeric;
  v_pre_bid_count integer;
  v_now timestamptz := now();
  v_new_ends_at timestamptz;
begin
  select * into v_item from public.auction_items where id = p_item_id for update;
  if v_item is null then
    raise exception 'Item not found';
  end if;
  if v_item.status <> 'open' then
    raise exception 'Item is not open for bidding';
  end if;
  if v_item.ends_at is not null and v_item.ends_at <= v_now then
    raise exception 'Bidding has closed for this item';
  end if;
  if p_max_amount < v_item.starting_bid then
    raise exception 'Bid must be at least the starting bid';
  end if;
  if p_max_amount < coalesce(v_item.current_bid, v_item.starting_bid) then
    raise exception 'Max bid must be at least the current bid';
  end if;
  insert into public.pre_bids (item_id, auction_id, buyer_username, buyer_user_id, max_amount)
  values (p_item_id, v_item.auction_id, p_username, p_user_id, p_max_amount)
  on conflict (item_id, buyer_username)
  do update set max_amount = excluded.max_amount, buyer_user_id = excluded.buyer_user_id;
  select buyer_user_id, max_amount into v_leader_user_id, v_leader_amount
  from public.pre_bids
  where item_id = p_item_id
  order by max_amount desc, created_at asc
  limit 1;
  select max(max_amount) into v_second_amount
  from public.pre_bids
  where item_id = p_item_id and buyer_user_id <> v_leader_user_id;
  select count(*) into v_pre_bid_count from public.pre_bids where item_id = p_item_id;
  v_increment := case
    when coalesce(v_item.current_bid, v_item.starting_bid) < 50 then 1
    when coalesce(v_item.current_bid, v_item.starting_bid) < 100 then 2
    when coalesce(v_item.current_bid, v_item.starting_bid) < 200 then 5
    when coalesce(v_item.current_bid, v_item.starting_bid) < 500 then 10
    when coalesce(v_item.current_bid, v_item.starting_bid) < 1000 then 25
    else 50
  end;
  if v_second_amount is null then
    v_new_current_bid := greatest(v_item.starting_bid, p_opening_min);
  else
    v_new_current_bid := least(v_leader_amount, v_second_amount + v_increment);
  end if;
  v_new_ends_at := v_item.ends_at;
  if v_item.extend_by_seconds is not null then
    -- za: a live lot. A bid with <= extend_window_seconds left adds extend_by_seconds (0 = sudden death).
    if v_item.ends_at is not null and v_item.extend_by_seconds > 0
       and v_item.ends_at - v_now <= make_interval(secs => v_item.extend_window_seconds) then
      v_new_ends_at := v_item.ends_at + make_interval(secs => v_item.extend_by_seconds);
    end if;
  elsif v_item.ends_at is not null and v_item.ends_at - v_now <= make_interval(mins => p_soft_close_minutes) then
    v_new_ends_at := v_now + make_interval(mins => p_soft_close_minutes);
  end if;
  update public.auction_items
  set current_bid = v_new_current_bid,
      leading_bidder = (select buyer_username from public.pre_bids where item_id = p_item_id and buyer_user_id = v_leader_user_id),
      top_pre_bid = v_leader_amount,
      pre_bid_count = v_pre_bid_count,
      bid_count = bid_count + 1,
      ends_at = v_new_ends_at
  where id = p_item_id
  returning * into v_item;
  insert into public.bids (auction_id, item_id, username, amount, leader_username, max_amount)
  values (v_item.auction_id::uuid, p_item_id, p_username, v_new_current_bid, v_item.leading_bidder, p_max_amount);
  return v_item;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- open_live_lot: pending -> open, pre-bids applied by the proxy rule, clock started. Raises readable P0001 errors.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.open_live_lot(p_item_id uuid, p_seconds integer, p_extend_window_seconds integer default 5,
  p_extend_by_seconds integer default 5, p_opening_min numeric default 1)
 returns public.auction_items
 language plpgsql
 set search_path to ''
as $function$
declare
  v_item public.auction_items;
  v_auction public.auctions;
  v_leader_user_id text;
  v_leader_name text;
  v_leader_amount numeric;
  v_second_amount numeric;
  v_count integer;
  v_floor numeric;
  v_price numeric;
  v_increment numeric;
begin
  if p_seconds is null or p_seconds < 5 or p_seconds > 600 then raise exception 'Clock must be 5 to 600 seconds'; end if;
  select * into v_item from public.auction_items where id = p_item_id;
  if v_item is null then raise exception 'Item not found'; end if;
  -- The show's row first (then the lot's): two "open" calls for the same show are serialized here, so only one
  -- lot can be open at a time.
  select * into v_auction from public.auctions where id = v_item.auction_id for update;
  if v_auction is null or v_auction.mode <> 'live' then raise exception 'Not a live show'; end if;
  if v_auction.status <> 'live' then raise exception 'The show is not on air'; end if;
  if exists (select 1 from public.auction_items where auction_id = v_item.auction_id and status = 'open' and id <> p_item_id) then
    raise exception 'Another lot is still open';
  end if;
  select * into v_item from public.auction_items where id = p_item_id for update;
  if v_item.status <> 'pending' then raise exception 'Lot is not waiting to be offered'; end if;

  select buyer_user_id, buyer_username, max_amount into v_leader_user_id, v_leader_name, v_leader_amount
    from public.pre_bids where item_id = p_item_id order by max_amount desc, created_at asc limit 1;
  select max(max_amount) into v_second_amount from public.pre_bids where item_id = p_item_id and buyer_user_id <> v_leader_user_id;
  select count(*) into v_count from public.pre_bids where item_id = p_item_id;
  v_floor := greatest(coalesce(v_item.starting_bid, 0), coalesce(p_opening_min, 1));

  if v_leader_user_id is null then
    v_price := coalesce(v_item.starting_bid, 0);              -- nobody yet: the first bid needs the opening minimum
  elsif v_second_amount is null then
    v_price := least(v_leader_amount, v_floor);               -- one pre-bidder: the opening minimum, never their max
  else
    v_increment := case when v_second_amount < 50 then 1 when v_second_amount < 100 then 2 when v_second_amount < 200 then 5
                        when v_second_amount < 500 then 10 when v_second_amount < 1000 then 25 else 50 end;
    v_price := greatest(least(v_leader_amount, v_second_amount + v_increment), v_floor);
    v_price := least(v_price, v_leader_amount);
  end if;

  update public.auction_items
     set status = 'open',
         current_bid = v_price,
         leading_bidder = v_leader_name,
         top_pre_bid = v_leader_amount,
         pre_bid_count = v_count,
         bid_count = case when v_leader_user_id is null then 0 else 1 end,
         ends_at = now() + make_interval(secs => p_seconds),
         extend_window_seconds = coalesce(p_extend_window_seconds, 5),
         extend_by_seconds = coalesce(p_extend_by_seconds, 5),
         reserve_price = null
   where id = p_item_id
  returning * into v_item;
  if v_leader_user_id is not null then
    -- The pre-bids, as one opening bid by the leader at the opening price (the record behind the hammer).
    insert into public.bids (auction_id, item_id, username, amount, leader_username, max_amount)
    values (v_item.auction_id, p_item_id, v_leader_name, v_price, v_leader_name, v_leader_amount);
  end if;
  return v_item;
end;
$function$;

-- The database's clock, which every live lot's ends_at is measured against. The backend asks for it now and then
-- and counts down by it, so a server whose own clock is a few seconds off still ticks and closes on time.
create or replace function public.live_db_now()
 returns timestamptz
 language sql
 stable
 set search_path to ''
as $function$
  select now();
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- close_live_lot: the hammer. Returns the closed lot, or null if this caller didn't close it (not open, not a live
-- lot, or the clock still running and p_force false).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.close_live_lot(p_item_id uuid, p_force boolean default false)
 returns public.auction_items
 language plpgsql
 set search_path to ''
as $function$
declare v_item public.auction_items; v_mode text;
begin
  select * into v_item from public.auction_items where id = p_item_id for update;
  if v_item is null or v_item.status <> 'open' or v_item.extend_by_seconds is null then return null; end if;
  select mode into v_mode from public.auctions where id = v_item.auction_id;
  if v_mode is distinct from 'live' then return null; end if;
  if not coalesce(p_force, false) and v_item.ends_at > now() then return null; end if;
  update public.auction_items
     set status = case when v_item.leading_bidder is not null and v_item.bid_count > 0 then 'sold' else 'unsold' end,
         ends_at = least(v_item.ends_at, now())
   where id = p_item_id
  returning * into v_item;
  return v_item;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- apply_order_discount: a live lot's G2 discount, decided once (same contract as apply_invoice_discount).
-- A % code entered for the show covers every lot the buyer wins in it, so it is not consumed by the first lot.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.apply_order_discount(p_order_id uuid, p_kind text, p_points integer,
  p_discount_cents integer, p_promotion_id uuid)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare v_order public.orders; v_user uuid;
begin
  if p_kind not in ('points_reward', 'promo_code', 'none') then raise exception 'bad_kind'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.discount_decided_at is not null then return 'already:' || coalesce(v_order.discount_kind, 'none'); end if;
  if coalesce(v_order.payment_status, 'unpaid') <> 'unpaid' or v_order.payment_intent_id is not null or v_order.invoice_id is not null then
    return 'not_unpaid';
  end if;
  if p_kind = 'none' then
    update public.orders set discount_decided_at = now() where id = p_order_id;
    return 'none';
  end if;
  if p_discount_cents is null or p_discount_cents <= 0 or p_discount_cents > v_order.total_cents then raise exception 'bad_amount'; end if;
  v_user := v_order.buyer_user_id::uuid;
  if p_kind = 'points_reward' then
    perform public.points_lock(v_user);
    if public.points_balance(v_user) < p_points then return 'insufficient'; end if;
    insert into public.points_ledger (user_id, kind, points, order_id, note)
    values (v_user, 'redeem', -p_points, p_order_id, 'Reward used');
  else
    update public.promotion_uses set applied_at = coalesce(applied_at, now())
     where promotion_id = p_promotion_id and user_id = v_user and auction_id = v_order.auction_id and invoice_id is null;
    if not found then return 'insufficient'; end if;
  end if;
  update public.orders
     set discount_kind = p_kind, discount_cents = p_discount_cents,
         total_cents = total_cents - p_discount_cents, discount_decided_at = now()
   where id = p_order_id;
  return p_kind;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- No premium, no reserve in live shows.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.auctions_live_no_premium()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if new.mode = 'live' then new.buyers_premium_pct := 0; end if;
  return new;
end;
$function$;
drop trigger if exists auctions_live_no_premium on public.auctions;
create trigger auctions_live_no_premium before insert or update on public.auctions
  for each row execute function public.auctions_live_no_premium();

create or replace function public.auction_items_live_no_reserve()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if new.reserve_price is not null
     and exists (select 1 from public.auctions where id = new.auction_id and mode = 'live') then
    new.reserve_price := null;
  end if;
  return new;
end;
$function$;
drop trigger if exists auction_items_live_no_reserve on public.auction_items;
create trigger auction_items_live_no_reserve before insert or update on public.auction_items
  for each row execute function public.auction_items_live_no_reserve();

-- Existing live-mode rows (old tests): premium to 0 (orders keep the amounts they were created with) and no reserve.
update public.auctions set buyers_premium_pct = 0 where mode = 'live' and buyers_premium_pct is distinct from 0;
update public.auction_items set reserve_price = null
 where reserve_price is not null and auction_id in (select id from public.auctions where mode = 'live');

drop function if exists public.place_bid(uuid, text, integer);

revoke execute on function public.place_standard_bid(uuid, text, text, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.place_standard_bid(uuid, text, text, numeric, numeric, integer) to service_role;
revoke execute on function public.open_live_lot(uuid, integer, integer, integer, numeric) from public, anon, authenticated;
grant execute on function public.open_live_lot(uuid, integer, integer, integer, numeric) to service_role;
revoke execute on function public.live_db_now() from public, anon, authenticated;
grant execute on function public.live_db_now() to service_role;
revoke execute on function public.close_live_lot(uuid, boolean) from public, anon, authenticated;
grant execute on function public.close_live_lot(uuid, boolean) to service_role;
revoke execute on function public.apply_order_discount(uuid, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.apply_order_discount(uuid, text, integer, integer, uuid) to service_role;
revoke execute on function public.auctions_live_no_premium() from public, anon, authenticated;
revoke execute on function public.auction_items_live_no_reserve() from public, anon, authenticated;

-- Verify, or abort the whole transaction.
do $$
declare
  cols integer; body_ok boolean; old_gone boolean; bad_fn text; trig integer; live_premium integer; live_reserve integer;
begin
  select count(*) into cols from information_schema.columns where table_schema = 'public'
     and ((table_name = 'auction_items' and column_name in ('extend_window_seconds', 'extend_by_seconds'))
       or (table_name = 'orders' and column_name in ('discount_kind', 'discount_cents', 'discount_decided_at')));
  select p.prosrc like '%extend_by_seconds%' and p.prosrc like '%leader_username, max_amount%' into body_ok
    from pg_proc p where p.oid = 'public.place_standard_bid(uuid, text, text, numeric, numeric, integer)'::regprocedure;
  select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'place_bid') into old_gone;
  select string_agg(p.proname, ', ') into bad_fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('place_standard_bid', 'open_live_lot', 'close_live_lot', 'apply_order_discount', 'live_db_now')
     and (not coalesce('search_path=""' = any(p.proconfig), false)
          or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select count(*) into trig from pg_trigger where tgname in ('auctions_live_no_premium', 'auction_items_live_no_reserve') and not tgisinternal;
  select count(*) into live_premium from public.auctions where mode = 'live' and buyers_premium_pct is distinct from 0;
  select count(*) into live_reserve from public.auction_items i join public.auctions a on a.id = i.auction_id
   where a.mode = 'live' and i.reserve_price is not null;
  if cols <> 5 or not coalesce(body_ok, false) or not old_gone or bad_fn is not null or trig <> 2 or live_premium > 0 or live_reserve > 0 then
    raise exception 'STOP (apply migration y and z first?): columns %/5, place_standard_bid live rule %, old place_bid dropped %, functions not pinned/locked: %, triggers %/2, live auctions with a premium %, live lots with a reserve %',
      cols, body_ok, old_gone, bad_fn, trig, live_premium, live_reserve;
  end if;
  raise notice 'OK: live clock on place_standard_bid; open_live_lot, close_live_lot, apply_order_discount, live_db_now service_role only; no premium/reserve in live; old place_bid dropped';
end $$;

commit;
