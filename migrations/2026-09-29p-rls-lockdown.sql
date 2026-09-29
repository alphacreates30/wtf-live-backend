-- STEP p (security review #1). NOT YET APPLIED ON PRODUCTION - for Albert/Cowork to run in the Supabase SQL editor.
-- Applied and verified on wtf-test 2026-09-29 (every verification suite green with it in place).
--
-- What was wrong: RLS was off on 9 public tables, and the Supabase roles `anon` and `authenticated` held ALL
-- privileges (select, insert, update, delete, truncate, ...) on all 15 public tables, with no policies. Both
-- roles, and PUBLIC, could also EXECUTE place_bid and place_standard_bid. Anyone holding the project's anon key
-- (not a secret by design) could read password hashes, emails and addresses, rewrite orders and invoices, or bid
-- as any user through https://<ref>.supabase.co/rest/v1/, bypassing the backend entirely.
--
-- Why this is safe for the app: the backend talks to Supabase ONLY with the service_role key, which bypasses RLS
-- and keeps its own grants (untouched here). The frontend never talks to Supabase directly. The public
-- `item-images` bucket is served by Storage, not by these tables, so photos keep working.
--
-- What it does, in one transaction:
--   1. enables RLS on the 9 tables that had it off - with NO policies, so anon/authenticated see nothing
--   2. revokes every table and sequence privilege in schema public from anon and authenticated
--   3. revokes EXECUTE on every function in schema public from PUBLIC, anon and authenticated
--   4. changes the DEFAULT privileges (objects created later by postgres) so new tables, sequences and functions
--      start closed instead of open to anon/authenticated
--   5. checks the result and aborts everything if any anon/authenticated privilege is left
--
-- Not covered: default privileges owned by supabase_admin (only Supabase's own tooling creates objects as that
-- role; postgres can't alter them). Step 5 still checks every object that exists.
-- Reversible: re-grant (see the Supabase defaults) - but there is no reason to.

begin;

-- 1. RLS on, no policies.
alter table public.users          enable row level security;
alter table public.profiles       enable row level security;
alter table public.orders         enable row level security;
alter table public.bids           enable row level security;
alter table public.pre_bids       enable row level security;
alter table public.auctions       enable row level security;
alter table public.auction_items  enable row level security;
alter table public.item_images    enable row level security;
alter table public.chat_messages  enable row level security;

-- 2. No table or sequence access for the API roles.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 3. No function access for the API roles (or for everyone, via PUBLIC). service_role keeps its own grant.
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;

-- 4. New objects start closed.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
-- Postgres grants EXECUTE on every new function to PUBLIC through a GLOBAL default, which a per-schema default
-- can't take away; this removes it for functions postgres creates (the backend grants service_role explicitly).
alter default privileges for role postgres revoke execute on functions from public;

-- 5. Verify, or abort the whole transaction.
do $$
declare n_tab int; n_seq int; n_fn int; n_rls int; probe boolean;
begin
  -- A function created now must not be callable by anon (checks step 4); dropped straight away.
  create function public.zz_rls_probe_fn() returns int language sql as $f$ select 1 $f$;
  probe := has_function_privilege('anon', 'public.zz_rls_probe_fn()', 'EXECUTE');
  drop function public.zz_rls_probe_fn();
  if probe then raise exception 'STOP: a newly created function is still executable by anon'; end if;

  select count(*) into n_tab from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated');
  select count(*) into n_seq from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
     and (has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') or has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE'));
  select count(*) into n_fn from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  select count(*) into n_rls from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity;
  if n_tab + n_seq + n_fn + n_rls > 0 then
    raise exception 'STOP: still open - table grants %, sequences %, functions %, tables without RLS %', n_tab, n_seq, n_fn, n_rls;
  end if;
  raise notice 'OK: RLS on every public table; anon/authenticated have no table, sequence or function access';
end $$;

commit;

-- Afterwards (optional, read-only): the Security Advisor's 9 "RLS disabled" errors should be gone.
-- select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
