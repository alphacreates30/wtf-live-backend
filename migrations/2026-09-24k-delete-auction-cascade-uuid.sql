-- STEP k (#44 step 3; the brief's "migration h", renamed so the letters match run order). Run in the Supabase SQL
-- editor AFTER steps i and j. Before i, the function would still be created, but every call on an auction with lots
-- would fail with "operator does not exist: text = uuid" (the same failure as step e), because the columns are text.
-- SUPERSEDES step f. Same function, same behaviour, same grants; only the comparisons change.
--
-- f compared lower(col::text) because auction_items.auction_id and pre_bids.auction_id were TEXT and had held
-- UPPERCASE ids. After step i both are uuid (case-insensitive by construction), so plain uuid equality is correct,
-- and it can use the indexes (lower(col::text) could not).
--
-- The locking and atomicity reasoning from e/f is unchanged: FOR UPDATE on the auction serialises this against an
-- order insert; if the final delete is refused (an order or invoice exists - orders/invoices.auction_id RESTRICT),
-- the error aborts the function and every delete above it rolls back. After step j, auction_items.auction_id is
-- also RESTRICT, which is why lots are deleted explicitly before the auction (as they already were).

create or replace function public.delete_auction_cascade(p_auction_id uuid)
returns void
language plpgsql
as $$
begin
  perform 1 from public.auctions where id = p_auction_id for update;
  if not found then
    return;  -- already gone: harmless, same as before
  end if;

  delete from public.item_images      where item_id in (select id from public.auction_items where auction_id = p_auction_id);
  delete from public.outbid_email_log where item_id in (select id from public.auction_items where auction_id = p_auction_id);
  delete from public.pre_bids         where auction_id = p_auction_id
                                         or item_id in (select id from public.auction_items where auction_id = p_auction_id);
  delete from public.bids             where auction_id = p_auction_id;
  delete from public.chat_messages    where auction_id = p_auction_id;
  delete from public.auction_terms_acceptances where auction_id = p_auction_id;
  delete from public.auction_items    where auction_id = p_auction_id;

  -- Refused (23503) if any order or invoice exists at this instant; the error aborts the whole function, so every
  -- delete above is rolled back with it.
  delete from public.auctions where id = p_auction_id;
end;
$$;

revoke all on function public.delete_auction_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_auction_cascade(uuid) to service_role;

-- (read-only) confirm. Expect one row, security_definer = false, ACL {postgres=X/postgres,service_role=X/postgres},
-- and a body with no lower(.
select proname, prosecdef as security_definer, proacl, prosrc not ilike '%lower(%' as no_lower_casts
from pg_proc where proname = 'delete_auction_cascade';

notify pgrst, 'reload schema';
