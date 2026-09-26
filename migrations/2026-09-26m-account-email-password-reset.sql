-- NOT YET APPLIED. Run once in the Supabase SQL editor, BEFORE deploying the backend commit that adds password
-- reset. That backend reads users.password_changed_at on every signed-in request (and users.email at registration):
-- deployed without this migration, every logged-in request would fail with 503. Safe to run while the CURRENT
-- backend is live - it only adds columns, an index and a table. Idempotent.
--
-- STEP m. Every account gets an email (required from now on), buyers can reset a forgotten password by email, and a
-- password change signs out existing sessions (item 4, below).
--
-- 1. users.email - the account's own email, used for password reset. Until now the only email lived on the buyer
--    profile (profiles.email, optional, and only for the half of accounts that have a profile). Registration now
--    requires it; accounts without one are asked for it at their next login.
--    Not unique: two accounts can share an address (one does today). A reset requested by email sends one link per
--    matching account, each naming its username.
-- 2. Backfill from profiles.email where it looks like an address, so existing buyers aren't asked again.
-- 3. password_resets - one row per reset link. Only a SHA-256 of the token is stored, so a leaked row can't be used
--    as a link. Single use (used_at), 1-hour expiry (expires_at). CASCADE: a reset link means nothing without its
--    account and carries no money.

alter table public.users add column if not exists email text;

-- 4. users.password_changed_at - set by the backend on every password change (registration, reset link, host
--    temporary password, admin change). Login tokens carry the value they were issued under; a token older than
--    the account's current value is refused, so changing a password signs out every existing session. NULL for
--    existing accounts on purpose: "no change recorded", so their current sessions stay valid until their next
--    password change. No default - the backend always writes it itself, in ms precision, so it round-trips exactly.
alter table public.users add column if not exists password_changed_at timestamptz;

update public.users u
   set email = lower(trim(p.email))
  from public.profiles p
 where p.user_id = u.id::text
   and u.email is null
   and p.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$';

create index if not exists users_email_lower_idx on public.users (lower(email));

create table if not exists public.password_resets (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.users (id) on delete cascade,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists password_resets_user_created_idx on public.password_resets (user_id, created_at);

-- Server-only (service role bypasses RLS); no policies = no client access.
alter table public.password_resets enable row level security;

-- (read-only) confirm. Expect: accounts = total users, with_email = how many were backfilled (13 at the time of
-- writing, one address shared by two accounts), and the table present with RLS on.
select count(*) as accounts, count(email) as with_email, count(password_changed_at) as with_pw_changed from public.users;
select relname, relrowsecurity from pg_class where relname = 'password_resets';

notify pgrst, 'reload schema';
