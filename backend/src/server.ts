import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { loadConfig } from './config.js';
import {
  hostHeaderAllowlistFactory,
  originCheck,
  securityHeaders,
} from './middleware/security.js';
import { csrfIssueCookie, csrfValidate, getCsrfToken } from './middleware/csrf.js';
import { GcClient } from './gc-client.js';
import { sessionsRouter } from './routes/sessions.js';
import { agentsRouter } from './routes/agents.js';
import { beadsRouter } from './routes/beads.js';
import { mailRouter } from './routes/mail.js';
import { mailSendRouter } from './routes/mail-send.js';
import { gitRouter } from './routes/git.js';
import { buildsRouter } from './routes/builds.js';
import { healthRouter } from './routes/health.js';
import { doltRouter, startDoltNomsSampler } from './routes/dolt.js';
import { adminRouter } from './routes/admin.js';
import { eventsRouter } from './routes/events.js';
import { setAuditLogPath, setAuditOwnerAlias } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function main(): void {
  const config = loadConfig();

  if (config.disabled) {
    console.error('[admin] THRIVA_ADMIN_DASHBOARD_DISABLED=1 — refusing to start');
    process.exit(0);
  }

  setAuditLogPath(config.auditLogPath);
  setAuditOwnerAlias(config.cityOwnerAlias);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // ── Security middleware (V0-SHIP-REQUIRED) ────────────────────────────
  app.use(hostHeaderAllowlistFactory(config.extraAllowedHosts));
  app.use(originCheck(config.port, config.extraAllowedHosts));
  // CSP connect-src is just 'self': the browser's only event stream is the
  // same-origin SSE proxy at /api/events/stream (cd-16a94). Earlier Phase C
  // opened EventSource cross-origin straight at the gc supervisor, which
  // required enumerating supervisor origins here (cd-7d6n) — but the
  // supervisor's CORS only allows loopback page origins, so cross-origin
  // never worked from LAN. The proxy removed that dependency entirely.
  app.use(securityHeaders());
  app.use(csrfIssueCookie);

  // ── Health check (no CSRF, no privileged access) ──────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get('/api/csrf', (_req, res) => {
    res.json({ token: getCsrfToken() });
  });

  // ── API routes ────────────────────────────────────────────────────────
  const gc = new GcClient({
    baseUrl: config.gcSupervisorUrl,
    cityName: config.cityName,
  });

  const writeRouter = express.Router();
  writeRouter.use(csrfValidate);
  writeRouter.use('/sessions', sessionsRouter(gc));
  // cd-i81q: agents router — currently exposes GET /:alias/prime
  // (composed behavioural prompt). Read-only; edit-and-save deferred.
  writeRouter.use('/agents', agentsRouter(config.cityPath));
  writeRouter.use('/beads', beadsRouter(gc, config.cityPath, config.cityOwnerAlias));
  writeRouter.use('/mail', mailRouter(gc, config.cityOwnerAlias));
  // mail-send is a SEPARATE router mounted at its own path. The handler in
  // mail-send.ts has no `viewing-as` parameter — physical separation per
  // architect th-1i30ih §"Identity-switching for mail".
  writeRouter.use('/mail-send', mailSendRouter());
  // Phase C: Activity + Health surface.
  writeRouter.use('/git', gitRouter());
  writeRouter.use('/builds', buildsRouter());
  writeRouter.use('/system', healthRouter(gc));
  writeRouter.use('/dolt-noms', doltRouter());
  // Cockpit (td-a40qsy) — engine gauges + destructive common knobs.
  writeRouter.use('/admin', adminRouter(gc, config.cityPath));
  // Same-origin SSE proxy (cd-16a94): the browser opens EventSource here,
  // the backend pipes the supervisor stream over loopback. GET-only, so it
  // passes csrfValidate untouched.
  writeRouter.use('/events', eventsRouter(gc));

  app.use('/api', writeRouter);

  // Bootstrap config for the frontend. `city` is the display name (Sidebar,
  // Cockpit); `owner_alias` is bootstrap identity (td-4k317p): ViewingAsContext
  // defaults to it, "Claim as X" / "Sends as X" UI strings render it. Default
  // `'human'` matches the backend's GC_CITY_OWNER_ALIAS floor. The supervisor
  // URL is no longer surfaced — the browser reaches the event stream through
  // the same-origin /api/events/stream proxy (cd-16a94), not directly.
  app.get('/api/config/gc-supervisor', (_req, res) => {
    res.json({
      city: config.cityName,
      owner_alias: config.cityOwnerAlias,
    });
  });

  // Start the dolt-noms 10-min sampler. Source landed in td-pke1a9 —
  // walks the on-disk Dolt tree (config.doltNomsRoot, defaulting to
  // <city>/.beads/dolt) and sums file sizes per tick.
  startDoltNomsSampler({ doltNomsRoot: config.doltNomsRoot });

  // ── Frontend static files (prod) ──────────────────────────────────────
  const distDir = path.resolve(__dirname, '..', config.frontendDistPath);
  if (fs.existsSync(distDir)) {
    app.use(
      express.static(distDir, {
        index: 'index.html',
        dotfiles: 'deny',
        // SPA assets are content-hashed by Vite; the index.html itself
        // should NOT be cached so deploys are visible on next page load.
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // SPA fallback — any non-/api path returns index.html so the React
    // router can take over.
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    console.log(`[admin] frontend dist not found at ${distDir} — API-only mode`);
  }

  // Bind 127.0.0.1 ONLY (DNS-rebinding floor; security_researcher).
  const server = app.listen(config.port, config.bindHost, () => {
    console.log(
      `[admin] listening on http://${config.bindHost}:${config.port} (city=${config.cityName}, supervisor=${config.gcSupervisorUrl})`,
    );
  });

  function shutdown(signal: string): void {
    console.log(`[admin] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
