import { Router } from 'express';
import { ExecError, execAgentPrime } from '../exec.js';
import { recordAudit } from '../audit.js';

// cd-i81q: per-agent prompt/directive surface. Read-only for v0 (the
// bead's edit-and-save acceptance is a stretch goal that needs
// security_researcher review — direct prompt edit via UI is a
// high-blast-radius action; cf. th-s1sqq supervisor auth bead).
//
// Why a new router instead of folding into /api/sessions: sessions are
// keyed by id (td-…); agent identity here is the alias (e.g.
// 'gastown.mayor' or 'thriva/devpipeline.architect') because that's
// what gc prime accepts. Keeping the namespace separate avoids
// confusion about which key type a route takes.
//
// AGENT_ALIAS_RE in exec.ts already validates the alias shape; the
// route forwards the raw string and lets exec.ts gate it. 404 vs 502
// distinguished by gc's exit code: --strict exits 1 with stderr
// "agent ... not found in city config" for unknown agents, exits 0
// with the composed prompt on success.

export function agentsRouter(cityPath: string): Router {
  const router = Router();

  router.get('/:alias/prime', async (req, res) => {
    const alias = req.params.alias;
    try {
      const result = await execAgentPrime(alias, cityPath);
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/agents/:alias/prime',
        parsed_args: {
          agent: alias,
          prompt_bytes: String(result.stdout.length),
          exit_code: String(result.exitCode),
        },
        duration_ms: result.durationMs,
      });
      if (result.exitCode !== 0) {
        // --strict reports "agent X not found in city config" on stderr
        // when the alias doesn't map to a configured agent. Surface as
        // 404 so the UI can render an "agent not configured" state
        // instead of a generic upstream error.
        const stderr = result.stderr.slice(0, 1024);
        const notFound = /not found in city config|no agent/i.test(stderr);
        res.status(notFound ? 404 : 502).json({
          error: notFound ? 'agent not configured' : `gc prime failed with exit ${result.exitCode}`,
          kind: notFound ? 'not_found' : 'upstream',
          details: { stderr },
        });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        agent: alias,
        prompt: result.stdout,
        bytes: result.stdout.length,
      });
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
