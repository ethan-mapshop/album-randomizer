-- Genre hours: what played, and when.
--
-- Run once in the Neon SQL editor. Safe to run again — it changes nothing that
-- already exists.
--
-- These are tracks from the genre playlists, not albums, so they do not belong
-- in randomizer.albums. A row per track, replaced each time that track plays:
-- the app only ever asks how long ago a track last came up, so one row per
-- track is all it needs, and the table can never outgrow the playlists.

create table if not exists randomizer.track_plays (
  id        text primary key,           -- Spotify track id
  genre     text not null,              -- the hour it played in
  artist    text,
  title     text,
  played_at timestamptz not null default now()
);

grant select, insert, update, delete on randomizer.track_plays to album_app;

-- Check: should return the table with no rows.
select * from randomizer.track_plays;
