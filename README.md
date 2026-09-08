# Album Randomizer

An HTML version of `AlbumRandomizer.xlsx` — the daily ~8 hour Spotify playlist builder.

Open `index.html` in a browser. No build step, no server, no dependencies.

## The daily loop

1. **Today** opens with one random unplayed album drawn from each genre, in the
   spreadsheet's column order, starting at the genre after the one the last day
   ended on.
2. It keeps drawing — looping back around the genre list — until the plan reaches
   the 8 hour target.
3. Hit **Spotify ↗** on a card to search for the album, add it to the playlist,
   then hit **Add** on the card. Not feeling it? **↻** draws a different album
   from that genre, or open **alternates** and pick one of the four runners‑up.
4. **Finish day** moves everything you added to the Played tab and parks the
   rotation on the genre after the last one you used, ready for tomorrow.

Album lengths decide how many albums a day needs. Connect Spotify (below) to get
real ones; otherwise everything is assumed to be 45 minutes. Either way you can
type over any card's `min` box — the value sticks to that album for good, and the
day tops itself up if the change leaves you short of the target.

The Favorites column comes through as a star on the album plus one bonus draw at
the end of the day, outside the rotation. Turn it off in Settings.

## Where the links open

**Spotify ↗** on a card, and the **↗** on every library and played row, open the
desktop app rather than the web player. They use `spotify:` links — a direct
`spotify:album:…` where the album has been matched, a `spotify:search:…` where it
has not. Your browser asks permission the first time and can remember the answer.

Turn **Open Spotify in the app** off in Settings to go back to `open.spotify.com`
in a new tab. Nothing else changes: the same album is on the other end either way.

## Release years and scores

Every album carries a **release year** and a **RateYourMusic score**. Both show
in the library and on the day's cards, and both are entered by hand.

The library is ordered by artist, then by year within that artist, so a band
reads as a chronology rather than an alphabet. Albums with no year yet sit at the
end of their artist's run instead of scattering through it.

A leading "The" is ignored when filing, so The Black Keys sit between Black Flag
and Black Label Society, the way a record shop would rack them. The name still
displays in full — only the sort key changes — and it takes a following space, so
Them Crooked Vultures and Thelonious Monk are left alone. The played list files
the same way.

Neither field is ever written by Spotify. Release dates were tried and dropped:
Spotify dates the *pressing*, not the work, so a 1981 album comes back as 2022 if
that is the edition it matched. Right often enough to look trustworthy, wrong
often enough not to be — and a wrong year is worse than a blank one, because a
blank shows up in the **No release year** filter as work still to do.

Scores have no API to read them from either, so the two get typed together. The
boxes on a Today card are the natural moment: finish the album, fill both in.
Years accept 1900-2100; scores accept 0 to 5 and round to two decimals, so a raw
RateYourMusic average can be pasted straight in. Library → **No RYM score** and
**No release year** list whatever is still blank.

The review list still shows each candidate release's year, which is often the
quickest way to tell an original from a reissue when picking between them.

## Sync

One library across every device. The app keeps it as a single JSON file in a
GitHub repository, pulls it when it opens and when the tab regains focus, and
pushes a few seconds after you stop editing.

### Setting it up

1. Make a repository for the data. It can be private; the app reaches it by
   token rather than by being served.
2. Create a **fine-grained personal access token** at
   *Settings → Developer settings → Personal access tokens → Fine-grained*:
   scope it to **only that repository**, and grant **Contents: read and write**
   and nothing else.
3. In the app, **Settings → Sync**: fill in owner, repository, file and branch,
   paste the token, name the device, and press **Save & connect**.

The first device to connect finds no file and uploads what it has. Every device
after that pulls that copy and adopts it.

### What travels, and what does not

The file carries the library, genres and their colours, the rotation, the day in
progress, and the settings that describe the collection — target length, assumed
album length, the favourites draw.

It deliberately does **not** carry your Spotify credentials, the sync token, the
theme or the sidebar state. Those stay on each device, which means no secret of
yours is ever written to GitHub.

### When two devices disagree

Every write says which version it is replacing. If another device saved since
this one last looked, GitHub refuses the write rather than letting it overwrite,
and the status line reads **Conflict**. Two ways out:

- **Pull now** takes the other device's copy and discards local changes.
- **Overwrite repo copy** does the opposite, after asking.

Nothing is merged automatically. Silently combining two libraries is how records
go missing without anyone noticing.

### Notes

Files over 1 MB come back from the contents endpoint without their content, so
reads fall through to the blob endpoint, which has no such limit. Closing the tab
with a save still queued will ask before leaving — a queued push cannot be
completed during unload, so pretending otherwise would lose the edit.

## Connecting Spotify

Optional, but it turns the 8 hour target from an estimate into a real number, and
makes each card link straight to the album instead of a search.

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and **Create app**. Name it anything. The redirect URI is required by the form
   but never used here — `http://127.0.0.1:8777/` is fine.
2. Open the app's settings and copy the **Client ID** and **Client secret**.
3. Paste both into **Settings → Album lengths**, hit **Save & test**, then
   **Look up album lengths**.

Budget 15-20 minutes for the whole library. It is paced deliberately slowly:
Spotify counts calls in a rolling 30 second window and a development-mode app's
allowance is small, so the lookup holds a steady gap between calls and slows
itself further if Spotify pushes back.

You can stop it and resume later — it only looks at albums it hasn't resolved
yet, and progress is written every 10 albums.

If you do get rate-limited, the run stops and says so. Wait 15-30 minutes and
press **Look up album lengths** again; nothing already found is lost. (A browser
cannot read Spotify's `Retry-After` header — it isn't CORS-exposed — so the wait
is a deliberate fixed backoff rather than the value Spotify suggests.)

This uses the client-credentials flow, which reads the public catalogue and
nothing else: it cannot see or change your account, playlists or listening
history, and there is no login or redirect. The secret is stored in this
browser's `localStorage` in plain text, so treat it like any other local
credential — **Forget credentials** removes it, and you can rotate it from the
dashboard at any time.

### When Spotify says no

Spotify has been progressively withdrawing catalogue endpoints from
client-credentials tokens, and which ones a development-mode app may use varies.
**Check API access** in Settings probes each endpoint and reports exactly what
your app is allowed to touch.

The lookup adapts rather than failing. It tries three routes in order and drops
to the next one the first time Spotify refuses:

1. **Album details in batches of 20** — fastest, one call per 20 albums.
2. **One tracklist per album** — still exact, just slower.
3. **Track count times four minutes** — an estimate, used only when both exact
   routes are denied.

It only pays the cost of discovering a refusal once per run, then sticks with
whatever works. Estimated lengths show as `~44m` in amber, in both the library
and on the cards, so an approximation never reads as a measured fact. Hover any
length to see where it came from.

### Matches it isn't sure about

Albums resolve into three buckets:

- **Matched** — the title and artist line up exactly. Length applied, nothing to do.
- **Needs review** — only an edition variant was found (a Deluxe, a live record,
  a remaster). Library → **Needs review** lists them with the candidates Spotify
  returned, each labelled with why it's doubtful and how many tracks it has.
  One click picks one; **None of these** dismisses it.
- **Not found** — nothing plausible. Left on the 45 minute estimate; you can type
  a length in by hand.

The matcher deliberately prefers the plain title over a Deluxe or Anniversary
edition with the same name, and treats a shorter tracklist as the original when
two releases otherwise look identical — which lines up with skipping the bonus
cuts anyway.

## Tabs

| | |
|---|---|
| **Today** | Build the day's playlist. |
| **Library** | Every album with its year, score and running time, ordered by artist then release year. Search, filter by genre, star favorites, add and edit albums, resolve uncertain Spotify matches, mark things played or unplayed by hand. |
| **Played** | Everything you've listened to, grouped by day. **↺** puts an album back in the pool. |
| **Settings** | Target length, assumed album length, genre rotation, Spotify connection, whether links open the app or the web player, backup and restore. |

## Exporting a CSV

**Export CSV** in the library toolbar writes out whatever you are currently
looking at. If any albums are ticked it exports those; otherwise it exports
everything the search, genre and status filters match. The button says which,
and how many, before you press it.

Columns are Artist, Album, Genre, Year, RYM, Runtime, Favorite, Played and
Played On — the same headings the bulk importer recognises, so a sheet can be
exported, edited and fed back in. Rows come out in the library's own order:
artist, then year.

Written as UTF-8 with a byte-order mark, so Excel opens it without mangling
accents, and quoted per RFC 4180 so commas and quote marks in titles survive.

## Editing in bulk

Every library row has a tick box. Select some albums and a bar appears with the
actions that apply to all of them: **move to a genre**, favorite, unfavorite,
mark played or unplayed, and delete.

- **Select all** takes everything matching the current filter, not just the rows
  on screen — filter to a genre and one click selects all of them.
- **Shift-click** extends the selection from the last tick, for grabbing a run.
- The selection **survives changing the search**, so it can be built up in
  passes: search one artist, tick them, search the next, tick those, then apply
  once.

This is the fast way to split a genre up: filter to it, select all, move them
across, then refine from there.

## Adding and editing albums

**+ Add album** takes artist, album, genre and an optional runtime as separate
fields. Leave the artist blank for compilations that have no meaningful one
("Traveling Wilburys Collection"); leave the runtime blank and the next Spotify
lookup will fill it in.

The **✎** on any row edits that album in place — artist, album, genre and
runtime. A few notes on what editing does:

- The album's internal id never changes, so a rename cannot break today's picks,
  your played history, or anything else pointing at it.
- A runtime you type is treated as authoritative and is left alone by lookups.
  Clear the field and the album becomes eligible again on the next run.
- Renaming does not discard an existing Spotify match, on the assumption that
  most edits are typo fixes. If a rename makes the match genuinely wrong, clear
  the runtime and re-run the lookup.
- Two albums cannot end up with the same artist and title.

## Bulk import

**Settings → Bulk import** adds albums from a spreadsheet. Reads `.xlsx` and
`.csv` directly — no conversion, no upload, nothing leaves the browser.

Two layouts are recognised automatically:

- **A table with headings** — any of *Artist*, *Album*, *Genre*, *Runtime*,
  *Favorite*, in any column order. Synonyms work (*Title*, *Length*, *Duration*,
  *Band*…). Runtime accepts `41`, `41:12`, `1:02:30`, or a cell formatted as a
  time.
- **One genre per column** — the original spreadsheet's shape, with genre names
  in the first row and `Artist - Album` beneath.

If the workbook has several sheets it picks the one with the most content and
lets you switch. You get a preview — how it read the file, how many albums are
new, how many you already have — and nothing is added until you confirm.
Duplicates are matched on artist and album and skipped. A genre the library
doesn't have yet is added to the rotation.

## Genres

The rotation is the genre list in **Settings → Genres**, in order. Sixteen at
present: the spreadsheet's original ten, then six added by hand for splitting
Metal up — Juggernaut, Mechanized, Nightfall, Omen of the Deep, Onslaught,
Vortex.

A genre with nothing left to draw is skipped, so an empty one costs nothing:
it simply sits in the rotation until albums are moved into it, then starts
getting picked. Reassign an album with the **✎** button on its library row.

Drag a genre by its handle to change the rotation order, or use the arrows.
Reordering is safe mid-day: the "next up" pointer and every card already drawn
are re-anchored by name, so nothing you have picked is disturbed. Each genre also
keeps its own colour permanently rather than deriving it from list position.

**✕** deletes a genre. An empty one goes straight away; one holding albums asks
where those albums should go first, because an album left pointing at a genre
that no longer exists would quietly stop being drawn. Cards in an open day follow
their album to the new genre. A deleted genre stays deleted — adding it back by
name restores it, along with its original colour.

## Data

Without sync configured, state lives in the browser's `localStorage`, so it is
tied to that browser and to how the page is opened — `file://` and
`http://localhost` are separate origins with separate storage. With sync
configured that stops mattering: local storage becomes a cache and the GitHub
copy is the record.

**Settings → Export JSON** writes a full backup (library, played history, looked-up
lengths, settings, the day in progress); **Import JSON** restores it. Worth doing
occasionally — clearing site data wipes everything otherwise. Note the export
includes your Spotify credentials, so treat the file as a secret.

## Files

| | |
|---|---|
| `index.html` | Markup. |
| `styles.css` | Styles, dark and light. |
| `app.js` | All the logic. |
| `albums.js` | The seeded library, generated from the spreadsheet. |
| `sheet-import.js` | Dependency-free `.xlsx` / `.csv` reader for bulk import. |

`albums.js` only seeds a library that doesn't exist yet. Adding albums to it
later tops up an existing library on next load — anything you deleted in the app
stays deleted, and your played history is untouched.

To start completely over from the spreadsheet, use **Settings → Reset to
spreadsheet**.
