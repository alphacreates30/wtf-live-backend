-- STEP zf: at an equal max, the bidder who reached that max FIRST leads (timed lots and live shows alike).
-- NOT YET APPLIED on production. Runs after migrations n, y and za. Idempotent.
--
-- The engine picks the leader with `order by max_amount desc, created_at asc` on pre_bids: the earlier max wins a
-- tie. But a buyer's pre_bids row is upserted when they raise their max, and the upsert kept the row's ORIGINAL
-- created_at. So at a tie the buyer who first bid earliest won, even when they reached that amount LAST. Found by the
-- live load test (phase 8, 2026-10-19: five buyers bidding the same amount at once were told "winning" in turn) and
-- reproduced on a timed lot: A max $5, then B max $10 (B leads at $6), then A raises to $10 -> A led at $10. Now B
-- keeps the lead, as the rule says.
--
--   pre_bids_max_set_at()  a BEFORE UPDATE trigger: when max_amount changes, created_at becomes the moment of that
--                          write (clock_timestamp(): two bids racing for the same lot are serialized by its row lock,
--                          so the one the engine processes first keeps the earlier time, and it is also the one told
--                          "winning"). Covers every path that writes a max: place_standard_bid, the leader's
--                          max-only raise (update_standard_leader_max) and the pre-bid route (POST .../prebid).
--                          created_at is not shown anywhere as "when they first bid"; bids keeps every bid's time.
--
-- Nothing else changes: the engine functions are untouched, and existing rows keep their times.

begin;

create or replace function public.pre_bids_max_set_at()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if new.max_amount is distinct from old.max_amount then
    new.created_at := clock_timestamp();
  end if;
  return new;
end;
$function$;

revoke execute on function public.pre_bids_max_set_at() from public, anon, authenticated;

drop trigger if exists pre_bids_max_set_at on public.pre_bids;
create trigger pre_bids_max_set_at before update on public.pre_bids
  for each row execute function public.pre_bids_max_set_at();

do $$
declare n integer; pinned boolean;
begin
  select count(*) into n from pg_trigger where tgname = 'pre_bids_max_set_at' and tgrelid = 'public.pre_bids'::regclass and not tgisinternal;
  select coalesce('search_path=""' = any(proconfig), false) into pinned from pg_proc where oid = 'public.pre_bids_max_set_at()'::regprocedure;
  if n <> 1 or not pinned then
    raise exception 'STOP: trigger %/1, search_path pinned: %', n, pinned;
  end if;
  raise notice 'OK: pre_bids_max_set_at (a raised max takes the time it was set, so a tie goes to whoever reached that max first)';
end $$;

commit;
