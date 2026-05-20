import type { Request } from 'express';

// Why this file exists (cd-7d6n):
//
// GC_SUPERVISOR_URL commonly defaults to a loopback address (127.0.0.1)
// because the backend reaches the supervisor through loopback. The
// BROWSER, however, may be on a different host — e.g. dashboard reached
// via http://thriva-dev:8081 over the LAN. Handing the browser
// "http://127.0.0.1:8372" makes it try its own local loopback, which has
// no supervisor, so EventSource never fires onopen. The connection-status
// indicator then flaps between 'connecting' and 'offline' forever.
//
// Two pieces are needed to let the browser reach the supervisor:
//   1. The /api/config/gc-supervisor handler hands the browser a URL with
//      the host the browser is already using — rewriteSupervisorUrlForBrowser.
//   2. The CSP connect-src enumerates a supervisor URL for every host the
//      dashboard is reachable on — buildSupervisorCspSources.
//
// Both only kick in when the configured URL is loopback. If the operator
// set GC_SUPERVISOR_URL to a specific non-loopback host, we trust it.

const LOOPBACK_HOSTNAMES = new Set<string>(['127.0.0.1', 'localhost', '::1']);

// Single source of bracket-stripping + casefolding for hostnames coming
// from URL.hostname (no brackets, per WHATWG URL) AND from req.hostname
// (may have brackets depending on Host header form). Mirrors the pattern
// in middleware/security.ts::hostnameOnly so the supervisor-URL layer
// and the host-allowlist layer normalise the same way (review feedback
// on this bead).
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function originOf(parsed: URL, host: string): string {
  const portSuffix = parsed.port ? `:${parsed.port}` : '';
  const bare = normalizeHostname(host);
  // IPv6 literals MUST be bracketed in a URL — `http://::1:8372` is
  // unparseable, only `http://[::1]:8372` round-trips through new URL().
  const hostInUrl = bare.includes(':') ? `[${bare}]` : bare;
  return `${parsed.protocol}//${hostInUrl}${portSuffix}`;
}

export function buildSupervisorCspSources(
  supervisorUrl: string,
  extraAllowedHosts: ReadonlyArray<string>,
): string[] {
  const parsed = parseUrl(supervisorUrl);
  if (!parsed) return [supervisorUrl];
  if (!isLoopbackHostname(parsed.hostname)) return [supervisorUrl];

  const out = new Set<string>([supervisorUrl]);
  for (const host of ['127.0.0.1', 'localhost', ...extraAllowedHosts]) {
    out.add(originOf(parsed, host));
  }
  return [...out];
}

export function rewriteSupervisorUrlForBrowser(
  supervisorUrl: string,
  req: Request,
  extraAllowedHosts: ReadonlyArray<string>,
): string {
  const parsed = parseUrl(supervisorUrl);
  if (!parsed) return supervisorUrl;
  if (!isLoopbackHostname(parsed.hostname)) return supervisorUrl;

  const browserHost = normalizeHostname(req.hostname || '');
  if (!browserHost) return supervisorUrl;

  // Defence-in-depth: the host-header allowlist middleware already vetted
  // req.hostname before we got here, but match the same allowlist anyway
  // so any future bypass can't lead us to hand the browser a URL we
  // didn't sanction. Normalise both sides through the same helper so an
  // IPv6 entry like '[::1]' in either source still resolves.
  const allowed = new Set<string>([
    '127.0.0.1',
    'localhost',
    ...extraAllowedHosts.map(normalizeHostname),
  ]);
  if (!allowed.has(browserHost)) return supervisorUrl;

  return originOf(parsed, browserHost);
}
