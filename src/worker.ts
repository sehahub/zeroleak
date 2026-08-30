// Serves the static site and one tiny endpoint. No document ever reaches this
// code — scanning happens entirely in the visitor's browser.
interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  DB?: D1Database;
}

const EMAIL = /^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/subscribe') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }
      if (!env.DB) return new Response('not configured', { status: 503 });

      let email: unknown;
      try {
        email = ((await request.json()) as { email?: unknown }).email;
      } catch {
        return new Response('bad request', { status: 400 });
      }
      if (typeof email !== 'string' || !EMAIL.test(email.trim()) || email.length > 254) {
        return new Response('invalid address', { status: 400 });
      }

      try {
        await env.DB.prepare(
          'INSERT INTO subscribers (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING',
        )
          .bind(email.trim().toLowerCase(), new Date().toISOString())
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
        const day = new Date().toISOString().slice(0, 10);
        await env.DB.prepare(
          'INSERT INTO hits (day, path, ref, n) VALUES (?, ?, ?, 1) ' +
          'ON CONFLICT(day, path, ref) DO UPDATE SET n = n + 1',
        ).bind(day, path, ref).run();
      } catch { /* a missed count is not worth an error */ }
      return new Response(null, { status: 204 });
    }

    return env.ASSETS.fetch(request);
  },
};
