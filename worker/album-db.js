/* Album Randomizer — database relay (Cloudflare Worker).
 *
 * GitHub Pages only hands out files, so the browser used to talk to Neon
 * directly, and every new browser needed the database password pasted into it.
 * This Worker holds the password instead: the app calls the Worker, the Worker
 * calls Neon, and no browser ever needs setting up.
 *
 * It runs only the four statements below and never SQL sent by a caller. Its
 * address is public, so anyone who found it could edit the library — accepted,
 * since nobody else uses this app — but nobody can run arbitrary queries
 * through it or run up the compute bill.
 *
 * The password must never go in this file or in the app. Neon scans public
 * GitHub repositories for its own credentials and can revoke one it finds.
 * It lives in the Worker's settings as a secret called NEON_URL.
 *
 * The push and pull statements mirror NEON_PUSH_SQL and NEON_PULL_SQL in
 * app.js, which a browser still uses if the relay address is ever blanked.
 * Change one, change both.
 */

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
  ].join('\n')
};

// Only a push carries parameters.
const TAKES_PARAMS = { push: true };

// Nothing here is private, so any page may call it. The app sends its body as
// plain text, which keeps the browser from preflighting at all; OPTIONS is
// answered anyway for anything that does.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400'
};

function reply(status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const op = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');
    if (!Object.prototype.hasOwnProperty.call(SQL, op)) {
      return reply(404, { message: 'Unknown operation "' + op + '". Try /test.' });
    }
    if (TAKES_PARAMS[op] && request.method !== 'POST') {
      return reply(405, { message: op + ' needs a POST' });
    }
    if (!env.NEON_URL) {
      return reply(500, { message: 'The Worker has no NEON_URL secret set.' });
    }
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
        headers: {
          'Neon-Connection-String': env.NEON_URL,
          'Neon-Raw-Text-Output': 'true'
        },
        body: body
      });
    } catch (e) {
      return reply(502, { message: 'Could not reach Neon: ' + (e && e.message || e) });
    }

    // Streamed straight back, for the same reason the push is not parsed.
    return new Response(res.body, {
      status: res.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
    });
  }
};
