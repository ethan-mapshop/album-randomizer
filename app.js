/* Album Randomizer — daily playlist builder.
 *
 * Mirrors the spreadsheet it replaces: one random unplayed album per genre,
 * walked in a fixed rotation that picks up where the previous day stopped, and
 * looped around until the day reaches its target running time. Everything is
 * kept in localStorage; albums.js only seeds a fresh library.
 */
(function () {
  'use strict';

  var KEY = 'albumRandomizer.v1';
  var LIB_LIMIT = 250;
  var ALT_COUNT = 4;
  var BONUS = -1; // genreIndex for the off-rotation Favorites pick

  var state = null;
  var libLimit = LIB_LIMIT;
  var editingId = null;   // library row currently open for editing
  var selected = {};      // library ids ticked for a bulk action
  var lastPicked = null;  // anchor for shift-click range selection
  var deletingGenre = null; // genre row asking where its albums should go
  var genreFilter = '';   // sidebar genre selection, shared by Library and Played

  /* ───────────────────────────── state ───────────────────────────── */

  function defaults() {
    return {
      version: 1,
      genres: SEED.genres.slice(),
      library: [],
      deletedSeedIds: [],
      deletedGenres: [],
      rotation: 0,
      session: null,
      spotify: { clientId: '', clientSecret: '', token: null, tokenExp: 0 },
      // Never included in the synced file: it is this device's key to it.
      sync: {
        owner: '', repo: '', branch: 'main', path: 'library.json',
        token: '', sha: null, remoteAt: null, lastPush: 0, device: ''
      },
      genreHues: SEED.genreHues ? JSON.parse(JSON.stringify(SEED.genreHues)) : null,
      settings: {
        targetMinutes: 480,
        defaultMinutes: 45,
        favoritesBonus: true,
        desktopLinks: true,
        lastAddGenre: '',
        sidebarCollapsed: false,
        theme: 'dark'
      }
    };
  }

  // albums.js stores the library compactly: flags are 1 rather than true, and
  // anything derivable from the Spotify id is left out and rebuilt here.
  function seedAlbum(s) {
    return {
      id: s.id,
      name: s.name,
      artist: s.artist || '',
      title: s.title || '',
      genre: s.genre,
      year: s.year || null,
      rym: s.rym === 0 || s.rym ? s.rym : null,
      minutes: s.minutes || null,
      tracks: s.tracks || null,
      fav: !!s.fav,
      played: !!s.played,
      playedAt: s.playedAt || null,
      custom: !!s.custom,
      approx: !!s.approx,
      spotifyId: s.sp || null,
      spotifyUrl: s.sp ? (s.spotifyUrl || 'https://open.spotify.com/album/' + s.sp) : null,
      matchName: s.sp ? (s.matchName || ((s.artist ? s.artist + ' - ' : '') + s.title)) : null,
      match: s.match || (s.sp ? 'auto' : null),
      candidates: null
    };
  }

  // Fields introduced after a library was first stored. Stamped onto every row
  // on load so the rest of the app can read them without an undefined check;
  // mergeSeed only ever adds whole albums, so it would never reach these.
  function backfill(st) {
    for (var i = 0; i < st.library.length; i++) {
      var a = st.library[i];
      if (a.year === undefined) a.year = null;
      if (a.rym === undefined) a.rym = null;
    }
  }

  // Adds any album in albums.js the stored library has not seen and the user
  // has not deleted, so refreshing the seed file tops up an existing library.
  function mergeSeed(st) {
    var known = {}, gone = {}, i, added = 0;
    for (i = 0; i < st.library.length; i++) known[st.library[i].id] = true;
    for (i = 0; i < st.deletedSeedIds.length; i++) gone[st.deletedSeedIds[i]] = true;
    for (i = 0; i < SEED.albums.length; i++) {
      var s = SEED.albums[i];
      if (known[s.id] || gone[s.id]) continue;
      st.library.push(seedAlbum(s));
      added++;
    }
    var dropped = st.deletedGenres || [];
    for (i = 0; i < SEED.genres.length; i++) {
      var g = SEED.genres[i];
      if (st.genres.indexOf(g) === -1 && dropped.indexOf(g) === -1) st.genres.push(g);
    }
    return added;
  }

  function load() {
    var st = defaults();
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    if (raw) {
      try {
        var saved = JSON.parse(raw);
        if (saved && saved.library) {
          st.genres = saved.genres && saved.genres.length ? saved.genres : st.genres;
          st.library = saved.library;
          st.deletedSeedIds = saved.deletedSeedIds || [];
          st.deletedGenres = saved.deletedGenres || [];
          st.genreHues = saved.genreHues || SEED.genreHues || null;
          st.rotation = saved.rotation || 0;
          st.session = saved.session || null;
          if (saved.sync) {
            for (var yk in st.sync) {
              if (saved.sync[yk] !== undefined) st.sync[yk] = saved.sync[yk];
            }
          }
          if (saved.spotify) {
            for (var sk in st.spotify) {
              if (saved.spotify[sk] !== undefined) st.spotify[sk] = saved.spotify[sk];
            }
          }
          if (saved.settings) {
            for (var k in st.settings) {
              if (saved.settings[k] !== undefined) st.settings[k] = saved.settings[k];
            }
          }
        }
      } catch (e) { /* corrupt payload — fall back to a fresh library */ }
    }
    if (!st.sync.device) st.sync.device = guessDeviceName();
    mergeSeed(st);
    backfill(st);
    if (st.rotation >= st.genres.length) st.rotation = 0;
    state = st;      // ensureHues reads through state
    ensureHues();
    return st;
  }

  // A device name that reads as a place rather than an id, so a commit list
  // says where an edit came from.
  function guessDeviceName() {
    var ua = navigator.userAgent || '';
    var os = /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Mac OS X/i.test(ua) ? 'Mac'
      : /Windows/i.test(ua) ? 'Windows'
      : /Linux/i.test(ua) ? 'Linux' : 'browser';
    var browser = /Edg\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : '';
    return (browser ? browser + ' on ' : '') + os;
  }

  // quiet saves come from the sync layer itself and must not re-arm the
  // push timer, or a pull would bounce straight back as a push.
  function save(quiet) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — local storage is full or blocked.'); }
    if (!quiet) syncSoon();
  }

  /* ──────────────────────────── helpers ──────────────────────────── */

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // A genre keeps its colour for good. Deriving it from list position meant
  // reordering the rotation recoloured half the library.
  function ensureHues() {
    if (!state.genreHues) state.genreHues = {};
    var used = Object.keys(state.genreHues).length;
    state.genres.forEach(function (g) {
      if (state.genreHues[g] === undefined) {
        state.genreHues[g] = (15 + used * 37) % 360;
        used++;
      }
    });
  }

  function hue(genre) {
    if (state.genreHues && state.genreHues[genre] !== undefined) return state.genreHues[genre];
    return 15;
  }

  function fmt(mins) {
    mins = Math.round(mins);
    var h = Math.floor(mins / 60), m = mins % 60;
    if (!h) return m + 'm';
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function longDate(iso) {
    var p = iso.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function shortDate(iso) {
    var p = iso.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function spotifyUrl(name) {
    return 'https://open.spotify.com/search/' + encodeURIComponent(name) + '/albums';
  }

  // The desktop app registers the spotify: scheme; open.spotify.com sends the
  // same target to the web player. The album id is the durable half of a stored
  // link, so a URI can be rebuilt whichever field survived.
  function spotifyUri(album) {
    var id = album.spotifyId ||
      (String(album.spotifyUrl || '').match(/\/album\/([A-Za-z0-9]+)/) || [])[1];
    return id ? 'spotify:album:' + id : 'spotify:search:' + encodeURIComponent(album.name);
  }

  // Both attributes together: a custom scheme hands off to the OS and strands an
  // empty tab when opened with target=_blank, so only web links get one.
  function spotifyLink(album) {
    var href = state.settings.desktopLinks
      ? spotifyUri(album)
      : (album.spotifyUrl || spotifyUrl(album.name));
    return 'href="' + esc(href) + '"' +
      (href.indexOf('spotify:') === 0 ? '' : ' target="_blank" rel="noopener"');
  }

  function byId(id) {
    for (var i = 0; i < state.library.length; i++) {
      if (state.library[i].id === id) return state.library[i];
    }
    return null;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = el('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? okMsg : 'Copy failed — your browser blocked it.');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else {
      fallback();
    }
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function pickRandom(pool, n) {
    var copy = pool.slice(), out = [];
    while (out.length < n && copy.length) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }

  /* ──────────────────────────── spotify ────────────────────────────
   * Client-credentials flow: a catalogue-only token, no user scope, no
   * redirect. Used to resolve each album to a specific Spotify release and
   * read its real running time.
   */

  var BASE_PACE = 700;      // ms between any two catalogue calls
  var MAX_PACE = 4000;      // ceiling once Spotify has pushed back
  // Retry-After is not CORS-exposed, so a browser cannot read it. These are
  // deliberate long waits rather than guesses at a header we cannot see.
  var RATE_WAITS = [30000, 60000, 120000, 240000];
  var SEARCH_LIMIT = 10;    // /v1/search caps limit at 10; anything higher is a 400
  var ALBUM_BATCH = 20;     // /v1/albums accepts at most 20 ids per call
  var AUTO_AT = 0.9;        // score at or above this is accepted without asking
  var MAYBE_AT = 0.5;       // below this we call it a miss rather than guess
  var stopLookup = false;
  var lookupBusy = false;   // one run at a time, whichever view started it

  // Abortable, so Stop still works during a long rate-limit wait.
  function sleep(ms) {
    return new Promise(function (done) {
      var until = Date.now() + ms;
      (function tick() {
        if (stopLookup || Date.now() >= until) return done();
        setTimeout(tick, Math.min(250, until - Date.now()));
      })();
    });
  }

  // Spotify counts calls in a rolling 30s window and a development-mode app's
  // allowance is small, so every call goes through one global throttle rather
  // than sprinkling sleeps through the callers. It slows itself on a 429.
  var paceMs = BASE_PACE;
  var nextSlot = 0;

  function throttle() {
    var now = Date.now();
    var at = Math.max(now, nextSlot);
    nextSlot = at + paceMs;
    return sleep(at - now);
  }

  function slowDown() {
    paceMs = Math.min(MAX_PACE, Math.round(paceMs * 1.8));
  }

  function showWait(msg) {
    var log = document.getElementById('sp-log');
    if (log) log.textContent = msg;
  }

  function spConfigured() {
    return !!(state.spotify.clientId && state.spotify.clientSecret);
  }

  function spToken(force) {
    var sp = state.spotify;
    if (!force && sp.token && sp.tokenExp > Date.now() + 30000) return Promise.resolve(sp.token);
    return fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(sp.clientId + ':' + sp.clientSecret)
      },
      body: 'grant_type=client_credentials'
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error_description || j.error || ('auth failed (' + r.status + ')'));
        sp.token = j.access_token;
        sp.tokenExp = Date.now() + ((j.expires_in || 3600) * 1000);
        save();
        return sp.token;
      });
    });
  }

  // Transient on Spotify's side: worth waiting out rather than failing the run.
  var RETRY_STATUS = { 500: 1, 502: 1, 503: 1, 504: 1 };
  var MAX_ATTEMPTS = 4;

  function backoff(attempt) {
    return Math.min(8000, 800 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
  }

  function spGet(path, attempt, forceToken) {
    attempt = attempt || 0;
    var url = 'https://api.spotify.com/v1' + path;

    function again(wait, refresh) {
      return sleep(wait).then(function () { return spGet(path, attempt + 1, refresh); });
    }

    return throttle().then(function () {
      return spToken(!!forceToken);
    }).then(function (tok) {
      return fetch(url, { headers: { Authorization: 'Bearer ' + tok } }).then(function (r) {
        if (r.status === 401 && attempt < MAX_ATTEMPTS) return again(0, true);

        if (r.status === 429) {
          slowDown();
          if (attempt >= RATE_WAITS.length) {
            throw new Error('RATE_LIMIT');
          }
          var wait = RATE_WAITS[attempt];
          showWait('Rate-limited by Spotify — waiting ' + Math.round(wait / 1000) +
            's before trying again. Progress is saved.');
          return again(wait, false);
        }

        if (RETRY_STATUS[r.status] && attempt < MAX_ATTEMPTS) {
          return again(backoff(attempt), false);
        }
        if (!r.ok) {
          // Spotify explains every rejection in the body; surfacing it is the
          // difference between a bare "400" and knowing what to fix.
          return r.text().then(function (body) {
            var detail = '';
            try {
              var j = JSON.parse(body);
              detail = (j.error && (j.error.message || j.error)) || '';
            } catch (ignored) {
              detail = body.slice(0, 140);
            }
            console.warn('[album-randomizer] ' + r.status + ' ' + url, body.slice(0, 400));
            throw new Error('Spotify ' + r.status + (detail ? ': ' + detail : ''));
          });
        }
        return r.json();
      }, function (netErr) {
        // The request never landed — dropped connection, DNS, offline.
        if (attempt < MAX_ATTEMPTS) return again(backoff(attempt), false);
        throw new Error('Could not reach Spotify: ' + (netErr.message || netErr));
      });
    });
  }

  function norm(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // How a title suffix changes what you would actually hear.
  var SUFFIX_SAME = /^(\d{4} )?(remaster|remastered|reissue|mono|stereo|the remaster|remastered version|original recording remastered)\b/;
  var SUFFIX_MORE = /(deluxe|expanded|bonus|anniversar|super|legacy|collector|complete|special|edition)/;
  var SUFFIX_DIFF = /(live|acoustic|demo|karaoke|tribute|instrumental|in the style of|re ?record|orchestral|symphon|cover)/;

  function artistsOf(item) {
    return (item.artists || []).map(function (a) { return a.name; }).join(', ');
  }

  function scoreAlbum(target, cand) {
    var ta = norm(target.artist), tt = norm(target.title || target.name);
    var names = (cand.artists || []).map(function (a) { return norm(a.name); });
    var artist;
    if (!ta) artist = 0.6;
    else if (names.indexOf(ta) > -1) artist = 1;
    else if (names.some(function (n) { return n && (n.indexOf(ta) > -1 || ta.indexOf(n) > -1); })) artist = 0.8;
    else artist = 0;

    var cn = norm(cand.name), title, kind;
    if (cn === tt) { title = 1; kind = 'exact'; }
    else if (cn.indexOf(tt + ' ') === 0) {
      var suffix = cn.slice(tt.length).trim();
      if (SUFFIX_DIFF.test(suffix)) { title = 0.3; kind = 'other recording'; }
      else if (SUFFIX_MORE.test(suffix)) { title = 0.62; kind = 'extra tracks'; }
      else if (SUFFIX_SAME.test(suffix)) { title = 0.93; kind = 'remaster'; }
      else { title = 0.5; kind = 'variant'; }
    } else if (cn.indexOf(tt) > -1) { title = 0.5; kind = 'variant'; }
    else {
      var want = tt.split(' ');
      var hit = cn.split(' ').filter(function (w) { return want.indexOf(w) > -1; }).length;
      title = (hit / Math.max(want.length, 1)) * 0.45;
      kind = 'loose';
    }

    var score = (artist * 0.4) + (title * 0.6);
    if (cand.album_type === 'single') score -= 0.15;
    return { score: Math.max(0, +score.toFixed(3)), kind: kind };
  }

  function bestMatch(album, items) {
    var ranked = items.map(function (it) {
      var s = scoreAlbum(album, it);
      return { item: it, score: s.score, kind: s.kind };
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      // Same-looking releases: the shorter one is the original, not the deluxe.
      return (a.item.total_tracks || 99) - (b.item.total_tracks || 99);
    });
    return ranked;
  }

  function spSearch(album) {
    var quoted = function (s) { return String(s).replace(/["]/g, ' ').trim(); };
    var loose = quoted(album.name);
    var strict = album.artist
      ? 'album:"' + quoted(album.title) + '" artist:"' + quoted(album.artist) + '"'
      : loose;

    function run(q) {
      return spGet('/search?type=album&limit=' + SEARCH_LIMIT + '&q=' + encodeURIComponent(q))
        .then(function (j) { return (j.albums && j.albums.items) || []; });
    }

    if (strict === loose) return run(loose);
    return run(strict).catch(function (e) {
      // A query Spotify will not parse must not abort the whole run.
      if (String(e.message).indexOf('400') === -1) throw e;
      return run(loose);
    }).then(function (items) {
      // Field filters are strict; retry as loose text before giving up.
      return items.length ? items : run(loose);
    });
  }

  // Both queries, merged. spSearch stops as soon as the strict field query
  // returns anything at all, which is how "A Hero's Death" only ever offered a
  // Soulwax remix single: strict matched exactly one release, so the loose
  // retry that ranks the actual album first never ran. Worth the second call
  // here because the picker is a deliberate ask, not a bulk sweep.
  function spSearchAll(album) {
    var quoted = function (s) { return String(s).replace(/["]/g, ' ').trim(); };
    var loose = quoted(album.name);
    var strict = album.artist
      ? 'album:"' + quoted(album.title) + '" artist:"' + quoted(album.artist) + '"'
      : loose;
    function run(q) {
      return spGet('/search?type=album&limit=' + SEARCH_LIMIT + '&q=' + encodeURIComponent(q))
        .then(function (j) { return (j.albums && j.albums.items) || []; });
    }
    if (strict === loose) return run(loose);
    // A field query can 400 on odd punctuation; that must not lose the loose
    // results, but a rate limit on the loose call still has to surface.
    return Promise.all([run(strict).catch(function () { return []; }), run(loose)])
      .then(function (both) {
        var seen = {}, out = [];
        both[0].concat(both[1]).forEach(function (it) {
          if (it && !seen[it.id]) { seen[it.id] = true; out.push(it); }
        });
        return out;
      });
  }

  // Sums track durations. Albums over 50 tracks paginate, so page the rest.
  // Spotify is withdrawing metadata endpoints from client-credentials tokens,
  // and which ones an app may touch varies. Rather than fail, fall down a
  // ladder: exact batch -> exact per-album -> track-count estimate.
  var durationMode = 'batch';   // 'batch' | 'tracks' | 'estimate'
  var AVG_TRACK_MIN = 4;        // only used once both exact routes are refused

  function isForbidden(err) {
    var m = String(err && err.message);
    return m.indexOf('403') > -1 || m.indexOf('401') > -1;
  }

  // Probes each endpoint this app might use and reports what came back.
  function spProbe() {
    var id = '4m0jnlUGcgxFUjF7JfearQ';
    var checks = [
      { name: 'Search albums', path: '/search?type=album&limit=1&q=muse' },
      { name: 'Album details (batch)', path: '/albums?ids=' + id },
      { name: 'Album details (single)', path: '/albums/' + id },
      { name: 'Album tracklist', path: '/albums/' + id + '/tracks?limit=5' }
    ];
    return checks.reduce(function (chain, c) {
      return chain.then(function (acc) {
        return spGet(c.path).then(function () {
          acc.push({ name: c.name, ok: true, detail: 'OK' });
          return acc;
        }, function (err) {
          acc.push({ name: c.name, ok: false, detail: String(err.message).replace('Spotify ', '') });
          return acc;
        });
      });
    }, Promise.resolve([]));
  }

  // Exact running time for one album, without the multi-get endpoint.
  function spAlbumTracks(id) {
    var ms = 0, total = null;
    function page(offset) {
      return spGet('/albums/' + id + '/tracks?limit=50&offset=' + offset).then(function (j) {
        (j.items || []).forEach(function (t) { ms += t.duration_ms || 0; });
        if (total === null) total = j.total || (j.items || []).length;
        var seen = offset + ((j.items || []).length);
        if (j.items && j.items.length && seen < total) return page(seen);
        return { ms: ms, tracks: total, url: null };
      });
    }
    return page(0);
  }

  function spDurations(ids) {
    return spGet('/albums?ids=' + ids.join(',')).then(function (j) {
      var out = {}, extra = [];
      (j.albums || []).forEach(function (al) {
        if (!al) return;
        var items = (al.tracks && al.tracks.items) || [];
        var ms = items.reduce(function (t, x) { return t + (x.duration_ms || 0); }, 0);
        out[al.id] = {
          ms: ms,
          tracks: al.total_tracks,
          url: (al.external_urls && al.external_urls.spotify) || null
        };
        if (al.tracks && al.tracks.total > items.length) {
          extra.push({ id: al.id, offset: items.length, total: al.tracks.total });
        }
      });
      if (!extra.length) return out;
      return extra.reduce(function (chain, e) {
        return chain.then(function () {
          return spGet('/albums/' + e.id + '/tracks?limit=50&offset=' + e.offset).then(function (page) {
            (page.items || []).forEach(function (t) { out[e.id].ms += t.duration_ms || 0; });
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  // One album's running time, walking the same ladder a full run uses. Shared
  // so the review picker can never drift from what the run already learned.
  async function resolveOne(item) {
    if (durationMode === 'batch') {
      try {
        var map = await spDurations([item.id]);
        if (map[item.id]) return map[item.id];
        throw new Error('Spotify returned no tracks for that release');
      } catch (e) {
        if (!isForbidden(e)) throw e;
        durationMode = 'tracks';
      }
    }
    if (durationMode === 'tracks') {
      try {
        return await spAlbumTracks(item.id);
      } catch (e2) {
        if (!isForbidden(e2)) throw e2;
        durationMode = 'estimate';
      }
    }
    return estimateFrom(item);
  }

  // Spotify dates the pressing, not the work: reissues and remasters report the
  // year they were re-released. Good enough to sort by, wrong often enough that
  // the field stays editable and a year already on the album is never replaced.
  function applyMatch(album, item, info) {
    album.minutes = Math.round(info.ms / 60000);
    album.approx = !!info.approx;
    album.spotifyId = item.id;
    // The search result already carries a usable album link; the details call
    // only ever confirms it, so never downgrade to null when that call is denied.
    album.spotifyUrl = info.url || (item.external_urls && item.external_urls.spotify) || album.spotifyUrl || null;
    album.matchName = artistsOf(item) + ' - ' + item.name;
    album.tracks = info.tracks || item.total_tracks || null;
    album.candidates = null;
  }

  // Last resort when every exact route is refused: track count times a typical
  // track length. Flagged as approximate so the UI never presents it as fact.
  function estimateFrom(item) {
    var tracks = item.total_tracks || 0;
    return { ms: tracks * AVG_TRACK_MIN * 60000, tracks: tracks, url: null, approx: true };
  }

  function candidateRow(entry) {
    var it = entry.item;
    return {
      id: it.id,
      name: it.name,
      artist: artistsOf(it),
      tracks: it.total_tracks || 0,
      url: (it.external_urls && it.external_urls.spotify) || null,
      year: (it.release_date || '').slice(0, 4),
      kind: entry.kind,
      score: entry.score
    };
  }

  function needsLookup(a, retryMisses) {
    if (a.minutes) return false;
    if (a.match === 'review') return false;         // waiting on a human
    if (a.match === 'none' && !retryMisses) return false;
    return true;
  }

  // Walks the library, resolving one album per search call. Auto-matches are
  // batched 20 at a time for their durations; anything doubtful is parked for
  // review with its candidates rather than guessed at.
  async function runLookup(todo, onProgress) {
    var stats = { total: todo.length, done: 0, auto: 0, approx: 0, review: 0, none: 0, failed: 0, queued: 0, note: '' };
    var pending = [];
    var streak = 0; // consecutive failures — bail rather than grind through them all
    paceMs = BASE_PACE;
    nextSlot = 0;

    // Resolves durations for a queued batch, stepping down the strategy ladder
    // the first time Spotify refuses a route. Nothing is ever dropped: if the
    // exact routes are denied we still record an estimate.
    async function flush() {
      if (!pending.length) return;
      var batch = pending.splice(0, pending.length);

      if (durationMode === 'batch') {
        try {
          var map = await spDurations(batch.map(function (p) { return p.entry.item.id; }));
          batch.forEach(function (p) {
            var info = map[p.entry.item.id];
            if (info) { applyMatch(p.album, p.entry.item, info); p.album.match = 'auto'; stats.auto++; }
            else { p.album.match = 'none'; stats.none++; }
          });
          save();
          return;
        } catch (e) {
          if (String(e.message) === 'RATE_LIMIT') { pending = batch; throw e; }
          if (!isForbidden(e)) {
            batch.forEach(function (p) { p.album.match = null; stats.failed++; });
            save();
            return;
          }
          durationMode = 'tracks';
          stats.note = 'album details refused — reading tracklists instead';
        }
      }

      if (durationMode === 'tracks') {
        for (var i = 0; i < batch.length; i++) {
          if (durationMode !== 'tracks') break;
          try {
            var info2 = await spAlbumTracks(batch[i].entry.item.id);
            applyMatch(batch[i].album, batch[i].entry.item, info2);
            batch[i].album.match = 'auto';
            stats.auto++;
            batch[i].done = true;
          } catch (e2) {
            if (String(e2.message) === 'RATE_LIMIT') { save(); throw e2; }
            if (isForbidden(e2)) {
              durationMode = 'estimate';
              stats.note = 'tracklists refused too — estimating from track counts';
              break;
            }
            batch[i].album.match = null;
            batch[i].done = true;
            stats.failed++;
          }
        }
      }

      if (durationMode === 'estimate') {
        batch.forEach(function (p) {
          if (p.done) return;
          applyMatch(p.album, p.entry.item, estimateFrom(p.entry.item));
          p.album.match = 'auto';
          stats.approx++;
        });
      }
      save();
    }

    for (var i = 0; i < todo.length; i++) {
      if (stopLookup) break;
      var album = todo[i];
      try {
        var ranked = bestMatch(album, await spSearch(album));
        var top = ranked[0];
        if (!top || top.score < MAYBE_AT) {
          album.match = 'none';
          album.candidates = ranked.slice(0, 5).map(candidateRow);
          stats.none++;
        } else if (top.score >= AUTO_AT) {
          pending.push({ album: album, entry: top });
          if (pending.length >= ALBUM_BATCH) await flush();
        } else {
          album.match = 'review';
          album.candidates = ranked.slice(0, 5).map(candidateRow);
          stats.review++;
        }
        streak = 0;
      } catch (e) {
        if (String(e.message) === 'RATE_LIMIT') {
          stats.fatal = 'Spotify is rate-limiting this app. Everything found so far is saved — ' +
            'wait about 15 minutes, then press Look up again to carry on.';
          stats.rateLimited = true;
          break;
        }
        stats.failed++;
        if (++streak >= 5) {
          stats.fatal = e.message || String(e);
          break;
        }
      }
      stats.done++;
      stats.queued = pending.length;
      onProgress(stats, album);
      if (stats.done % 10 === 0) save(); // survive a closed tab mid-run
    }
    await flush();
    save();
    return stats;
  }


  /* ─────────────────────────── github sync ───────────────────────────
   * The library lives as one JSON file in a GitHub repo. Every device pulls it
   * on load and on focus, and pushes a debounced snapshot after changes. Writes
   * carry the blob SHA they were based on, so a second device cannot silently
   * overwrite the first — GitHub rejects the write and we surface the clash.
   *
   * Credentials and per-device preferences deliberately stay out of the file,
   * which keeps secrets off GitHub entirely.
   */

  var SYNC_DEBOUNCE = 4000;     // quiet period after the last edit before pushing
  var SYNC_SETTINGS = ['targetMinutes', 'defaultMinutes', 'favoritesBonus',
                       'desktopLinks', 'lastAddGenre'];
  var syncTimer = null;
  var syncBusy = false;
  var syncState = 'idle';       // idle | pulling | pushing | conflict | error | off
  var syncNote = '';

  function syncConfigured() {
    var s = state.sync;
    return !!(s && s.owner && s.repo && s.token);
  }

  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + state.sync.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function ghUrl(extra) {
    var s = state.sync;
    return 'https://api.github.com/repos/' + encodeURIComponent(s.owner) + '/' +
      encodeURIComponent(s.repo) + '/contents/' +
      s.path.split('/').map(encodeURIComponent).join('/') +
      (extra || '');
  }

  // btoa cannot take UTF-8 directly, and spreading a megabyte of bytes into
  // fromCharCode overflows the stack, so both directions go in chunks.
  function toBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var out = '', step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(out);
  }

  function fromBase64(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function ghFetch(url, options) {
    return fetch(url, options).then(function (r) {
      if (r.status === 404) return { missing: true, status: 404 };
      return r.json().then(function (body) {
        if (!r.ok) {
          var msg = (body && body.message) || ('GitHub ' + r.status);
          var err = new Error(msg);
          err.status = r.status;
          throw err;
        }
        return body;
      }, function () {
        var err = new Error('GitHub ' + r.status);
        err.status = r.status;
        throw err;
      });
    });
  }

  /* ---- what actually travels ---- */

  function packAlbum(a) {
    var o = { id: a.id, name: a.name, artist: a.artist || '', title: a.title || '', genre: a.genre };
    if (a.year) o.year = a.year;
    if (a.rym || a.rym === 0) o.rym = a.rym;
    if (a.minutes) o.minutes = a.minutes;
    if (a.tracks) o.tracks = a.tracks;
    if (a.fav) o.fav = 1;
    if (a.played) { o.played = 1; if (a.playedAt) o.playedAt = a.playedAt; }
    if (a.custom) o.custom = 1;
    if (a.approx) o.approx = 1;
    if (a.match && a.match !== 'auto') o.match = a.match;
    if (a.spotifyId) {
      o.sp = a.spotifyId;
      if (a.spotifyUrl && a.spotifyUrl !== 'https://open.spotify.com/album/' + a.spotifyId) {
        o.spotifyUrl = a.spotifyUrl;
      }
      if (a.matchName && a.matchName !== ((a.artist ? a.artist + ' - ' : '') + a.title)) {
        o.matchName = a.matchName;
      }
    }
    if (a.candidates && a.candidates.length) o.candidates = a.candidates;
    return o;
  }

  function snapshot() {
    var settings = {};
    SYNC_SETTINGS.forEach(function (k) { settings[k] = state.settings[k]; });
    return {
      v: 1,
      updatedAt: new Date().toISOString(),
      device: state.sync.device || 'unknown',
      genres: state.genres,
      genreHues: state.genreHues,
      deletedSeedIds: state.deletedSeedIds,
      deletedGenres: state.deletedGenres,
      rotation: state.rotation,
      session: state.session,
      settings: settings,
      albums: state.library.map(packAlbum)
    };
  }

  // Replaces local state wholesale. The remote file is the record; anything a
  // device holds that has not been pushed is by definition older.
  function adopt(remote) {
    state.genres = remote.genres && remote.genres.length ? remote.genres : state.genres;
    state.genreHues = remote.genreHues || state.genreHues;
    state.deletedSeedIds = remote.deletedSeedIds || [];
    state.deletedGenres = remote.deletedGenres || [];
    state.rotation = remote.rotation || 0;
    state.session = remote.session || null;
    if (remote.settings) {
      SYNC_SETTINGS.forEach(function (k) {
        if (remote.settings[k] !== undefined) state.settings[k] = remote.settings[k];
      });
    }
    state.library = (remote.albums || []).map(seedAlbum);
    // candidates survive a round trip so a half-finished review is not lost
    (remote.albums || []).forEach(function (s, i) {
      if (s.candidates) state.library[i].candidates = s.candidates;
    });
    if (state.rotation >= state.genres.length) state.rotation = 0;
    ensureHues();
  }

  /* ---- pull / push ---- */

  function syncPull(quiet) {
    if (!syncConfigured()) return Promise.resolve(false);
    syncState = 'pulling';
    renderSyncStatus();
    return ghFetch(ghUrl('?ref=' + encodeURIComponent(state.sync.branch || 'main')),
      { headers: ghHeaders() })
      .then(function (meta) {
        if (meta.missing) {
          // Nothing there yet: this device's copy becomes the first version.
          syncState = 'idle';
          syncNote = 'No file in the repo yet — your next save creates it.';
          renderSyncStatus();
          return false;
        }
        state.sync.sha = meta.sha;
        // The contents endpoint omits content above 1 MB; the blob endpoint has
        // no such limit, so fall through to it rather than failing on size.
        if (meta.content) return fromBase64(meta.content);
        return ghFetch('https://api.github.com/repos/' + encodeURIComponent(state.sync.owner) +
          '/' + encodeURIComponent(state.sync.repo) + '/git/blobs/' + meta.sha,
          { headers: ghHeaders() }).then(function (blob) { return fromBase64(blob.content); });
      })
      .then(function (text) {
        if (text === false) return false;
        var remote = JSON.parse(text);
        adopt(remote);
        state.sync.remoteAt = remote.updatedAt || null;
        syncState = 'idle';
        syncNote = 'Loaded ' + state.library.length + ' albums saved ' +
          (remote.device ? 'on ' + remote.device : '') +
          (remote.updatedAt ? ' at ' + new Date(remote.updatedAt).toLocaleString() : '');
        save(true);
        render();
        renderSyncStatus();
        if (!quiet) toast('Synced from GitHub.');
        return true;
      })
      .catch(function (err) {
        syncState = 'error';
        syncNote = describeSyncError(err);
        renderSyncStatus();
        if (!quiet) toast('Sync failed: ' + syncNote);
        return false;
      });
  }

  function syncPush(force) {
    if (!syncConfigured()) return Promise.resolve(false);
    if (syncBusy) return Promise.resolve(false);
    syncBusy = true;
    syncState = 'pushing';
    renderSyncStatus();

    var payload = snapshot();
    var body = {
      message: 'Library updated on ' + payload.device,
      content: toBase64(JSON.stringify(payload)),
      branch: state.sync.branch || 'main'
    };
    // GitHub takes the sha as "the version I am replacing". Without it the
    // write is only accepted when no file exists yet.
    if (state.sync.sha) body.sha = state.sync.sha;

    return ghFetch(ghUrl(), {
      method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body)
    }).then(function (res) {
      syncBusy = false;
      state.sync.sha = res.content && res.content.sha;
      state.sync.remoteAt = payload.updatedAt;
      state.sync.lastPush = Date.now();
      syncState = 'idle';
      syncNote = 'Saved at ' + new Date(payload.updatedAt).toLocaleTimeString();
      save(true);
      renderSyncStatus();
      return true;
    }, function (err) {
      syncBusy = false;
      if (err.status === 409 || /does not match|sha/i.test(err.message)) {
        syncState = 'conflict';
        syncNote = 'Another device saved since this one loaded. Pull to take theirs, ' +
          'or push anyway to overwrite it.';
      } else {
        syncState = 'error';
        syncNote = describeSyncError(err);
      }
      renderSyncStatus();
      return false;
    });
  }

  function describeSyncError(err) {
    var m = String(err && err.message || err);
    if (err && err.status === 401) return 'Token rejected — check it has not expired.';
    if (err && err.status === 403) return 'Token lacks Contents write on that repository.';
    if (err && err.status === 404) return 'Repository or branch not found — check owner, name and branch.';
    if (/Failed to fetch/i.test(m)) return 'Could not reach GitHub.';
    return m;
  }

  // Any state change schedules a push; the timer collapses a burst of edits
  // into one commit rather than one per keystroke.
  function syncPending() {
    return syncConfigured() && (syncState === 'pending' || syncBusy);
  }

  function syncSoon() {
    if (!syncConfigured()) return;
    clearTimeout(syncTimer);
    syncState = 'pending';
    renderSyncStatus();
    syncTimer = setTimeout(function () { syncPush(false); }, SYNC_DEBOUNCE);
  }

  /* ──────────────────────────── session ──────────────────────────── */

  // The favourites pool deliberately ignores played, so a favourite can come
  // round again any day. A genre pool still retires what it has served.
  function poolFor(genreIndex, exclude) {
    var out = [];
    for (var i = 0; i < state.library.length; i++) {
      var a = state.library[i];
      if (a.played && genreIndex !== BONUS) continue;
      if (exclude[a.id]) continue;
      if (genreIndex === BONUS ? !a.fav : a.genre !== state.genres[genreIndex]) continue;
      out.push(a);
    }
    return out;
  }

  function usedIds(session) {
    var used = {};
    for (var i = 0; i < session.slots.length; i++) {
      if (session.slots[i].albumId) used[session.slots[i].albumId] = true;
    }
    return used;
  }

  function nextRotationIndex(session) {
    var last = null;
    for (var i = 0; i < session.slots.length; i++) {
      if (session.slots[i].genreIndex !== BONUS) last = session.slots[i].genreIndex;
    }
    if (last === null) return session.startRotation;
    return (last + 1) % state.genres.length;
  }

  var slotSeq = 0;
  function makeSlot(session, genreIndex) {
    var used = usedIds(session);
    var pool = poolFor(genreIndex, used);
    var picks = pickRandom(pool, 1 + ALT_COUNT);
    var alts = [];
    for (var i = 1; i < picks.length; i++) alts.push(picks[i].id);
    return {
      key: 's' + (++slotSeq) + '-' + Math.random().toString(36).slice(2, 7),
      genreIndex: genreIndex,
      albumId: picks.length ? picks[0].id : null,
      alternates: alts,
      minutes: (picks.length && picks[0].minutes) || state.settings.defaultMinutes,
      added: false,
      altsOpen: false
    };
  }

  // A day runs one favourite then four from the rotation, repeating: slots 1,
  // 6, 11 are favourites. Position is taken from the slot count, so dropping a
  // card does not retype the ones already drawn.
  var FAV_EVERY = 5;

  function wantsFavourite(session) {
    if (!state.settings.favoritesBonus) return false;
    return session.slots.length % FAV_EVERY === 0;
  }

  // Walks the rotation forward past any genre with nothing left to play.
  // Adds the next slot the cadence calls for. A favourite slot falls back to a
  // genre draw if there are no favourites left to serve.
  function appendRotationSlot(session) {
    var used = usedIds(session);
    if (wantsFavourite(session) && poolFor(BONUS, used).length) {
      session.slots.push(makeSlot(session, BONUS));
      return true;
    }
    var n = state.genres.length;
    var idx = nextRotationIndex(session);
    for (var tries = 0; tries < n; tries++) {
      if (poolFor(idx, used).length) {
        session.slots.push(makeSlot(session, idx));
        return true;
      }
      idx = (idx + 1) % n;
    }
    return false;
  }

  function plannedMinutes(session) {
    var total = 0;
    for (var i = 0; i < session.slots.length; i++) {
      if (session.slots[i].albumId) total += session.slots[i].minutes || 0;
    }
    return total;
  }

  function addedMinutes(session) {
    var total = 0;
    for (var i = 0; i < session.slots.length; i++) {
      if (session.slots[i].added) total += session.slots[i].minutes || 0;
    }
    return total;
  }

  // Keeps appending albums until the plan reaches the target — the "loop back
  // around if I didn't get to 8 hours" step.
  function ensureCoverage(session) {
    var guard = 0;
    while (plannedMinutes(session) < state.settings.targetMinutes && guard++ < 60) {
      if (!appendRotationSlot(session)) break;
    }
  }

  // Drops spare albums off the tail after the target is lowered. Never touches
  // anything already added, and never the Favorites draw.
  function trimCoverage(session) {
    for (var i = session.slots.length - 1; i >= 0; i--) {
      var s = session.slots[i];
      if (s.genreIndex === BONUS || s.added) continue;
      if (plannedMinutes(session) - (s.minutes || 0) < state.settings.targetMinutes) break;
      session.slots.splice(i, 1);
    }
  }

  function newSession() {
    var session = { date: today(), startRotation: state.rotation, slots: [] };
    ensureCoverage(session);
    return session;
  }

  function finishDay() {
    var s = state.session;
    if (!s) return;
    var added = s.slots.filter(function (x) { return x.added && x.albumId; });
    if (!added.length) { toast('Nothing marked as added yet.'); return; }

    // A favourite served as a favourite stays in the pool; the same album drawn
    // from its genre is retired, which is what keeps it a once-only genre pick.
    // Stamped when the day is finished, not when it was drawn. A day left open
    // overnight is finished today, and that is the day it was listened to.
    var finishedOn = today();
    var lastGenre = null, keptFav = 0;
    added.forEach(function (slot) {
      var a = byId(slot.albumId);
      if (slot.genreIndex === BONUS) { keptFav++; return; }
      if (a) { a.played = true; a.playedAt = finishedOn; }
      lastGenre = slot.genreIndex;
    });
    if (lastGenre !== null) state.rotation = (lastGenre + 1) % state.genres.length;

    state.session = null;
    save();
    render();
    toast('Logged ' + added.length + ' album' + (added.length === 1 ? '' : 's') +
      (keptFav ? ' (' + keptFav + ' favourite' + (keptFav === 1 ? '' : 's') +
        ' stay in the pool)' : '') +
      ' · next day starts with ' + state.genres[state.rotation] + '.');
  }

  /* ───────────────────────────── today ───────────────────────────── */

  function renderToday() {
    // A freshly drawn day is persisted straight away, so reopening the page
    // shows the same picks rather than rerolling them.
    if (!state.session) { state.session = newSession(); save(); }
    var s = state.session;

    $('#day-date').textContent = longDate(s.date) + (s.date !== today() ? ' · still open' : '');
    $('#day-title').textContent = 'Today’s playlist';

    // A genre with nothing to draw is either worked through or not filled in
    // yet — quite different situations, so say which.
    var playedOut = [], stillEmpty = 0;
    for (var i = 0; i < state.genres.length; i++) {
      if (poolFor(i, {}).length) continue;
      var name = state.genres[i];
      var owned = state.library.some(function (a) { return a.genre === name; });
      if (owned) playedOut.push(name); else stillEmpty++;
    }

    var sub = 'Rotation started at <b>' + esc(state.genres[s.startRotation]) + '</b>.';
    var notes = [];
    if (playedOut.length) {
      notes.push(esc(playedOut.join(', ')) +
        (playedOut.length === 1 ? ' is' : ' are') + ' fully played and skipped');
    }
    if (stillEmpty) {
      notes.push(stillEmpty + ' genre' + (stillEmpty === 1 ? ' has' : 's have') + ' no albums yet');
    }
    if (notes.length) sub += ' <span class="dim">' + notes.join('; ') + '.</span>';
    $('#day-sub').innerHTML = sub;

    // A day drawn before a lookup finished would otherwise keep showing the old
    // estimates. Typing a length writes to the album too, so these stay equal
    // once set — only a newly discovered running time actually changes here.
    var refreshed = 0;
    s.slots.forEach(function (slot) {
      var a = slot.albumId ? byId(slot.albumId) : null;
      if (a && a.minutes && slot.minutes !== a.minutes) { slot.minutes = a.minutes; refreshed++; }
    });
    if (refreshed) save();

    renderMeter();

    var box = $('#slots');
    box.textContent = '';
    var num = 0;
    s.slots.forEach(function (slot) {
      // Favourites are part of the run now, so the numbering counts them too.
      box.appendChild(renderSlot(slot, ++num));
    });

    var canAdd = anyPoolLeft(s);
    $('#add-slot').disabled = !canAdd;
    $('#tail-note').textContent = canAdd ? '' : 'Every album in the library has been played.';
    $('#finish-day').disabled = !s.slots.some(function (x) { return x.added; });
  }

  function anyPoolLeft(session) {
    var used = usedIds(session);
    for (var i = 0; i < state.genres.length; i++) {
      if (poolFor(i, used).length) return true;
    }
    return false;
  }

  function renderMeter() {
    var s = state.session;
    var target = state.settings.targetMinutes;
    var added = addedMinutes(s), planned = plannedMinutes(s);
    var count = s.slots.filter(function (x) { return x.added; }).length;

    $('#meter-fill').style.width = Math.min(100, (added / target) * 100) + '%';
    $('#meter-ghost').style.width = Math.min(100, (planned / target) * 100) + '%';
    $('#meter-added').textContent = fmt(added);
    $('#meter-count').textContent = count ? ' · ' + count + ' album' + (count === 1 ? '' : 's') : '';
    $('#meter-planned').textContent = planned > added ? fmt(planned) + ' planned' : '';
    $('#meter-target').textContent = fmt(target);
  }

  function renderSlot(slot, num) {
    var album = slot.albumId ? byId(slot.albumId) : null;
    var bonus = slot.genreIndex === BONUS;
    var genre = bonus ? 'Favorites' : state.genres[slot.genreIndex];

    var node = el('article', 'slot' + (slot.added ? ' is-added' : '') +
      (album ? '' : ' is-empty') + (bonus ? ' is-bonus' : ''));
    node.style.setProperty('--h', bonus ? 45 : hue(genre));
    node.dataset.key = slot.key;

    var top = el('div', 'slot-top');
    if (num) {
      var n = el('span', 'slot-num');
      n.textContent = String(num).padStart(2, '0');
      top.appendChild(n);
    }
    var badge = el('span', 'genre-badge');
    badge.textContent = bonus ? '★ Favorites' : genre;
    top.appendChild(badge);
    var close = el('button', 'slot-close');
    close.type = 'button';
    close.title = 'Drop this slot';
    close.dataset.act = 'drop';
    close.textContent = '×';
    top.appendChild(close);
    node.appendChild(top);

    if (!album) {
      var note = el('p', 'slot-empty-note');
      note.textContent = bonus ? 'No unplayed favorites left.' : 'Nothing left to play in ' + genre + '.';
      node.appendChild(note);
      return node;
    }

    if (album.artist || album.year) {
      var ar = el('p', 'slot-artist');
      ar.textContent = album.artist || '';
      if (album.year) {
        var yr = el('span', 'slot-year');
        yr.textContent = album.artist ? ' · ' + album.year : String(album.year);
        ar.appendChild(yr);
      }
      node.appendChild(ar);
    }
    var ti = el('h3', 'slot-album');
    ti.textContent = album.title || album.name;
    if (album.fav && !bonus) {
      var star = el('span', 'star');
      star.textContent = '★';
      star.title = 'Favorite';
      ti.appendChild(star);
    }
    node.appendChild(ti);

    var direct = !!album.spotifyUrl;
    var acts = el('div', 'slot-actions');
    acts.innerHTML =
      '<button class="btn add-btn" type="button" data-act="toggle">' +
        (slot.added ? '✓ Added' : 'Add') + '</button>' +
      '<button class="btn" type="button" data-act="reroll" title="Draw another">↻</button>' +
      '<a class="btn" ' + spotifyLink(album) + ' title="' +
        (direct ? esc(album.matchName || album.name) : 'Search Spotify') + '">Spotify ↗</a>' +
      '<button class="btn" type="button" data-act="copy" title="Copy album name">⧉</button>' +
      '<span class="slot-nums">' +
        '<label class="rym' + (album.rym ? ' is-known' : '') +
          '" title="RateYourMusic score — type one in once you have heard it">' +
          '<input type="number" min="0" max="5" step="any" placeholder="—"' +
          ' value="' + (album.rym || '') + '"' +
          ' data-act="rym" aria-label="RateYourMusic score"> rym</label>' +
        '<label class="mins' + (album.minutes ? (album.approx ? ' is-approx' : ' is-known') : '') +
          '" title="' + esc(lengthNote(album)) + '">' +
          '<input type="number" min="1" max="300" step="1" value="' + (slot.minutes || 0) + '"' +
          ' data-act="mins" aria-label="Album length in minutes"> min</label>' +
        '<label class="trk' + (album.tracks ? ' is-known' : '') +
          '" title="Tracks to take from the linked release — trim it here to drop' +
          ' the bonus cuts on a deluxe edition">' +
          '<input type="number" min="1" max="200" step="1" placeholder="—"' +
          ' value="' + (album.tracks || '') + '"' +
          ' data-act="tracks" aria-label="Tracks to take from the linked release"> trk</label>' +
      '</span>';
    node.appendChild(acts);

    if (slot.alternates.length) {
      var det = el('details', 'alts');
      det.open = !!slot.altsOpen;
      var sum = el('summary');
      sum.textContent = slot.alternates.length + ' alternate' + (slot.alternates.length === 1 ? '' : 's');
      det.appendChild(sum);
      slot.alternates.forEach(function (id) {
        var alt = byId(id);
        if (!alt) return;
        var b = el('button', 'alt');
        b.type = 'button';
        b.dataset.act = 'swap';
        b.dataset.id = id;
        b.textContent = alt.name;
        det.appendChild(b);
      });
      node.appendChild(det);
    }
    return node;
  }

  function refreshSlot(slot) {
    var old = document.querySelector('.slot[data-key="' + slot.key + '"]');
    if (!old) { renderToday(); return; }
    var num = old.querySelector('.slot-num');
    var fresh = renderSlot(slot, num ? +num.textContent : null);
    old.parentNode.replaceChild(fresh, old);
  }

  function slotFromEvent(e) {
    var card = e.target.closest('.slot');
    if (!card) return null;
    var key = card.dataset.key;
    var slots = state.session.slots;
    for (var i = 0; i < slots.length; i++) if (slots[i].key === key) return slots[i];
    return null;
  }

  function wireToday() {
    var box = $('#slots');

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.tagName === 'INPUT') return;
      var slot = slotFromEvent(e);
      if (!slot) return;
      var act = btn.dataset.act;

      if (act === 'toggle') {
        slot.added = !slot.added;
        save();
        refreshSlot(slot);
        renderMeter();
        $('#finish-day').disabled = !state.session.slots.some(function (x) { return x.added; });
      } else if (act === 'reroll') {
        // usedIds already excludes this slot's own album, so a reroll never
        // hands back the same record.
        var picks = pickRandom(poolFor(slot.genreIndex, usedIds(state.session)), 1 + ALT_COUNT);
        if (!picks.length) { toast('No other unplayed albums in that genre.'); return; }
        slot.albumId = picks[0].id;
        slot.alternates = picks.slice(1).map(function (a) { return a.id; });
        slot.added = false;
        save();
        refreshSlot(slot);
        renderMeter();
      } else if (act === 'swap') {
        var id = btn.dataset.id;
        var i = slot.alternates.indexOf(id);
        if (i > -1) slot.alternates.splice(i, 1);
        if (slot.albumId) slot.alternates.unshift(slot.albumId);
        slot.albumId = id;
        slot.altsOpen = true;
        save();
        refreshSlot(slot);
      } else if (act === 'copy') {
        var a = byId(slot.albumId);
        if (a) copyText(a.name, 'Copied “' + a.name + '”');
      } else if (act === 'drop') {
        var idx = state.session.slots.indexOf(slot);
        state.session.slots.splice(idx, 1);
        save();
        renderToday();
      }
    });

    box.addEventListener('toggle', function (e) {
      if (!e.target.classList || !e.target.classList.contains('alts')) return;
      var card = e.target.closest('.slot');
      if (!card) return;
      state.session.slots.forEach(function (s) {
        if (s.key === card.dataset.key) s.altsOpen = e.target.open;
      });
    }, true);

    box.addEventListener('input', function (e) {
      if (e.target.dataset.act !== 'mins') return;
      var slot = slotFromEvent(e);
      if (!slot) return;
      slot.minutes = Math.max(0, Math.min(300, +e.target.value || 0));
      renderMeter();
    });

    // Only redraw the whole day when the shorter running time actually pulled
    // in another album — otherwise editing one field would yank focus.
    box.addEventListener('change', function (e) {
      // A score is a fact about the album, not about the day, so it goes
      // straight to the record without disturbing the running total.
      if (e.target.dataset.act === 'rym') {
        var scored = slotFromEvent(e);
        var rated = scored && byId(scored.albumId);
        if (!rated) return;
        var raw = String(e.target.value).trim();
        rated.rym = parseRym(raw);
        if (raw && rated.rym === null) toast('A RateYourMusic score runs from 0 to 5.');
        e.target.value = rated.rym === null ? '' : rated.rym;
        e.target.closest('.rym').classList.toggle('is-known', rated.rym !== null);
        save();
        return;
      }
      // Likewise a track count: it describes the album, not the day. Trimming it
      // does not shorten the running total — the per-track times that would need
      // are not stored, so the min box stays a separate hand edit.
      if (e.target.dataset.act === 'tracks') {
        var counted = slotFromEvent(e);
        var trimmed = counted && byId(counted.albumId);
        if (!trimmed) return;
        var rawTrk = String(e.target.value).trim();
        trimmed.tracks = parseTracks(rawTrk);
        if (rawTrk && trimmed.tracks === null) toast('A track count has to be 1 or more.');
        e.target.value = trimmed.tracks === null ? '' : trimmed.tracks;
        e.target.closest('.trk').classList.toggle('is-known', trimmed.tracks !== null);
        save();
        return;
      }
      if (e.target.dataset.act !== 'mins') return;
      var slot = slotFromEvent(e);
      if (!slot) return;
      if (!slot.minutes) {
        slot.minutes = state.settings.defaultMinutes;
        e.target.value = slot.minutes;
      }
      // Remember it on the album itself, so it is only ever typed once.
      var album = byId(slot.albumId);
      if (album) album.minutes = slot.minutes;
      var count = state.session.slots.length;
      ensureCoverage(state.session);
      save();
      if (state.session.slots.length !== count) renderToday();
      else renderMeter();
    });

    $('#add-slot').addEventListener('click', function () {
      if (!appendRotationSlot(state.session)) { toast('Nothing left to draw.'); return; }
      save();
      renderToday();
    });

    $('#finish-day').addEventListener('click', finishDay);

    $('#reset-day').addEventListener('click', function () {
      var added = state.session.slots.filter(function (x) { return x.added; }).length;
      if (added && !confirm('Discard today’s ' + added + ' picked album' +
        (added === 1 ? '' : 's') + ' and draw a fresh set?')) return;
      state.session = null;
      save();
      renderToday();
    });

    $('#copy-day').addEventListener('click', function () {
      var s = state.session;
      var picked = s.slots.filter(function (x) { return x.added && x.albumId; });
      var list = picked.length ? picked : s.slots.filter(function (x) { return x.albumId; });
      if (!list.length) { toast('Nothing to copy yet.'); return; }
      var lines = ['Album Randomizer — ' + shortDate(s.date), ''];
      list.forEach(function (slot, i) {
        var a = byId(slot.albumId);
        var g = slot.genreIndex === BONUS ? 'Favorites' : state.genres[slot.genreIndex];
        lines.push((i + 1) + '. ' + a.name + '  (' + g + ')');
      });
      var mins = list.reduce(function (t, x) { return t + (x.minutes || 0); }, 0);
      lines.push('', '~' + fmt(mins) + (picked.length ? '' : ' — nothing marked as added yet'));
      copyText(lines.join('\n'), 'Playlist copied.');
    });
  }

  /* ──────────────────────────── library ──────────────────────────── */

  // The sidebar genre list. Counts answer the question the current view is
  // asking: what is left to play in Library, what has been played in Played.
  function renderSidebarGenres() {
    var box = $('#genre-list');
    if (!box) return;
    var playedView = document.body.dataset.view === 'played';
    var lib = state.library;

    box.textContent = '';
    var total = playedView
      ? lib.filter(function (a) { return a.played; }).length
      : lib.filter(function (a) { return !a.played; }).length;
    box.appendChild(genreItem('', 'All genres', total, playedView ? null : lib.length));

    state.genres.forEach(function (g) {
      var all = lib.filter(function (a) { return a.genre === g; });
      var n = all.filter(function (a) { return playedView ? a.played : !a.played; }).length;
      box.appendChild(genreItem(g, g, n, playedView ? null : all.length));
    });
  }

  // `of` is the genre's total when that adds something — the sidebar is too
  // narrow for "155 / 172", so the pair goes in the tooltip instead.
  function genreItem(value, label, count, of) {
    var item = el('button', 'gitem' + (value ? '' : ' gitem-all') +
      (genreFilter === value ? ' on' : ''));
    item.type = 'button';
    item.dataset.genre = value;
    if (value) item.style.setProperty('--h', hue(value));
    item.title = of === null
      ? count + ' played'
      : count + ' unplayed of ' + of;
    item.innerHTML = '<b>' + esc(label) + '</b><span>' + count + '</span>';
    return item;
  }

  function renderLibrary() {
    var lib = state.library;
    var played = lib.filter(function (a) { return a.played; }).length;
    $('#library-summary').textContent = lib.length + ' albums · ' + (lib.length - played) +
      ' unplayed · ' + lib.filter(function (a) { return a.fav; }).length + ' favorites';

    // Only decades that actually hold albums, so the list never offers an empty
    // span. Rebuilt with the library because entering years can introduce one;
    // the selection is put back, or dropped if that decade has since emptied.
    // The sidebar list and this dropdown are two faces of one genreFilter, so
    // the value is written from that rather than kept independently. It earns
    // its place because the sidebar can be collapsed away entirely.
    var gsel = $('#lib-genre');
    gsel.innerHTML = '<option value="">All genres</option>' +
      state.genres.map(function (g) {
        return '<option value="' + esc(g) + '">' + esc(g) + '</option>';
      }).join('');
    gsel.value = state.genres.indexOf(genreFilter) > -1 ? genreFilter : '';

    var dsel = $('#lib-decade');
    var wantDecade = dsel.value;
    var seen = {};
    lib.forEach(function (a) { if (a.year) seen[Math.floor(a.year / 10) * 10] = true; });
    var decades = Object.keys(seen).sort(function (x, y) { return x - y; });
    dsel.innerHTML = '<option value="">All decades</option>' +
      decades.map(function (d) { return '<option value="' + d + '">' + d + 's</option>'; }).join('');
    dsel.value = decades.indexOf(wantDecade) > -1 ? wantDecade : '';

    var asel = $('#add-genre');
    // Rebuilding the options drops the selection, so it is put back after. The
    // add form prefers what is on screen and falls back to the genre of the last
    // album added, which is what carries the choice across a reload.
    var wantAdd = asel.value || state.settings.lastAddGenre;
    asel.innerHTML = '';
    state.genres.forEach(function (g) {
      asel.insertAdjacentHTML('beforeend', '<option value="' + esc(g) + '">' + esc(g) + '</option>');
    });
    asel.value = state.genres.indexOf(wantAdd) > -1 ? wantAdd : state.genres[0];

    renderRows();
  }

  // One sentence explaining where a length came from, used in both tooltips.
  function lengthNote(a) {
    if (!a.minutes) return 'No length yet — using the ' + state.settings.defaultMinutes + ' minute estimate.';
    if (a.approx) return 'Estimated from ' + (a.tracks || '?') + ' tracks — Spotify would not give the exact time.' +
      (a.matchName ? ' Matched: ' + a.matchName : '');
    return 'Exact running time from Spotify.' + (a.matchName ? ' Matched: ' + a.matchName : '');
  }

  function composeName(artist, title) {
    return artist ? artist + ' - ' + title : title;
  }

  function slugOf(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Blank means "unknown", which lets a lookup fill it in later.
  function parseMinutes(raw) {
    var n = parseInt(String(raw).trim(), 10);
    if (!raw || isNaN(n) || n < 1) return null;
    return Math.min(300, n);
  }

  // Started life as "how many tracks the matched release has", and is becoming
  // "how many to take from it" — the two agree until you trim a deluxe edition.
  function parseTracks(raw) {
    var n = parseInt(String(raw == null ? '' : raw).trim(), 10);
    if (isNaN(n) || n < 1) return null;
    return Math.min(200, n);
  }

  function parseYear(raw) {
    var n = parseInt(String(raw == null ? '' : raw).trim(), 10);
    if (isNaN(n) || n < 1900 || n > 2100) return null;
    return n;
  }

  // RateYourMusic averages run 0.00–5.00. Kept as a number so sorting stays
  // honest; anything outside the scale is treated as a slip and ignored.
  function parseRym(raw) {
    var t = String(raw == null ? '' : raw).trim();
    if (!t) return null;
    var n = Number(t);
    if (isNaN(n) || n < 0 || n > 5) return null;
    return Math.round(n * 100) / 100;
  }

  function fmtRym(v) {
    return v || v === 0 ? Number(v).toFixed(2) : '—';
  }

  // Both sets are natural breaks (Fisher-Jenks, k=5) over the library as it
  // stood on 2026-09-06. Open at both ends, so a value outside the range they
  // were derived from still lands in a band rather than vanishing. Recompute
  // when the distributions have moved — the first set already drifted once.

  // 3224 scores, 1.72–4.34, median 3.45. Goodness of variance fit 0.91.
  var RYM_BANDS = [
    { min: -Infinity, max: 2.92 },
    { min: 2.92, max: 3.27 },
    { min: 3.27, max: 3.53 },
    { min: 3.53, max: 3.80 },
    { min: 3.80, max: Infinity }
  ];

  // 3239 runtimes, 4m–2h53m, median 44m. Goodness of variance fit 0.89.
  var LENGTH_BANDS = [
    { min: -Infinity, max: 39 },
    { min: 39, max: 49 },
    { min: 49, max: 64 },
    { min: 64, max: 99 },
    { min: 99, max: Infinity }
  ];

  // Labels come off the bounds so they can never drift from the filter itself.
  function bandLabel(b, show) {
    if (b.min === -Infinity) return 'Under ' + show(b.max);
    if (b.max === Infinity) return show(b.min) + ' and up';
    return show(b.min) + ' – ' + show(b.max);
  }

  function bandOptions(bands, show, allLabel) {
    return '<option value="">' + allLabel + '</option>' + bands.map(function (b, i) {
      return '<option value="' + (i + 1) + '">' + esc(bandLabel(b, show)) + '</option>';
    }).join('');
  }

  // A leading "The" is ignored, so The Black Keys file under B the way they
  // would in a record shop. Only the sort key changes; the name still displays
  // in full.
  function filingName(a) {
    return String(a.artist || a.name || '').replace(/^the\s+/i, '');
  }

  // Artist, then that artist's records in the order they came out. Undated
  // albums sit after the dated ones rather than scattering through the run.
  function byArtistThenYear(x, y) {
    var byArtist = filingName(x).localeCompare(filingName(y));
    if (byArtist) return byArtist;
    if ((x.year || 0) !== (y.year || 0)) {
      if (!x.year) return 1;
      if (!y.year) return -1;
      return x.year - y.year;
    }
    return (x.title || x.name).localeCompare(y.title || y.name);
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var t = String(v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  // What an export covers: a tick selection if there is one, otherwise
  // everything the filter currently matches.
  function exportScope() {
    var ids = selectedIds();
    if (ids.length) {
      var picked = {};
      ids.forEach(function (id) { picked[id] = true; });
      // Keep the on-screen ordering rather than tick order.
      var all = state.library.slice().sort(byArtistThenYear);
      return { rows: all.filter(function (a) { return picked[a.id]; }), from: 'selection' };
    }
    return { rows: currentMatches(), from: 'filter' };
  }

  // A tick means that album, linked or not — re-fetching is how a bad runtime
  // or track count gets corrected. Without a selection it falls back to the
  // filter, skipping albums already linked so a broad sweep does not redo them.
  function fetchScope() {
    var ids = selectedIds();
    if (ids.length) {
      return { rows: state.library.filter(function (a) { return selected[a.id]; }), from: 'selection' };
    }
    return {
      rows: currentMatches().filter(function (a) { return !a.spotifyId; }),
      from: 'filter'
    };
  }

  function exportName(scope) {
    if (scope.from === 'selection') return 'album-randomizer-selection-' + today() + '.csv';
    var genre = genreFilter;
    var status = $('#lib-status').value;
    var bits = ['album-randomizer'];
    if (genre) bits.push(genre.replace(/[^A-Za-z0-9]+/g, '-'));
    if (status && status !== 'all') bits.push(status);
    // An active band or decade belongs in the name too, or the file looks like
    // the whole filtered set when it is only a slice of it.
    if ($('#lib-decade').value) bits.push($('#lib-decade').value + 's');
    if ($('#lib-rym').value) bits.push('rym' + $('#lib-rym').value);
    if ($('#lib-length').value) bits.push('len' + $('#lib-length').value);
    bits.push(today());
    return bits.join('-') + '.csv';
  }

  // Column names match what the bulk importer looks for, so an exported sheet
  // can be edited and fed straight back in.
  var CSV_COLUMNS = [
    ['Artist', function (a) { return a.artist || ''; }],
    ['Album', function (a) { return a.title || a.name; }],
    ['Genre', function (a) { return a.genre; }],
    ['Year', function (a) { return a.year || ''; }],
    ['RYM', function (a) { return a.rym || a.rym === 0 ? Number(a.rym).toFixed(2) : ''; }],
    ['Runtime', function (a) { return a.minutes || ''; }],
    ['Favorite', function (a) { return a.fav ? 'yes' : ''; }],
    ['Played', function (a) { return a.played ? 'yes' : ''; }],
    ['Played On', function (a) { return a.playedAt || ''; }]
  ];

  function buildCsv(rows) {
    var out = [CSV_COLUMNS.map(function (c) { return csvCell(c[0]); }).join(',')];
    rows.forEach(function (a) {
      out.push(CSV_COLUMNS.map(function (c) { return csvCell(c[1](a)); }).join(','));
    });
    // CRLF and a BOM so Excel opens it as UTF-8 and keeps the accents.
    return '\ufeff' + out.join('\r\n') + '\r\n';
  }

  // Rows are sorted "Artist - Album", so they read that way too.
  function rowName(a) {
    if (!a.artist) return esc(a.name);
    return '<small>' + esc(a.artist) + ' ·</small> ' + esc(a.title);
  }

  // Correcting a record in place. The album's id never changes, so anything
  // already pointing at it — today's picks, played history — stays intact.
  function editRow(a) {
    return '<div class="row is-editing" data-id="' + esc(a.id) + '" style="--h:' + hue(a.genre) + '">' +
      '<form class="row-edit" data-act="save">' +
        '<input type="text" class="edit-artist" value="' + esc(a.artist || '') + '" placeholder="Artist">' +
        '<input type="text" class="edit-title" value="' + esc(a.title || a.name) + '" placeholder="Album" required>' +
        '<select class="edit-genre">' + state.genres.map(function (g) {
          return '<option value="' + esc(g) + '"' + (g === a.genre ? ' selected' : '') + '>' + esc(g) + '</option>';
        }).join('') + '</select>' +
        '<label class="numbox"><input type="number" class="edit-year" min="1900" max="2100" step="1"' +
          ' placeholder="—" aria-label="Release year" value="' + (a.year || '') + '"> yr</label>' +
        // step="any" so a raw average pasted from RYM is accepted and rounded,
        // rather than the browser refusing it over a step mismatch.
        '<label class="numbox"><input type="number" class="edit-rym" min="0" max="5" step="any"' +
          ' placeholder="—" aria-label="RateYourMusic score" value="' + (a.rym || '') + '"> rym</label>' +
        '<label class="numbox"><input type="number" class="edit-tracks" min="1" max="200" step="1"' +
          ' placeholder="—" aria-label="Tracks to take from the linked release"' +
          ' value="' + (a.tracks || '') + '"> trk</label>' +
        '<label class="mins"><input type="number" class="edit-mins" min="1" max="300" placeholder="—" value="' +
          (a.minutes || '') + '"> min</label>' +
        '<button class="btn btn-primary" type="submit">Save</button>' +
        '<button class="btn btn-quiet" type="button" data-act="cancel-edit">Cancel</button>' +
      '</form></div>';
  }

  // Shown for albums Spotify could not resolve confidently: the runners-up,
  // labelled with why each is doubtful, so picking one is a single click.
  function candidatePicker(a) {
    if (!a.candidates || !a.candidates.length) return '';
    // Three ways to get here: the run was unsure, the run found nothing, or you
    // asked to see the other versions. Only the last one is not a problem.
    var browsing = a.match === 'versions';
    return '<details class="alts picker"' + (browsing || a.match === 'review' ? ' open' : '') + '>' +
      '<summary>' + (browsing ? 'Which version should be linked?'
        : a.match === 'review' ? 'Which release is this?' : 'No confident match — pick one?') +
      '</summary>' +
      a.candidates.map(function (c) {
        return '<button class="alt" type="button" data-act="pick" data-cid="' + esc(c.id) + '">' +
          esc(c.artist) + ' — ' + esc(c.name) +
          ' <span class="alt-meta">' + (c.year ? c.year + ' · ' : '') + c.tracks + ' tracks' +
          (c.kind && c.kind !== 'exact' ? ' · ' + esc(c.kind) : '') + '</span></button>';
      }).join('') +
      '<button class="alt alt-none" type="button" data-act="nopick">' +
        (browsing ? 'Keep the current link' : 'None of these') + '</button>' +
      '</details>';
  }

  function currentMatches() {
    var q = $('#lib-search').value.trim().toLowerCase();
    var genre = genreFilter;
    var status = $('#lib-status').value;
    var band = $('#lib-rym').value ? RYM_BANDS[+$('#lib-rym').value - 1] : null;
    var decade = $('#lib-decade').value ? +$('#lib-decade').value : null;
    var len = $('#lib-length').value ? LENGTH_BANDS[+$('#lib-length').value - 1] : null;

    var matches = state.library.filter(function (a) {
      if (band && (a.rym == null || a.rym < band.min || a.rym >= band.max)) return false;
      if (len && (!a.minutes || a.minutes < len.min || a.minutes >= len.max)) return false;
      if (decade !== null && (!a.year || Math.floor(a.year / 10) * 10 !== decade)) return false;
      if (genre && a.genre !== genre) return false;
      if (status === 'unplayed' && a.played) return false;
      if (status === 'played' && !a.played) return false;
      if (status === 'fav' && !a.fav) return false;
      if (status === 'review' && !(a.candidates && a.candidates.length && a.match !== 'versions')) return false;
      if (status === 'nolength' && a.minutes) return false;
      if (status === 'noyear' && a.year) return false;
      if (status === 'norym' && a.rym) return false;
      return !q || a.name.toLowerCase().indexOf(q) > -1;
    });
    matches.sort(byArtistThenYear);
    return matches;
  }

  function selectedIds() {
    return Object.keys(selected).filter(function (id) { return selected[id] && byId(id); });
  }

  // Lives inline in the toolbar rather than as a card that appears and pushes
  // the rows down. The five state actions reuse the glyphs already on every
  // row, so nothing new has to be learned; move-to-genre stays spelled out
  // because it is the one in constant use.
  var BULK_ICONS = [
    ['fav', '★', 'Mark as favorite'],
    ['unfav', '☆', 'Remove from favorites'],
    ['played', '✓', 'Mark played'],
    ['unplayed', '↺', 'Mark unplayed'],
    ['delete', '✕', 'Delete from library']
  ];

  function renderBulkBar() {
    var ids = selectedIds();
    var bar = $('#bulk-bar');
    if (!ids.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML =
      '<span class="bulk-count">' + ids.length + ' selected</span>' +
      '<select id="bulk-genre" title="Genre to move them to">' +
        state.genres.map(function (g) {
          return '<option value="' + esc(g) + '">' + esc(g) + '</option>';
        }).join('') + '</select>' +
      '<button class="btn" type="button" data-bulk="move">Move</button>' +
      '<span class="bulk-sep"></span>' +
      BULK_ICONS.map(function (b) {
        return '<button class="bulk-icon' + (b[0] === 'delete' ? ' del' : '') +
          '" type="button" data-bulk="' + b[0] + '" title="' + esc(b[2]) + ' (' +
          ids.length + ')">' + b[1] + '</button>';
      }).join('') +
      '<span class="bulk-sep"></span>' +
      '<button class="btn btn-quiet" type="button" data-bulk="clear">Clear</button>';
  }

  function renderRows() {
    var matches = currentMatches();

    var shown = matches.slice(0, libLimit);
    var box = $('#lib-rows');
    if (!matches.length) {
      box.innerHTML = '<p class="row-empty">No albums match.</p>';
    } else {
      box.innerHTML = shown.map(function (a) {
        if (a.id === editingId) return editRow(a);
        return '<div class="row' + (a.played ? ' is-played' : '') +
          (selected[a.id] ? ' is-picked' : '') + '" data-id="' + esc(a.id) + '"' +
          ' style="--h:' + hue(a.genre) + '">' +
          '<input type="checkbox" class="row-tick" data-act="tick"' +
            (selected[a.id] ? ' checked' : '') + ' aria-label="Select ' + esc(a.name) + '">' +
          '<span class="row-main">' +
            '<span class="row-name">' + rowName(a) +
              (a.played && a.playedAt ? ' <small>· ' + shortDate(a.playedAt) + '</small>' : '') +
              ' <button type="button" class="ver-btn" data-act="versions"' +
              ' title="Find a different version of this album on Spotify">⇄</button>' + '</span>' +
            candidatePicker(a) +
          '</span>' +
          // The badge hugs its text; the wrapper is what holds the column width,
          // so a long genre name cannot shove the numbers out of alignment.
          '<span class="row-genre"><span class="genre-badge">' + esc(a.genre) + '</span></span>' +
          '<span class="row-year' + (a.year ? '' : ' is-blank') + '" title="Release year">' +
            (a.year || '—') + '</span>' +
          '<span class="row-rym' + (a.rym ? '' : ' is-blank') + '" title="RateYourMusic score">' +
            fmtRym(a.rym) + '</span>' +
          '<span class="row-len' + (a.minutes ? (a.approx ? ' is-approx' : '') : ' is-guess') + '"' +
            ' title="' + esc(lengthNote(a)) + '">' +
            (a.minutes ? (a.approx ? '~' : '') + fmt(a.minutes) : '—') + '</span>' +
          '<span class="row-tracks' + (a.tracks ? '' : ' is-blank') + '"' +
            ' title="Tracks to take from the linked release — trim it to drop the' +
            ' bonus cuts on a deluxe edition">' + (a.tracks || '—') + '</span>' +
          '<span class="row-spid' + (a.spotifyId ? '' : ' is-blank') + '" title="' +
            (a.spotifyId ? esc(a.matchName || a.name) : 'Not linked to Spotify yet') + '">' +
            (a.spotifyId ? esc(a.spotifyId) : '—') + '</span>' +
          '<span class="row-tools">' +
            '<button type="button" data-act="fav" class="' + (a.fav ? 'on' : '') +
              '" title="Toggle favorite">' + (a.fav ? '★' : '☆') + '</button>' +
            '<button type="button" data-act="played" title="' +
              (a.played ? 'Mark unplayed' : 'Mark played') + '">' + (a.played ? '↺' : '✓') + '</button>' +
            '<a ' + spotifyLink(a) +
              ' title="' + (a.spotifyUrl ? 'Open in Spotify' : 'Search Spotify') +
              '" style="text-decoration:none">↗</a>' +
            '<button type="button" data-act="edit" title="Edit artist, album, genre, year, score, tracks or runtime">✎</button>' +
            '<button type="button" data-act="del" class="del" title="Delete">✕</button>' +
          '</span></div>';
      }).join('');
    }

    renderBulkBar();
    var scope = exportScope();
    var exportBtn = $('#lib-export');
    exportBtn.disabled = !scope.rows.length;
    exportBtn.textContent = scope.rows.length
      ? 'Export ' + scope.rows.length + (scope.from === 'selection' ? ' sel.' : '')
      : 'Export CSV';
    exportBtn.title = scope.rows.length
      ? 'Write ' + scope.rows.length + ' album' + (scope.rows.length === 1 ? '' : 's') +
        ' to a CSV file'
      : 'Nothing to export';
    var fetch = fetchScope();
    var fetchBtn = $('#lib-fetch');
    fetchBtn.disabled = !fetch.rows.length || lookupBusy;
    // Terse — the toolbar is eight controls wide and the full phrasing tipped it
    // onto a second line, which costs a row off the list.
    fetchBtn.textContent = fetch.rows.length
      ? 'Fetch ' + fetch.rows.length + (fetch.from === 'selection' ? ' sel.' : '')
      : 'Fetch';
    fetchBtn.title = fetch.rows.length
      ? (fetch.from === 'selection'
          ? 'Re-fetch all ' + fetch.rows.length + ' selected album' +
            (fetch.rows.length === 1 ? '' : 's') + ' from Spotify, overwriting runtime and tracks'
          : 'Search Spotify for the ' + fetch.rows.length + ' album' +
            (fetch.rows.length === 1 ? '' : 's') + ' in view with no link yet')
      : 'Everything in view is already linked to Spotify';

    var allBox = $('#lib-all');
    var pickedHere = matches.filter(function (a) { return selected[a.id]; }).length;
    allBox.checked = matches.length > 0 && pickedHere === matches.length;
    allBox.indeterminate = pickedHere > 0 && pickedHere < matches.length;

    var more = $('#lib-more');
    if (matches.length > shown.length) {
      more.innerHTML = 'Showing ' + shown.length + ' of ' + matches.length +
        ' · <button class="btn btn-quiet" id="show-all">Show all</button>';
      $('#show-all').addEventListener('click', function () { libLimit = 1e6; renderRows(); });
    } else {
      more.textContent = matches.length ? matches.length + ' album' + (matches.length === 1 ? '' : 's') : '';
    }
  }

  // Shift-click extends from the last tick across the current filter order,
  // which is what makes reassigning a run of albums bearable.
  function tickRow(id, shiftHeld) {
    var want = !selected[id];
    if (shiftHeld && lastPicked && lastPicked !== id) {
      var order = currentMatches().map(function (a) { return a.id; });
      var from = order.indexOf(lastPicked);
      var to = order.indexOf(id);
      if (from > -1 && to > -1) {
        if (from > to) { var swap = from; from = to; to = swap; }
        for (var i = from; i <= to; i++) selected[order[i]] = true;
        lastPicked = id;
        return;
      }
    }
    if (want) selected[id] = true; else delete selected[id];
    lastPicked = id;
  }

  function bulkApply(action) {
    var ids = selectedIds();
    if (!ids.length) return;
    var albums = ids.map(byId);
    var word = ids.length + ' album' + (ids.length === 1 ? '' : 's');

    if (action === 'clear') {
      selected = {}; lastPicked = null;
      renderRows();
      return;
    }

    if (action === 'delete') {
      if (!confirm('Delete ' + word + ' from the library? This cannot be undone.')) return;
      albums.forEach(function (a) {
        state.library.splice(state.library.indexOf(a), 1);
        state.deletedSeedIds.push(a.id);   // seed now holds every album, so always tombstone
        if (state.session) {
          state.session.slots = state.session.slots.filter(function (sl) { return sl.albumId !== a.id; });
        }
      });
      selected = {}; lastPicked = null;
      save();
      render();
      toast('Deleted ' + word + '.');
      return;
    }

    if (action === 'move') {
      var genre = $('#bulk-genre').value;
      if (!genre) return;
      albums.forEach(function (a) { a.genre = genre; });
      save();
      render();
      toast('Moved ' + word + ' to ' + genre + '.');
      return;
    }

    if (action === 'fav' || action === 'unfav') {
      albums.forEach(function (a) { a.fav = action === 'fav'; });
    } else if (action === 'played' || action === 'unplayed') {
      var now = today();
      albums.forEach(function (a) {
        a.played = action === 'played';
        a.playedAt = a.played ? now : null;
      });
    } else {
      return;
    }
    save();
    render();
    toast(word + ' updated.');
  }

  function wireBulk() {
    $('#lib-all').addEventListener('change', function () {
      var matches = currentMatches();
      if (this.checked) matches.forEach(function (a) { selected[a.id] = true; });
      else matches.forEach(function (a) { delete selected[a.id]; });
      lastPicked = null;
      renderRows();
    });

    $('#bulk-bar').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-bulk]');
      if (btn) bulkApply(btn.dataset.bulk);
    });
  }

  function wireLibrary() {
    var t = null;
    $('#lib-search').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { libLimit = LIB_LIMIT; renderRows(); }, 120);
    });
    $('#lib-status').addEventListener('change', function () { libLimit = LIB_LIMIT; renderRows(); });

    // Built once — the bands are fixed, so rebuilding them per render would
    // only risk dropping the selection the way the genre select used to.
    $('#lib-rym').innerHTML = bandOptions(RYM_BANDS, function (v) { return v.toFixed(2); }, 'All scores');
    $('#lib-rym').addEventListener('change', function () { libLimit = LIB_LIMIT; renderRows(); });

    $('#lib-length').innerHTML = bandOptions(LENGTH_BANDS, fmt, 'Any length');
    $('#lib-length').addEventListener('change', function () { libLimit = LIB_LIMIT; renderRows(); });
    $('#lib-decade').addEventListener('change', function () { libLimit = LIB_LIMIT; renderRows(); });
    $('#lib-genre').addEventListener('change', function () {
      genreFilter = this.value;
      libLimit = LIB_LIMIT;
      renderSidebarGenres();   // keep the sidebar highlight in step
      renderRows();
    });

    $('#lib-rows').addEventListener('click', function (e) {
      var tick = e.target.closest('.row-tick');
      if (tick) {
        tickRow(tick.closest('.row').dataset.id, e.shiftKey);
        renderRows();
        return;
      }
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var row = btn.closest('.row');
      var a = byId(row.dataset.id);
      if (!a) return;
      var act = btn.dataset.act;

      if (act === 'edit') {
        editingId = a.id;
        renderRows();
        var open = document.querySelector('.row.is-editing .edit-artist');
        if (open) open.focus();
        return;
      }
      if (act === 'cancel-edit') {
        editingId = null;
        renderRows();
        return;
      }

      // Ask Spotify what else it has under this name. Reuses the review picker
      // wholesale — same candidate rows, same pick handler — so choosing a
      // version here goes down the identical path as resolving a bad match.
      if (act === 'versions') {
        if (!spConfigured()) { toast('Add your Spotify credentials in Settings first.'); return; }
        if (lookupBusy) { toast('A lookup is already running.'); return; }
        lookupBusy = true;
        btn.disabled = true;
        btn.textContent = '…';
        spSearchAll(a).then(function (items) {
          lookupBusy = false;
          var ranked = bestMatch(a, items);
          if (!ranked.length) { toast('Spotify has nothing under that name.'); renderRows(); return; }
          a.candidates = ranked.slice(0, 8).map(candidateRow);
          a.match = 'versions';
          save();
          renderRows();
        }, function (err) {
          lookupBusy = false;
          toast('Search failed: ' + err.message);
          renderRows();
        });
        return;
      }

      if (act === 'pick') {
        var cid = btn.dataset.cid;
        var chosen = a.candidates.filter(function (c) { return c.id === cid; })[0];
        btn.disabled = true;
        var item = {
          id: cid,
          name: chosen.name,
          artists: [{ name: chosen.artist }],
          total_tracks: chosen.tracks,
          // Album URLs are a fixed shape, so an older candidate without one
          // stored still ends up with a working link.
          external_urls: { spotify: chosen.url || 'https://open.spotify.com/album/' + cid }
        };
        resolveOne(item).then(function (info) {
          applyMatch(a, item, info);
          a.match = 'manual';
          save();
          render();
          toast(chosen.name + ' · ' + (a.approx ? '~' : '') + fmt(a.minutes));
        }, function (err) {
          btn.disabled = false;
          toast('Lookup failed: ' + err.message);
        });
        return;
      }
      if (act === 'nopick') {
        var browsed = a.match === 'versions';
        a.candidates = null;
        // Backing out of a browse leaves the album exactly as it was; backing
        // out of a genuine miss still records that nothing fitted.
        a.match = browsed ? (a.spotifyId ? 'manual' : null) : 'none';
        save();
        render();
        return;
      }

      if (act === 'fav') {
        a.fav = !a.fav;
      } else if (act === 'played') {
        a.played = !a.played;
        a.playedAt = a.played ? today() : null;
      } else if (act === 'del') {
        if (!confirm('Delete “' + a.name + '” from the library?')) return;
        state.library.splice(state.library.indexOf(a), 1);
        state.deletedSeedIds.push(a.id);   // seed now holds every album, so always tombstone
        if (state.session) {
          state.session.slots = state.session.slots.filter(function (s) { return s.albumId !== a.id; });
        }
      }
      save();
      render(); // played counts and today's cards both depend on this
    });

    $('#lib-rows').addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-act="save"]');
      if (!form) return;
      e.preventDefault();
      var a = byId(form.closest('.row').dataset.id);
      if (!a) return;

      var title = form.querySelector('.edit-title').value.trim();
      if (!title) { toast('An album needs a title.'); return; }
      var artist = form.querySelector('.edit-artist').value.trim();
      var name = composeName(artist, title);

      // Guard against colliding with a different record under the same name.
      var clash = state.library.filter(function (x) {
        return x.id !== a.id && x.name.toLowerCase() === name.toLowerCase();
      })[0];
      if (clash) { toast('“' + name + '” is already in the library.'); return; }

      a.artist = artist;
      a.title = title;
      a.name = name;
      a.genre = form.querySelector('.edit-genre').value;
      a.year = parseYear(form.querySelector('.edit-year').value);
      a.rym = parseRym(form.querySelector('.edit-rym').value);
      a.tracks = parseTracks(form.querySelector('.edit-tracks').value);
      var mins = parseMinutes(form.querySelector('.edit-mins').value);
      a.minutes = mins;
      // A runtime you typed is authoritative; clearing it re-opens the album
      // to the next Spotify lookup.
      if (mins) a.approx = false;

      editingId = null;
      save();
      render();
      toast('Saved “' + name + '”');
    });

    $('#lib-export').addEventListener('click', function () {
      var scope = exportScope();
      if (!scope.rows.length) { toast('Nothing to export.'); return; }
      download(exportName(scope), buildCsv(scope.rows), 'text/csv;charset=utf-8');
      toast('Exported ' + scope.rows.length + ' album' + (scope.rows.length === 1 ? '' : 's') +
        ' from the ' + scope.from + '.');
    });

    $('#lib-fetch').addEventListener('click', function () {
      if (lookupBusy) { toast('A lookup is already running.'); return; }
      if (!spConfigured()) { toast('Add your Spotify credentials in Settings first.'); return; }
      var scope = fetchScope();
      if (!scope.rows.length) { toast('Everything in view is already linked.'); return; }

      lookupBusy = true;
      stopLookup = false;
      var bar = $('#lib-fetch-bar');
      bar.hidden = false;
      $('#lib-fetch').disabled = true;
      $('#lib-fetch-stop').disabled = false;

      var finish = function (text) {
        lookupBusy = false;
        $('#lib-fetch-log').textContent = text;
        render();                 // rows, counts and the button label all move
        $('#lib-fetch-fill').style.width = '100%';
      };

      runLookup(scope.rows, function (stats) {
        $('#lib-fetch-fill').style.width = ((stats.done / stats.total) * 100) + '%';
        var bits = [stats.done + ' of ' + stats.total, stats.auto + ' linked'];
        if (stats.approx) bits.push(stats.approx + ' estimated');
        if (stats.review) bits.push(stats.review + ' to review');
        if (stats.none) bits.push(stats.none + ' not found');
        if (stats.failed) bits.push(stats.failed + ' errored');
        $('#lib-fetch-log').textContent = bits.join(' · ') + (stats.note ? ' — ' + stats.note : '');
      }).then(function (stats) {
        var summary = stats.auto + ' linked' +
          (stats.review ? ', ' + stats.review + ' to review' : '') +
          (stats.none ? ', ' + stats.none + ' not found' : '') +
          (stats.failed ? ', ' + stats.failed + ' errored' : '');
        finish(stats.fatal ? stats.fatal + ' (' + summary + ' this run)' : 'Finished — ' + summary + '.');
        toast(stats.fatal ? 'Stopped: ' + stats.fatal : summary + '.');
      }, function (err) {
        finish('Stopped: ' + err.message);
        toast('Stopped: ' + err.message);
      });
    });

    $('#lib-fetch-stop').addEventListener('click', function () {
      stopLookup = true;
      $('#lib-fetch-stop').disabled = true;
      $('#lib-fetch-log').textContent += ' — stopping…';
    });

    $('#show-add').addEventListener('click', function () {
      var f = $('#add-form');
      f.hidden = !f.hidden;
      if (!f.hidden) $('#add-artist').focus();
    });
    $('#cancel-add').addEventListener('click', function () { $('#add-form').hidden = true; });

    $('#add-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var artist = $('#add-artist').value.trim();
      var title = $('#add-title').value.trim();
      if (!title) return;
      var name = composeName(artist, title);
      var id = 'custom-' + slugOf(name);
      if (byId(id)) { toast('That album is already in the library.'); return; }
      var mins = parseMinutes($('#add-mins').value);
      var genre = $('#add-genre').value;
      state.library.push({
        id: id, name: name, artist: artist, title: title,
        genre: genre, fav: $('#add-fav').checked,
        minutes: mins, approx: false,
        played: false, playedAt: null, custom: true,
        year: parseYear($('#add-year').value), rym: parseRym($('#add-rym').value)
      });
      // Albums get added in runs within one genre, so the next one starts where
      // this one left off instead of jumping back to the top of the list.
      state.settings.lastAddGenre = genre;
      save();
      $('#add-artist').value = '';
      $('#add-title').value = '';
      $('#add-year').value = '';
      $('#add-rym').value = '';
      $('#add-mins').value = '';
      $('#add-fav').checked = false;
      $('#add-artist').focus();
      renderLibrary();
      toast('Added “' + name + '”');
    });
  }

  /* ──────────────────────────── played ──────────────────────────── */

  function renderPlayed() {
    var all = state.library.filter(function (a) { return a.played; });
    var played = genreFilter
      ? all.filter(function (a) { return a.genre === genreFilter; })
      : all;
    $('#played-summary').textContent = !all.length
      ? 'Nothing logged yet.'
      : played.length + ' album' + (played.length === 1 ? '' : 's') +
        (genreFilter ? ' in ' + genreFilter : ' logged');

    var groups = {};
    played.forEach(function (a) {
      var d = a.playedAt || 'unknown';
      (groups[d] = groups[d] || []).push(a);
    });
    var dates = Object.keys(groups).sort().reverse();

    var box = $('#played-list');
    if (!dates.length) {
      box.innerHTML = '<div class="rows"><p class="row-empty">' +
        (genreFilter ? 'Nothing played in ' + esc(genreFilter) + ' yet.'
                     : 'Albums you finish will pile up here.') + '</p></div>';
      return;
    }
    box.innerHTML = dates.map(function (d) {
      var items = groups[d].slice().sort(byArtistThenYear);
      return '<div class="day-group"><h3>' + (d === 'unknown' ? 'Date unknown' : esc(longDate(d))) +
        ' <span>' + items.length + ' album' + (items.length === 1 ? '' : 's') + '</span></h3>' +
        '<div class="rows">' + items.map(function (a) {
          return '<div class="row" data-id="' + esc(a.id) + '" style="--h:' + hue(a.genre) + '">' +
            '<span class="row-name">' + rowName(a) + '</span>' +
            '<span class="genre-badge row-genre">' + esc(a.genre) + '</span>' +
            '<span class="row-tools">' +
              '<a ' + spotifyLink(a) +
                ' title="' + (a.spotifyUrl ? 'Open in Spotify' : 'Search Spotify') +
                '" style="text-decoration:none">↗</a>' +
              '<button type="button" data-act="unplay" title="Put back in the pool">↺</button>' +
            '</span></div>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function wirePlayed() {
    $('#played-list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act="unplay"]');
      if (!btn) return;
      var a = byId(btn.closest('.row').dataset.id);
      if (!a) return;
      a.played = false;
      a.playedAt = null;
      save();
      render();
      toast('“' + a.name + '” is back in the pool.');
    });
  }

  /* ────────────────────────── bulk import ──────────────────────────
   * Two shapes are accepted without asking: a table with recognisable column
   * headings, or the original spreadsheet's layout of one genre per column.
   */

  var HEAD_ARTIST = /^(artist|band|performer)s?$/i;
  var HEAD_TITLE = /^(album|title|record|release)s?$/i;
  var HEAD_GENRE = /^(genre|category|style)s?$/i;
  var HEAD_MINS = /^(runtime|run time|length|duration|min(ute)?s?|time)$/i;
  var HEAD_FAV = /^(fav(ou?rite)?s?|starred)$/i;
  var HEAD_NAME = /^(name|artist ?[-/] ?album|full ?name)$/i;

  var imported = null;   // parsed workbook awaiting confirmation

  // Accepts 42, "42", "42:15", "1:02:30", or an Excel time fraction.
  function readRuntime(raw) {
    var t = String(raw == null ? '' : raw).trim();
    if (!t) return null;
    if (t.indexOf(':') > -1) {
      var parts = t.split(':').map(Number);
      if (parts.some(isNaN)) return null;
      var mins = parts.length === 3
        ? (parts[0] * 60) + parts[1] + (parts[2] / 60)
        : parts[0] + (parts[1] / 60);
      return Math.max(1, Math.min(300, Math.round(mins)));
    }
    var n = Number(t);
    if (isNaN(n) || n <= 0) return null;
    // A cell formatted as a time is stored as a fraction of a day.
    if (n < 1) return Math.max(1, Math.min(300, Math.round(n * 24 * 60)));
    return Math.min(300, Math.round(n));
  }

  function truthy(raw) {
    return /^(y|yes|true|1|x|★|✓)$/i.test(String(raw || '').trim());
  }

  function headerMap(row) {
    var map = {}, hits = 0;
    (row || []).forEach(function (cell, i) {
      var h = String(cell || '').trim();
      if (!h) return;
      if (map.artist === undefined && HEAD_ARTIST.test(h)) { map.artist = i; hits++; }
      else if (map.title === undefined && HEAD_TITLE.test(h)) { map.title = i; hits++; }
      else if (map.genre === undefined && HEAD_GENRE.test(h)) { map.genre = i; hits++; }
      else if (map.mins === undefined && HEAD_MINS.test(h)) { map.mins = i; hits++; }
      else if (map.fav === undefined && HEAD_FAV.test(h)) { map.fav = i; hits++; }
      else if (map.name === undefined && HEAD_NAME.test(h)) { map.name = i; hits++; }
    });
    map.hits = hits;
    return map;
  }

  function splitName(name) {
    var parts = name.split(/s-s|s-(?=S)|(?<=S)-s/);
    if (parts.length < 2 || !parts[0].trim()) return { artist: '', title: name };
    return {
      artist: parts[0].trim(),
      title: name.slice(parts[0].length).replace(/^s*-s*/, '').trim()
    };
  }

  // Columns of albums under a genre heading — the original spreadsheet's shape.
  function readGenreColumns(rows) {
    var out = [];
    var heads = rows[0] || [];
    var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    for (var col = 0; col < width; col++) {
      var genre = String(heads[col] || '').trim();
      if (!genre) continue;
      for (var r = 1; r < rows.length; r++) {
        var cell = String((rows[r] || [])[col] || '').trim();
        if (!cell) continue;
        var split = splitName(cell);
        out.push({ artist: split.artist, title: split.title, name: cell, genre: genre, minutes: null, fav: false });
      }
    }
    return out;
  }

  function readTable(rows, map) {
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var artist = map.artist !== undefined ? String(row[map.artist] || '').trim() : '';
      var title = map.title !== undefined ? String(row[map.title] || '').trim() : '';
      if (!title && map.name !== undefined) {
        var whole = String(row[map.name] || '').trim();
        if (!whole) continue;
        var split = splitName(whole);
        artist = artist || split.artist;
        title = split.title;
      }
      if (!title) continue;
      out.push({
        artist: artist,
        title: title,
        name: composeName(artist, title),
        genre: map.genre !== undefined ? String(row[map.genre] || '').trim() : '',
        minutes: map.mins !== undefined ? readRuntime(row[map.mins]) : null,
        fav: map.fav !== undefined ? truthy(row[map.fav]) : false
      });
    }
    return out;
  }

  function analyseSheet(sheet) {
    var rows = (sheet.rows || []).filter(function (r) { return r && r.join('').trim().length; });
    if (!rows.length) return { layout: 'empty', albums: [] };
    var map = headerMap(rows[0]);
    var tabular = map.hits >= 2 || (map.hits === 1 && (map.title !== undefined || map.name !== undefined));
    return tabular
      ? { layout: 'table', albums: readTable(rows, map), map: map }
      : { layout: 'columns', albums: readGenreColumns(rows) };
  }

  // Splits the parsed rows into what is new, what is already known, and what
  // needs a genre choice before it can be added.
  function planImport(albums, fallbackGenre) {
    var known = {}, seen = {};
    state.library.forEach(function (a) { known[norm(a.name)] = true; });
    var plan = { add: [], dupe: [], unknownGenre: 0 };
    albums.forEach(function (a) {
      var key = norm(a.name);
      if (!key) return;
      if (known[key] || seen[key]) { plan.dupe.push(a); return; }
      seen[key] = true;
      var genre = a.genre;
      if (!genre || state.genres.indexOf(genre) === -1) {
        if (genre && state.genres.indexOf(genre) === -1) plan.newGenre = true;
        else plan.unknownGenre++;
      }
      plan.add.push({
        artist: a.artist, title: a.title, name: a.name,
        genre: genre || fallbackGenre, minutes: a.minutes, fav: a.fav,
        madeUpGenre: !genre
      });
    });
    return plan;
  }

  function commitImport(plan, keepNewGenres) {
    var added = 0;
    plan.add.forEach(function (a) {
      if (keepNewGenres && a.genre && state.genres.indexOf(a.genre) === -1) state.genres.push(a.genre);
      var genre = state.genres.indexOf(a.genre) > -1 ? a.genre : state.genres[0];
      var id = 'custom-' + slugOf(a.name);
      if (byId(id)) return;
      state.library.push({
        id: id, name: a.name, artist: a.artist, title: a.title,
        genre: genre, fav: !!a.fav, minutes: a.minutes || null, approx: false,
        played: false, playedAt: null, custom: true, year: null, rym: null
      });
      added++;
    });
    save();
    return added;
  }

  /* ─────────────────────────── settings ─────────────────────────── */

  function renderSettings() {
    $('#set-target').value = state.settings.targetMinutes / 60;
    $('#set-length').value = state.settings.defaultMinutes;
    $('#set-fav-bonus').checked = !!state.settings.favoritesBonus;
    $('#set-desktop-links').checked = !!state.settings.desktopLinks;

    $('#sync-owner').value = state.sync.owner;
    $('#sync-repo').value = state.sync.repo;
    $('#sync-path').value = state.sync.path;
    $('#sync-branch').value = state.sync.branch;
    $('#sync-token').value = state.sync.token;
    $('#sync-device').value = state.sync.device;
    renderSyncStatus();

    $('#sp-id').value = state.spotify.clientId;
    $('#sp-secret').value = state.spotify.clientSecret;
    renderSpotifyStatus();

    var sel = $('#set-rotation');
    sel.innerHTML = state.genres.map(function (g, i) {
      return '<option value="' + i + '"' + (i === state.rotation ? ' selected' : '') + '>' + esc(g) + '</option>';
    }).join('');

    renderGenreOrder();
  }

  function lengthStats() {
    var known = 0, review = 0, missing = 0, none = 0;
    state.library.forEach(function (a) {
      if (a.minutes) known++;
      else if (a.match === 'review') review++;
      else if (a.match === 'none') none++;
      else missing++;
    });
    return { known: known, review: review, none: none, missing: missing, total: state.library.length };
  }

  function renderSpotifyStatus() {
    var s = lengthStats();
    var bits = [];
    bits.push(s.known + ' of ' + s.total + ' albums have a real running time');
    if (s.review) bits.push(s.review + ' need a look');
    if (s.none) bits.push(s.none + ' not found');
    $('#sp-status').textContent = spConfigured()
      ? bits.join(' · ')
      : 'Not connected — album lengths fall back to the ' + state.settings.defaultMinutes + ' minute estimate.';
    $('#sp-run').disabled = !spConfigured();
    $('#sp-run').textContent = s.missing || s.none
      ? 'Look up ' + (s.missing || s.none) + ' album lengths'
      : 'Look up album lengths';

  }

  function renderGenreOrder() {
    var counts = {};
    state.library.forEach(function (a) { counts[a.genre] = (counts[a.genre] || 0) + 1; });
    $('#genre-order').innerHTML = state.genres.map(function (g, i) {
      var n = counts[g] || 0;
      if (g === deletingGenre) return genreDeleteRow(g, n);
      return '<li draggable="true" data-genre="' + esc(g) + '"' +
        (i === state.rotation ? ' class="cur"' : '') + '>' +
        '<span class="grip" aria-hidden="true">⠿</span>' +
        '<span class="gname" style="--h:' + hue(g) + '">' + esc(g) + '</span>' +
        '<span class="gcount">' + (n ? n + ' album' + (n === 1 ? '' : 's') : 'empty') + '</span>' +
        (i === state.rotation ? '<span class="gnext">next up</span>' : '') +
        '<span class="gmove">' +
          '<button type="button" data-act="g-up" title="Move up"' + (i ? '' : ' disabled') + '>↑</button>' +
          '<button type="button" data-act="g-down" title="Move down"' +
            (i === state.genres.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" data-act="g-del" class="del" title="Delete genre"' +
            (state.genres.length < 2 ? ' disabled' : '') + '>✕</button>' +
        '</span></li>';
    }).join('');
  }

  // The rotation pointer and every slot in an open day are stored as indexes
  // into state.genres, so a reorder has to re-anchor them by name.
  function applyGenreOrder(order) {
    var nameAt = function (i) { return state.genres[i]; };
    var rotationName = nameAt(state.rotation);
    var session = state.session;
    var startName = session ? nameAt(session.startRotation) : null;
    var slotNames = session ? session.slots.map(function (sl) {
      return sl.genreIndex === BONUS ? null : nameAt(sl.genreIndex);
    }) : [];

    state.genres = order.slice();

    var idx = function (name) {
      var i = state.genres.indexOf(name);
      return i > -1 ? i : 0;
    };
    state.rotation = idx(rotationName);
    if (session) {
      session.startRotation = idx(startName);
      session.slots.forEach(function (sl, n) {
        if (sl.genreIndex === BONUS) return;
        sl.genreIndex = idx(slotNames[n]);
      });
    }
    ensureHues();
    save();
  }

  function moveGenre(name, delta) {
    var order = state.genres.slice();
    var from = order.indexOf(name);
    var to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    applyGenreOrder(order);
    renderSettings();
    renderToday();
  }

  function genreDeleteRow(name, count) {
    var others = state.genres.filter(function (g) { return g !== name; });
    var prompt = count
      ? 'Move its ' + count + ' album' + (count === 1 ? '' : 's') + ' to'
      : 'Delete this empty genre?';
    return '<li class="g-confirm" data-genre="' + esc(name) + '">' +
      '<span class="gname" style="--h:' + hue(name) + '">' + esc(name) + '</span>' +
      '<span class="gprompt">' + prompt + '</span>' +
      (count
        ? '<select id="g-move-to">' + others.map(function (g) {
            return '<option value="' + esc(g) + '">' + esc(g) + '</option>';
          }).join('') + '</select>'
        : '') +
      '<button class="btn btn-danger" type="button" data-act="g-del-yes">' +
        (count ? 'Move &amp; delete' : 'Delete') + '</button>' +
      '<button class="btn btn-quiet" type="button" data-act="g-del-no">Cancel</button>' +
    '</li>';
  }

  // Removing a genre shifts every index after it, and an album left pointing at
  // a genre that no longer exists would quietly stop being drawn — so albums are
  // moved first and everything is re-anchored by name afterwards.
  function deleteGenre(name, moveTo) {
    if (state.genres.length < 2) return;
    var nameAt = function (i) { return state.genres[i]; };
    var rotationName = nameAt(state.rotation);
    var session = state.session;
    var startName = session ? nameAt(session.startRotation) : null;
    var slotNames = session ? session.slots.map(function (sl) {
      return sl.genreIndex === BONUS ? null : nameAt(sl.genreIndex);
    }) : [];

    var moved = 0;
    state.library.forEach(function (a) {
      if (a.genre !== name) return;
      a.genre = moveTo;
      moved++;
    });

    state.genres = state.genres.filter(function (g) { return g !== name; });
    // Without this the seed would hand the genre straight back on next load.
    if (!state.deletedGenres) state.deletedGenres = [];
    if (state.deletedGenres.indexOf(name) === -1) state.deletedGenres.push(name);

    var idx = function (n, fallback) {
      var i = state.genres.indexOf(n);
      return i > -1 ? i : fallback;
    };
    var landing = idx(moveTo, 0);
    state.rotation = idx(rotationName, landing);
    if (session) {
      session.startRotation = idx(startName, landing);
      session.slots.forEach(function (sl, n) {
        if (sl.genreIndex === BONUS) return;
        // A card whose genre just vanished follows its album to the new one.
        var album = sl.albumId ? byId(sl.albumId) : null;
        sl.genreIndex = idx(slotNames[n], album ? idx(album.genre, landing) : landing);
      });
    }
    save();
    return moved;
  }

  function wireGenreOrder() {
    var list = $('#genre-order');
    var dragging = null;

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var li = btn.closest('li');
      var name = li.dataset.genre;
      var act = btn.dataset.act;

      if (act === 'g-del') {
        deletingGenre = name;
        renderGenreOrder();
        return;
      }
      if (act === 'g-del-no') {
        deletingGenre = null;
        renderGenreOrder();
        return;
      }
      if (act === 'g-del-yes') {
        var picker = $('#g-move-to');
        var moveTo = picker ? picker.value : state.genres.filter(function (g) { return g !== name; })[0];
        var moved = deleteGenre(name, moveTo);
        deletingGenre = null;
        renderSettings();
        render();
        toast(moved
          ? 'Deleted ' + name + ', moved ' + moved + ' album' + (moved === 1 ? '' : 's') + ' to ' + moveTo + '.'
          : 'Deleted ' + name + '.');
        return;
      }
      if (act === 'g-up' || act === 'g-down') moveGenre(name, act === 'g-up' ? -1 : 1);
    });

    list.addEventListener('dragstart', function (e) {
      dragging = e.target.closest('li');
      if (!dragging) return;
      dragging.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragging.dataset.genre); } catch (ignored) {}
    });

    list.addEventListener('dragover', function (e) {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var over = e.target.closest('li');
      if (!over || over === dragging) return;
      var box = over.getBoundingClientRect();
      var below = (e.clientY - box.top) > box.height / 2;
      list.insertBefore(dragging, below ? over.nextSibling : over);
    });

    list.addEventListener('drop', function (e) { if (dragging) e.preventDefault(); });

    list.addEventListener('dragend', function () {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      var order = [].map.call(list.querySelectorAll('li'), function (li) { return li.dataset.genre; });
      if (order.join('|') === state.genres.join('|')) { renderGenreOrder(); return; }
      applyGenreOrder(order);
      renderSettings();
      renderToday();
      toast('Rotation reordered.');
    });
  }

  function wireSpotify() {
    $('#sp-save').addEventListener('click', function () {
      state.spotify.clientId = $('#sp-id').value.trim();
      state.spotify.clientSecret = $('#sp-secret').value.trim();
      state.spotify.token = null;
      state.spotify.tokenExp = 0;
      save();
      if (!spConfigured()) { renderSpotifyStatus(); toast('Enter both the ID and the secret.'); return; }
      $('#sp-status').textContent = 'Checking…';
      spToken(true).then(function () {
        renderSpotifyStatus();
        toast('Connected to Spotify.');
      }, function (err) {
        $('#sp-status').textContent = 'Spotify rejected those credentials: ' + err.message;
        $('#sp-run').disabled = true;
        toast('Could not connect.');
      });
    });

    $('#sp-probe').addEventListener('click', function () {
      if (!spConfigured()) { toast('Add your credentials first.'); return; }
      var box = $('#sp-probe-out');
      box.hidden = false;
      box.textContent = 'Checking…';
      spProbe().then(function (rows) {
        box.innerHTML = rows.map(function (r) {
          return '<div class="probe-row"><span class="' + (r.ok ? 'probe-ok' : 'probe-no') + '">' +
            (r.ok ? '✓' : '✕') + '</span> ' + esc(r.name) + ' <small>' + esc(r.detail) + '</small></div>';
        }).join('');
      }, function (err) {
        box.textContent = 'Check failed: ' + err.message;
      });
    });

    $('#sp-clear').addEventListener('click', function () {
      state.spotify = { clientId: '', clientSecret: '', token: null, tokenExp: 0 };
      save();
      $('#sp-id').value = '';
      $('#sp-secret').value = '';
      renderSpotifyStatus();
      toast('Credentials removed.');
    });

    $('#sp-run').addEventListener('click', function () {
      var retry = $('#sp-retry').checked;
      var pending = state.library.filter(function (a) { return needsLookup(a, retry); }).length;
      if (!pending) { toast('Nothing left to look up.'); return; }
      if (lookupBusy) { toast('A lookup is already running.'); return; }

      stopLookup = false;
      $('#sp-run').hidden = true;
      $('#sp-stop').hidden = false;
      $('#sp-progress').hidden = false;

      lookupBusy = true;
      runLookup(state.library.filter(function (a) { return needsLookup(a, retry); }), function (stats) {
        $('#sp-fill').style.width = ((stats.done / stats.total) * 100) + '%';
        var bits = [stats.done + ' of ' + stats.total];
        bits.push(stats.auto + ' matched' + (stats.queued ? ' (+' + stats.queued + ' queued)' : ''));
        if (stats.approx) bits.push(stats.approx + ' estimated');
        bits.push(stats.review + ' to review');
        bits.push(stats.none + ' not found');
        if (stats.failed) bits.push(stats.failed + ' errored');
        $('#sp-log').textContent = bits.join(' · ') + (stats.note ? ' — ' + stats.note : '');
      }).then(function (stats) {
        lookupBusy = false;
        $('#sp-run').hidden = false;
        $('#sp-stop').hidden = true;
        $('#sp-fill').style.width = '100%';
        var summary = stats.auto + ' matched' +
          (stats.approx ? ', ' + stats.approx + ' estimated' : '') + ', ' + stats.review +
          ' to review, ' + stats.none + ' not found' +
          (stats.failed ? ', ' + stats.failed + ' errored' : '');
        $('#sp-log').textContent = stats.rateLimited
          ? stats.fatal + ' (' + summary + ' this run)'
          : stats.fatal
            ? 'Stopped after ' + stats.done + ' — ' + stats.fatal
            : 'Finished — ' + summary + '.';
        if (stats.fatal) toast('Stopped: ' + stats.fatal);
        render();
      }, function (err) {
        lookupBusy = false;
        $('#sp-run').hidden = false;
        $('#sp-stop').hidden = true;
        $('#sp-log').textContent = 'Stopped: ' + err.message;
        render();
      });
    });


    $('#sp-stop').addEventListener('click', function () {
      stopLookup = true;
      $('#sp-stop').disabled = true;
      $('#sp-log').textContent += ' — stopping…';
      setTimeout(function () { $('#sp-stop').disabled = false; }, 1500);
    });
  }

  function renderImportPreview() {
    var box = $('#imp-preview');
    if (!imported) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;

    var sheet = imported.sheets[imported.pick];
    var found = analyseSheet(sheet);
    var plan = planImport(found.albums, state.genres[0]);
    imported.plan = plan;

    var sheetPicker = imported.sheets.length > 1
      ? '<select id="imp-sheet">' + imported.sheets.map(function (sh, i) {
          return '<option value="' + i + '"' + (i === imported.pick ? ' selected' : '') + '>' +
            esc(sh.name) + ' (' + (sh.rows ? sh.rows.length : 0) + ' rows)</option>';
        }).join('') + '</select>'
      : '<span class="imp-summary">Sheet <b>' + esc(sheet.name) + '</b></span>';

    var shape = found.layout === 'columns'
      ? 'one genre per column'
      : found.layout === 'table' ? 'a table with headings' : 'nothing readable';

    var notes = [];
    if (plan.dupe.length) notes.push(plan.dupe.length + ' already in your library');
    if (plan.newGenre) notes.push('<span class="imp-warn">new genres will be added</span>');
    if (plan.unknownGenre) notes.push('<span class="imp-warn">' + plan.unknownGenre +
      ' with no genre &rarr; ' + esc(state.genres[0]) + '</span>');

    var rows = plan.add.slice(0, 40).map(function (a) {
      return '<div class="imp-row"><span class="imp-name">' + esc(a.name) + '</span>' +
        '<span class="imp-tag">' + esc(a.genre || '—') +
        (a.minutes ? ' · ' + a.minutes + 'm' : '') + (a.fav ? ' · ★' : '') + '</span></div>';
    }).join('');
    if (plan.add.length > 40) {
      rows += '<div class="imp-row dupe"><span class="imp-name">… and ' +
        (plan.add.length - 40) + ' more</span></div>';
    }

    box.innerHTML =
      '<div class="imp-head">' + sheetPicker +
        '<span class="imp-summary">Read as ' + shape + ' — <b>' + plan.add.length +
        '</b> to add' + (notes.length ? ', ' + notes.join(', ') : '') + '</span></div>' +
      (plan.add.length ? '<div class="imp-table">' + rows + '</div>' : '') +
      '<div class="btn-row">' +
        '<button class="btn btn-primary" id="imp-go"' + (plan.add.length ? '' : ' disabled') + '>' +
          'Add ' + plan.add.length + ' album' + (plan.add.length === 1 ? '' : 's') + '</button>' +
        '<button class="btn btn-quiet" id="imp-cancel">Cancel</button>' +
      '</div>';

    var picker = $('#imp-sheet');
    if (picker) picker.addEventListener('change', function () {
      imported.pick = +this.value;
      renderImportPreview();
    });
    $('#imp-cancel').addEventListener('click', function () {
      imported = null;
      renderImportPreview();
    });
    $('#imp-go').addEventListener('click', function () {
      var n = commitImport(imported.plan, true);
      imported = null;
      render();
      renderImportPreview();
      toast('Added ' + n + ' album' + (n === 1 ? '' : 's') + ' from the spreadsheet.');
    });
  }

  function wireImport() {
    $('#imp-pick').addEventListener('click', function () { $('#imp-file').click(); });
    $('#imp-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      $('#imp-preview').hidden = false;
      $('#imp-preview').textContent = 'Reading ' + file.name + '…';
      SheetImport.read(file).then(function (book) {
        if (!book.sheets.length) throw new Error('That file has no sheets.');
        // Default to the sheet with the most content — the data, not a summary tab.
        var best = 0, bestCells = -1;
        book.sheets.forEach(function (sh, i) {
          var cells = (sh.rows || []).reduce(function (n, r) { return n + r.filter(Boolean).length; }, 0);
          if (cells > bestCells) { bestCells = cells; best = i; }
        });
        imported = { sheets: book.sheets, pick: best, file: file.name };
        renderImportPreview();
      }, function (err) {
        imported = null;
        $('#imp-preview').hidden = false;
        $('#imp-preview').textContent = 'Could not read that file: ' + err.message;
      });
    });
  }

  function wireSettings() {
    $('#set-target').addEventListener('change', function () {
      var h = Math.max(0.5, Math.min(24, +this.value || 8));
      this.value = h;
      state.settings.targetMinutes = Math.round(h * 60);
      if (state.session) {
        trimCoverage(state.session);
        ensureCoverage(state.session);
      }
      save();
      renderToday();
    });

    $('#set-length').addEventListener('change', function () {
      state.settings.defaultMinutes = Math.max(5, Math.min(200, +this.value || 45));
      this.value = state.settings.defaultMinutes;
      save();
    });

    $('#set-desktop-links').addEventListener('change', function () {
      state.settings.desktopLinks = this.checked;
      save();
      render();   // every link on every tab is rebuilt from this
      toast(this.checked ? 'Links open in the Spotify app.' : 'Links open the web player.');
    });

    $('#set-fav-bonus').addEventListener('change', function () {
      state.settings.favoritesBonus = this.checked;
      // The cadence fixes which positions are favourites across the whole day,
      // so it cannot be patched into a run that is already drawn. Redraw when
      // nothing has been picked yet, and otherwise leave today alone.
      var s = state.session;
      var picked = s ? s.slots.filter(function (x) { return x.added; }).length : 0;
      if (s && !picked) {
        state.session = null;
      } else if (picked) {
        toast('Applies from tomorrow — today already has ' + picked +
          ' album' + (picked === 1 ? '' : 's') + ' picked.');
      }
      save();
      renderToday();
    });

    $('#set-rotation').addEventListener('change', function () {
      state.rotation = +this.value;
      if (state.session && !state.session.slots.some(function (x) { return x.added; })) {
        state.session = null; // redraw the untouched day from the new start point
      }
      save();
      renderSettings();
      renderToday();
      toast('Next day starts with ' + state.genres[state.rotation] + '.');
    });

    $('#genre-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#new-genre').value.trim();
      if (!name) return;
      if (state.genres.indexOf(name) > -1) { toast('That genre already exists.'); return; }
      state.genres.push(name);
      if (state.deletedGenres) {
        state.deletedGenres = state.deletedGenres.filter(function (g) { return g !== name; });
      }
      ensureHues();
      $('#new-genre').value = '';
      save();
      renderSettings();
      renderLibrary();
      toast('Added ' + name + ' to the rotation.');
    });

    $('#export-json').addEventListener('click', function () {
      download('album-randomizer-' + today() + '.json', JSON.stringify(state, null, 1));
      toast('Exported.');
    });
    $('#copy-json').addEventListener('click', function () {
      copyText(JSON.stringify(state), 'Backup JSON copied.');
    });
    $('#import-json').addEventListener('click', function () { $('#import-file').click(); });
    $('#import-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          if (!data || !Array.isArray(data.library)) throw new Error('bad shape');
          if (!confirm('Replace the current library with ' + data.library.length + ' albums from this file?')) return;
          var keepSpotify = state.spotify;
          state = data;
          if (!state.settings) state.settings = defaults().settings;
          if (!state.genres || !state.genres.length) state.genres = SEED.genres.slice();
          if (!state.deletedSeedIds) state.deletedSeedIds = [];
          if (!state.spotify || !state.spotify.clientId) state.spotify = keepSpotify;
          mergeSeed(state);
          backfill(state);
          save();
          applyTheme();
          render();
          toast('Imported ' + state.library.length + ' albums.');
        } catch (err) {
          toast('That file is not an Album Randomizer export.');
        }
      };
      reader.readAsText(file);
      this.value = '';
    });

    $('#clear-played').addEventListener('click', function () {
      var n = state.library.filter(function (a) { return a.played; }).length;
      if (!n) { toast('Nothing is marked played.'); return; }
      if (!confirm('Put all ' + n + ' played albums back in the pool?')) return;
      state.library.forEach(function (a) { a.played = false; a.playedAt = null; });
      save();
      render();
      toast('All ' + n + ' albums are back in rotation.');
    });

    $('#reset-all').addEventListener('click', function () {
      if (!confirm('Wipe played history, custom albums, looked-up lengths and today’s picks, ' +
        'and reload the original spreadsheet? Your Spotify credentials are kept.')) return;
      var theme = state.settings.theme;
      var spotify = state.spotify;
      state = defaults();
      state.settings.theme = theme;
      state.spotify = spotify;
      mergeSeed(state);
      save();
      render();
      toast('Reset to the spreadsheet library.');
    });
  }

  /* ──────────────────────────── shell ──────────────────────────── */


  function renderSyncStatus() {
    var el = document.getElementById('sync-status');
    if (!el) return;
    var s = state.sync;
    if (!syncConfigured()) {
      el.className = 'sync-status';
      el.textContent = 'Not connected — this device keeps its own copy.';
    } else {
      var label = {
        idle: 'In sync', pending: 'Saving shortly…', pulling: 'Pulling…',
        pushing: 'Saving…', conflict: 'Conflict', error: 'Problem'
      }[syncState] || syncState;
      el.className = 'sync-status is-' + syncState;
      el.textContent = label + (syncNote ? ' — ' + syncNote : '') +
        (s.remoteAt ? '  ·  repo copy ' + new Date(s.remoteAt).toLocaleString() : '');
    }
    var conflict = syncState === 'conflict';
    var push = document.getElementById('sync-push');
    if (push) push.textContent = conflict ? 'Overwrite repo copy' : 'Push now';
  }

  function wireSync() {
    var f = function (id) { return document.getElementById(id); };

    f('sync-save').addEventListener('click', function () {
      state.sync.owner = f('sync-owner').value.trim();
      state.sync.repo = f('sync-repo').value.trim();
      state.sync.path = f('sync-path').value.trim() || 'library.json';
      state.sync.branch = f('sync-branch').value.trim() || 'main';
      state.sync.token = f('sync-token').value.trim();
      state.sync.device = f('sync-device').value.trim() || guessDeviceName();
      state.sync.sha = null;
      save(true);
      if (!syncConfigured()) { renderSyncStatus(); toast('Owner, repo and token are all needed.'); return; }
      syncNote = 'Connecting…';
      renderSyncStatus();
      syncPull(true).then(function (got) {
        if (got) { toast('Connected — library loaded from GitHub.'); return; }
        if (syncState === 'error') { toast('Could not connect: ' + syncNote); return; }
        // Empty repo file: seed it from what this device already has.
        syncPush(true).then(function (ok) {
          toast(ok ? 'Connected — this library is now the repo copy.' : 'Could not write: ' + syncNote);
        });
      });
    });

    f('sync-pull').addEventListener('click', function () {
      if (!syncConfigured()) { toast('Fill in the repository and token first.'); return; }
      syncPull(false);
    });

    f('sync-push').addEventListener('click', function () {
      if (!syncConfigured()) { toast('Fill in the repository and token first.'); return; }
      clearTimeout(syncTimer);
      var forcing = syncState === 'conflict';
      if (forcing && !confirm('Overwrite the repo copy with this device\'s library?\n\n' +
        'Anything saved from another device since this one loaded will be lost.')) return;
      if (forcing) {
        // Take the current sha so the write is accepted, then overwrite.
        ghFetch(ghUrl('?ref=' + encodeURIComponent(state.sync.branch || 'main')),
          { headers: ghHeaders() }).then(function (meta) {
            state.sync.sha = meta.missing ? null : meta.sha;
            syncPush(true).then(function (ok) { if (ok) toast('Repo copy overwritten.'); });
          }, function () { syncPush(true); });
      } else {
        syncPush(false).then(function (ok) { if (ok) toast('Pushed to GitHub.'); });
      }
    });

    f('sync-forget').addEventListener('click', function () {
      state.sync.token = '';
      state.sync.sha = null;
      f('sync-token').value = '';
      save(true);
      syncState = 'idle';
      syncNote = '';
      renderSyncStatus();
      toast('Token removed from this device.');
    });

    // Coming back to the tab is the moment another device's changes matter.
    window.addEventListener('focus', function () {
      if (syncConfigured() && syncState !== 'conflict' && !syncBusy) syncPull(true);
    });

    // A queued push cannot be completed during unload: sendBeacon cannot carry
    // an Authorization header, and the payload is far past what keepalive
    // allows. So ask, rather than pretend.
    window.addEventListener('beforeunload', function (e) {
      if (syncPending() ) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme;
  }

  // Collapsing hides the sidebar outright, so the tabs move up into the top bar
  // rather than disappearing with it — otherwise there is no way to navigate,
  // or to get the sidebar back from another view.
  function applySidebar() {
    var collapsed = !!state.settings.sidebarCollapsed;
    var nav = $('.tabs');
    document.body.dataset.sidebar = collapsed ? 'collapsed' : 'open';
    $('#sidebar-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (collapsed) $('.topbar').insertBefore(nav, $('#theme-toggle'));
    else $('.sidebar').insertBefore(nav, $('#side-genres'));
  }

  function show(name) {
    ['today', 'library', 'played', 'settings'].forEach(function (v) {
      $('#view-' + v).hidden = v !== name;
    });
    document.querySelectorAll('.tab').forEach(function (t) {
      t.setAttribute('aria-selected', t.dataset.view === name ? 'true' : 'false');
    });
    // The library sizes itself to the window and scrolls its own list; the other
    // views scroll the page normally. This is what lets the CSS tell them apart.
    document.body.dataset.view = name;
    renderSidebarGenres();   // the counts mean different things per view
    // Both views read the same genre filter, so the one being switched to has
    // to be redrawn — it may have been filtered from the other.
    if (name === 'library') renderRows();
    else if (name === 'played') renderPlayed();
    try { location.hash = name; } catch (e) { /* ignore */ }
  }

  function render() {
    renderToday();
    renderLibrary();
    renderPlayed();
    renderSettings();
    renderSidebarGenres();
  }

  function init() {
    state = load();
    applyTheme();
    applySidebar();

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { show(t.dataset.view); });
    });

    // One filter shared by both views, so switching tabs keeps your focus.
    $('#genre-list').addEventListener('click', function (e) {
      var item = e.target.closest('.gitem');
      if (!item) return;
      genreFilter = genreFilter === item.dataset.genre ? '' : item.dataset.genre;
      libLimit = LIB_LIMIT;
      $('#lib-genre').value = genreFilter;   // the other face of the same filter
      renderSidebarGenres();
      if (document.body.dataset.view === 'played') renderPlayed();
      else renderRows();
    });
    $('#sidebar-toggle').addEventListener('click', function () {
      state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
      applySidebar();
      save();
    });
    $('#theme-toggle').addEventListener('click', function () {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      save();
    });

    wireToday();
    wireLibrary();
    wirePlayed();
    wireSettings();
    wireSpotify();
    wireImport();
    wireGenreOrder();
    wireBulk();
    wireSync();

    render();
    save();

    // Pull straight away so a device that has been away starts current.
    if (syncConfigured()) syncPull(true);

    var hash = (location.hash || '').replace('#', '');
    show(['today', 'library', 'played', 'settings'].indexOf(hash) > -1 ? hash : 'today');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
