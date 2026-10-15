-- STEP z: buyer points + promotions (G2, wtf-handoff POINTS_BRIEF.md). NOT YET APPLIED ON PRODUCTION.
-- Runs after migration w (it redefines delete_account again, keeping w's lines). Idempotent.
--
--   points_settings        one row (id = 1): enabled, points per $1, points per reward, reward value, expiry months.
--                          Defaults 1 / 250 / $25 / 12, enabled = false. The backend ALSO needs POINTS_ENABLED=true on
--                          Railway: points are on only when both say so.
--   points_accounts        per buyer: auto_apply (default ON: timed auctions have no checkout step), last_win_at (the
--                          last successful paid win; drives the 12-month expiry), expiry_reminded_for (the last_win_at
--                          the 30-day reminder was sent for, so it goes once per expiry date).
--   points_ledger          every change: earn | redeem | expire | reverse | adjust. balance = sum(points). One earn and
--                          one reverse per order, one redeem per invoice (or per order, for live shows later): unique
--                          indexes make every write idempotent per source.
--   promotions             admin promos per auction (or site-wide when auction_id is null), with start/end:
--                          percent_code | free_shipping | bundle_free_shipping.
--   promotion_uses         a buyer's entered % code for an auction (one per buyer per auction), and the invoice it
--                          was applied to.
--   invoices.discount_*    the one discount on an invoice: kind (points_reward | promo_code), the amount off the
--                          winning bids, the premium saved on it, and when it was decided (null = not yet).
--   orders.shipping_promo  why a shipment's postage was free (free_shipping | bundle_free_shipping), else null.
--
-- Functions (service_role only, search_path pinned, like p-y). Each takes the buyer's account row lock, so two
-- invoices for the same buyer closing at once can never both spend the same 250 points.
--   points_earn(user, order, points, now)              credit a paid lot once; sets last_win_at
--   points_reverse(order, note)                        refund/cancel: take back that lot's points, never below 0;
--                                                      returns the shortfall (points already spent, not clawed back)
--   apply_invoice_discount(invoice, kind, points, off, premium_off, promotion)
--                                                      decide the invoice's discount once, atomically: spend the
--                                                      points (if the balance still allows) or mark the code used,
--                                                      and lower total_cents. Returns the kind actually applied.
--   points_expire_due(now, months)                     expire every balance with no win for `months`
--   points_reminders_due(now, months)                  claim the buyers whose points expire within 30 days
--   points_adjust(user, +/-points, note)               admin correction; never below 0
--   points_outstanding(points_per_reward)              admin total owed
--   delete_account(user)                               as in w, plus the buyer's points and promo rows (A5)
--
-- Before this is applied: the backend treats points as switched off (every points route answers enabled:false or
-- 503 for admin writes); invoices, charges and shipping work exactly as before.

begin;

create table if not exists public.points_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  points_per_dollar integer not null default 1 check (points_per_dollar between 0 and 100),
  points_per_reward integer not null default 250 check (points_per_reward between 1 and 100000),
  reward_cents integer not null default 2500 check (reward_cents between 1 and 100000),
  expiry_months integer not null default 12 check (expiry_months between 1 and 120),
  updated_at timestamptz not null default now()
);
insert into public.points_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.points_accounts (
  user_id uuid primary key references public.users(id) on delete cascade,
  auto_apply boolean not null default true,
  last_win_at timestamptz,
  expiry_reminded_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.points_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('earn', 'redeem', 'expire', 'reverse', 'adjust')),
  points integer not null,
  invoice_id uuid references public.invoices(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists points_ledger_user_idx on public.points_ledger (user_id, created_at desc);
create unique index if not exists points_ledger_order_once on public.points_ledger (kind, order_id)
  where order_id is not null and kind in ('earn', 'reverse', 'redeem');
create unique index if not exists points_ledger_invoice_once on public.points_ledger (kind, invoice_id)
  where invoice_id is not null and kind = 'redeem';

create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid references public.auctions(id) on delete cascade,
  kind text not null check (kind in ('percent_code', 'free_shipping', 'bundle_free_shipping')),
  code text,
  percent integer,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((kind = 'percent_code') = (code is not null and percent is not null)),
  check (percent is null or percent between 1 and 90),
  check (code is null or code ~ '^[A-Z0-9_-]{3,30}$')
);
create index if not exists promotions_auction_idx on public.promotions (auction_id);

create table if not exists public.promotion_uses (
  id bigint generated always as identity primary key,
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  auction_id uuid not null references public.auctions(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, auction_id)
);

alter table public.invoices add column if not exists hammer_cents integer;
alter table public.invoices add column if not exists discount_kind text check (discount_kind in ('points_reward', 'promo_code'));
alter table public.invoices add column if not exists discount_cents integer not null default 0;
alter table public.invoices add column if not exists discount_premium_cents integer not null default 0;
alter table public.invoices add column if not exists discount_decided_at timestamptz;
alter table public.orders add column if not exists shipping_promo text check (shipping_promo in ('free_shipping', 'bundle_free_shipping'));

alter table public.points_settings enable row level security;
alter table public.points_accounts enable row level security;
alter table public.points_ledger   enable row level security;
alter table public.promotions      enable row level security;
alter table public.promotion_uses  enable row level security;
revoke all on public.points_settings, public.points_accounts, public.points_ledger, public.promotions, public.promotion_uses from anon, authenticated;
grant all on public.points_settings, public.points_accounts, public.points_ledger, public.promotions, public.promotion_uses to service_role;
grant all on all sequences in schema public to service_role;
revoke all on all sequences in schema public from anon, authenticated;

-- Locks (creating if needed) the buyer's points account row; every balance-changing function starts here.
create or replace function public.points_lock(p_user_id uuid)
 returns public.points_accounts
 language plpgsql
 set search_path to ''
as $function$
declare v public.points_accounts;
begin
  insert into public.points_accounts (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v from public.points_accounts where user_id = p_user_id for update;
  return v;
end;
$function$;

create or replace function public.points_balance(p_user_id uuid)
 returns integer
 language sql
 stable
 set search_path to ''
as $function$
  select coalesce(sum(points), 0)::integer from public.points_ledger where user_id = p_user_id;
$function$;

-- Credit a paid lot. Returns the points credited now (0 if this order was already credited, or p_points <= 0).
create or replace function public.points_earn(p_user_id uuid, p_order_id uuid, p_points integer, p_now timestamptz default now())
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare n integer;
begin
  if p_points is null or p_points <= 0 then return 0; end if;
  perform public.points_lock(p_user_id);
  insert into public.points_ledger (user_id, kind, points, order_id, note, created_at)
  values (p_user_id, 'earn', p_points, p_order_id, 'Won and paid', p_now)
  on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return 0; end if;
  update public.points_accounts set last_win_at = greatest(coalesce(last_win_at, p_now), p_now), updated_at = now()
   where user_id = p_user_id;
  return p_points;
end;
$function$;

-- Take back one lot's points after a refund or cancellation. Never takes the balance below 0. Returns the
-- shortfall (points that had already been spent and are not clawed back), or -1 if nothing was earned / already
-- reversed.
create or replace function public.points_reverse(p_order_id uuid, p_note text default null)
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare v_user uuid; v_earned integer; v_bal integer; v_take integer; n integer;
begin
  select user_id, points into v_user, v_earned from public.points_ledger where kind = 'earn' and order_id = p_order_id;
  if v_user is null then return -1; end if;
  perform public.points_lock(v_user);
  if exists (select 1 from public.points_ledger where kind = 'reverse' and order_id = p_order_id) then return -1; end if;
  v_bal := public.points_balance(v_user);
  v_take := least(v_earned, greatest(v_bal, 0));
  insert into public.points_ledger (user_id, kind, points, order_id, note)
  values (v_user, 'reverse', -v_take, p_order_id,
          coalesce(p_note, 'Refunded or cancelled') || case when v_take < v_earned
            then ' (' || (v_earned - v_take) || ' points already spent, not taken back)' else '' end)
  on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return -1; end if;
  return v_earned - v_take;
end;
$function$;

-- Decide an invoice's discount exactly once. p_kind: 'points_reward' | 'promo_code' | 'none'. For a points reward
-- the balance is re-checked under the lock; if it no longer covers p_points the result is 'insufficient' and nothing
-- changes (the caller decides again). Returns the kind applied, 'insufficient', or 'already:<kind>' if the invoice
-- was decided earlier (a re-run), or 'not_unpaid' if it is no longer unpaid.
create or replace function public.apply_invoice_discount(p_invoice_id uuid, p_kind text, p_points integer,
  p_discount_cents integer, p_premium_cents integer, p_promotion_id uuid)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare v_inv public.invoices; v_user uuid;
begin
  if p_kind not in ('points_reward', 'promo_code', 'none') then raise exception 'bad_kind'; end if;
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if v_inv.discount_decided_at is not null then return 'already:' || coalesce(v_inv.discount_kind, 'none'); end if;
  if v_inv.payment_status <> 'unpaid' or v_inv.payment_intent_id is not null then return 'not_unpaid'; end if;
  if p_kind = 'none' then
    update public.invoices set discount_decided_at = now() where id = p_invoice_id;
    return 'none';
  end if;
  if p_discount_cents is null or p_discount_cents <= 0 or p_premium_cents < 0
     or p_discount_cents + p_premium_cents > v_inv.total_cents then raise exception 'bad_amount'; end if;
  v_user := v_inv.buyer_user_id::uuid;
  if p_kind = 'points_reward' then
    perform public.points_lock(v_user);
    if public.points_balance(v_user) < p_points then return 'insufficient'; end if;
    insert into public.points_ledger (user_id, kind, points, invoice_id, note)
    values (v_user, 'redeem', -p_points, p_invoice_id, 'Reward used');
  else
    update public.promotion_uses set invoice_id = p_invoice_id, applied_at = now()
     where promotion_id = p_promotion_id and user_id = v_user and auction_id = v_inv.auction_id and applied_at is null;
    if not found then return 'insufficient'; end if;
  end if;
  update public.invoices
     set discount_kind = p_kind, discount_cents = p_discount_cents, discount_premium_cents = p_premium_cents,
         total_cents = total_cents - p_discount_cents - p_premium_cents, discount_decided_at = now()
   where id = p_invoice_id;
  return p_kind;
end;
$function$;

-- Expire every positive balance whose last win (or, with no win yet, the account's start) is p_months or more
-- before p_now. Returns the number of buyers expired. Safe to re-run: an expired balance is 0.
create or replace function public.points_expire_due(p_now timestamptz, p_months integer)
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare r record; v_bal integer; n integer := 0;
begin
  for r in select a.user_id from public.points_accounts a
            where coalesce(a.last_win_at, a.created_at) <= p_now - make_interval(months => p_months)
  loop
    perform public.points_lock(r.user_id);
    v_bal := public.points_balance(r.user_id);
    if v_bal > 0 then
      insert into public.points_ledger (user_id, kind, points, note, created_at)
      values (r.user_id, 'expire', -v_bal, 'No win for ' || p_months || ' months', p_now);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$function$;

-- Claim the buyers whose positive balance expires within 30 days of p_now and who have not been reminded for this
-- expiry date. Each is returned once per last_win_at (a new win moves the date and re-arms the reminder).
create or replace function public.points_reminders_due(p_now timestamptz, p_months integer)
 returns table (user_id uuid, balance integer, expires_at timestamptz)
 language plpgsql
 set search_path to ''
as $function$
begin
  return query
  with due as (
    update public.points_accounts a set expiry_reminded_for = coalesce(a.last_win_at, a.created_at), updated_at = now()
     where coalesce(a.last_win_at, a.created_at) + make_interval(months => p_months) > p_now
       and coalesce(a.last_win_at, a.created_at) + make_interval(months => p_months) <= p_now + interval '30 days'
       and a.expiry_reminded_for is distinct from coalesce(a.last_win_at, a.created_at)
       and public.points_balance(a.user_id) > 0
    returning a.user_id, coalesce(a.last_win_at, a.created_at) + make_interval(months => p_months) as exp
  )
  select d.user_id, public.points_balance(d.user_id), d.exp
    from due d join public.users u on u.id = d.user_id and u.deleted_at is null;
end;
$function$;

-- Admin +/- with a note. A minus can't take the balance below 0 (raises 'points_below_zero'). Returns the new balance.
create or replace function public.points_adjust(p_user_id uuid, p_points integer, p_note text)
 returns integer
 language plpgsql
 set search_path to ''
as $function$
declare v_bal integer;
begin
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then raise exception 'bad_points'; end if;
  if p_note is null or length(trim(p_note)) = 0 then raise exception 'note_required'; end if;
  perform public.points_lock(p_user_id);
  v_bal := public.points_balance(p_user_id);
  if v_bal + p_points < 0 then raise exception 'points_below_zero'; end if;
  insert into public.points_ledger (user_id, kind, points, note) values (p_user_id, 'adjust', p_points, trim(p_note));
  return v_bal + p_points;
end;
$function$;

-- Admin total: points owed to buyers (positive balances only), how many buyers hold them, and how many whole
-- rewards they could use right now.
create or replace function public.points_outstanding(p_points_per_reward integer)
 returns table (points bigint, buyers bigint, rewards_ready bigint)
 language sql
 stable
 set search_path to ''
as $function$
  select coalesce(sum(b.bal), 0)::bigint, count(*)::bigint, coalesce(sum(b.bal / greatest(p_points_per_reward, 1)), 0)::bigint
    from (select user_id, sum(points)::bigint as bal from public.points_ledger group by user_id having sum(points) > 0) b;
$function$;

-- delete_account: identical to migration w, plus the points data (marked "z:").
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

revoke execute on function public.points_lock(uuid), public.points_balance(uuid), public.points_earn(uuid, uuid, integer, timestamptz),
  public.points_reverse(uuid, text), public.apply_invoice_discount(uuid, text, integer, integer, integer, uuid),
  public.points_expire_due(timestamptz, integer), public.points_reminders_due(timestamptz, integer), public.delete_account(uuid),
  public.points_adjust(uuid, integer, text), public.points_outstanding(integer)
  from public, anon, authenticated;
grant execute on function public.points_lock(uuid), public.points_balance(uuid), public.points_earn(uuid, uuid, integer, timestamptz),
  public.points_reverse(uuid, text), public.apply_invoice_discount(uuid, text, integer, integer, integer, uuid),
  public.points_expire_due(timestamptz, integer), public.points_reminders_due(timestamptz, integer), public.delete_account(uuid),
  public.points_adjust(uuid, integer, text), public.points_outstanding(integer)
  to service_role;

-- Verify, or abort the whole transaction.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('points_settings', 'points_accounts', 'points_ledger', 'promotions', 'promotion_uses')
     and (not c.relrowsecurity or has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')
          or has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'INSERT')
          or not has_table_privilege('service_role', c.oid, 'SELECT') or not has_table_privilege('service_role', c.oid, 'INSERT'));
  if bad is not null then raise exception 'STOP: RLS/grants wrong on %', bad; end if;
  if (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace
       and c.relname in ('points_settings', 'points_accounts', 'points_ledger', 'promotions', 'promotion_uses')) <> 5 then
    raise exception 'STOP: tables missing'; end if;
  if (select count(*) from information_schema.columns where table_schema = 'public'
       and ((table_name = 'invoices' and column_name in ('hammer_cents', 'discount_kind', 'discount_cents', 'discount_premium_cents', 'discount_decided_at'))
         or (table_name = 'orders' and column_name = 'shipping_promo'))) <> 6 then
    raise exception 'STOP: invoice/order columns missing'; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('points_lock', 'points_balance', 'points_earn', 'points_reverse', 'apply_invoice_discount',
                       'points_expire_due', 'points_reminders_due', 'delete_account', 'points_adjust', 'points_outstanding')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or not has_function_privilege('service_role', p.oid, 'EXECUTE') or not coalesce('search_path=""' = any(p.proconfig), false));
  if bad is not null then raise exception 'STOP: grants/search_path wrong on %', bad; end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('points_lock', 'points_balance', 'points_earn', 'points_reverse', 'apply_invoice_discount',
                         'points_expire_due', 'points_reminders_due', 'delete_account', 'points_adjust',
                         'points_outstanding')) <> 10 then
    raise exception 'STOP: functions missing (or an old overload left behind)'; end if;
  if (select prosrc from pg_proc where oid = 'public.delete_account(uuid)'::regprocedure) not like '%points_ledger%' then
    raise exception 'STOP: delete_account does not remove points'; end if;
  if (select enabled from public.points_settings where id = 1) is distinct from false then
    raise notice 'NOTE: points_settings.enabled is already true (left as it was)'; end if;
  raise notice 'OK: points + promotions schema in place; service_role only; search_path pinned; delete_account removes points';
end $$;

commit;
