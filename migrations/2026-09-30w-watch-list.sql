-- STEP w: watch list, followed auctions and reminder emails (F3, wtf-handoff WATCH_LIST_BRIEF.md).
-- NOT YET APPLIED on production: Cowork applies it in the Supabase SQL editor, after migration t (it redefines
-- delete_account). Idempotent. Applied and verified on wtf-test 2026-09-30 (its own checks passed; verification/watch-list.js
-- and account-delete.js green).
--
--   lot_watches         a buyer watches a lot. reminded_at = the "closing within the hour" reminder was queued
--                       (set once; a soft-close extension never re-sends).
--   auction_follows     a buyer follows an auction ("Remind me" before it opens). open_notified_at /
--                       closing_notified_at = those reminders were queued (once each).
--   notification_prefs  per buyer, one switch per reminder kind; no row = all on. (Outbid emails are separate and
--                       unchanged.)
--   notifications       the outbox. One row per reminder (kind + payload ids); the email sender groups a buyer's
--                       unsent rows into ONE email per run. channel 'email' now; the phone app later adds 'push' rows
--                       and device tokens without changing anything here.
--   queue_reminders(now)       claims due reminders and writes their outbox rows in one transaction
--                              (update ... set x_at = now where x_at is null returning ...): idempotent, restart-safe.
--   claim_notifications(...)   hands unsent outbox rows to one sender at a time (skip locked; a claim older than
--                              5 minutes is retried; at most 3 attempts).
--   delete_account(user)       as in migration t, plus: the buyer's watches, follows, preferences and UNSENT
--                              notifications are deleted in the same transaction (A5).
-- All tables RLS on, service_role only; functions service_role only with search_path pinned (like p-v).
--
-- Before this is applied the watch/follow routes answer 503 "not available yet" and the reminder job does nothing;
-- the rest of the site is unaffected.

begin;

create table if not exists public.lot_watches (
  user_id uuid not null references public.users(id) on delete cascade,
  item_id uuid not null references public.auction_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  reminded_at timestamptz,
  primary key (user_id, item_id)
);
create index if not exists lot_watches_item_idx on public.lot_watches (item_id);
create index if not exists lot_watches_due_idx on public.lot_watches (item_id) where reminded_at is null;

create table if not exists public.auction_follows (
  user_id uuid not null references public.users(id) on delete cascade,
  auction_id uuid not null references public.auctions(id) on delete cascade,
  created_at timestamptz not null default now(),
  open_notified_at timestamptz,
  closing_notified_at timestamptz,
  primary key (user_id, auction_id)
);
create index if not exists auction_follows_auction_idx on public.auction_follows (auction_id);

create table if not exists public.notification_prefs (
  user_id uuid primary key references public.users(id) on delete cascade,
  lot_closing boolean not null default true,
  auction_open boolean not null default true,
  auction_closing boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('lot_closing', 'auction_open', 'auction_closing')),
  payload jsonb not null default '{}'::jsonb,
  channel text not null default 'email' check (channel in ('email', 'push')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  error text
);
create index if not exists notifications_unsent_idx on public.notifications (channel, user_id, id) where sent_at is null;

alter table public.lot_watches        enable row level security;
alter table public.auction_follows    enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.notifications      enable row level security;
revoke all on public.lot_watches, public.auction_follows, public.notification_prefs, public.notifications from anon, authenticated;
grant all on public.lot_watches, public.auction_follows, public.notification_prefs, public.notifications to service_role;
grant all on all sequences in schema public to service_role;
revoke all on all sequences in schema public from anon, authenticated;

-- Claims every reminder that is due at p_now and writes one outbox row for each, in one transaction.
-- "Open" auction = status live, or upcoming with starts_at passed (as /home). A lot is due for its reminder when
-- it is open (not sold/unsold) and closes within the hour; an auction's "closing" reminder when its first OPEN lot
-- closes within 24 hours. Each claim stamps its *_at column, so a reminder is queued at most once, even if the lot's
-- end moves later (soft close) or two servers run this at the same moment. A buyer who switched a kind off, or a
-- deleted account, is claimed but gets no outbox row (nothing to send later either).
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

-- Hands up to p_limit unsent rows of one channel to the caller, whole buyers at a time where possible (ordered by
-- user). Rows another sender holds are skipped; a claim older than 5 minutes (a crashed sender) is taken over;
-- after 3 attempts a row is left alone (its error column says why).
create or replace function public.claim_notifications(p_channel text, p_limit integer)
 returns setof public.notifications
 language plpgsql
 set search_path to ''
as $function$
begin
  return query
  update public.notifications n set claimed_at = now(), attempts = n.attempts + 1
   where n.id in (
     select x.id from public.notifications x
      where x.channel = p_channel and x.sent_at is null and x.attempts < 3
        and (x.claimed_at is null or x.claimed_at < now() - interval '5 minutes')
      order by x.user_id, x.id
      limit p_limit
      for update skip locked)
  returning n.*;
end;
$function$;

-- delete_account: identical to migration t, plus the watch-list data (marked "w:").
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

  -- the profile: every personal field cleared, can't bid
  update public.profiles set full_name = '', phone = '', address_line1 = '', address_line2 = null, city = '', state = '',
         zip = '', email = null, stripe_customer_id = null, stripe_payment_method_id = null, card_verified_at = null,
         card_verify_error = null, payment_status = 'none', status = 'blocked', reviewed_at = now(), reviewed_by = 'account_deleted'
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

revoke execute on function public.queue_reminders(timestamptz), public.claim_notifications(text, integer), public.delete_account(uuid) from public, anon, authenticated;
grant  execute on function public.queue_reminders(timestamptz), public.claim_notifications(text, integer), public.delete_account(uuid) to service_role;

-- Verify, or abort the whole transaction.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname in ('lot_watches', 'auction_follows', 'notification_prefs', 'notifications')
     and (not c.relrowsecurity or has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')
          or has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'INSERT')
          or not has_table_privilege('service_role', c.oid, 'SELECT') or not has_table_privilege('service_role', c.oid, 'INSERT'));
  if bad is not null then raise exception 'STOP: RLS/grants wrong on %', bad; end if;
  if (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace
       and c.relname in ('lot_watches', 'auction_follows', 'notification_prefs', 'notifications')) <> 4 then
    raise exception 'STOP: tables missing'; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('queue_reminders', 'claim_notifications', 'delete_account')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or not has_function_privilege('service_role', p.oid, 'EXECUTE') or not coalesce('search_path=""' = any(p.proconfig), false));
  if bad is not null then raise exception 'STOP: grants/search_path wrong on %', bad; end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('queue_reminders', 'claim_notifications', 'delete_account')) <> 3 then
    raise exception 'STOP: functions missing'; end if;
  raise notice 'OK: watch-list schema in place; service_role only; search_path pinned';
end $$;

commit;
