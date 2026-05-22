import type { Request, Response, NextFunction } from 'express';

// DNS-rebinding defense + clickjacking defense + content-type lockdown.
// security_researcher td-wisp-eb0pn — all V0-SHIP-REQUIRED.

// Always-allowed floor. Extra hosts (e.g. LAN names like 'thriva-dev' or
// '192.168.1.58') are added at runtime via hostHeaderAllowlistFactory() —
// see td-9u9im9 for the headless-VM workflow this supports.
const ALLOWED_HOSTS_FLOOR: ReadonlyArray<string> = ['127.0.0.1', 'localhost'];

function originHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.hostname;
  } catch {
    return null;
  }
}

function hostnameOnly(host: string | undefined): string | null {
  if (!host) return null;
  // Strip port + ipv6 brackets
  const noPort = host.replace(/:\d+$/, '');
  return noPort.replace(/^\[|\]$/g, '').toLowerCase();
}

export function hostHeaderAllowlistFactory(extraAllowedHosts: ReadonlyArray<string> = []) {
  const allowed = new Set<string>(ALLOWED_HOSTS_FLOOR);
  for (const h of extraAllowedHosts) allowed.add(h.toLowerCase());
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = hostnameOnly(req.headers.host);
    if (host === null || !allowed.has(host)) {
      // 421 Misdirected Request — semantically right for DNS-rebinding.
      res.status(421).type('text/plain').send('Host not allowed');
      return;
    }
    next();
  };
}

// Back-compat: existing callers that don't pass extras get floor-only.
export const hostHeaderAllowlist = hostHeaderAllowlistFactory();

export function originCheck(port: number, extraAllowedHosts: ReadonlyArray<string> = []) {
  const allowedOrigins = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  for (const h of extraAllowedHosts) {
    allowedOrigins.add(`http://${h.toLowerCase()}:${port}`);
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    // Only check state-changing methods. GETs are exempt — the host-header
    // allowlist already covers DNS-rebinding for read paths.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
      res.status(403).type('application/json').send(
        JSON.stringify({ error: 'Origin not allowed', kind: 'origin' }),
      );
      return;
    }
    next();
  };
}

export function securityHeaders() {
  // connect-src is 'self' only. The browser's sole cross-component channel
  // is the same-origin SSE proxy at /api/events/stream (cd-16a94); nothing
  // is fetched from another origin. (Phase C once opened EventSource direct
  // at the gc supervisor on :8372 and had to enumerate that origin here, but
  // the supervisor's CORS only allows loopback page origins, so cross-origin
  // never worked from the LAN — the proxy removed the need entirely.)
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', csp);
    next();
  };
}
