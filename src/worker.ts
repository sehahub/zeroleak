// Serves the static site and three small endpoints. No document ever reaches
// this code — scanning and cleaning happen entirely in the visitor's browser.
interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  DB?: D1Database;
}

const EMAIL = /^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$/;

/** The only event names that can ever be stored. Anything else is dropped, so
 *  this endpoint cannot be turned into a place to put arbitrary text. */
const EVENTS = new Set(['scan', 'scan-failed', 'clean']);

const today = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/subscribe') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }
      if (!env.DB) return new Response('not configured', { status: 503 });

      let body: { email?: unknown; note?: unknown; source?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response('bad request', { status: 400 });
      }
      const email = body.email;
      if (typeof email !== 'string' || !EMAIL.test(email.trim()) || email.length > 254) {
        return new Response('invalid address', { status: 400 });
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null;
      const source = typeof body.source === 'string' ? body.source.slice(0, 120) : null;

      try {
        await env.DB.prepare(
          'INSERT INTO subscribers (email, created_at, note, source) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(email) DO UPDATE SET note = COALESCE(NULLIF(excluded.note, \'\'), subscribers.note)',
        )
          .bind(email.trim().toLowerCase(), new Date().toISOString(), note, source)
          .run();
      } catch {
        return new Response('could not save', { status: 500 });
      }
      return new Response(null, { status: 204 });
    }

    // An aggregate page counter. No cookie, no IP, no visitor identifier, and
    // nothing about any document — scanning never reaches this code at all.
    if (url.pathname === '/api/hit') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!env.DB) return new Response(null, { status: 204 });
      try {
        const body = (await request.json()) as { path?: unknown; ref?: unknown };
        const path = typeof body.path === 'string' ? body.path.slice(0, 120) : '/';
        const ref = typeof body.ref === 'string' ? body.ref.slice(0, 80) : '';
        await env.DB.prepare(
          'INSERT INTO hits (day, path, ref, n) VALUES (?, ?, ?, 1) ' +
          'ON CONFLICT(day, path, ref) DO UPDATE SET n = n + 1',
        ).bind(today(), path, ref).run();
      } catch { /* a missed count is not worth an error */ }
      return new Response(null, { status: 204 });
    }

    // Three tallies: a scan finished, a scan failed, a file was cleaned. The
    // name is checked against the fixed list above and the request carries
    // nothing else, so no property of any document can arrive here.
    if (url.pathname === '/api/event') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!env.DB) return new Response(null, { status: 204 });
      try {
        const body = (await request.json()) as { name?: unknown };
        if (typeof body.name !== 'string' || !EVENTS.has(body.name)) {
          return new Response('unknown event', { status: 400 });
        }
        await env.DB.prepare(
          'INSERT INTO events (day, name, n) VALUES (?, ?, 1) ' +
          'ON CONFLICT(day, name) DO UPDATE SET n = n + 1',
        ).bind(today(), body.name).run();
      } catch { /* a missed count is not worth an error */ }
      return new Response(null, { status: 204 });
    }

    return env.ASSETS.fetch(request);
  },
};
