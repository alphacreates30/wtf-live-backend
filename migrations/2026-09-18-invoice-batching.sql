-- Invoice batching for standard auctions: one charge per buyer per auction,
-- covering hammer + premium only (shipping is a separate later charge, see
-- 2026-09-16-shipping-charge.sql - untouched by this). Live auctions keep
-- per-lot charging via chargeOrder, unchanged.
--
-- Do NOT wrap in begin/commit - it breaks silently in the Supabase SQL editor.

-- One row per (auction, buyer). total_cents is the SUM of that buyer's
-- orders.total_cents for the auction - each order already captured
-- hammer_cents/premium_cents/total_cents at the rate in force when that lot
-- sold, so this is never recomputed from the auction's current premium rate.
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references auctions(id) on delete cascade,
  buyer_user_id text not null,
  buyer_username text,
  total_cents integer not null default 0,
  payment_status text not null default 'unpaid',
  payment_intent_id text,
  payment_error text,
  charging_since timestamptz,
  won_email_sent_at timestamptz,
  payment_failed_email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (auction_id, buyer_user_id)
);

create index if not exists invoices_auction_id_idx on invoices(auction_id);

-- Holds payment data (payment_intent_id, amounts) - written only by the
-- service key, so no anon access. Same as auction_terms_acceptances,
-- email_send_log and outbid_email_log: RLS on, 0 policies.
alter table invoices enable row level security;

-- Links each lot's order to the one invoice it was billed on. Nullable -
-- live-auction orders (which never batch) and any order predating this
-- migration stay null forever, and existing per-order UI keeps reading
-- orders.payment_status directly for those.
alter table orders add column if not exists invoice_id uuid references invoices(id);

create index if not exists orders_invoice_id_idx on orders(invoice_id);
