-- STEP s (security review #27). NOT YET APPLIED ON PRODUCTION - for Albert/Cowork to run in the Supabase SQL editor.
-- Applied and verified on wtf-test 2026-09-29 (every verification suite green with it in place).
--
-- Clears the Security Advisor's 5 "Function search path mutable" warnings: place_bid, place_standard_bid,
-- get_expired_standard_items, delete_auction_cascade, update_standard_leader_max. Their tables were looked up
-- through the CALLER's search_path, so a caller that could put its own table first (for example a temporary table,
-- which Postgres searches before public) would make the function read or write that instead. Each function now:
--   - pins search_path to '' (nothing resolved implicitly except pg_catalog, where now(), greatest() etc. live)
--   - names every table as public.<table> (return types and %rowtype included)
-- The logic is unchanged, line for line: the bodies below are production's own definitions (pg_get_functiondef,
-- identical on wtf-test) with only those two edits. CREATE OR REPLACE keeps each function's grants.
--
-- One transaction; step 2 checks the result and aborts everything if it isn't right.

begin;

-- 1. The five functions.

CREATE OR REPLACE FUNCTION public.delete_auction_cascade(p_auction_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  perform 1 from public.auctions where id = p_auction_id for update;
  if not found then
    return;  -- already gone: harmless, same as before
  end if;

  delete from public.item_images      where item_id in (select id from public.auction_items where auction_id = p_auction_id);
  delete from public.outbid_email_log where item_id in (select id from public.auction_items where auction_id = p_auction_id);
  delete from public.pre_bids         where auction_id = p_auction_id
                                         or item_id in (select id from public.auction_items where auction_id = p_auction_id);
  delete from public.bids             where auction_id = p_auction_id;
  delete from public.chat_messages    where auction_id = p_auction_id;
  delete from public.auction_terms_acceptances where auction_id = p_auction_id;
  delete from public.auction_items    where auction_id = p_auction_id;

  -- Refused (23503) if any order or invoice exists at this instant; the error aborts the whole function, so every
  -- delete above is rolled back with it.
  delete from public.auctions where id = p_auction_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_expired_standard_items()
 RETURNS SETOF public.auction_items
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select ai.*
  from public.auction_items ai
  join public.auctions a on a.id = ai.auction_id::uuid
  where a.mode = 'standard'
    and ai.status = 'open'
    and ai.ends_at is not null
    and ai.ends_at <= now();
$function$;

CREATE OR REPLACE FUNCTION public.place_bid(p_auction_id uuid, p_username text, p_amount integer)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_auction public.auctions%rowtype;
  v_bid public.bids%rowtype;
begin
  select * into v_auction
  from public.auctions
  where id = p_auction_id
  for update;

  if not found then
    return json_build_object('success', false, 'error', 'Auction not found');
  end if;

  if v_auction.status <> 'live' then
    return json_build_object('success', false, 'error', 'Auction is not live');
  end if;

  if now() > v_auction.ends_at then
    return json_build_object('success', false, 'error', 'Auction has ended');
  end if;

  if p_amount <= v_auction.current_bid then
    return json_build_object(
      'success', false,
      'error', format('Bid must be higher than $%s', v_auction.current_bid)
    );
  end if;

  insert into public.bids (auction_id, username, amount)
  values (p_auction_id, p_username, p_amount)
  returning * into v_bid;

  update public.auctions
  set current_bid = p_amount, leading_bidder = p_username
  where id = p_auction_id;

  return json_build_object(
    'success', true,
    'bid', json_build_object(
      'id', v_bid.id,
      'auction_id', p_auction_id,
      'username', p_username,
      'amount', p_amount,
      'created_at', v_bid.created_at
    )
  );
end;
$function$;

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
  if v_item.ends_at is not null and v_item.ends_at - v_now <= make_interval(mins => p_soft_close_minutes) then
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
  insert into public.bids (auction_id, item_id, username, amount)
  values (v_item.auction_id::uuid, p_item_id, p_username, v_new_current_bid);
  return v_item;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_standard_leader_max(p_item_id uuid, p_username text, p_max_amount numeric)
 RETURNS SETOF public.auction_items
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$;

-- 2. Verify, or abort the whole transaction.
do $$
declare mutable text; anon_exec text; sr_missing text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into mutable from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not coalesce('search_path=""' = any(p.proconfig), false);
  select string_agg(p.oid::regprocedure::text, ', ') into anon_exec from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select string_agg(p.oid::regprocedure::text, ', ') into sr_missing from pg_proc p
   where p.pronamespace = 'public'::regnamespace and not has_function_privilege('service_role', p.oid, 'EXECUTE');
  if mutable is not null or anon_exec is not null or sr_missing is not null then
    raise exception 'STOP: search_path not pinned on: % | executable by anon/authenticated: % | service_role missing EXECUTE: %',
      coalesce(mutable, 'none'), coalesce(anon_exec, 'none'), coalesce(sr_missing, 'none');
  end if;
  raise notice 'OK: every public function has search_path pinned to ''''; grants unchanged (service_role only)';
end $$;

commit;
