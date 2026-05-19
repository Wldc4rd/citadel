import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GcBead } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';
import { useGcEventRefresh } from '../hooks/useGcEvents';

export function BeadsPage() {
  const [rows, setRows] = useState<GcBead[]>([]);
  const [showing, setShowing] = useState(0);
  const [upstreamTotal, setUpstreamTotal] = useState<number | undefined>(undefined);
  const [upstreamFetched, setUpstreamFetched] = useState<number | undefined>(undefined);
  const [fetchLimit, setFetchLimit] = useState<number | undefined>(undefined);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [closing, setClosing] = useState<GcBead | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [actionInFlight, setActionInFlight] = useState<{ id: string; action: string } | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listBeads(showAll);
      setRows(data.items);
      setShowing(data.total);
      setUpstreamTotal(data.upstream_total);
      setUpstreamFetched(data.upstream_fetched);
      setFetchLimit(data.fetch_limit);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  // td-nky2js: label filter — click a chip on a row, only show rows that
  // carry that label. Click again (or "clear") to drop it. Filter applies
  // client-side over the data the backend already returned.
  const filteredRows = useMemo(() => {
    if (labelFilter === null) return rows;
    return rows.filter((r) => Array.isArray(r.labels) && r.labels.includes(labelFilter));
  }, [rows, labelFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Phase C: live updates when supervisor emits bead.*
  useGcEventRefresh(['bead.'], () => void refresh());

  const runAction = useCallback(
    async (
      bead: GcBead,
      action: 'claim' | 'close' | 'nudge',
      reason?: string,
    ): Promise<void> => {
      setActionInFlight({ id: bead.id, action });
      setActionResult(null);
      try {
        if (action === 'claim') await api.claimBead(bead.id);
        else if (action === 'close') await api.closeBead(bead.id, reason);
        else await api.nudgeBead(bead.id);
        setActionResult(`${action} ${bead.id} → ok`);
        await refresh();
      } catch (err) {
        const msg =
          err instanceof ApiClientError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'action failed';
        setActionResult(`${action} ${bead.id} → ${msg}`);
      } finally {
        setActionInFlight(null);
      }
    },
    [refresh],
  );

  const columns = useMemo<ReadonlyArray<TableColumn<GcBead>>>(() => [
    {
      key: 'id',
      label: 'ID',
      sortable: true,
      sortValue: (r) => r.id,
      render: (r) => (
        <Link
          to={`/beads/${encodeURIComponent(r.id)}`}
          className="font-sans text-xs text-accent-500 hover:underline"
          title="Open bead drill-in"
        >
          {r.id}
        </Link>
      ),
      className: 'w-28',
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      sortValue: (r) => r.title,
      render: (r) => (
        <div className="min-w-0">
          <Link
            to={`/beads/${encodeURIComponent(r.id)}`}
            className="text-ink-100 truncate hover:text-accent-500 hover:underline block"
            title="Open bead drill-in"
          >
            {r.title}
          </Link>
          <p className="text-[11px] text-ink-300">
            {r.issue_type}{r.assignee ? ` · ${r.assignee}` : ''}
          </p>
          {/* td-nky2js: inline label chips, colour-coded by family. Click
              a chip to filter the table to that label. Memory
              "gc-labels-state-sling-delivery" — pipeline state is label-
              driven, so labels need at-a-glance visibility. */}
          {Array.isArray(r.labels) && r.labels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.labels.slice(0, 8).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLabelFilter((cur) => (cur === l ? null : l));
                  }}
                  className={`text-[10px] px-1.5 py-0.5 rounded border ${labelTone(l)} hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500`}
                  title={`Filter to label "${l}"`}
                >
                  {l}
                </button>
              ))}
              {r.labels.length > 8 && (
                <span className="text-[10px] text-ink-300 italic px-1">
                  +{r.labels.length - 8} more
                </span>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'priority',
      label: 'P',
      sortable: true,
      sortValue: (r) => r.priority,
      render: (r) => (
        <span
          className={`text-xs tabular-nums font-medium ${
            r.priority === 0
              ? 'text-error-500'
              : r.priority === 1
                ? 'text-warn-500'
                : 'text-ink-200'
          }`}
        >
          P{r.priority}
        </span>
      ),
      align: 'right',
      className: 'w-10',
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortValue: (r) => r.status,
      render: (r) => <StatusPill status={r.status} />,
      className: 'w-28',
    },
    {
      key: 'updated',
      label: 'Updated',
      sortable: true,
      sortValue: (r) => r.updated_at ?? r.created_at,
      render: (r) => (
        <span className="text-xs text-ink-200 tabular-nums">
          {formatDate(r.updated_at ?? r.created_at)}
        </span>
      ),
      className: 'w-28',
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            tone="ghost"
            disabled={r.status === 'in_progress' || actionInFlight !== null}
            onClick={() => void runAction(r, 'claim')}
          >
            Claim
          </Button>
          <Button
            size="sm"
            tone="ghost"
            disabled={r.status === 'closed' || actionInFlight !== null}
            onClick={() => {
              setCloseReason('');
              setClosing(r);
            }}
          >
            Close
          </Button>
          <Button
            size="sm"
            tone="ghost"
            disabled={!r.assignee || actionInFlight !== null}
            onClick={() => void runAction(r, 'nudge')}
            title={r.assignee ? `nudge ${r.assignee}` : 'no assignee'}
          >
            Nudge
          </Button>
        </div>
      ),
      align: 'right',
      className: 'w-44',
    },
  ], [actionInFlight, runAction]);

  // td-7t24i6: surface the fetch-window truncation so Charlie sees when
  // the dashboard is potentially undercounting. With fetch_limit=1000 and
  // the city's ~2139 total, the engineering working set fits comfortably
  // (~183 eng-only), but a future growth could push past the window —
  // this pill shows when that happens.
  const isTruncated =
    typeof upstreamTotal === 'number' &&
    typeof upstreamFetched === 'number' &&
    upstreamFetched < upstreamTotal;
  const truncationMessage = isTruncated
    ? `fetch window covered ${upstreamFetched} of ${upstreamTotal} store beads — raise limit if engineering work past the window`
    : null;

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-sans font-semibold text-ink-100">Beads</h1>
          <p className="text-xs text-ink-300">
            Engineering work in <code className="font-sans">gc bd</code>
            {' · '}
            <span className="text-ink-200">{filteredRows.length}</span>
            {labelFilter !== null ? (
              <> matching <code className="text-accent-500">{labelFilter}</code></>
            ) : (
              <> of {showing} engineering bead{showing === 1 ? '' : 's'}</>
            )}
            {typeof upstreamTotal === 'number' && (
              <> · fetched {upstreamFetched ?? '?'} of {upstreamTotal} store beads (limit {fetchLimit ?? '?'})</>
            )}
            {' · v0 filter hides session/message noise.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-error-500">{error}</span>}
          <label className="flex items-center gap-1.5 text-xs text-ink-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-accent-700"
            />
            show all
          </label>
          <Button size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {truncationMessage && (
        <div className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-1.5 text-xs text-warn-500">
          ⚠ {truncationMessage}
        </div>
      )}

      {labelFilter !== null && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-xs text-accent-500 flex items-center justify-between gap-3">
          <span>
            Filtering by label <code className="font-sans text-ink-100">{labelFilter}</code>
          </span>
          <button
            type="button"
            onClick={() => setLabelFilter(null)}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            clear
          </button>
        </div>
      )}

      {actionResult && (
        <div className="rounded-md border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs text-ink-200">
          {actionResult}
        </div>
      )}

      <div className="panel">
        {/* td-liky3d: default newest-first by updated_at — most recently
            touched beads at the top. The user can re-sort by any sortable
            column (priority, status, id, title) by clicking the header. */}
        <Table
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.id}
          empty={
            labelFilter !== null
              ? `No beads on this page match label "${labelFilter}"`
              : 'Nothing on the queue right now'
          }
          initialSort={{ key: 'updated', dir: 'desc' }}
        />
      </div>

      <Modal
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={closing ? `Close ${closing.id}` : 'Close bead'}
        caption={closing?.title}
        widthClass="max-w-lg"
        footer={
          <>
            <Button tone="ghost" size="sm" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              tone="accent"
              size="sm"
              disabled={actionInFlight !== null}
              onClick={() => {
                if (!closing) return;
                const c = closing;
                setClosing(null);
                void runAction(c, 'close', closeReason.trim() || undefined);
              }}
            >
              {actionInFlight?.action === 'close' ? 'Closing…' : 'Close bead'}
            </Button>
          </>
        }
      >
        <label className="block text-xs text-ink-200">
          Reason <span className="text-ink-300">(optional)</span>
          <textarea
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="What was resolved + how"
            rows={5}
            className="mt-1 w-full bg-ink-900 border border-ink-600 rounded-md px-2 py-1.5 text-sm font-body focus:border-accent-700 focus:outline-none focus:ring-2 focus:ring-accent-700/30"
          />
        </label>
      </Modal>
    </section>
  );
}

// td-nky2js: colour-code label chips by family so Charlie's eye picks out
// pipeline-state at a glance. Comments document the mapping rationale.
function labelTone(label: string): string {
  // Pipeline-state labels (load-bearing per gc-labels-state-sling-delivery memory)
  if (label === 'approved' || label.endsWith('-approved')) {
    return 'bg-accent-700/30 border-accent-700/40 text-accent-500';
  }
  if (label === 'needs-review' || label.startsWith('needs-review-')) {
    return 'bg-thriva-primary/20 border-thriva-primary/40 text-thriva-primary';
  }
  if (label.startsWith('needs-impl:') || label.startsWith('needs-')) {
    return 'bg-warn-500/20 border-warn-500/40 text-warn-500';
  }
  if (label === 'blocked' || label === 'mayor-skip' || label === 'mayor-needs-human') {
    return 'bg-error-500/20 border-error-500/40 text-error-500';
  }
  // Scope + admin labels
  if (label.startsWith('scope:')) {
    return 'bg-ink-700 border-ink-600 text-ink-200';
  }
  if (label.startsWith('gc:') || label.startsWith('agent:')) {
    return 'bg-ink-800 border-ink-700 text-ink-300';
  }
  // Default — distinct enough to read but quiet enough not to fight the state labels
  return 'bg-ink-700/60 border-ink-600 text-ink-200';
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'open'
      ? 'bg-ink-700 text-ink-200 border-ink-600'
      : status === 'in_progress'
        ? 'bg-accent-700/30 text-accent-500 border-accent-700/40'
        : status === 'blocked'
          ? 'bg-error-500/20 text-error-500 border-error-500/30'
          : 'bg-ink-700/40 text-ink-300 border-ink-600';
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {status}
    </span>
  );
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
