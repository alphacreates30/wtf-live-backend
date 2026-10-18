-- STEP zd: live shows, phase 2a (G1, wtf-handoff LIVE_SHOWS_PHASE2_BRIEF.md step 2a; LIVE_SHOWS_PHASE0_AUDIT.md §2):
-- the show lifecycle behind the host's phone screen.
-- APPLIED on production by Cowork 2026-10-18 (SQL editor; byte-identical to this file, sha256 c5c7c9d6…451c; after:
-- 12 columns, 3 functions service_role only, 0 public tables with RLS off, anon can't read auctions). Applied and verified on wtf-test 2026-10-18. Runs after migrations za and zb.
-- Idempotent.
--
--   auctions.clock_seconds          the show's default clock per lot: 60, 30, 15 or 5 (default 30). The host can
--                                   pick another preset on each lot card.
--   auctions.auto_pace              per-show option, off by default: after a sale the next lot is shown and its
--                                   clock starts after 15 s of talk time, unless the host taps Hold.
--   auctions.on_hold                the host's Hold: auto-pace waits until it is released.
--   auctions.shown_item_id          the lot on screen (Show lot N), before or while its clock runs.
--   auctions.autostart_at           auto-pace: when the shown lot's clock starts by itself (null = not armed).
--   auctions.last_host_activity_at  every host event sets it; a show on air with no host activity for 60 min ends
--                                   itself (never while a lot is open).
--   auctions.ended_at               when the show ended (End show, or that auto-end).
--   auctions.rehearsal_key          the private rehearsal link's key (?rehearsal=<key>); the host can rotate it.
--                                   Never public. A DRAFT live show with on_air_at set and no ended_at is a
--                                   rehearsal on air: it stays a draft (hidden from every list) but runs like a
--                                   show for the invited test accounts.
--   auction_items.clock_seconds     the preset picked on this lot's card (null = the show's default).
--   auction_items.sudden_death      this lot's Sudden death switch (bids add no time).
--   auction_items.run_order         the lineup order after the host drags it (null = lot number order). Lot numbers
--                                   (position + 1) never change.
--   auction_items.run_again_of      a "Run again" copy points at the lot it copies.
--   run_again_live_lot(item, next)  the host's Run again for a Passed (unsold) lot: a copy with the next free lot
--                                   number, offered next (next = true) or at the end. One waiting copy per lot.
--   open_live_lot, reoffer_live_order
--                                   redefined: the same bodies as migrations za / zb, except that "the show is on
--                                   air" also accepts a rehearsal on air (above). Nothing else changes.
--
-- Before this is applied: live shows stay off on production (LIVE_ENABLED unset), so none of it is used.

begin;

alter table public.auctions add column if not exists clock_seconds integer not null default 30;
alter table public.auctions add column if not exists auto_pace boolean not null default false;
alter table public.auctions add column if not exists on_hold boolean not null default false;
alter table public.auctions add column if not exists shown_item_id uuid;
alter table public.auctions add column if not exists autostart_at timestamptz;
alter table public.auctions add column if not exists last_host_activity_at timestamptz;
alter table public.auctions add column if not exists ended_at timestamptz;
alter table public.auctions add column if not exists rehearsal_key text;
alter table public.auction_items add column if not exists clock_seconds integer;
alter table public.auction_items add column if not exists sudden_death boolean not null default false;
alter table public.auction_items add column if not exists run_order integer;
alter table public.auction_items add column if not exists run_again_of uuid;

alter table public.auctions drop constraint if exists auctions_clock_seconds_check;
alter table public.auctions add constraint auctions_clock_seconds_check check (clock_seconds in (5, 15, 30, 60));
alter table public.auction_items drop constraint if exists auction_items_clock_seconds_check;
alter table public.auction_items add constraint auction_items_clock_seconds_check check (clock_seconds is null or clock_seconds in (5, 15, 30, 60));

-- ---------------------------------------------------------------------------------------------------------------
-- open_live_lot: migration za's body; the on-air check also accepts a rehearsal on air.
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
  if v_auction.status <> 'live'
     and not (v_auction.status = 'draft' and v_auction.on_air_at is not null and v_auction.ended_at is null) then
    raise exception 'The show is not on air';
  end if;
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

-- ---------------------------------------------------------------------------------------------------------------
-- reoffer_live_order: migration zb's body; "Re-run now" also works in a rehearsal on air.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.reoffer_live_order(p_order_id uuid, p_target_auction_id uuid, p_next boolean default false)
 returns uuid
 language plpgsql
 set search_path to ''
as $function$
declare
  v_order public.orders; v_show public.auctions; v_target public.auctions; v_lot public.auction_items;
  v_new uuid; v_pos integer; v_spent integer; v_rerun boolean;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.payment_status is distinct from 'failed' or v_order.invoice_id is not null or v_order.payment_intent_id is not null then
    raise exception 'Only an unpaid live lot can be re-offered';
  end if;
  select * into v_show from public.auctions where id = v_order.auction_id;
  if v_show.mode is distinct from 'live' then raise exception 'Not a live show'; end if;
  select * into v_target from public.auctions where id = p_target_auction_id for update;
  if not found then raise exception 'Target auction not found'; end if;
  v_rerun := v_target.id = v_show.id;
  if v_rerun then
    -- "Re-run now": back into this show's lineup, only while it is on air (or a rehearsal on air).
    if v_target.status <> 'live'
       and not (v_target.status = 'draft' and v_target.on_air_at is not null and v_target.ended_at is null) then
      raise exception 'The show is not on air: choose a later show or a timed auction';
    end if;
  else
    if v_show.status <> 'ended' then
      raise exception 'The buyer has until the end of the show to fix their card (or re-run the lot in this show now)';
    end if;
    if v_target.status not in ('draft', 'upcoming', 'live') then
      raise exception 'Choose a later show or a timed auction that has not ended';
    end if;
  end if;
  if v_target.mode = 'standard' and v_target.ends_at is null then raise exception 'Set the timed auction''s end time first'; end if;
  select * into v_lot from public.auction_items where id = v_order.item_id for update;
  if not found then raise exception 'Lot not found'; end if;

  select coalesce(max(position), -1) + 1 into v_pos from public.auction_items where auction_id = v_target.id;
  insert into public.auction_items (auction_id, title, description, condition, image_url, starting_bid, current_bid, position, status, ends_at, offer_next)
  values (v_target.id, v_lot.title, v_lot.description, v_lot.condition, v_lot.image_url, coalesce(v_lot.starting_bid, 0),
          case when v_target.mode = 'standard' then coalesce(v_lot.starting_bid, 0) else null end, v_pos,
          case when v_target.mode = 'standard' then 'open' else 'pending' end,
          case when v_target.mode = 'standard' then v_target.ends_at else null end,
          v_rerun and coalesce(p_next, false))
  returning id into v_new;
  insert into public.item_images (item_id, url, position)
  select v_new, url, position from public.item_images where item_id = v_lot.id;

  update public.orders set payment_status = 'cancelled', status = 'cancelled', group_id = null, reoffered_item_id = v_new,
         payment_error = coalesce(payment_error, '') || ' | Re-offered (lot ' || v_new || ')'
   where id = p_order_id;
  update public.auction_items set status = 'unsold' where id = v_lot.id;

  -- A points reward spent on this lot comes back (no money moved).
  select -sum(points) into v_spent from public.points_ledger where kind = 'redeem' and order_id = p_order_id;
  if coalesce(v_spent, 0) > 0 and not exists (select 1 from public.points_ledger where kind = 'adjust' and order_id = p_order_id) then
    perform public.points_lock(v_order.buyer_user_id::uuid);
    insert into public.points_ledger (user_id, kind, points, order_id, note)
    values (v_order.buyer_user_id::uuid, 'adjust', v_spent, p_order_id, 'Reward returned: the lot was re-offered');
  end if;
  return v_new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- run_again_live_lot: the host's Run again for a lot that closed unsold (Passed, or no bids). A copy with the next
-- free lot number goes back in this show's lineup: next (p_next) or at the end. The old lot keeps its number and
-- its record. Refused if the lot has a live order, isn't unsold, or already has a copy waiting.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.run_again_live_lot(p_item_id uuid, p_next boolean default false)
 returns uuid
 language plpgsql
 set search_path to ''
as $function$
declare v_lot public.auction_items; v_show public.auctions; v_new uuid; v_pos integer;
begin
  select * into v_lot from public.auction_items where id = p_item_id;
  if not found then raise exception 'Lot not found'; end if;
  -- The show's row first, as open_live_lot does: two taps are serialized here, so only one copy is made.
  select * into v_show from public.auctions where id = v_lot.auction_id for update;
  if v_show.mode is distinct from 'live' then raise exception 'Not a live show'; end if;
  if v_show.status <> 'live'
     and not (v_show.status = 'draft' and v_show.on_air_at is not null and v_show.ended_at is null) then
    raise exception 'The show is not on air';
  end if;
  select * into v_lot from public.auction_items where id = p_item_id for update;
  if v_lot.status <> 'unsold' then raise exception 'Only a lot that didn''t sell can run again'; end if;
  if exists (select 1 from public.orders where item_id = p_item_id and payment_status is distinct from 'cancelled') then
    raise exception 'This lot has an order';
  end if;
  if exists (select 1 from public.auction_items where run_again_of = p_item_id and status = 'pending') then
    raise exception 'This lot is already waiting to run again';
  end if;

  select coalesce(max(position), -1) + 1 into v_pos from public.auction_items where auction_id = v_show.id;
  insert into public.auction_items (auction_id, title, description, condition, image_url, starting_bid, position, status,
                                    offer_next, run_again_of, clock_seconds, sudden_death)
  values (v_show.id, v_lot.title, v_lot.description, v_lot.condition, v_lot.image_url, coalesce(v_lot.starting_bid, 0), v_pos,
          'pending', coalesce(p_next, false), p_item_id, v_lot.clock_seconds, v_lot.sudden_death)
  returning id into v_new;
  insert into public.item_images (item_id, url, position)
  select v_new, url, position from public.item_images where item_id = p_item_id;
  return v_new;
end;
$function$;

revoke execute on function public.open_live_lot(uuid, integer, integer, integer, numeric) from public, anon, authenticated;
grant execute on function public.open_live_lot(uuid, integer, integer, integer, numeric) to service_role;
revoke execute on function public.reoffer_live_order(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.reoffer_live_order(uuid, uuid, boolean) to service_role;
revoke execute on function public.run_again_live_lot(uuid, boolean) from public, anon, authenticated;
grant execute on function public.run_again_live_lot(uuid, boolean) to service_role;

do $$
declare cols integer; bad_fn text; checks integer;
begin
  select count(*) into cols from information_schema.columns where table_schema = 'public'
     and ((table_name = 'auctions' and column_name in ('clock_seconds', 'auto_pace', 'on_hold', 'shown_item_id', 'autostart_at',
                                                       'last_host_activity_at', 'ended_at', 'rehearsal_key'))
       or (table_name = 'auction_items' and column_name in ('clock_seconds', 'sudden_death', 'run_order', 'run_again_of')));
  select string_agg(p.proname, ', ') into bad_fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('open_live_lot', 'reoffer_live_order', 'run_again_live_lot')
     and (not coalesce('search_path=""' = any(p.proconfig), false)
          or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select count(*) into checks from pg_constraint where conname in ('auctions_clock_seconds_check', 'auction_items_clock_seconds_check');
  if cols <> 12 or bad_fn is not null or checks <> 2
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
          and proname in ('open_live_lot', 'reoffer_live_order', 'run_again_live_lot', 'pass_live_lot', 'close_live_lot')) <> 5 then
    raise exception 'STOP (apply migrations za and zb first?): columns %/12, functions not pinned/locked: %, clock checks %/2', cols, bad_fn, checks;
  end if;
  raise notice 'OK: show lifecycle columns (clock, auto-pace, hold, shown lot, host activity, ended_at, rehearsal key; lot clock, sudden death, run order, run again); run_again_live_lot; open_live_lot and reoffer_live_order accept a rehearsal on air; service_role only';
end $$;

notify pgrst, 'reload schema';

commit;
