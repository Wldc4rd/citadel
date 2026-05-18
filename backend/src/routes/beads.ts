import { Router } from 'express';
import type { GcBead } from 'thriva-admin-shared';
import type { GcClient } from '../gc-client.js';
import { execBeadAction, ExecError } from '../exec.js';
import { recordAudit } from '../audit.js';

// v0 hardcoded spam filter. Comments here are the load-bearing
// documentation — "why isn't bead X showing" has a file/line answer.
//   - issue_type in {feature, bug, task, docs}  : engineering work only
//   - NOT label starting 'gc:'                  : session/message noise
//   - NOT issue_type 'convoy'                   : auto-convoy trackers
//
// ?showAll=1 disables the filter for diagnostic cases.
function defaultBeadFilter(bead: GcBead): boolean {
  const allowedTypes = new Set(['feature', 'bug', 'task', 'docs']);
  if (!allowedTypes.has(bead.issue_type)) return false;
  if (Array.isArray(bead.labels) && bead.labels.some((l) => l.startsWith('gc:'))) {
    return false;
  }
  return true;
}

const BEAD_ID_RE = /^(td|th|jt)-[a-z0-9-]{3,32}$/;

export function beadsRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const { items } = await gc.listBeads();
      const showAll = req.query.showAll === '1';
      const filtered = showAll ? items : items.filter(defaultBeadFilter);
      res.json({ items: filtered, total: items.length, returned: filtered.length });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to list beads', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  router.post('/:id/claim', async (req, res) => {
    await runBeadAction(req.params.id, 'claim', undefined, res);
  });

  router.post('/:id/close', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await runBeadAction(req.params.id, 'close', reason, res);
  });

  router.post('/:id/nudge', async (req, res) => {
    await runBeadAction(req.params.id, 'nudge', undefined, res);
  });

  return router;
}

async function runBeadAction(
  beadId: string,
  action: 'claim' | 'close' | 'nudge',
  reason: string | undefined,
  res: import('express').Response,
): Promise<void> {
  if (!BEAD_ID_RE.test(beadId)) {
    res.status(400).json({ error: 'invalid bead id', kind: 'validation' });
    return;
  }
  try {
    const result = await execBeadAction(beadId, action, reason);
    void recordAudit({
      type: 'dashboard.exec',
      endpoint: `POST /api/beads/:id/${action}`,
      parsed_args: { bead_id: beadId, ...(reason ? { reason } : {}) },
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });
    if (result.exitCode !== 0) {
      res.status(502).json({
        error: `gc command failed with exit ${result.exitCode}`,
        kind: 'upstream',
        details: { stderr: result.stderr.slice(0, 1024) },
      });
      return;
    }
    res.json({ ok: true, stdout: result.stdout.slice(0, 4096) });
  } catch (err) {
    if (err instanceof ExecError) {
      const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
      res.status(status).json({ error: err.message, kind: err.kind });
      return;
    }
    res.status(500).json({ error: (err as Error).message, kind: 'internal' });
  }
}
