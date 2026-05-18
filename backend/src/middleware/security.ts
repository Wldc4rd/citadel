import type { Request, Response, NextFunction } from 'express';

// DNS-rebinding defense + clickjacking defense + content-type lockdown.
// security_researcher td-wisp-eb0pn — all V0-SHIP-REQUIRED.

const ALLOWED_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
]);

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

export function hostHeaderAllowlist(req: Request, res: Response, next: NextFunction): void {
  const host = hostnameOnly(req.headers.host);
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    // 421 Misdirected Request — semantically right for DNS-rebinding.
    res.status(421).type('text/plain').send('Host not allowed');
    return;
  }
  next();
}

export function originCheck(port: number) {
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
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

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Defeat clickjacking + iframe-embedding.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Per security_researcher: strict CSP, no inline script, no eval, no foreign frames.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // Tailwind / Vite produce inline styles in dev; allow unsafe-inline only for style.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
}
