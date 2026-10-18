-- STEP zc: service requests (F5, wtf-handoff SERVICES_BRIEF.md): the Services pages' one request form.
-- APPLIED on production by Cowork 2026-10-16 (SQL editor; byte-identical to this file, sha256 df90ddae…87ef; after:
-- RLS on, anon/authenticated no access, bucket private 5 MB, 0 public tables with RLS off). Applied and verified on wtf-test 2026-10-16. Independent of the other migrations.
-- Idempotent.
--
--   service_requests          one row per form sent: the service (sell, consign, estates, collection_auction, or
--                             general = the Contact page), name, email, phone (10 digits, a US number), city/ZIP,
--                             what they have, roughly how many items, how they heard about us, the photos' storage
--                             paths, and the admin's status (new, contacted, offer_made, closed) and notes.
--                             RLS on, service_role only: contact details are never public.
--   storage bucket            'service-request-photos': PRIVATE (not the public item-images bucket). JPEG, PNG or
--                             WebP up to 5 MB each; the backend re-encodes every photo first (no EXIF/GPS). The admin
--                             sees them through signed links that last 10 minutes; deleting a request removes them.
--
-- Before this is applied: POST /service-requests answers 503 (code not_available) and the form shows the email
-- address instead; the admin's Requests page says the table isn't there yet. Nothing else changes.

begin;

create table if not exists public.service_requests (
  id          uuid primary key default gen_random_uuid(),
  service     text not null check (service in ('sell', 'consign', 'estates', 'collection_auction', 'general')),
  name        text not null check (char_length(name) between 1 and 120),
  email       text not null check (char_length(email) between 3 and 254),
  phone       text not null check (phone ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$'),
  location    text check (char_length(location) <= 120),
  details     text not null check (char_length(details) between 1 and 4000),
  item_count  text check (item_count in ('1', '2-10', '11-25', '26-100', '100+')),
  heard_from  text check (char_length(heard_from) <= 200),
  photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 10),
  status      text not null default 'new' check (status in ('new', 'contacted', 'offer_made', 'closed')),
  notes       text check (char_length(notes) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists service_requests_created_idx on public.service_requests (created_at desc);
create index if not exists service_requests_new_idx on public.service_requests (status) where status = 'new';

alter table public.service_requests enable row level security;
revoke all on public.service_requests from anon, authenticated;
grant all on public.service_requests to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('service-request-photos', 'service-request-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

do $$
declare bad text;
begin
  if not exists (select 1 from pg_class where oid = 'public.service_requests'::regclass and relrowsecurity) then
    raise exception 'STOP: service_requests has RLS off';
  end if;
  if has_table_privilege('anon', 'public.service_requests', 'SELECT') or has_table_privilege('authenticated', 'public.service_requests', 'SELECT')
     or has_table_privilege('anon', 'public.service_requests', 'INSERT') or has_table_privilege('authenticated', 'public.service_requests', 'INSERT') then
    raise exception 'STOP: anon/authenticated can still read or write service_requests';
  end if;
  select string_agg(id, ', ') into bad from storage.buckets where id = 'service-request-photos' and public;
  if bad is not null or not exists (select 1 from storage.buckets where id = 'service-request-photos') then
    raise exception 'STOP: the service-request-photos bucket is missing or public';
  end if;
  raise notice 'OK: service_requests (RLS on, service_role only); service-request-photos bucket private';
end $$;

commit;
