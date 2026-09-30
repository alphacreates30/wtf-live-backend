-- STEP v: photo thumbnails (F1a). APPLIED on production by Cowork 2026-09-29 (SQL editor): rls_on=true,
-- anon/authenticated no select/insert, service_role insert.
-- Idempotent. Applied and verified on wtf-test 2026-09-30 (RLS on; anon/authenticated have no privileges;
-- verification/thumbnails.js green; scripts/backfill-thumbs.js run there on 8 photos).
--
--   image_thumbs   one row per stored photo that has a small version: the full photo's public URL -> the thumbnail's
--                  public URL (about 480px wide WebP, no metadata, stored in the same item-images bucket under
--                  <folder>/thumbs/). Written by POST /upload-image for every new photo, and by
--                  scripts/backfill-thumbs.js for photos uploaded before thumbnails existed.
--                  Cards, rails, search results and the homepage collage show the thumbnail; the lot page keeps the
--                  full photo. No row = no thumbnail yet, and the site falls back to the full photo.
--
-- Kept as its own table rather than a column on auction_items / item_images / auctions: every photo reaches the
-- site through one upload route, so the thumbnail is recorded once there and no write path that stores a photo URL
-- (bulk create, add lot, replace photo, gallery, auction cover) has to change.
-- RLS on, service_role only (like migrations p, t and u).
--
-- Before this is applied, uploads still work (full photo only, thumb_url null) and every thumb_url in the API is
-- null, so the site shows full photos exactly as before.

begin;

create table if not exists public.image_thumbs (
  url text primary key,
  thumb_url text not null,
  created_at timestamptz not null default now()
);
alter table public.image_thumbs enable row level security;
revoke all on public.image_thumbs from anon, authenticated;
grant all on public.image_thumbs to service_role;

-- Check: RLS on, no anon/authenticated grants.
do $$
declare bad text;
begin
  select c.relname into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'image_thumbs'
     and (not c.relrowsecurity
          or has_table_privilege('anon', c.oid, 'select,insert,update,delete')
          or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'));
  if bad is not null then raise exception 'STOP: RLS/grants wrong on %', bad; end if;
end $$;

commit;
