/* Album Randomizer — relay (Cloudflare Worker).
 *
 * GitHub Pages only hands out files, so the browser used to hold every
 * credential itself: the database password, the Spotify client secret, the
 * Spotify account connection. Each new browser had to be set up by hand. This
 * Worker holds all of them instead. The app calls the Worker; the Worker calls
 * Neon and Spotify; no browser ever needs setting up.
 *
 * Its address is public, so it is built to be harmless to find:
 *
 *   Database  runs only the statements below, never SQL a caller sends.
 *             Someone could edit the album library — accepted — but not run
 *             arbitrary queries or run up the compute bill.
 *   Spotify   reads only what the app reads, and the one write it will make is
 *             replacing the contents of the single playlist named in its
 *             settings. The account connection never leaves the Worker, so
 *             there is no token for anyone to lift and use elsewhere.
 *
 * No credential may go in this file or in the app: the repository is public,
 * and Neon scans public repositories for its credentials and can revoke them.
 *
 * Settings (Worker → Settings → Variables and Secrets):
 *   NEON_URL                secret  album_app connection string
 *   SPOTIFY_CLIENT_ID       text    from the Spotify dashboard
 *   SPOTIFY_CLIENT_SECRET   secret  from the Spotify dashboard
 *   SPOTIFY_USER_ID         text    the only Spotify account allowed to connect
 *   SPOTIFY_TODAY_PLAYLIST  text    id of the one playlist it may write to
 * Binding (Worker → Settings → Bindings):
 *   SPOTIFY_KV              KV namespace holding the account connection
 *
 * The push and pull statements mirror NEON_PUSH_SQL and NEON_PULL_SQL in
 * app.js, which a browser still uses if the relay address is ever blanked.
 * Change one, change both.
 */

/* ═══════════════════════════════ database ═══════════════════════════════ */

const SQL = {
  version: 'select version from randomizer.state where id = true',

  test: [
    'select current_user as who,',
    '  (select count(*) from randomizer.albums) as albums,',
    '  (select count(*) from randomizer.meta) as meta,',
    '  (select version from randomizer.state where id = true) as version'
  ].join('\n'),

  pull: [
    'select',
    "  (select coalesce(jsonb_agg(doc order by id), '[]'::jsonb) from randomizer.albums) as albums,",
    "  (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from randomizer.meta) as meta,",
    '  (select version from randomizer.state where id = true) as version,',
    '  (select device  from randomizer.state where id = true) as device,',
    '  (select updated_at from randomizer.state where id = true) as updated_at'
  ].join('\n'),

  // One statement, so a push can never half-apply. The version guard gates
  // every other branch: if another device has saved since this one loaded,
  // nothing is written and version comes back null.
  push: [
    'with bump as (',
    '  update randomizer.state set version = version + 1, device = $4, updated_at = now()',
    '  where id = true and ($3::bigint < 0 or version = $3::bigint)',
    '  returning version',
    '), ups as (',
    '  insert into randomizer.albums (id, doc, updated_at)',
    '  select x.id, x.doc, now()',
    '  from jsonb_to_recordset($1::jsonb) as x(id text, doc jsonb)',
    '  where exists (select 1 from bump)',
    '  on conflict (id) do update set doc = excluded.doc, updated_at = now()',
    '  returning 1',
    '), dels as (',
    '  delete from randomizer.albums',
    '  where exists (select 1 from bump)',
    '    and id in (select jsonb_array_elements_text($2::jsonb))',
    '  returning 1',
    '), mets as (',
    '  insert into randomizer.meta (key, value, updated_at)',
    '  select x.key, x.value, now()',
    '  from jsonb_to_recordset($5::jsonb) as x(key text, value jsonb)',
    '  where exists (select 1 from bump)',
    '  on conflict (key) do update set value = excluded.value, updated_at = now()',
    '  returning 1',
    ')',
    'select (select version from bump) as version,',
    '       (select count(*) from ups)  as upserted,',
    '       (select count(*) from dels) as deleted,',
    '       (select count(*) from mets) as metas'
  ].join('\n'),

  // A genre hour draws tracks that have not played lately, so it needs the day
  // each one last played. Its own table rather than the library: these are
  // tracks from the genre playlists, not albums, and the row count grows with
  // listening rather than with the library.
  plays: [
    'select id, genre, artist, title,',
    '  floor(extract(epoch from played_at))::bigint as at',
    'from randomizer.track_plays'
  ].join('\n'),

  logplays: [
    'with ins as (',
    '  insert into randomizer.track_plays (id, genre, artist, title, played_at)',
    '  select x.id, x.genre, x.artist, x.title, now()',
    '  from jsonb_to_recordset($1::jsonb) as x(id text, genre text, artist text, title text)',
    '  on conflict (id) do update set genre = excluded.genre, artist = excluded.artist,',
    '    title = excluded.title, played_at = now()',
    '  returning 1',
    ')',
    'select count(*) as logged from ins'
  ].join('\n')
};

// Which statements carry parameters.
const TAKES_PARAMS = { push: true, logplays: true };

async function database(op, request, env) {
  if (TAKES_PARAMS[op] && request.method !== 'POST') {
    return reply(405, { message: op + ' needs a POST' });
  }
  if (!env.NEON_URL) return reply(500, { message: 'The Worker has no NEON_URL secret set.' });
  const host = (String(env.NEON_URL).match(/@([^\/?]+)/) || [])[1];
  if (!host) return reply(500, { message: 'NEON_URL has no host in it.' });

  // Parameters pass through as text. Parsing a megabyte-sized push into
  // objects and back would spend the free plan's CPU allowance on nothing.
  let params = '[]';
  if (TAKES_PARAMS[op]) {
    params = (await request.text()).trim();
    if (params.charAt(0) !== '[') {
      return reply(400, { message: op + ' expects a JSON array of parameters' });
    }
  }
  const body = '{"query":' + JSON.stringify(SQL[op]) + ',"params":' + params + '}';

  let res;
  try {
    res = await fetch('https://' + host.split(':')[0] + '/sql', {
      method: 'POST',
      headers: { 'Neon-Connection-String': env.NEON_URL, 'Neon-Raw-Text-Output': 'true' },
      body: body
    });
  } catch (e) {
    return reply(502, { message: 'Could not reach Neon: ' + (e && e.message || e) });
  }
  // Streamed straight back, for the same reason the push is not parsed.
  return new Response(res.body, { status: res.status, headers: withCors({ 'Content-Type': 'application/json' }) });
}

/* ═══════════════════════════════ spotify ════════════════════════════════ */

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const SCOPES = 'playlist-read-private playlist-modify-private playlist-modify-public';
const ID = /^[A-Za-z0-9]{22}$/;
const URI = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;
const MAX_URIS = 100;    // Spotify's own limit per playlist write

// The reads the app makes, and nothing else. Anything not described here is
// refused before it reaches Spotify.
function readAllowed(path) {
  if (typeof path !== 'string' || path.charAt(0) !== '/' || path.indexOf('//') > -1) return false;
  let u;
  try { u = new URL('https://relay' + path); } catch (e) { return false; }
  const p = u.pathname, q = u.searchParams;
  let m;
  if (p === '/search') {
    return q.get('type') === 'album' && q.has('q') && Number(q.get('limit') || 10) <= 10;
  }
  if (p === '/albums') {
    const ids = (q.get('ids') || '').split(',');
    return ids.length >= 1 && ids.length <= 20 && ids.every(function (i) { return ID.test(i); });
  }
  if ((m = p.match(/^\/albums\/([^/]+)$/))) return ID.test(m[1]);
  if ((m = p.match(/^\/albums\/([^/]+)\/tracks$/))) return ID.test(m[1]);
  if (p === '/me/playlists') return true;
  if ((m = p.match(/^\/playlists\/([^/]+)\/items$/))) return ID.test(m[1]);
  return false;
}

function spotifyError(status, message) {
  // Spotify's own error shape, so the app reports relay refusals the same way.
  return reply(status, { error: { status: status, message: message } });
}

function notConfigured(env) {
  const missing = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_USER_ID',
                   'SPOTIFY_TODAY_PLAYLIST'].filter(function (k) { return !env[k]; });
  if (!env.SPOTIFY_KV) missing.push('SPOTIFY_KV binding');
  return missing.length ? missing : null;
}

function tokenRequest(env, fields) {
  return fetch(ACCOUNTS + '/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET)
    },
    body: new URLSearchParams(fields).toString()
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
}

// The connection lives in KV. An access token is kept in memory as well, so a
// busy stretch does not read KV on every call.
let cached = null;

class NotConnected extends Error {}

async function accessToken(env, force) {
  const now = Date.now();
  if (!force && cached && cached.exp > now + 60000) return cached.access;
  const saved = JSON.parse((await env.SPOTIFY_KV.get('auth')) || 'null');
  if (!saved || !saved.refresh) throw new NotConnected('Spotify is not connected to the relay yet.');
  if (!force && saved.access && saved.exp > now + 60000) { cached = saved; return saved.access; }

  const res = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: saved.refresh });
  if (!res.ok || !res.body.access_token) {
    cached = null;
    throw new NotConnected('Spotify refused the relay’s connection (' +
      (res.body.error_description || res.body.error || 'unknown') + '). Connect it again.');
  }
  // Spotify sometimes issues a new refresh token; the old one may then stop
  // working, so the replacement is saved before anything else happens.
  const next = {
    refresh: res.body.refresh_token || saved.refresh,
    access: res.body.access_token,
    exp: now + (res.body.expires_in || 3600) * 1000,
    user: saved.user
  };
  await env.SPOTIFY_KV.put('auth', JSON.stringify(next));
  cached = next;
  return next.access;
}

async function callSpotify(env, method, url, body) {
  let tok = await accessToken(env, false);
  const opts = function (t) {
    const o = { method: method, headers: { Authorization: 'Bearer ' + t } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = body; }
    return o;
  };
  let res = await fetch(url, opts(tok));
  if (res.status === 401) {
    // Revoked or expired early: refresh once, then give up.
    tok = await accessToken(env, true);
    res = await fetch(url, opts(tok));
  }
  const headers = withCors({ 'Content-Type': 'application/json' });
  const wait = res.headers.get('Retry-After');
  if (wait) headers['Retry-After'] = wait;
  return new Response(res.body, { status: res.status, headers: headers });
}

function page(status, title, text) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
    '<body style="font:16px system-ui;max-width:34em;margin:4em auto;padding:0 1em;line-height:1.5">' +
    '<h1 style="font-size:1.3em">' + title + '</h1><p>' + text + '</p>',
    { status: status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function spotify(route, request, env) {
  const url = new URL(request.url);
  const missing = notConfigured(env);

  // What the app asks on load. Nothing secret in it.
  if (route === 'status') {
    if (missing) return reply(200, { connected: false, configured: false, missing: missing });
    const saved = JSON.parse((await env.SPOTIFY_KV.get('auth')) || 'null');
    return reply(200, { connected: !!(saved && saved.refresh), configured: true,
                        user: env.SPOTIFY_USER_ID, playlist: env.SPOTIFY_TODAY_PLAYLIST,
                        login: url.origin + '/spotify/login' });
  }

  if (missing) {
    if (route === 'login' || route === 'callback') {
      return page(500, 'Relay not set up', 'The Worker is missing: ' + missing.join(', ') + '.');
    }
    return spotifyError(503, 'The relay is missing Spotify settings: ' + missing.join(', '));
  }

  // Connecting happens once, ever, in a normal browser tab. Anyone could start
  // it; only the account named in SPOTIFY_USER_ID is ever kept.
  if (route === 'login') {
    const st = randomState();
    await env.SPOTIFY_KV.put('state:' + st, '1', { expirationTtl: 600 });
    const to = ACCOUNTS + '/authorize?' + new URLSearchParams({
      client_id: env.SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: url.origin + '/spotify/callback',
      scope: SCOPES,
      state: st
    }).toString();
    return Response.redirect(to, 302);
  }

  if (route === 'callback') {
    const code = url.searchParams.get('code');
    const st = url.searchParams.get('state') || '';
    if (url.searchParams.get('error')) {
      return page(400, 'Not connected', 'Spotify said: ' + url.searchParams.get('error') + '.');
    }
    if (!code || !st || !(await env.SPOTIFY_KV.get('state:' + st))) {
      return page(400, 'Not connected', 'That sign-in reply was not started here, or it expired. ' +
        'Open <a href="/spotify/login">/spotify/login</a> again.');
    }
    await env.SPOTIFY_KV.delete('state:' + st);

    const res = await tokenRequest(env, {
      grant_type: 'authorization_code', code: code, redirect_uri: url.origin + '/spotify/callback'
    });
    if (!res.ok || !res.body.refresh_token) {
      return page(400, 'Not connected', 'Spotify would not exchange the sign-in (' +
        (res.body.error_description || res.body.error || 'unknown') + ').');
    }
    const me = await fetch(API + '/me', { headers: { Authorization: 'Bearer ' + res.body.access_token } })
      .then(function (r) { return r.ok ? r.json() : null; });
    if (!me || me.id !== env.SPOTIFY_USER_ID) {
      return page(403, 'Not connected', 'That is not the Spotify account this relay belongs to, so ' +
        'nothing was saved.');
    }
    const next = { refresh: res.body.refresh_token, access: res.body.access_token,
                   exp: Date.now() + (res.body.expires_in || 3600) * 1000, user: me.id };
    await env.SPOTIFY_KV.put('auth', JSON.stringify(next));
    cached = next;
    return page(200, 'Spotify connected', 'Connected as <b>' + me.id + '</b>. Every browser running ' +
      'the Album Randomizer can now use Spotify. You can close this tab.');
  }

  try {
    // Reads: GET only, and only the paths the app uses.
    if (route === 'api') {
      if (request.method !== 'GET') return spotifyError(405, 'Reads use GET.');
      const path = url.searchParams.get('path');
      if (!readAllowed(path)) return spotifyError(403, 'The relay does not allow that request.');
      return await callSpotify(env, 'GET', API + path);
    }

    // The single write: replace or extend the one playlist in the settings.
    if (route === 'today/replace' || route === 'today/append') {
      if (request.method !== 'POST') return spotifyError(405, 'Writes use POST.');
      let parsed;
      try { parsed = JSON.parse(await request.text()); } catch (e) { parsed = null; }
      const uris = parsed && parsed.uris;
      if (!Array.isArray(uris) || uris.length > MAX_URIS ||
          !uris.every(function (u) { return typeof u === 'string' && URI.test(u); })) {
        return spotifyError(400, 'Expected { uris: [...] } with at most ' + MAX_URIS + ' track URIs.');
      }
      if (route === 'today/append' && !uris.length) return spotifyError(400, 'Nothing to add.');
      return await callSpotify(env, route === 'today/replace' ? 'PUT' : 'POST',
        API + '/playlists/' + env.SPOTIFY_TODAY_PLAYLIST + '/items', JSON.stringify({ uris: uris }));
    }
  } catch (e) {
    if (e instanceof NotConnected) return spotifyError(409, e.message);
    return spotifyError(502, 'Could not reach Spotify: ' + (e && e.message || e));
  }

  return spotifyError(404, 'Unknown Spotify operation "' + route + '".');
}

/* ════════════════════════════════ shared ════════════════════════════════ */

// Nothing here is private, so any page may call it. The app sends plain-text
// POSTs and plain GETs, which keeps the browser from preflighting at all;
// OPTIONS is answered anyway for anything that does.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400'
};

function withCors(headers) { return Object.assign(headers || {}, CORS); }

function reply(status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status, headers: withCors({ 'Content-Type': 'application/json' })
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const route = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');
    if (route.indexOf('spotify/') === 0) return spotify(route.slice(8), request, env);
    if (Object.prototype.hasOwnProperty.call(SQL, route)) return database(route, request, env);
    return reply(404, { message: 'Unknown operation "' + route + '". Try /test or /spotify/status.' });
  }
};
