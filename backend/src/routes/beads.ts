import { Router } from 'express';
import type {
  BeadDetailRaw,
  BeadDetailResponse,
  BeadSortKey,
  BeadSortOrder,
  GcBead,
  ListBeadsResponse,
} from 'citadel-shared';
import type { GcClient } from '../gc-client.js';
import { execBdShow, execBeadAction, ExecError } from '../exec.js';
import { renderMarkdownSafe } from '../markdown.js';
import { recordAudit } from '../audit.js';

// Must mirror BEAD_ID_RE in exec.ts so claim/close/nudge (write) and
// the drill-in /:id (read) accept the same prefix set: td/th/jt/cd/thriva.
const BEAD_ID_RE = /^(td|th|jt|cd|thriva)-[a-z0-9-]{3,32}$/;

// cd-d68p: pagination + filter + sort moved server-side. Mayor's
// pragmatic defaults: cursor pagination, server-side WHERE/ORDER BY,
// server returns next-cursor each page.
//
// DEFAULT_PAGE_SIZE 50 keeps interactive pages small and responsive.
// MAX_PAGE_SIZE 1000 is the supervisor's natural cap; the Beads UI
// stays under the mayor's 200-per-page guidance by default, while bulk
// callers (Cockpit "all beads" panels, AgentDetail's assignee filter)
// can opt into the larger window without paginating through the API.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;
// Engineering view (default) issues four type-filtered supervisor
// queries and merges the result. Each query is bounded to keep total
// memory + latency predictable even at heavy growth.
// Stable across rigs — config-promotion not planned. (Distinct from
// the OWNER_ALIAS pattern which IS config-driven via td-4k317p; this
// list is hardcoded because the engineering-vs-noise type set is a
// steady-state product decision, not a per-deploy knob.)
const ENGINEERING_TYPES: ReadonlyArray<string> = ['feature', 'bug', 'task', 'docs'];
const ENGINEERING_PER_TYPE_LIMIT = 1000;
const VALID_SORT_KEYS: ReadonlySet<BeadSortKey> = new Set<BeadSortKey>([
  'id',
  'priority',
  'created_at',
  'updated_at',
  'status',
]);
const VALID_STATUS = new Set(['open', 'in_progress', 'blocked', 'closed']);
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const TYPE_RE = /^[a-z][a-z_-]{0,31}$/;

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// Cursor encodes offset today; format is internal. `v: 1` is the
// version byte — future migration to a stable (sort_key, id) cursor
// can bump to `v: 2` without breaking deployed clients that hold a
// `v: 1` value. Drift on concurrent insert is a known limitation —
// clients observing an item appearing twice (or skipped) across pages
// should refetch from offset 0. The "stable cursor" migration (per
// reviewer alternative (b)) is filed as a follow-up; (c) per the
// reviewer's three-way choice is the chosen shape for cd-d68p.
const CURSOR_VERSION = 1;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      v?: unknown;
      o?: unknown;
    };
    // Reject unknown cursor versions. Tolerate v=undefined for any
    // residual pre-version-byte cursors still in flight from a paused
    // browser tab (treat as v=1 since that was the only shape).
    if (decoded.v !== undefined && decoded.v !== CURSOR_VERSION) return 0;
    const offset = decoded?.o;
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 && offset < 1_000_000) {
      return offset;
    }
  } catch {
    /* falls through to 0 — invalid cursors are treated as start-of-list */
  }
  return 0;
}

interface ParsedQuery {
  sort: BeadSortKey;
  order: BeadSortOrder;
  label: string | undefined;
  /**
   * cd-iiq7: cockpit pipeline-stage chips (e.g., "needs-impl") link to
   * /beads with this param so the page filters to any label starting
   * with the prefix. The supervisor's /v0/beads doesn't accept a
   * label-prefix flag, so the prefix filter runs AFTER the fan-out in
   * the engineering branch (and AFTER the supervisor's single-query
   * response in the passthrough branch). Validated against the same
   * LABEL_RE the exact-match `label` param uses.
   */
  label_prefix: string | undefined;
  status: 'open' | 'in_progress' | 'blocked' | 'closed' | undefined;
  type: string | undefined;
  offset: number;
  limit: number;
  showAll: boolean;
}

function parseListQuery(query: Record<string, unknown>): ParsedQuery | { error: string } {
  const sortRaw = typeof query.sort === 'string' ? query.sort : undefined;
  const sort: BeadSortKey = sortRaw && VALID_SORT_KEYS.has(sortRaw as BeadSortKey)
    ? (sortRaw as BeadSortKey)
    : 'updated_at';
  const orderRaw = typeof query.order === 'string' ? query.order : undefined;
  const order: BeadSortOrder = orderRaw === 'asc' ? 'asc' : 'desc';

  const label = typeof query.label === 'string' && LABEL_RE.test(query.label) ? query.label : undefined;
  if (typeof query.label === 'string' && query.label.length > 0 && label === undefined) {
    return { error: 'invalid label' };
  }
  const labelPrefixRaw = typeof query.label_prefix === 'string' ? query.label_prefix : undefined;
  const label_prefix = labelPrefixRaw && LABEL_RE.test(labelPrefixRaw) ? labelPrefixRaw : undefined;
  if (typeof labelPrefixRaw === 'string' && labelPrefixRaw.length > 0 && label_prefix === undefined) {
    return { error: 'invalid label_prefix' };
  }
  const statusRaw = typeof query.status === 'string' ? query.status : undefined;
  if (statusRaw && !VALID_STATUS.has(statusRaw)) return { error: 'invalid status' };
  const type = typeof query.type === 'string' && TYPE_RE.test(query.type) ? query.type : undefined;
  if (typeof query.type === 'string' && query.type.length > 0 && type === undefined) {
    return { error: 'invalid type' };
  }

  const limit = parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = decodeCursor(query.cursor);
  const showAll = query.showAll === '1';

  return {
    sort,
    order,
    label,
    label_prefix,
    status: (statusRaw as ParsedQuery['status']) ?? undefined,
    type,
    offset,
    limit,
    showAll,
  };
}

function compareForSort(a: GcBead, b: GcBead, sort: BeadSortKey, order: BeadSortOrder): number {
  const dir = order === 'asc' ? 1 : -1;
  // Read the requested sort field, falling back to created_at when the
  // primary is missing (updated_at is not always populated by the
  // supervisor; see gc-supervisor-s-v0-city-name-beads-endpoint memory).
  const get = (bead: GcBead): string | number | null => {
    switch (sort) {
      case 'id': return bead.id;
      case 'priority': return bead.priority ?? null;
      case 'created_at': return bead.created_at ?? null;
      case 'updated_at': return bead.updated_at ?? bead.created_at ?? null;
      case 'status': return bead.status ?? null;
      default: return null;
    }
  };
  const av = get(a);
  const bv = get(b);
  if (av === bv) {
    // Stable tiebreak by id (lex, asc) so the page boundaries don't slide.
    return a.id.localeCompare(b.id);
  }
  if (av === null) return -dir;
  if (bv === null) return dir;
  if (av < bv) return -dir;
  if (av > bv) return dir;
  return 0;
}

export function beadsRouter(gc: GcClient, cityPath: string, ownerAlias: string): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = parseListQuery(req.query as Record<string, unknown>);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error, kind: 'validation' });
      return;
    }
    const { sort, order, label, label_prefix, status, type, offset, limit, showAll } = parsed;

    try {
      // Two materialisation paths:
      //
      //   "passthrough": the caller specified showAll OR an explicit type
      //   filter. We forward exactly one supervisor query with sort+order
      //   +offset+limit applied upstream. Supervisor's `total` is the
      //   filter-matching count; the page is what the supervisor returns.
      //
      //   "engineering" (default): hide non-engineering noise. The
      //   supervisor doesn't accept a comma-list of types, so we fan out
      //   four parallel queries (one per engineering type) with the
      //   filter+sort upstream, then merge, sort once locally to break
      //   ties consistently across the four sources, and slice the
      //   requested page. Total is the sum of the four supervisor totals.
      const view: 'engineering' | 'passthrough' = (showAll || type) ? 'passthrough' : 'engineering';

      const sharedParams = { sort, order, status, label };
      let items: GcBead[];
      let total: number;
      // Truthy iff any per-type supervisor query in the engineering
      // fan-out hit ENGINEERING_PER_TYPE_LIMIT. Surface to UI so Charlie
      // knows a wider view exists (passthrough / showAll=1) when the
      // current page might be incomplete.
      let view_capped = false;

      if (view === 'passthrough') {
        const upstream = await gc.listBeads(undefined, {
          ...sharedParams,
          type,
          offset,
          limit,
        });
        items = upstream.items;
        total = typeof upstream.total === 'number' ? upstream.total : items.length;
      } else {
        const responses = await Promise.all(
          ENGINEERING_TYPES.map((t) =>
            gc.listBeads(undefined, {
              ...sharedParams,
              type: t,
              limit: ENGINEERING_PER_TYPE_LIMIT,
            }),
          ),
        );
        // Engineering view filter: drop items whose labels start with `gc:`
        // (session/message noise). Mirrors the pre-cd-d68p
        // defaultBeadFilter — dropping this was a latent regression
        // even though the live store has 0 such beads today.
        const merged: GcBead[] = [];
        for (const r of responses) {
          merged.push(...r.items);
          if (r.items.length === ENGINEERING_PER_TYPE_LIMIT) view_capped = true;
        }
        let filtered = merged.filter((b) =>
          !(Array.isArray(b.labels) && b.labels.some((l) => l.startsWith('gc:'))),
        );
        // cd-iiq7: optional label-prefix filter — used by the cockpit's
        // pipeline-stage chips (e.g. "needs-impl" → filter to any bead
        // whose label starts with "needs-impl"). Server-side here keeps
        // pagination honest (total reflects the prefix-filtered set,
        // same discipline as the gc:* filter above).
        if (label_prefix !== undefined) {
          const pfx = label_prefix;
          filtered = filtered.filter((b) =>
            Array.isArray(b.labels) && b.labels.some((l) => l.startsWith(pfx)),
          );
        }
        filtered.sort((a, b) => compareForSort(a, b, sort, order));
        // total comes from the FILTERED set — pagination would otherwise
        // "lie" by emitting a non-null next_cursor pointing into an empty
        // slice when per-type queries were truncated and the upstream sum
        // exceeded what we actually fetched.
        total = filtered.length;
        items = filtered.slice(offset, offset + limit);
      }

      const next_cursor = offset + items.length < total ? encodeCursor(offset + limit) : null;
      const prev_cursor = offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null;
      const payload: ListBeadsResponse = {
        items,
        total,
        next_cursor,
        prev_cursor,
        page_size: limit,
        sort,
        order,
        view,
        view_capped,
      };
      res.json(payload);
    } catch (err) {
      res.status(502).json({
        error: 'failed to list beads',
        kind: 'upstream',
        details: { message: (err as Error).message },
      });
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
    await runBeadAction(req.params.id, 'claim', ownerAlias, undefined, res);
  });

  router.post('/:id/close', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await runBeadAction(req.params.id, 'close', ownerAlias, reason, res);
  });

  router.post('/:id/nudge', async (req, res) => {
    await runBeadAction(req.params.id, 'nudge', ownerAlias, undefined, res);
  });

  return router;
}

async function runBeadAction(
  beadId: string,
  action: 'claim' | 'close' | 'nudge',
  ownerAlias: string,
  reason: string | undefined,
  res: import('express').Response,
): Promise<void> {
  if (!BEAD_ID_RE.test(beadId)) {
    res.status(400).json({ error: 'invalid bead id', kind: 'validation' });
    return;
  }
  try {
    const result = await execBeadAction(beadId, action, ownerAlias, reason);
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
