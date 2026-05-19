import { Router } from 'express';
import type { BeadDetailRaw, BeadDetailResponse, GcBead } from 'citadel-shared';
import type { GcClient } from '../gc-client.js';
import { execBdShow, execBeadAction, ExecError } from '../exec.js';
import { renderMarkdownSafe } from '../markdown.js';
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

// Must mirror BEAD_ID_RE in exec.ts so claim/close/nudge (write) and
// the drill-in /:id (read) accept the same prefix set: td/th/jt/cd/thriva.
const BEAD_ID_RE = /^(td|th|jt|cd|thriva)-[a-z0-9-]{3,32}$/;

// td-7t24i6 fix: gc default /beads limit is 50, far below the city's working
// set (~2139 total, ~183 eng-only). Pull a wide window so the spam filter
// operates on the full set, not a 50-item slice. 1000 is well over the
// current ~183-item eng-only count and leaves headroom; safety cap in case
// the supervisor returns more.
const BEADS_FETCH_LIMIT = 1000;

export function beadsRouter(gc: GcClient, cityPath: string): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const { items, total } = await gc.listBeads(undefined, { limit: BEADS_FETCH_LIMIT });
      const showAll = req.query.showAll === '1';
      const filtered = showAll ? items : items.filter(defaultBeadFilter);
      res.json({
        items: filtered,
        total: filtered.length,
        // upstream_total: the store's total bead count (per gc's `total`
        // field). Diff between upstream_total and items.length tells the UI
        // how much was truncated by our fetch limit so Charlie can see when
        // the window isn't covering everything.
        upstream_total: typeof total === 'number' ? total : undefined,
        upstream_fetched: items.length,
        fetch_limit: BEADS_FETCH_LIMIT,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to list beads', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  // GET /:id — bead drill-in (td-384rhs). Reads the FULL bead record via
  // the bd CLI. Supervisor's HTTP /v0/city/{name}/bead/{id} omits
  // design/notes/closed_at/updated_at/owner — fields the detail page needs.
  // Markdown fields (description/design/notes) are rendered server-side
  // through markdown.ts's strict-allowlist sanitiser so the frontend can
  // dangerouslySetInnerHTML the rendered_* fields without further escaping.
  router.get('/:id', async (req, res) => {
    const id = req.params.id;
    if (!BEAD_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid bead id', kind: 'validation' });
      return;
    }
    try {
      const result = await execBdShow(cityPath, id);
      if (result.exitCode !== 0) {
        // bd show on a missing bead: exit=1, stderr="Error fetching <id>:
        // no issue found matching <id>", stdout=JSON {"error": "no
        // issues found matching the provided IDs", schema_version: 1}.
        // Parse stdout first (structured); fall back to stderr regex.
        let notFound = false;
        if (result.stdout.length > 0) {
          try {
            const parsed = JSON.parse(result.stdout) as { error?: string };
            if (typeof parsed?.error === 'string' && /no issue.*found|not found/i.test(parsed.error)) {
              notFound = true;
            }
          } catch {
            /* not JSON — fall through to stderr check */
          }
        }
        if (!notFound) {
          notFound = /no issue.*found|not found|no such issue|does not exist/i.test(result.stderr);
        }
        res.status(notFound ? 404 : 502).json({
          error: notFound ? 'bead not found' : `gc bd show failed with exit ${result.exitCode}`,
          kind: notFound ? 'not_found' : 'upstream',
          details: notFound ? undefined : { stderr: result.stderr.slice(0, 1024) },
        });
        return;
      }
      let bead: BeadDetailRaw;
      try {
        const parsed = JSON.parse(result.stdout);
        bead = (Array.isArray(parsed) ? parsed[0] : parsed) as BeadDetailRaw;
        if (!bead || typeof bead !== 'object' || typeof bead.id !== 'string') {
          throw new Error('unexpected bd show shape');
        }
      } catch (parseErr) {
        res.status(502).json({
          error: 'failed to parse bd show output',
          kind: 'upstream',
          details: { message: (parseErr as Error).message },
        });
        return;
      }
      const payload: BeadDetailResponse = {
        bead,
        description_html: renderMarkdownSafe(bead.description ?? ''),
        design_html: renderMarkdownSafe(bead.design ?? ''),
        notes_html: renderMarkdownSafe(bead.notes ?? ''),
      };
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/beads/:id',
        parsed_args: { bead_id: id },
        duration_ms: result.durationMs,
      });
      res.json(payload);
    } catch (err) {
      if (err instanceof ExecError) {
        const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      res.status(500).json({ error: (err as Error).message, kind: 'internal' });
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
