-- STEP f. APPLIED on production 2026-09-21, verified (security_definer = false, ACL postgres+service_role only), followed by notify pgrst. DO NOT RUN AGAIN. Supersedes step e (whose function failed on any auction with rows: "operator does not exist: text = uuid").
-- auction that has rows: "operator does not exist: text = uuid"). Run in the Supabase SQL editor.
--
-- Cause: auction_items.auction_id and pre_bids.auction_id / item_id are TEXT columns (auctions.id is uuid), and e
-- compared them to a uuid. Nothing was deleted by the failed calls - the error aborts the whole function, which is
-- the atomicity working - but it means e's function cannot delete anything yet.
--
-- Fix: compare as text, and lower() the text side. Those text columns have held UPPERCASE ids before (the pre-bid
-- and add-item id poisoning fixed on 2026-09-20), and a case-sensitive text compare would silently skip such rows,
-- leaving them behind as orphans.
--
-- create or replace keeps the existing grants, but they are re-asserted below so this file is self-contained.

create or replace function public.delete_auction_cascade(p_auction_id uuid)
returns void
language plpgsql
as $$
declare
  v_id text := p_auction_id::text;
begin
  perform 1 from public.auctions where id = p_auction_id for update;
  if not found then
    return;  -- already gone: harmless, same as before
  end if;

  delete from public.item_images      where lower(item_id::text) in (select lower(id::text) from public.auction_items where lower(auction_id::text) = v_id);
  delete from public.outbid_email_log where lower(item_id::text) in (select lower(id::text) from public.auction_items where lower(auction_id::text) = v_id);
  delete from public.pre_bids         where lower(auction_id::text) = v_id
                                         or lower(item_id::text) in (select lower(id::text) from public.auction_items where lower(auction_id::text) = v_id);
  delete from public.bids             where lower(auction_id::text) = v_id;
  delete from public.chat_messages    where lower(auction_id::text) = v_id;
  delete from public.auction_terms_acceptances where lower(auction_id::text) = v_id;
  delete from public.auction_items    where lower(auction_id::text) = v_id;

  -- Refused (23503) if any order or invoice exists at this instant; the error aborts the whole function, so every
  -- delete above is rolled back with it.
  delete from public.auctions where id = p_auction_id;
end;
$$;

revoke all on function public.delete_auction_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_auction_cascade(uuid) to service_role;

-- (read-only) confirm. Expect one row, security_definer = false, ACL {postgres=X/postgres,service_role=X/postgres}.
select proname, prosecdef as security_definer, proacl from pg_proc where proname = 'delete_auction_cascade';

notify pgrst, 'reload schema';
