import { Router } from 'express';
import type {
  AdminActionResult,
  GcBead,
  GcSession,
  KanbanCard,
  KanbanColumn,
  KanbanResponse,
  PipelineStageCounts,
  ThroughputTrend,
} from 'citadel-shared';
import { KANBAN_COLUMNS } from 'citadel-shared';
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

// ── Kanban classifier (td-wyr6ly) ────────────────────────────────────

const KANBAN_TITLE_CAP = 120;
const KANBAN_STALL_MS = 60 * 60 * 1_000; // 1h: in-flight vs stalled threshold
const KANBAN_CLOSED_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Map a bead → its Kanban column (or null to omit). Uses session
 * activity to distinguish in-flight vs stalled. Uses open-id set
 * membership of each blocked bead's deps to distinguish blocked-real
 * vs blocked-stale.
 *
 * Architect td-wisp-ujl1k discussion lists more states (orphan,
 * dual-labeled) that the strawman in td-wyr6ly doesn't expose as
 * columns. v0 follows the strawman; future revision when the
 * ownership-data-shape design lands.
 */
function classifyKanban(
  bead: GcBead,
  sessionByAssignee: Map<string, GcSession>,
  openBeadIds: Set<string>,
  now: number,
  closedAtById: Map<string, string>,
): KanbanColumn | null {
  // Closed: include only within the 24h window.
  if (bead.status === 'closed') {
    const ca = closedAtById.get(bead.id);
    if (!ca) return null;
    const ms = Date.parse(ca);
    if (!Number.isFinite(ms) || now - ms > KANBAN_CLOSED_WINDOW_MS) return null;
    return 'closed_24h';
  }

  const labels = bead.labels ?? [];
  // Label-driven states take precedence over status — these are
  // pipeline-stage signals Charlie cares about regardless of
  // status=open vs in_progress.
  if (labels.includes('approved')) return 'approved';
  if (labels.includes('needs-changes')) return 'needs_changes';
  if (labels.includes('needs-review')) return 'in_review';
  if (labels.includes('blocked') || bead.status === 'blocked') {
    // blocked-real: any dep still active (open / in_progress / blocked).
    // blocked-stale: all deps resolved → mayor needs to unblock.
    // Since supervisor's /beads returns dependencies as {issue_id,
    // depends_on_id, type} (no status), we infer status via
    // open_bead_ids set membership. A dep not in the set is either
    // closed or doesn't exist; either way the blocked state is stale.
    const deps = (bead.dependencies ?? []) as Array<{ depends_on_id?: string }>;
    if (deps.length === 0) return 'blocked_stale';
    const anyOpen = deps.some(
      (d) => typeof d.depends_on_id === 'string' && openBeadIds.has(d.depends_on_id),
    );
    return anyOpen ? 'blocked_real' : 'blocked_stale';
  }

  // Active-work states.
  if (bead.status === 'in_progress') {
    const sess = bead.assignee ? sessionByAssignee.get(bead.assignee) : undefined;
    const lastActive = sess?.last_active ? Date.parse(sess.last_active) : NaN;
    if (sess && sess.state === 'active' && Number.isFinite(lastActive) && now - lastActive < KANBAN_STALL_MS) {
      return 'in_flight';
    }
    return 'stalled';
  }

  // Open (no special label, not in_progress): mayor needs to monitor
  // routing. With or without an assignee — if an assignee is set but
  // hasn't claimed, mayor still tracks pickup latency.
  if (bead.status === 'open') return 'mayor_plate';

  return null; // unknown status — ignore rather than guess
}

function lastActiveForBead(
  bead: GcBead,
  sessionByAssignee: Map<string, GcSession>,
): string | null {
  const sess = bead.assignee ? sessionByAssignee.get(bead.assignee) : undefined;
  const sessLast = sess?.last_active ?? null;
  const beadLast = bead.updated_at ?? bead.created_at;
  // Prefer the most-recent of the two signals.
  if (sessLast && beadLast) {
    return sessLast > beadLast ? sessLast : beadLast;
  }
  return sessLast ?? beadLast ?? null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function toKanbanCard(
  bead: GcBead,
  sessionByAssignee: Map<string, GcSession>,
  openBeadIds: Set<string>,
): KanbanCard {
  const deps = (bead.dependencies ?? []) as Array<{ depends_on_id?: string }>;
  const openBlockerCount = deps.filter(
    (d) => typeof d.depends_on_id === 'string' && openBeadIds.has(d.depends_on_id),
  ).length;
  return {
    id: bead.id,
    title: truncate(bead.title ?? '', KANBAN_TITLE_CAP),
    assignee: bead.assignee ?? '',
    last_active: lastActiveForBead(bead, sessionByAssignee),
    open_blocker_count: openBlockerCount,
    priority: typeof bead.priority === 'number' ? bead.priority : 4,
  };
}

function buildKanban(
  openBeads: GcBead[],
  closedBeads: GcBead[],
  sessions: GcSession[],
  now: Date,
): KanbanResponse {
  // Index sessions by assignee fields. Bead-store assignees use mixed
  // formats (alias / session_name / id) — mirror the agent drill-in's
  // OR-match strategy here.
  const sessionByAssignee = new Map<string, GcSession>();
  for (const s of sessions) {
    if (s.alias) sessionByAssignee.set(s.alias, s);
    if (s.session_name) sessionByAssignee.set(s.session_name, s);
    sessionByAssignee.set(s.id, s);
  }
  const openBeadIds = new Set<string>(openBeads.map((b) => b.id));
  const closedAtById = new Map<string, string>();
  for (const b of closedBeads) {
    if (b.closed_at) closedAtById.set(b.id, b.closed_at);
  }

  const cols: Record<KanbanColumn, KanbanCard[]> = {
    mayor_plate: [],
    in_flight: [],
    stalled: [],
    blocked_real: [],
    blocked_stale: [],
    in_review: [],
    needs_changes: [],
    approved: [],
    closed_24h: [],
  };
  const nowMs = now.getTime();

  // Classify open + in_progress beads.
  for (const bead of openBeads) {
    if (!isEngBead(bead)) continue;
    const col = classifyKanban(bead, sessionByAssignee, openBeadIds, nowMs, closedAtById);
    if (col === null) continue;
    cols[col].push(toKanbanCard(bead, sessionByAssignee, openBeadIds));
  }

  // Classify recently-closed beads (from the shell-exec source).
  for (const bead of closedBeads) {
    if (!isEngBead(bead)) continue;
    const col = classifyKanban(bead, sessionByAssignee, openBeadIds, nowMs, closedAtById);
    if (col === null) continue;
    cols[col].push(toKanbanCard(bead, sessionByAssignee, openBeadIds));
  }

  // Sort each column. Within a column:
  //   - closed_24h:   newest closure first (by last_active descending)
  //   - everything else: priority ascending (P0 first), then last_active desc
  for (const c of KANBAN_COLUMNS) {
    cols[c].sort((a, b) => {
      if (c === 'closed_24h') {
        return cmpIso(b.last_active, a.last_active);
      }
      if (a.priority !== b.priority) return a.priority - b.priority;
      return cmpIso(b.last_active, a.last_active);
    });
  }

  const total = KANBAN_COLUMNS.reduce((sum, c) => sum + cols[c].length, 0);
  return { as_of: now.toISOString(), columns: cols, total };
}

function cmpIso(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
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

  router.get('/kanban', async (_req, res) => {
    try {
      // Three sources combined: open beads (supervisor /beads), recent
      // closures (bd CLI shell-exec for the 24h window — supervisor
      // omits closed_at), and sessions (for in-flight vs stalled).
      // Parallel fetches.
      const closedAfter = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
      const [openResp, sessionResp, closedExec] = await Promise.all([
        gc.listBeads(undefined, { limit: 1000 }),
        gc.listSessions(),
        execBdListClosed(cityPath, closedAfter, 500),
      ]);
      let closedBeads: GcBead[] = [];
      if (closedExec.exitCode === 0 && closedExec.stdout.length > 0) {
        try {
          const parsed = JSON.parse(closedExec.stdout);
          if (Array.isArray(parsed)) closedBeads = parsed as GcBead[];
        } catch {
          /* leave closedBeads empty — partial failure is fine for the Kanban */
        }
      }
      const payload = buildKanban(openResp.items, closedBeads, sessionResp.items, new Date());
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/admin/kanban',
        parsed_args: {
          open_count: String(openResp.items.length),
          closed_count: String(closedBeads.length),
          session_count: String(sessionResp.items.length),
        },
        duration_ms: closedExec.durationMs,
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
        error: 'failed to compute kanban',
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
