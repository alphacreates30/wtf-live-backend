-- STEP zb: live shows, phase 1b (G1, wtf-handoff LIVE_SHOWS_PHASE0_AUDIT.md §1.5-1.6 + pre-bid expiry;
-- LIVE_SHOWS_PHASE0_REVIEW.md answers 4 and 5, the "Phase 1 build decisions" and the "Phase 1b decisions").
-- NOT YET APPLIED ON PRODUCTION. Applied and verified on wtf-test 2026-10-16 (changed the same day for "Re-run now").
-- Runs after migration za. Idempotent.
--
--   auctions.on_air_at              when the host started the show (start_auction, or the first lot offered). A
--                                   live show with no on_air_at 24 h after its starts_at releases its pre-bids.
--   auctions.prebids_released_at    set once, when that happened (so it runs once).
--   auctions.live_summary_sent_at   set once, when the "your show wins" emails went out after the show.
--   auction_items.offer_next        a re-run lot the host put next in the show's lineup.
--   orders.reoffered_item_id        the lot a declined order's lot was re-offered as (the record; and a buyer whose
--                                   lot was re-run in a show still can't bid in it until they save a new card).
--   notifications.kind              + 'prebid_released': the outbox row is the record of that email (answer 4).
--   pass_live_lot(item)             the host's Pass: an open live lot closes with no sale ('unsold'), whatever its
--                                   bids. Same row lock and same single-closer rule as close_live_lot.
--   reoffer_live_order(order, target_auction, next)
--                                   a lot whose buyer's card was declined goes back on sale, in one transaction:
--                                   the order is cancelled (kept as the record; reoffered_item_id = the new lot), a
--                                   points reward spent on it is given back, the old lot is marked 'unsold', and a
--                                   copy of the lot (title, description, condition, photos, starting bid) is added
--                                   to the target (the cancelled order also leaves the buyer's show box). Returns
--                                   the new lot's id. Answer 5: the host chooses each time.
--                                   * target = the same show, while it is on air ("Re-run now", Albert, Oct 16):
--                                     back in this show's lineup, waiting ('pending'): offered next (next = true:
--                                     offer_next, which the host's next_item takes before the rest) or at the end
--                                     (next = false). Lot numbers never change: the copy gets the next free number.
--                                   * target = a later live show (waiting) or a timed auction (open until that
--                                     auction's end): only once the show has ended (the buyer has until then).
--                                   A cancelled order is never charged, so a card fixed later charges nothing for it.
--
-- Before this is applied: live shows stay off on production, so none of these is used; the backend's 30-second job
-- skips the expiry and summary steps quietly while the columns are missing.

begin;

alter table public.auctions add column if not exists on_air_at timestamptz;
alter table public.auctions add column if not exists prebids_released_at timestamptz;
alter table public.auctions add column if not exists live_summary_sent_at timestamptz;
alter table public.auction_items add column if not exists offer_next boolean not null default false;
alter table public.orders add column if not exists reoffered_item_id uuid;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('lot_closing', 'auction_open', 'auction_closing', 'prebid_released'));

create or replace function public.pass_live_lot(p_item_id uuid)
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
  update public.auction_items set status = 'unsold', ends_at = least(v_item.ends_at, now())
   where id = p_item_id
  returning * into v_item;
  return v_item;
end;
$function$;

-- The first wtf-test run made a two-argument version; the three-argument one (next) replaces it.
drop function if exists public.reoffer_live_order(uuid, uuid);
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
    -- "Re-run now": back into this show's lineup, only while it is on air.
    if v_target.status <> 'live' then raise exception 'The show is not on air: choose a later show or a timed auction'; end if;
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

revoke execute on function public.pass_live_lot(uuid) from public, anon, authenticated;
grant execute on function public.pass_live_lot(uuid) to service_role;
revoke execute on function public.reoffer_live_order(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.reoffer_live_order(uuid, uuid, boolean) to service_role;

do $$
declare cols integer; bad_fn text; kinds text; reoffer_args text;
begin
  select count(*) into cols from information_schema.columns where table_schema = 'public'
     and ((table_name = 'auctions' and column_name in ('on_air_at', 'prebids_released_at', 'live_summary_sent_at'))
       or (table_name = 'auction_items' and column_name = 'offer_next')
       or (table_name = 'orders' and column_name = 'reoffered_item_id'));
  select string_agg(p.proname, ', ') into bad_fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('pass_live_lot', 'reoffer_live_order')
     and (not coalesce('search_path=""' = any(p.proconfig), false)
          or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select pg_get_constraintdef(oid) into kinds from pg_constraint where conname = 'notifications_kind_check';
  select string_agg(pg_get_function_identity_arguments(p.oid), ' / ') into reoffer_args from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'reoffer_live_order';
  if cols <> 5 or bad_fn is not null or kinds not like '%prebid_released%'
     or reoffer_args is distinct from 'p_order_id uuid, p_target_auction_id uuid, p_next boolean'
     or (select count(*) from pg_proc where proname in ('pass_live_lot', 'reoffer_live_order', 'close_live_lot')) <> 3 then
    raise exception 'STOP (apply migration za first?): columns %/5, functions not pinned/locked: %, notification kinds: %, reoffer_live_order(%)', cols, bad_fn, kinds, reoffer_args;
  end if;
  raise notice 'OK: on_air_at, prebids_released_at, live_summary_sent_at, offer_next, reoffered_item_id; prebid_released notifications; pass_live_lot, reoffer_live_order (re-run in the show) service_role only';
end $$;

commit;
