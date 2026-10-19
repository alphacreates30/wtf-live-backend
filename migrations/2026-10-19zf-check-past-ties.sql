-- READ-ONLY check that goes with migration zf (run it in the SQL editor; it changes nothing).
-- Lots whose leader (or winner) reached the top max AFTER another bidder had already reached that same max: the
-- lots migration zf's bug may have decided. From the bid history (bids keeps every bid with its max and time).
-- Pre-bids on live lots and the leader's own max-only raises leave no bid row and aren't covered; live shows were
-- off on production, and a max-only raise only happens for the buyer already leading.
with lead as (
  select i.id as item_id, i.auction_id, i.position + 1 as lot_number, i.status, i.current_bid, i.leading_bidder, i.top_pre_bid as top
    from public.auction_items i
   where i.top_pre_bid is not null and i.leading_bidder is not null
), reached as (
  select b.item_id, b.username, min(b.created_at) as at
    from public.bids b join lead l on l.item_id = b.item_id and b.max_amount = l.top
   group by b.item_id, b.username
)
select a.title as auction, l.lot_number, l.status, l.current_bid as price, l.leading_bidder as leader_now,
       (select r.username from reached r where r.item_id = l.item_id order by r.at limit 1) as reached_it_first,
       l.top as tied_max, l.item_id
  from lead l join public.auctions a on a.id = l.auction_id
 where exists (select 1 from reached r
                where r.item_id = l.item_id and r.username <> l.leading_bidder
                  and r.at < coalesce((select min(r2.at) from reached r2 where r2.item_id = l.item_id and r2.username = l.leading_bidder), 'infinity'))
 order by a.title, l.lot_number;
