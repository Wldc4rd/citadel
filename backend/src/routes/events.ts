import { Router } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { GcClient } from '../gc-client.js';

// Why this proxy exists (cd-16a94):
//
// The gc supervisor serves a real SSE stream at
// /v0/city/{name}/events/stream, but its CORS allowlist echoes
// Access-Control-Allow-Origin ONLY for loopback page origins (127.0.0.1,
// localhost). When the dashboard is reached over the LAN — e.g.
// http://thriva-dev:8081, the firewalled-VM workflow that HOST=0.0.0.0 +
// ADMIN_EXTRA_ALLOWED_HOSTS exist for — the browser's EventSource is a
// cross-origin request whose response carries no Access-Control-Allow-Origin,
// so the browser blocks it and the connection indicator flaps
// connecting/offline forever, never 'live'.
//
// cd-7d6n tried to fix this by rewriting the supervisor URL so the browser
// used the same hostname it reached the dashboard on. That made :8372
// reachable, but :8372 is still a different ORIGIN than :8081, so the
// cross-origin CORS block remained — symptom unchanged. (Its curl smoke
// test couldn't catch this: curl doesn't enforce CORS; only a browser does.)
//
// The robust fix: stop opening EventSource cross-origin. The browser
// connects to THIS endpoint, same-origin with the page (covered by
// `connect-src 'self'`), and the backend pipes the supervisor's stream
// over loopback (127.0.0.1:8372) — which the supervisor always allows and
// which is always reachable because the backend is co-located with it.
// This also restores the dashboard's "all supervisor reads go through the
// backend" invariant that direct-EventSource was the sole exception to.

const MAX_CURSOR_LEN = 64;

// Resume cursors arrive from the URL (?after=) or the EventSource
// Last-Event-ID reconnect header, both ultimately browser-influenced.
// They are forwarded to the upstream as a query value; restrict to a
// plain cursor token so a crafted Last-Event-ID can't smuggle anything
// into the upstream request. The supervisor's cursors are numeric event
// seqs, so [A-Za-z0-9_-] is comfortably permissive.
function sanitizeCursor(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CURSOR_LEN) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function eventsRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/stream', async (req, res) => {
    // Prefer the EventSource reconnect header; fall back to ?after=.
    const cursor =
      sanitizeCursor(req.headers['last-event-id']) ??
      sanitizeCursor(req.query.after as string | string[] | undefined);

    const upstream = new URL(
      `${gc.baseUrl}/v0/city/${encodeURIComponent(gc.cityName)}/events/stream`,
    );
    if (cursor) upstream.searchParams.set('after', cursor);

    // Abort the upstream the instant the browser goes away, so a
    // navigated-away tab doesn't leak a held-open supervisor connection.
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());

    const upstreamRes = await fetch(upstream, {
      signal: ctl.signal,
      headers: { Accept: 'text/event-stream' },
    }).catch(() => null);

    // Supervisor unreachable or unhappy: fail the handshake so the
    // browser's EventSource sees a closed connection and retries. The
    // useGcEvents hook backs off and reconnects on its own.
    if (!upstreamRes || !upstreamRes.ok || !upstreamRes.body) {
      if (!res.headersSent) res.status(502).end();
      return;
    }

    // Same-origin SSE — no CORS needed. Disable any intermediary
    // buffering so events arrive promptly.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const body = Readable.fromWeb(upstreamRes.body as NodeWebReadableStream);
    // If the upstream errors mid-stream, end our response cleanly so the
    // browser reconnects rather than hanging on a half-open stream.
    body.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    body.pipe(res);
  });

  return router;
}
