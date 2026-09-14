-- Buyer email idempotency markers on orders.
-- won_email_sent_at: set once the WON+CHARGED email has been sent for this order.
-- payment_failed_email_sent_at: set once the PAYMENT FAILED email has been sent.
-- shipped_email_sent_at: set once the SHIPPED email has been sent.
alter table orders add column if not exists won_email_sent_at timestamptz;
alter table orders add column if not exists payment_failed_email_sent_at timestamptz;
alter table orders add column if not exists shipped_email_sent_at timestamptz;

-- Per (lot, outbid user) throttle state for OUTBID emails. last_sent_at is
-- reused as both "last sent" and the row's existence marker - see
-- claimOutbidEmailSlot() in server.js for how it's read/written atomically.
create table if not exists outbid_email_log (
  item_id uuid not null references auction_items(id) on delete cascade,
  username text not null,
  last_sent_at timestamptz not null default now(),
  primary key (item_id, username)
);
