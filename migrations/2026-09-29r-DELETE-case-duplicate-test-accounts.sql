-- STEP r. DELETES ROWS. NOT YET APPLIED ON PRODUCTION - for Albert/Cowork to run in the Supabase SQL editor.
-- Albert, 2026-09-29: delete both case-duplicate test accounts, bidder305TEST and Bidder305TEST, so migration q
-- (unique lower(username)) can run. Tested on wtf-test with look-alike fixtures (see the commit).
--
-- Removes, for exactly those two accounts: pre-bids, bids, chat messages, outbid-email log rows, terms
-- acceptances, profiles and the user rows (password_resets go with them: ON DELETE CASCADE).
--
-- Kept on purpose: ai_usage (admin's own log), email_send_log (volume history), and anything in Stripe's test mode
-- (a saved test customer/card is Stripe's record, not ours to delete from here).
--
-- One transaction. The gate aborts EVERYTHING, deleting nothing, if:
--   - it doesn't find exactly these two accounts
--   - either has an order or invoice (the record of a sale - Albert decides those by hand)
--   - either leads an open lot or hosts an auction
-- It ends by checking nothing is left, and says whether any case-duplicate usernames remain (q's own check).

begin;

create temporary table zz_r_targets on commit drop as
  select id, username from public.users where username in ('bidder305TEST', 'Bidder305TEST');

do $$
declare
  n_users int; n_orders int; n_invoices int; n_leading int; n_hosting int;
begin
  select count(*) into n_users from zz_r_targets;
  if n_users <> 2 then raise exception 'STOP: expected exactly 2 accounts (bidder305TEST, Bidder305TEST), found %', n_users; end if;

  select count(*) into n_orders from public.orders o
   where o.buyer_user_id in (select id::text from zz_r_targets) or o.buyer_username in (select username from zz_r_targets);
  select count(*) into n_invoices from public.invoices i
   where i.buyer_user_id in (select id::text from zz_r_targets) or i.buyer_username in (select username from zz_r_targets);
  if n_orders + n_invoices > 0 then
    raise exception 'STOP: these accounts have % order(s) and % invoice(s) - a sale record; decide those first, nothing deleted', n_orders, n_invoices;
  end if;

  select count(*) into n_leading from public.auction_items l
   where l.leading_bidder in (select username from zz_r_targets) and l.status not in ('sold', 'unsold');
  select count(*) into n_hosting from public.auctions a where a.host_username in (select username from zz_r_targets);
  if n_leading + n_hosting > 0 then
    raise exception 'STOP: these accounts lead % open lot(s) / host % auction(s) - nothing deleted', n_leading, n_hosting;
  end if;
end $$;

delete from public.pre_bids                  where buyer_user_id in (select id::text from zz_r_targets) or buyer_username in (select username from zz_r_targets);
delete from public.bids                      where username in (select username from zz_r_targets);
delete from public.chat_messages             where username in (select username from zz_r_targets);
delete from public.outbid_email_log          where username in (select username from zz_r_targets);
delete from public.auction_terms_acceptances where user_id in (select id::text from zz_r_targets);
delete from public.profiles                  where user_id in (select id::text from zz_r_targets);
delete from public.users                     where id in (select id from zz_r_targets);   -- password_resets cascade

do $$
declare left_rows int; dups text;
begin
  select (select count(*) from public.users where username in ('bidder305TEST', 'Bidder305TEST'))
       + (select count(*) from public.profiles where user_id in (select id::text from zz_r_targets))
       + (select count(*) from public.pre_bids where buyer_username in ('bidder305TEST', 'Bidder305TEST'))
       + (select count(*) from public.bids where username in ('bidder305TEST', 'Bidder305TEST'))
       + (select count(*) from public.password_resets where user_id in (select id from zz_r_targets))
    into left_rows;
  if left_rows > 0 then raise exception 'STOP: % row(s) still left - rolled back', left_rows; end if;
  select string_agg(l, ', ') into dups from (select lower(username) l from public.users group by 1 having count(*) > 1) d;
  raise notice 'OK: both accounts and their rows removed. Case-duplicate usernames remaining: % %', coalesce(dups, 'none'),
    case when dups is null then '- migration q can run now' else '- q will still stop on these' end;
end $$;

commit;
