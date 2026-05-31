create table if not exists auctions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  image_url text,
  category text,
  starting_bid integer not null default 0,
  current_bid integer not null default 0,
  leading_bidder text,
  status text not null default 'upcoming',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid references auctions(id) on delete cascade,
  username text not null,
  amount integer not null,
  created_at timestamptz default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid references auctions(id) on delete cascade,
  username text not null,
  text text not null,
  role text default 'viewer',
  created_at timestamptz default now()
);

create index if not exists bids_auction_id_idx on bids(auction_id);
create index if not exists chat_auction_id_idx on chat_messages(auction_id);
create index if not exists bids_created_at_idx on bids(created_at desc);
create index if not exists chat_created_at_idx on chat_messages(created_at asc);

insert into auctions (title, description, category, starting_bid, current_bid, status, ends_at)
values (
  '1:6 Custom Alex DeLarge Figure',
  'Custom 1:6 scale Alex DeLarge from A Clockwork Orange. Removable derby hat, cane, full outfit. One of a kind.',
  'Vintage Toys',
  50,
  142,
  'live',
  now() + interval '30 minutes'
);
