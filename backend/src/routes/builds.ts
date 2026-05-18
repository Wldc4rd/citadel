import { Router } from 'express';
import fs from 'node:fs/promises';
import type { DeployRecord, DeployStatus } from 'citadel-shared';
import { recordAudit } from '../audit.js';

const DEFAULT_LOG_PATH = '/home/charlie/thriva/.dev-deploy-log';
const DEFAULT_MARKER_PATH = '/home/charlie/thriva/.dev-deploy-FAILED';
// td-7t24i6 scope expansion: builds list was already capped here, but at
// 200 records that's ~30 days at typical dev-deploy cadence — fine for the
// "recent activity" use case. Documented so the cap is intentional and not
// the same undercount bug.
const MAX_RECORDS = 200;

// Format of the lines we parse — written by /home/charlie/thriva/scripts/dev-deploy.sh:
//   [ISO-TS] deploy OK (old-sha -> new-sha)
//   [ISO-TS] deploying old-sha -> new-sha
//   [ISO-TS] DEPLOY FAILED at stage: <stage>
//   [ISO-TS] manual recovery for th-X: ... (informational)
// Anything not matching becomes status: 'unknown' with the raw line as detail.

const LINE_RE = /^\[(?<ts>[^\]]+)\]\s+(?<rest>.*)$/;

export interface BuildsConfig {
  logPath?: string;
  markerPath?: string;
}

export function buildsRouter(cfg: BuildsConfig = {}): Router {
  const router = Router();
  const logPath = cfg.logPath ?? DEFAULT_LOG_PATH;
  const markerPath = cfg.markerPath ?? DEFAULT_MARKER_PATH;

  router.get('/', async (_req, res) => {
    const items: DeployRecord[] = [];
    let source: string | null = null;
    try {
      const text = await fs.readFile(logPath, 'utf-8');
      source = logPath;
      const lines = text.split('\n').reverse();
      for (const line of lines) {
        if (items.length >= MAX_RECORDS) break;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const m = LINE_RE.exec(trimmed);
        if (!m || !m.groups) continue;
        const ts = m.groups.ts;
        const rest = m.groups.rest;
        if (!ts || !rest) continue;
        items.push({
          at: ts,
          status: classify(rest),
          detail: rest,
        });
      }
    } catch {
      /* file may not exist on a fresh checkout — return empty */
    }
    let failedMarker = false;
    try {
      await fs.access(markerPath);
      failedMarker = true;
    } catch {
      /* marker absent — clean state */
    }
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/builds',
      parsed_args: { records: String(items.length), failed_marker: String(failedMarker) },
      duration_ms: 0,
    });
    res.json({ items, source, failed_marker: failedMarker });
  });

  return router;
}

function classify(rest: string): DeployStatus {
  if (rest.startsWith('deploy OK')) return 'ok';
  if (rest.startsWith('DEPLOY FAILED')) return 'failed';
  if (rest.startsWith('deploying ')) return 'in-progress';
  return 'unknown';
}
