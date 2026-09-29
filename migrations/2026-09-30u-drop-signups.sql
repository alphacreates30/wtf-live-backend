-- STEP u: homepage email sign-up ("wake me when it opens"), wtf-handoff HOMEPAGE_REFRESH_BRIEF.md section 4.
-- NOT YET APPLIED on production: Cowork applies it in the Supabase SQL editor. Idempotent.
-- Applied and verified on wtf-test 2026-09-30 (RLS on; anon/authenticated have no privileges; verification/home.js green).
--
--   drop_signups   one row per email address that asked to hear when the next collection opens.
--                  Stored only: nothing is sent yet. Albert exports the list for the first drop; confirm/unsubscribe
--                  come when emails start going out (confirmed_at / unsubscribed_at are ready for that).
--                  email is stored trimmed + lowercased by the backend, so a plain unique constraint is enough, and
--                  POST /signup inserts with ON CONFLICT DO NOTHING (a repeat sign-up changes nothing and answers the
--                  same message).
-- RLS on, service_role only (like migrations p and t).
--
-- Before this is applied, POST /signup answers 503 "Sign-up isn't open yet"; the rest of the homepage works.

begin;

create table if not exists public.drop_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  constraint drop_signups_email_key unique (email),
  constraint drop_signups_email_lower check (email = lower(email))
);
alter table public.drop_signups enable row level security;
revoke all on public.drop_signups from anon, authenticated;
grant all on public.drop_signups to service_role;

-- Check: RLS on, no anon/authenticated grants.
do $$
declare bad text;
begin
  select c.relname into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'drop_signups'
     and (not c.relrowsecurity
          or has_table_privilege('anon', c.oid, 'select,insert,update,delete')
          or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'));
  if bad is not null then raise exception 'STOP: RLS/grants wrong on %', bad; end if;
end $$;

commit;
