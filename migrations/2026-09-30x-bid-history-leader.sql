-- STEP x: anonymised bid history on the lot page (F2, wtf-handoff LOT_PAGE_BRIEF.md section 4).
-- NOT YET APPLIED on production. Applied and verified on wtf-test 2026-09-30 (verification/lot-page.js green).
-- Idempotent. Runs after migration s (it redefines place_standard_bid with the same pinned search_path).
--
-- Why: every place_standard_bid call writes one `bids` row (that is what bid_count counts), but the row's
-- `username` is whoever SUBMITTED the bid. When a challenger loses a proxy battle, the row carries the
-- challenger's name at the LEADER's price, so a history built from it would say "Bidder B $21" while A leads.
--
--   bids.leader_username   who held the lead at `amount` right after this bid (the lot's leading_bidder after the
--                          proxy battle). Null on rows written before this migration; GET /lots/:id/bids then falls
--                          back to the submitter for those rows. Never sent to anyone: the API maps it to
--                          "Bidder A" / "Bidder B" / "You".
--   bids.amount            integer -> numeric(12,2). A max bid can have cents ($20.50), so the proxy price can too
--                          ($21.50); the integer column rounded it to $22 and the history disagreed with the lot's
--                          current_bid. Existing whole-dollar rows convert unchanged.
--   place_standard_bid     identical to migration s, plus leader_username in its bids insert.
--
-- Before this is applied: the lot page works; its history attributes every row to the submitter.

begin;

alter table public.bids add column if not exists leader_username text;
alter table public.bids alter column amount type numeric(12,2);

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
  insert into public.bids (auction_id, item_id, username, amount, leader_username)
  values (v_item.auction_id::uuid, p_item_id, p_username, v_new_current_bid, v_item.leading_bidder);
  return v_item;
end;
$function$;

-- CREATE OR REPLACE keeps the function's grants, but say so explicitly, as migration s does.
revoke execute on function public.place_standard_bid(uuid, text, text, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.place_standard_bid(uuid, text, text, numeric, numeric, integer) to service_role;

-- Verify, or abort the whole transaction.
do $$
declare col_type text; has_leader boolean; body_ok boolean; pinned boolean; anon_exec boolean;
begin
  select data_type into col_type from information_schema.columns
   where table_schema = 'public' and table_name = 'bids' and column_name = 'amount';
  select exists (select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'bids' and column_name = 'leader_username') into has_leader;
  select p.prosrc like '%leader_username%', coalesce('search_path=""' = any(p.proconfig), false),
         has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    into body_ok, pinned, anon_exec
    from pg_proc p where p.oid = 'public.place_standard_bid(uuid, text, text, numeric, numeric, integer)'::regprocedure;
  if col_type <> 'numeric' or not has_leader or not body_ok or not pinned or anon_exec then
    raise exception 'STOP: amount type %, leader_username column %, function writes it %, search_path pinned %, anon/authenticated execute %',
      col_type, has_leader, body_ok, pinned, anon_exec;
  end if;
  raise notice 'OK: bids.leader_username added, bids.amount numeric, place_standard_bid records the leader; grants service_role only';
end $$;

commit;
