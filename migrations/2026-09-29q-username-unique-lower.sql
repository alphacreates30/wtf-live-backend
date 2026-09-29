-- APPLIED on production 2026-09-29 by Cowork. Albert first deleted the two case-duplicate June test accounts
-- bidder305TEST / Bidder305TEST (no profile, bids, pre-bids, orders or invoices) in the same transaction, then this
-- ran. Verified: 0 leftovers, users_username_lower_key present, 28 users. DO NOT RUN AGAIN (it is idempotent).
-- Was: STEP q (security review #14). Applied and verified on wtf-test 2026-09-29.
--
-- Usernames were unique only case-sensitively, so 'WhatTheFind' and 'WHATTHEFIND' could register next to the admin's
-- 'whatthefind' and impersonate the host in chat and bids. The server now stores new names lowercase (a-z 0-9 _ only)
-- and checks case-insensitively before inserting; this index makes the database refuse a case-duplicate too.
-- Existing names are left exactly as they are.
--
-- If this stops with "case-duplicate usernames exist", two accounts already differ only by case: the message lists
-- them. Decide which to rename (nothing here renames anyone), then run it again. Read-only until the index is made.

begin;

do $$
declare dups text;
begin
  select string_agg(format('%s (%s accounts: %s)', l, n, names), '; ')
    into dups
    from (select lower(username) l, count(*) n, string_agg(username, ', ') names
            from public.users group by lower(username) having count(*) > 1) d;
  if dups is not null then
    raise exception 'STOP: case-duplicate usernames exist: %', dups;
  end if;
end $$;

create unique index if not exists users_username_lower_key on public.users (lower(username));

commit;
