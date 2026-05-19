import { Router } from 'express';
import type {
  AdminActionResult,
  GcBead,
  PipelineStageCounts,
  ThroughputTrend,
} from 'citadel-shared';
import type { GcClient } from '../gc-client.js';
import {
  ExecError,
  execAgentResume,
  execAgentSuspend,
  execBdListClosed,
  execCityRestart,
  execCityStop,
  type ExecResult,
} from '../exec.js';
import { recordAudit } from '../audit.js';

// Cockpit (td-a40qsy) backend surface. Two GETs for the engine gauges,
// four POSTs for the "common knobs" destructive actions.
//
// Reads (GET) are computed from `gc.listBeads()` each call. v0 has no
// in-memory caching — the cockpit refreshes every 30s and listBeads is
// already wide-fetched (limit=1000). If supervisor load becomes a real
// concern, add a 30s memoize here without changing the wire shape.
//
// Writes (POST) thread through exec.ts named wrappers. Each route is
// also CSRF + Origin + Host-allowlist gated by the dashboard's existing
// middleware (see server.ts writeRouter). Audit log records every
// invocation, success or failure.

const WINDOW_HOURS = 6;

// Stage classifier — pure function, applied to each bead's labels +
// status. Order matters: a bead with both needs-changes and needs-review
// classifies as needs-changes (the more specific "back to implementer"
// state) because that's the actionable signal for Charlie.
function classifyStage(bead: GcBead): keyof PipelineStageCounts['stages'] | null {
  if (bead.status === 'closed') return null;
  if (bead.status === 'blocked') return 'blocked';
  const labels = bead.labels ?? [];
  if (labels.includes('needs-changes')) return 'needs_changes';
  if (labels.includes('needs-review')) return 'needs_review';
  if (labels.some((l) => l.startsWith('needs-impl'))) return 'needs_impl';
  if (labels.includes('needs-arch') || labels.includes('needs-architect')) {
    return 'needs_arch';
  }
  if (bead.status === 'in_progress') return 'in_progress';
  if (bead.status === 'open') return 'other_open';
  return null;
}

// v0 spam filter — must mirror routes/beads.ts::defaultBeadFilter so
// the cockpit counts match the Beads view. DRY would be nice; this is
// duplicated rather than imported to keep the cockpit's "what counts"
// definition co-located with its endpoint.
const ENG_TYPES = new Set(['feature', 'bug', 'task', 'docs']);
function isEngBead(bead: GcBead): boolean {
  if (!ENG_TYPES.has(bead.issue_type)) return false;
  if (bead.labels?.some((l) => l.startsWith('gc:'))) return false;
  return true;
}

function topOfHour(d: Date): Date {
  const r = new Date(d);
  r.setMinutes(0, 0, 0);
  return r;
}

function computeThroughput(beads: GcBead[], now: Date): ThroughputTrend {
  const buckets = new Array(WINDOW_HOURS).fill(0) as number[];
  const startOfNow = topOfHour(now);
  // Bucket index 0 = oldest hour, index WINDOW_HOURS - 1 = current hour.
  const windowStartMs = startOfNow.getTime() - (WINDOW_HOURS - 1) * 60 * 60 * 1_000;
  for (const bead of beads) {
    if (!isEngBead(bead)) continue;
    if (bead.status !== 'closed') continue;
    const closedAt = bead.closed_at ?? null;
    if (typeof closedAt !== 'string') continue;
    const ts = Date.parse(closedAt);
    if (!Number.isFinite(ts) || ts < windowStartMs) continue;
    const bucketIdx = Math.floor((ts - windowStartMs) / (60 * 60 * 1_000));
    if (bucketIdx < 0 || bucketIdx >= WINDOW_HOURS) continue;
    buckets[bucketIdx]! += 1;
  }
  return {
    as_of: now.toISOString(),
    window_hours: WINDOW_HOURS,
    buckets: buckets.map((count, i) => ({
      start: new Date(windowStartMs + i * 60 * 60 * 1_000).toISOString(),
      count,
    })),
  };
}

function computePipelineStageCounts(beads: GcBead[], now: Date): PipelineStageCounts {
  const stages = {
    needs_arch: 0,
    needs_impl: 0,
    needs_review: 0,
    needs_changes: 0,
    in_progress: 0,
    blocked: 0,
    other_open: 0,
  };
  for (const bead of beads) {
    if (!isEngBead(bead)) continue;
    const stage = classifyStage(bead);
    if (stage === null) continue;
    stages[stage] += 1;
  }
  const total_open = Object.values(stages).reduce((a, b) => a + b, 0);
  return { as_of: now.toISOString(), stages, total_open };
}

function execToResult(commandArgs: string[], r: ExecResult): AdminActionResult {
  return {
    ok: true,
    command: ['gc', ...commandArgs].join(' '),
    stdout: r.stdout.slice(0, 4096),
    stderr: r.stderr.length > 0 ? r.stderr.slice(0, 1024) : undefined,
    duration_ms: r.durationMs,
  };
}

export function adminRouter(gc: GcClient, cityPath: string): Router {
  const router = Router();

  // ── Read endpoints — engine gauges ──────────────────────────────────

  router.get('/throughput-trend', async (_req, res) => {
    try {
      // Supervisor's HTTP /beads endpoint omits closed_at on closed beads
      // (confirmed during impl: a status=closed&limit=1000 response had
      // closed_at=null on every item). The bd CLI returns the full record
      // including closed_at, so we shell-exec it here. The --closed-after
      // window keeps the JSON small enough to fit under exec.ts's MAX_BYTES
      // cap; without the window-filter, a no-limit response runs ~500KB+
      // for thousands of closed beads.
      const windowStartMs =
        topOfHour(new Date()).getTime() - (WINDOW_HOURS - 1) * 60 * 60 * 1_000;
      const closedAfter = new Date(windowStartMs).toISOString();
      const result = await execBdListClosed(cityPath, closedAfter, 500);
      if (result.exitCode !== 0) {
        res.status(502).json({
          error: `gc bd list failed with exit ${result.exitCode}`,
          kind: 'upstream',
          details: { stderr: result.stderr.slice(0, 1024) },
        });
        return;
      }
      let items: GcBead[];
      try {
        items = JSON.parse(result.stdout) as GcBead[];
        if (!Array.isArray(items)) throw new Error('expected array');
      } catch (parseErr) {
        res.status(502).json({
          error: 'failed to parse bd list output',
          kind: 'upstream',
          details: { message: (parseErr as Error).message },
        });
        return;
      }
      const payload = computeThroughput(items, new Date());
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/admin/throughput-trend',
        parsed_args: { window_hours: String(WINDOW_HOURS), bead_count: String(items.length) },
        duration_ms: result.durationMs,
      });
      res.json(payload);
    } catch (err) {
      if (err instanceof ExecError) {
        res.status(err.kind === 'timeout' ? 504 : 500).json({
          error: err.message,
          kind: err.kind,
        });
        return;
      }
      res.status(502).json({
        error: 'failed to compute throughput trend',
        kind: 'upstream',
        details: { message: (err as Error).message },
      });
    }
  });

  router.get('/pipeline-stage-counts', async (_req, res) => {
    try {
      const { items } = await gc.listBeads(undefined, { limit: 1000 });
      const payload = computePipelineStageCounts(items, new Date());
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/admin/pipeline-stage-counts',
        parsed_args: { bead_count: String(items.length) },
        duration_ms: 0,
      });
      res.json(payload);
    } catch (err) {
      res.status(502).json({
        error: 'failed to compute pipeline stage counts',
        kind: 'upstream',
        details: { message: (err as Error).message },
      });
    }
  });

  // ── Destructive endpoints — common knobs ────────────────────────────
  // CSRF + Origin + Host-allowlist are applied upstream by the
  // writeRouter middleware chain in server.ts. Each handler here
  // additionally validates: the route is a known action (Express
  // matches the literal path), and exec.ts enforces the enum of
  // permitted agent names + command shapes.

  router.post('/pause-polecats', async (_req, res) => {
    await runAdminAction(
      'pause-polecats',
      ['agent', 'suspend', 'polecat'],
      () => execAgentSuspend('polecat'),
      res,
    );
  });

  router.post('/resume-polecats', async (_req, res) => {
    await runAdminAction(
      'resume-polecats',
      ['agent', 'resume', 'polecat'],
      () => execAgentResume('polecat'),
      res,
    );
  });

  router.post('/stop-city', async (_req, res) => {
    await runAdminAction(
      'stop-city',
      ['stop', '--timeout=30s'],
      () => execCityStop(),
      res,
    );
  });

  router.post('/restart-city', async (_req, res) => {
    await runAdminAction('restart-city', ['restart'], () => execCityRestart(), res);
  });

  return router;
}

async function runAdminAction(
  action: string,
  commandArgs: string[],
  invoke: () => Promise<ExecResult>,
  res: import('express').Response,
): Promise<void> {
  const start = Date.now();
  try {
    const result = await invoke();
    void recordAudit({
      type: 'dashboard.exec',
      endpoint: `POST /api/admin/${action}`,
      parsed_args: { command: ['gc', ...commandArgs].join(' ') },
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
    res.json(execToResult(commandArgs, result));
  } catch (err) {
    void recordAudit({
      type: 'dashboard.exec',
      endpoint: `POST /api/admin/${action}`,
      parsed_args: { command: ['gc', ...commandArgs].join(' '), failed: 'true' },
      duration_ms: Date.now() - start,
    });
    if (err instanceof ExecError) {
      const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
      res.status(status).json({ error: err.message, kind: err.kind });
      return;
    }
    res.status(500).json({ error: (err as Error).message, kind: 'internal' });
  }
}
