import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { loadConfig } from './config.js';
import {
  hostHeaderAllowlist,
  originCheck,
  securityHeaders,
} from './middleware/security.js';
import { csrfIssueCookie, csrfValidate, getCsrfToken } from './middleware/csrf.js';
import { GcClient } from './gc-client.js';
import { sessionsRouter } from './routes/sessions.js';
import { beadsRouter } from './routes/beads.js';
import { setAuditLogPath } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function main(): void {
  const config = loadConfig();

  if (config.disabled) {
    console.error('[admin] THRIVA_ADMIN_DASHBOARD_DISABLED=1 — refusing to start');
    process.exit(0);
  }

  setAuditLogPath(config.auditLogPath);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // ── Security middleware (V0-SHIP-REQUIRED) ────────────────────────────
  app.use(hostHeaderAllowlist);
  app.use(originCheck(config.port));
  app.use(securityHeaders);
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
  writeRouter.use('/beads', beadsRouter(gc));

  app.use('/api', writeRouter);

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
