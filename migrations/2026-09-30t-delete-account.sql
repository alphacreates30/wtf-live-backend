-- STEP t (A5, "Delete my account"). NOT YET APPLIED ON PRODUCTION - for Albert/Cowork to run in the Supabase SQL editor.
-- Applied and verified on wtf-test 2026-09-30.
--
-- Anonymise, don't erase: a buyer's personal details go, sale records stay (DELETE_ACCOUNT_BRIEF.md).
--   users.deleted_at                    when the account was deleted (null = active)
--   account_deletions                   audit trail: user id + time, nothing personal
--   reserved_usernames                  a deleted buyer's old username can't be re-registered for 30 days; stored as a
--                                       SHA-256 of the lowercased name, never the name itself
--   account_deletion_blockers(user)     why the account can't be deleted right now (empty = it can)
--   delete_account(user)                does the whole deletion in ONE transaction and returns the new placeholder
--                                       username ('deleted_' + 12 hex of the id). Re-checks the blockers first.
-- Both functions: search_path pinned, every table public.<x>, EXECUTE for service_role only (like migrations p/s).
-- Stripe (cards, customer) is handled by the backend BEFORE it calls delete_account; if Stripe fails, it stops.
--
-- Until this is applied, the backend's delete route answers 503 "not available yet" and registration works as before.

begin;

alter table public.users add column if not exists deleted_at timestamptz;

create table if not exists public.account_deletions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  deleted_at timestamptz not null default now()
);
create table if not exists public.reserved_usernames (
  username_hash text primary key,
  reserved_until timestamptz not null
);
alter table public.account_deletions  enable row level security;
alter table public.reserved_usernames enable row level security;
revoke all on public.account_deletions, public.reserved_usernames from anon, authenticated;
grant all on public.account_deletions, public.reserved_usernames to service_role;
grant all on all sequences in schema public to service_role;
revoke all on all sequences in schema public from anon, authenticated;

create or replace function public.account_deletion_blockers(p_user_id uuid)
 returns text[]
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_username text;
  v_reasons text[] := '{}';
begin
  select username into v_username from public.users where id = p_user_id;
  if v_username is null then return v_reasons; end if;
  -- leads a lot that is still open (bids are binding)
  if exists (select 1 from public.auction_items i where i.leading_bidder = v_username and i.status not in ('sold', 'unsold')) then
    v_reasons := v_reasons || 'leading_open_lot'::text; end if;
  -- has a max bid on a lot that is still open
  if exists (select 1 from public.pre_bids p join public.auction_items i on i.id = p.item_id
             where (p.buyer_user_id = p_user_id::text or p.buyer_username = v_username) and i.status not in ('sold', 'unsold')) then
    v_reasons := v_reasons || 'max_bid_open_lot'::text; end if;
  -- an unpaid or failed invoice (or an order not yet invoiced that is unpaid/failed)
  if exists (select 1 from public.invoices v where v.buyer_user_id = p_user_id::text and v.payment_status in ('unpaid', 'failed', 'charging'))
     or exists (select 1 from public.orders o where o.buyer_user_id = p_user_id::text and o.invoice_id is null
                and coalesce(o.payment_status, 'unpaid') in ('unpaid', 'failed', 'charging')) then
    v_reasons := v_reasons || 'unpaid_invoice'::text; end if;
  -- an order not yet shipped or collected: its address is still needed
  if exists (select 1 from public.orders o where o.buyer_user_id = p_user_id::text and o.status in ('pending', 'label_created')) then
    v_reasons := v_reasons || 'order_not_shipped'::text; end if;
  return v_reasons;
end;
$function$;

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

revoke execute on function public.account_deletion_blockers(uuid), public.delete_account(uuid) from public, anon, authenticated;
grant  execute on function public.account_deletion_blockers(uuid), public.delete_account(uuid) to service_role;

-- Verify, or abort the whole transaction.
do $$
declare bad text;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'deleted_at') then
    raise exception 'STOP: users.deleted_at missing'; end if;
  select string_agg(c.relname, ', ') into bad from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname in ('account_deletions', 'reserved_usernames')
     and (not c.relrowsecurity or has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')
          or not has_table_privilege('service_role', c.oid, 'SELECT') or not has_table_privilege('service_role', c.oid, 'INSERT'));
  if bad is not null then raise exception 'STOP: RLS/grants wrong on %', bad; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('account_deletion_blockers', 'delete_account')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or not has_function_privilege('service_role', p.oid, 'EXECUTE') or not coalesce('search_path=""' = any(p.proconfig), false));
  if bad is not null then raise exception 'STOP: grants/search_path wrong on %', bad; end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('account_deletion_blockers', 'delete_account')) <> 2 then
    raise exception 'STOP: functions missing'; end if;
  raise notice 'OK: delete-account schema in place; service_role only; search_path pinned';
end $$;

commit;
