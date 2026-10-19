-- STEP ze: live shows, phase 5/6 (G1, wtf-handoff LIVE_SHOWS_PHASE5_BRIEF.md; LIVE_SHOWS_PHASE0_AUDIT.md §5-6):
-- chat moderation for the host, and the "show starting now" email and phone alert.
-- APPLIED on production by Cowork 2026-10-19 (SQL editor; byte-identical to this file, sha256 68214002…901b; queue_reminders
-- and delete_account on production matched migrations w and z before; after: both new tables RLS on and service_role only,
-- functions service_role only, 0 public tables with RLS off, show_live index present). Runs after migrations w (watch list), z (points), zb and zd. Idempotent.
--
--   live_moderation              the host's mute / block of one account for ONE show (the site-wide block stays
--                                admin-only, on profiles.status). mute = can't chat, can still bid; block = can't
--                                chat or bid (or pre-bid) in this show. by = the host's username. There is no
--                                moderator role in v1 (review answer 6). RLS on, service_role only.
--   chat_messages.deleted_at     the host deleted the message (removed for everyone; the row stays, as the record).
--   chat_messages.deleted_by     who deleted it (the host's username).
--   chat_messages.pinned         the show's pinned message (one at a time; the server unpins the old one).
--   auctions.slow_mode_seconds   the show's slow mode: 0 (off), 10 or 30 seconds between one account's messages.
--   notifications.kind           + 'show_live': "show starting now", by email and (channel 'push') phone alert.
--   notifications_show_live_once at most one show_live row per person per channel per show (a unique index).
--   profiles.live_alerts         "Tell me when any show goes live": on by default, for every account (Albert, Oct 18).
--   push_subscriptions           a browser's web-push subscription (endpoint, its keys). RLS on, service_role only.
--                                Deleted when a send answers 404/410, and with the account (delete_account below).
--   queue_show_live(auction, push)
--                                on Go live: show_live outbox rows for the show's followers (their "auctions you
--                                follow opening" switch applies) PLUS every approved buyer with live_alerts on; one
--                                email row each and, when push is configured (p_push), one push row for each who has
--                                a subscription. Never for a rehearsal (a draft), a timed auction or an ended show;
--                                never the host or the admin; never a deleted account. Running it again adds nothing.
--                                Followers' "open" reminder is marked done. Returns { email, push } (rows added).
--   delete_account(user)         migration z's body, plus (marked "ze:") the push subscriptions, and live_alerts off.
--   queue_reminders(now)         migration w's body, except that live shows are left out of all three reminders:
--                                a live show's lots open on a short clock, so "closing within the hour / 24 hours"
--                                would arrive after the lot sold, and its "open" email is show_live above.
--
-- Before this is applied: live shows stay off on production (LIVE_ENABLED unset). Chat on timed auctions, the chat
-- history, the reminders, the profile page, the unsubscribe links and account deletion all run without it, and
-- phone alerts stay off (verification/live-before-ze.js).

begin;

create table if not exists public.live_moderation (
  auction_id uuid not null references public.auctions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('mute', 'block')),
  by text not null,
  at timestamptz not null default now(),
  primary key (auction_id, user_id, kind)
);
alter table public.live_moderation enable row level security;
revoke all on public.live_moderation from anon, authenticated;
grant all on public.live_moderation to service_role;

alter table public.chat_messages add column if not exists deleted_at timestamptz;
alter table public.chat_messages add column if not exists deleted_by text;
alter table public.chat_messages add column if not exists pinned boolean not null default false;
create unique index if not exists chat_messages_one_pinned on public.chat_messages (auction_id) where pinned;

alter table public.auctions add column if not exists slow_mode_seconds integer not null default 0;
alter table public.auctions drop constraint if exists auctions_slow_mode_seconds_check;
alter table public.auctions add constraint auctions_slow_mode_seconds_check check (slow_mode_seconds in (0, 10, 30));

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('lot_closing', 'auction_open', 'auction_closing', 'prebid_released', 'show_live'));
create unique index if not exists notifications_show_live_once on public.notifications (user_id, channel, (payload->>'auction_id'))
  where kind = 'show_live';

alter table public.profiles add column if not exists live_alerts boolean not null default true;

create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;
grant all on all sequences in schema public to service_role;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- queue_show_live: Go live's "show starting now" outbox rows (email, and push when p_push). Only a published live
-- show on air (status 'live', not ended). The unique index makes a second run add nothing.
-- ---------------------------------------------------------------------------------------------------------------
drop function if exists public.queue_show_live(uuid);
create or replace function public.queue_show_live(p_auction_id uuid, p_push boolean default false)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare v_show public.auctions; n_email integer := 0; n_push integer := 0;
begin
  select * into v_show from public.auctions where id = p_auction_id;
  if v_show.id is null or v_show.mode is distinct from 'live' or v_show.status <> 'live' or v_show.ended_at is not null then
    return jsonb_build_object('email', 0, 'push', 0);
  end if;
  -- The followers' "open" reminder is this one.
  update public.auction_follows set open_notified_at = now() where auction_id = p_auction_id and open_notified_at is null;
  with who as (
    select f.user_id from public.auction_follows f
     where f.auction_id = p_auction_id
       and coalesce((select p.auction_open from public.notification_prefs p where p.user_id = f.user_id), true)
    union
    select u.id from public.users u join public.profiles pr on pr.user_id = u.id::text
     where pr.status = 'approved' and pr.live_alerts
  ), ok as (
    select w.user_id from who w join public.users u on u.id = w.user_id
     where u.deleted_at is null and u.username <> 'whatthefind' and u.username is distinct from v_show.host_username
  ), ins as (
    insert into public.notifications (user_id, kind, payload, channel)
    select ok.user_id, 'show_live', jsonb_build_object('auction_id', p_auction_id), ch.channel
      from ok cross join (select 'email'::text as channel union all select 'push'::text where coalesce(p_push, false)) ch
     where ch.channel = 'email' or exists (select 1 from public.push_subscriptions x where x.user_id = ok.user_id)
    on conflict do nothing
    returning channel
  )
  select count(*) filter (where channel = 'email'), count(*) filter (where channel = 'push') into n_email, n_push from ins;
  return jsonb_build_object('email', n_email, 'push', n_push);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- queue_reminders: migration w's body; every reminder now leaves live shows out (a.mode is distinct from 'live').
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.queue_reminders(p_now timestamptz)
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare n integer := 0; k integer;
begin
  with due as (
    update public.lot_watches w set reminded_at = p_now
      from public.auction_items i, public.auctions a
     where w.item_id = i.id and a.id = i.auction_id and w.reminded_at is null
       and i.status not in ('sold', 'unsold') and i.ends_at > p_now and i.ends_at <= p_now + interval '1 hour'
       and (a.status = 'live' or (a.status = 'upcoming' and a.starts_at <= p_now))
       and a.mode is distinct from 'live'
    returning w.user_id, w.item_id, i.auction_id
  )
  insert into public.notifications (user_id, kind, payload)
  select d.user_id, 'lot_closing', jsonb_build_object('item_id', d.item_id, 'auction_id', d.auction_id)
    from due d join public.users u on u.id = d.user_id and u.deleted_at is null
   where coalesce((select p.lot_closing from public.notification_prefs p where p.user_id = d.user_id), true);
  get diagnostics k = row_count; n := n + k;

  with due as (
    update public.auction_follows f set open_notified_at = p_now
      from public.auctions a
     where f.auction_id = a.id and f.open_notified_at is null
       and (a.status = 'live' or (a.status = 'upcoming' and a.starts_at <= p_now))
       and a.mode is distinct from 'live'
    returning f.user_id, f.auction_id
  )
  insert into public.notifications (user_id, kind, payload)
  select d.user_id, 'auction_open', jsonb_build_object('auction_id', d.auction_id)
    from due d join public.users u on u.id = d.user_id and u.deleted_at is null
   where coalesce((select p.auction_open from public.notification_prefs p where p.user_id = d.user_id), true);
  get diagnostics k = row_count; n := n + k;

  with due as (
    update public.auction_follows f set closing_notified_at = p_now
      from public.auctions a
     where f.auction_id = a.id and f.closing_notified_at is null
       and (a.status = 'live' or (a.status = 'upcoming' and a.starts_at <= p_now))
       and a.mode is distinct from 'live'
       and (select min(i.ends_at) from public.auction_items i
             where i.auction_id = a.id and i.status not in ('sold', 'unsold') and i.ends_at > p_now) <= p_now + interval '24 hours'
    returning f.user_id, f.auction_id
  )
  insert into public.notifications (user_id, kind, payload)
  select d.user_id, 'auction_closing', jsonb_build_object('auction_id', d.auction_id)
    from due d join public.users u on u.id = d.user_id and u.deleted_at is null
   where coalesce((select p.auction_closing from public.notification_prefs p where p.user_id = d.user_id), true);
  get diagnostics k = row_count; n := n + k;
  return n;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- delete_account: migration z's body, plus the push subscriptions and live_alerts off (marked "ze:").
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.delete_account(p_user_id uuid)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare
  v_user public.users%rowtype;
  v_new text;
  v_reasons text[];
begin
  select * into v_user from public.users where id = p_user_id for update;
  if not found then raise exception 'account_not_found'; end if;
  if v_user.deleted_at is not null then raise exception 'account_already_deleted'; end if;
  if v_user.username = 'whatthefind' then raise exception 'account_is_admin'; end if;
  v_reasons := public.account_deletion_blockers(p_user_id);
  if array_length(v_reasons, 1) > 0 then raise exception 'account_not_deletable:%', array_to_string(v_reasons, ','); end if;

  v_new := 'deleted_' || substr(replace(p_user_id::text, '-', ''), 1, 12);

  -- the username, everywhere it is shown or stored
  update public.bids          set username = v_new       where username = v_user.username;
  update public.pre_bids      set buyer_username = v_new where buyer_username = v_user.username or buyer_user_id = p_user_id::text;
  update public.chat_messages set username = v_new       where username = v_user.username;
  update public.auction_items set leading_bidder = v_new where leading_bidder = v_user.username;
  update public.auctions      set leading_bidder = v_new where leading_bidder = v_user.username;
  update public.orders        set buyer_username = v_new where buyer_user_id = p_user_id::text or buyer_username = v_user.username;
  update public.invoices      set buyer_username = v_new where buyer_user_id = p_user_id::text or buyer_username = v_user.username;
  delete from public.outbid_email_log where username = v_user.username;
  delete from public.password_resets  where user_id = p_user_id;

  -- w: what the buyer watched and followed, their reminder settings, and reminders not yet sent
  delete from public.lot_watches        where user_id = p_user_id;
  delete from public.auction_follows    where user_id = p_user_id;
  delete from public.notification_prefs where user_id = p_user_id;
  delete from public.notifications      where user_id = p_user_id and sent_at is null;

  -- z: points history and balance, settings, entered promo codes (invoices keep their discount lines)
  delete from public.points_ledger   where user_id = p_user_id;
  delete from public.points_accounts where user_id = p_user_id;
  delete from public.promotion_uses  where user_id = p_user_id;

  -- ze: the buyer's phone-alert subscriptions (their endpoints and keys)
  delete from public.push_subscriptions where user_id = p_user_id;

  -- the profile: every personal field cleared, can't bid
  update public.profiles set full_name = '', phone = '', address_line1 = '', address_line2 = null, city = '', state = '',
         zip = '', email = null, stripe_customer_id = null, stripe_payment_method_id = null, card_verified_at = null,
         card_verify_error = null, payment_status = 'none', status = 'blocked', live_alerts = false, reviewed_at = now(), reviewed_by = 'account_deleted'
   where user_id = p_user_id::text;

  -- the old username is blocked for 30 days (only its hash is kept)
  insert into public.reserved_usernames (username_hash, reserved_until)
  values (encode(sha256(convert_to(lower(v_user.username), 'UTF8')), 'hex'), now() + interval '30 days')
  on conflict (username_hash) do update set reserved_until = excluded.reserved_until;

  -- the account: no email, an unusable password, every session ended
  update public.users set username = v_new, email = null, password_hash = 'account-deleted', password_changed_at = now(), deleted_at = now()
   where id = p_user_id;

  insert into public.account_deletions (user_id) values (p_user_id);
  return v_new;
end;
$function$;


revoke execute on function public.queue_show_live(uuid, boolean) from public, anon, authenticated;
grant execute on function public.queue_show_live(uuid, boolean) to service_role;
revoke execute on function public.delete_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_account(uuid) to service_role;
revoke execute on function public.queue_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.queue_reminders(timestamptz) to service_role;

do $$
declare cols integer; bad_fn text; kinds text; rls boolean; anon_read boolean; push_rls boolean; once integer; del_ok boolean;
begin
  select count(*) into cols from information_schema.columns where table_schema = 'public'
     and ((table_name = 'chat_messages' and column_name in ('deleted_at', 'deleted_by', 'pinned'))
       or (table_name = 'auctions' and column_name = 'slow_mode_seconds')
       or (table_name = 'live_moderation' and column_name in ('auction_id', 'user_id', 'kind', 'by', 'at'))
       or (table_name = 'profiles' and column_name = 'live_alerts')
       or (table_name = 'push_subscriptions' and column_name in ('id', 'user_id', 'endpoint', 'p256dh', 'auth', 'user_agent', 'created_at', 'last_ok_at')));
  select string_agg(p.proname, ', ') into bad_fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('queue_show_live', 'queue_reminders', 'delete_account')
     and (not coalesce('search_path=""' = any(p.proconfig), false)
          or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select pg_get_constraintdef(oid) into kinds from pg_constraint where conname = 'notifications_kind_check';
  select relrowsecurity into rls from pg_class where oid = 'public.live_moderation'::regclass;
  select relrowsecurity into push_rls from pg_class where oid = 'public.push_subscriptions'::regclass;
  anon_read := has_table_privilege('anon', 'public.live_moderation', 'SELECT') or has_table_privilege('authenticated', 'public.live_moderation', 'SELECT')
            or has_table_privilege('anon', 'public.push_subscriptions', 'SELECT') or has_table_privilege('authenticated', 'public.push_subscriptions', 'SELECT');
  select count(*) into once from pg_indexes where schemaname = 'public' and indexname = 'notifications_show_live_once';
  select position('push_subscriptions' in pg_get_functiondef('public.delete_account(uuid)'::regprocedure)) > 0
     and position('points_ledger' in pg_get_functiondef('public.delete_account(uuid)'::regprocedure)) > 0 into del_ok;
  if cols <> 18 or bad_fn is not null or kinds not like '%show_live%' or kinds not like '%prebid_released%' or not rls or not push_rls or anon_read
     or once <> 1 or not del_ok
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('queue_show_live', 'queue_reminders')) <> 2 then
    raise exception 'STOP (apply migrations w, z, zb and zd first?): columns %/18, functions not pinned/locked: %, notification kinds: %, RLS on live_moderation: % and push_subscriptions: %, anon/authenticated can read them: %, show_live once index: %/1, delete_account has z and ze: %',
      cols, bad_fn, kinds, rls, push_rls, anon_read, once, del_ok;
  end if;
  raise notice 'OK: live_moderation (mute/block per show, RLS on, service_role only); chat deleted_at/deleted_by/pinned (one pinned per show); auctions.slow_mode_seconds (0/10/30); notification kind show_live (once per person per channel per show); profiles.live_alerts (default on); push_subscriptions (RLS on, service_role only); queue_show_live (followers + live alerts, email and push); delete_account removes push subscriptions; queue_reminders leaves live shows out; functions service_role only';
end $$;

notify pgrst, 'reload schema';

commit;
