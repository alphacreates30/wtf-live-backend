-- STEP y: hide bidders and the pickup address (wtf-handoff PRIVACY_BIDDERS_PICKUP_BRIEF.md, B6 + B7).
-- APPLIED on production by Cowork 2026-09-30 (SQL editor, after x; byte-identical to this file; pickup_town,
-- max_amount present, function body matches). Applied and verified on wtf-test 2026-09-30. Runs AFTER migration x (it redefines
-- place_standard_bid again, keeping x's leader_username). Idempotent.
--
--   auctions.pickup_town   the town the public sees ("Miami, FL"). The street address (pickup_address) now goes only
--                          to the admin and to buyers who won a lot in that auction and chose pickup. Publishing an
--                          auction that offers pickup requires it. No backfill (no real auctions yet).
--   bids.max_amount        the max the bidder entered with that bid. PRIVATE: only that bidder (their own bids on
--                          the lot page) and the admin ever see it. `amount` stays the price that bid produced,
--                          which can be the leader's price, so it can't tell a buyer what they bid.
--   place_standard_bid     identical to migration x, plus max_amount in its bids insert.
--
-- Before this is applied: the site works; the public sees no pickup town (only "the address is sent to winners"),
-- the admin can't enter one, and a buyer's own bid list shows the price each bid produced instead of their max.

begin;

alter table public.auctions add column if not exists pickup_town text;
alter table public.bids add column if not exists max_amount numeric(12,2);

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
  insert into public.bids (auction_id, item_id, username, amount, leader_username, max_amount)
  values (v_item.auction_id::uuid, p_item_id, p_username, v_new_current_bid, v_item.leading_bidder, p_max_amount);
  return v_item;
end;
$function$;

revoke execute on function public.place_standard_bid(uuid, text, text, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.place_standard_bid(uuid, text, text, numeric, numeric, integer) to service_role;

-- Verify, or abort the whole transaction.
do $$
declare has_town boolean; has_max boolean; has_leader boolean; body_ok boolean; pinned boolean; anon_exec boolean;
begin
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'auctions' and column_name = 'pickup_town') into has_town;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bids' and column_name = 'max_amount') into has_max;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bids' and column_name = 'leader_username') into has_leader;
  select p.prosrc like '%leader_username, max_amount%', coalesce('search_path=""' = any(p.proconfig), false),
         has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    into body_ok, pinned, anon_exec
    from pg_proc p where p.oid = 'public.place_standard_bid(uuid, text, text, numeric, numeric, integer)'::regprocedure;
  if not has_town or not has_max or not has_leader or not body_ok or not pinned or anon_exec then
    raise exception 'STOP (apply migration x first?): pickup_town %, bids.max_amount %, bids.leader_username %, function writes both %, search_path pinned %, anon/authenticated execute %',
      has_town, has_max, has_leader, body_ok, pinned, anon_exec;
  end if;
  raise notice 'OK: auctions.pickup_town, bids.max_amount added; place_standard_bid records leader and max; grants service_role only';
end $$;

commit;
