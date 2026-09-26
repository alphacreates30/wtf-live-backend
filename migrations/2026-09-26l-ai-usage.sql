-- APPLIED on production 2026-09-26 in Albert's Supabase SQL editor - run by a Claude session there, not by Albert (per Albert; the session that wrote this file had no SQL access and did not run it). Verified: ai_usage exists with RLS on. DO NOT RUN AGAIN.
-- Was: NOT YET APPLIED. Run once in the Supabase SQL editor. Safe to run before or after the backend deploy: until this
-- table exists the backend logs "ai_usage insert failed" and carries on (AI calls are never blocked by it), and the
-- Host Dashboard's AI spend card says tracking isn't set up yet.
--
-- STEP l. One row per Claude call the backend makes (photo grouping, lot cataloguing, description regeneration), so
-- the host can see what AI has cost - per auction, per day, all time.
--
-- Raw token counts are stored alongside cost_usd, so if prices change the history can be re-costed from the tokens.
-- cost_usd is what the call cost at the rates in ai_lots.js PRICES when it was made.
--
-- auction_id deliberately has NO foreign key. This is a spend log: it must outlive the auction it was spent on (a
-- deleted test auction still cost money), so it can't RESTRICT a delete, and CASCADE / SET NULL would erase or
-- orphan-without-a-trace the spend. The dashboard shows a missing auction as "Deleted auction".

create table if not exists public.ai_usage (
  id                           bigint generated always as identity primary key,
  created_at                   timestamptz not null default now(),
  kind                         text not null check (kind in ('group', 'analyze', 'regenerate')),
  model                        text not null,
  auction_id                   uuid,
  username                     text,
  input_tokens                 integer not null default 0,
  output_tokens                integer not null default 0,
  cache_creation_input_tokens  integer not null default 0,
  cache_read_input_tokens      integer not null default 0,
  cost_usd                     numeric(12, 6)
);

create index if not exists ai_usage_created_at_idx on public.ai_usage (created_at);
create index if not exists ai_usage_auction_id_idx on public.ai_usage (auction_id);

-- Server-only, like the rest of the schema: the backend uses the service role, which bypasses RLS. No policies means
-- anon/authenticated clients can neither read nor write it.
alter table public.ai_usage enable row level security;

-- (read-only) confirm. Expect one row: ai_usage | true
select relname, relrowsecurity from pg_class where relname = 'ai_usage';

notify pgrst, 'reload schema';
