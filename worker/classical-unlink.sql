-- The per-work classical playlists are gone from Spotify, so the ids and names
-- pointing at them are dead weight on 612 records.
--
-- Run once in the Neon SQL editor. Close the app first, or refresh it after, so
-- no browser pushes its older copy back over this.
--
-- What stays is what plays: each work keeps its track ids and its runtime, which
-- is what the day is built from and what goes to 01. Today.

update randomizer.albums
   set doc = doc - 'playlistId' - 'playlistName',
       updated_at = now()
 where doc->>'mode' = 'classical'
   and (doc ? 'playlistId' or doc ? 'playlistName');

-- Every device decides what to pull by this number, so it has to move or the
-- change sits here unnoticed.
update randomizer.state
   set version = version + 1, device = 'sql: classical unlink', updated_at = now()
 where id = true;

-- Check: 612 works, none carrying a playlist, all still carrying their tracks.
select count(*)                                            as classical,
       count(*) filter (where doc ? 'playlistId')          as still_linked,
       count(*) filter (where jsonb_array_length(coalesce(doc->'trackIds', '[]'::jsonb)) > 0) as with_tracks
  from randomizer.albums
 where doc->>'mode' = 'classical';
