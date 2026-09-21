-- STEP e. APPLIED 2026-09-21 but its function body was BROKEN ("operator does not exist: text = uuid" on any auction that has rows) - superseded by step f, which is also applied. DO NOT RUN AGAIN.
-- Must be applied BEFORE the matching server.js is deployed: the new DELETE /auction/:id calls this function
-- and answers 500 ("Nothing was removed") if it does not exist.
--
-- DELETE /auction/:id used to delete lots, bids and chat one statement at a time, THEN the auction, and ignore the
-- last error. Orders are created when an auction closes, so an order could appear in the gap: the database refused
-- the auction (orders_auction_id_fkey RESTRICT) after the lots, bids and chat were already gone, and the route
-- still answered 200. This does the whole cascade in ONE function = ONE transaction: if the final delete is refused,
-- everything above it rolls back and nothing is removed.
--
-- Why explicit deletes rather than relying on ON DELETE CASCADE: measured on production 2026-09-20, only bids,
-- chat_messages and auction_terms_acceptances cascade from auctions. auction_items.auction_id and pre_bids have no
-- cascade, so a bare `delete from auctions` would leave orphan lots and pre-bids behind.
--
-- The row lock on the auction serialises this against an order being inserted for it (an insert takes a KEY SHARE
-- lock on the parent to check its foreign key, which conflicts with FOR UPDATE): either the order insert commits
-- first and the delete below is refused, or this delete commits first and the order insert fails its foreign key.

-- 0. (read-only) confirm nothing by this name exists yet. Expect 0 rows.
select proname from pg_proc where proname = 'delete_auction_cascade';

-- 1. The function.
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

-- 2. Only the backend (service key) may call it. Functions in public are callable through the API by anon and
--    authenticated by default, and this deletes an auction.
revoke all on function public.delete_auction_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_auction_cascade(uuid) to service_role;

-- 3. (read-only) confirm. Expect one row, security_definer = false, and only service_role/postgres in the ACL.
select proname, prosecdef as security_definer, proacl from pg_proc where proname = 'delete_auction_cascade';

notify pgrst, 'reload schema';
