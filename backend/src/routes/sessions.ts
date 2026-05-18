import { Router } from 'express';
import type { PeekResult } from 'thriva-admin-shared';
import type { GcClient } from '../gc-client.js';
import { execSessionPeek, ExecError } from '../exec.js';
import { recordAudit } from '../audit.js';

export function sessionsRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const { items } = await gc.listSessions();
      res.json({ items });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to list sessions', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  router.post('/:id/peek', async (req, res) => {
    const id = req.params.id;
    try {
      const exec = await execSessionPeek(id);
      const result: PeekResult = {
        session_id: id,
        content: exec.stdout,
        bytes: Buffer.byteLength(exec.stdout, 'utf-8'),
        captured_at: new Date().toISOString(),
        truncated: exec.truncated,
      };
      void recordAudit({
        type: 'dashboard.exec',
        endpoint: 'POST /api/sessions/:id/peek',
        parsed_args: { session_id: id },
        exit_code: exec.exitCode,
        duration_ms: exec.durationMs,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof ExecError) {
        const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      res.status(500).json({ error: (err as Error).message, kind: 'internal' });
    }
  });

  return router;
}
