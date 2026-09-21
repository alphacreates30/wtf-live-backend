-- One row per email actually accepted by Resend (any kind: admin, won,
-- failed, outbid, shipped). Used only to count the rolling 30-day send volume so
-- outbid emails can be suppressed once we're near Resend's quota -
-- see shouldSuppressOutbid() / sendEmail() in server.js. Written only by
-- the service key, so no anon access.
create table if not exists email_send_log (
  id bigserial primary key,
  kind text not null,
  sent_at timestamptz not null default now()
);
create index if not exists email_send_log_sent_at_idx on email_send_log (sent_at);
alter table email_send_log enable row level security;
