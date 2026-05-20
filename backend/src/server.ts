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
import { beadsRouter } from './routes/beads.js';
import { mailRouter } from './routes/mail.js';
import { mailSendRouter } from './routes/mail-send.js';
import { gitRouter } from './routes/git.js';
import { buildsRouter } from './routes/builds.js';
import { healthRouter } from './routes/health.js';
import { doltRouter, startDoltNomsSampler } from './routes/dolt.js';
import { adminRouter } from './routes/admin.js';
import { setAuditLogPath, setAuditOwnerAlias } from './audit.js';
import {
  buildSupervisorCspSources,
  rewriteSupervisorUrlForBrowser,
} from './supervisor-url.js';

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
  // CSP connect-src extension: Phase C wires EventSource direct to gc
  // supervisor for /events/stream. Different port = different origin under
  // same-origin policy, so the supervisor URL must be explicitly enumerated.
  // When the configured URL is loopback, we enumerate the same supervisor
  // port on every allowed host so the browser can reach it via whichever
  // hostname the dashboard is served on (cd-7d6n).
  app.use(securityHeaders(
    buildSupervisorCspSources(config.gcSupervisorUrl, config.extraAllowedHosts),
  ));
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

  app.use('/api', writeRouter);

  // Frontend needs to know the gc supervisor URL to open EventSource
  // direct (architect addendum td-wisp-ijk7g). The CSP already allows
  // it; this endpoint is the one place that surfaces it to the browser
  // so the URL isn't hardcoded in two places. When the configured URL
  // is loopback, the URL handed to the browser is rewritten to use the
  // same hostname the browser used to reach us (cd-7d6n). `owner_alias`
  // is bootstrap identity for the frontend (td-4k317p): ViewingAsContext
  // defaults to it, "Claim as X" / "Sends as X" UI strings render it.
  // Default `'human'` matches the backend's GC_CITY_OWNER_ALIAS floor.
  app.get('/api/config/gc-supervisor', (req, res) => {
    res.json({
      supervisor_url: rewriteSupervisorUrlForBrowser(
        config.gcSupervisorUrl,
        req,
        config.extraAllowedHosts,
      ),
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
