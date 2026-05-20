import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BeadSortKey, BeadSortOrder, GcBead, ListBeadsResponse } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn, type SortState } from '../components/Table';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { usePageTitle } from '../hooks/usePageTitle';

// cd-d68p: sort + filter + pagination are now server-side. Cursor is an
// opaque token from the backend; prev/next come back in the response and
// we just hand them back unchanged on the next click. Sort lives in
// component state and round-trips to the API on every header click.

const SORT_COL_TO_KEY: Record<string, BeadSortKey> = {
  id: 'id',
  priority: 'priority',
  status: 'status',
  updated: 'updated_at',
};

const KEY_TO_SORT_COL: Record<BeadSortKey, string> = {
  id: 'id',
  priority: 'priority',
  status: 'status',
  updated_at: 'updated',
  created_at: 'updated', // share the "time" column header for either time key
};

// cd-iiq7: validate URL-driven status filter at the consumer boundary.
// Mirrors backend/src/routes/beads.ts VALID_STATUS so a bogus deep-link
// (e.g. ?status=garbage) silently falls through instead of forcing the
// server to 400 on bootstrap.
const URL_STATUS_VALUES = new Set<'open' | 'in_progress' | 'blocked' | 'closed'>([
  'open',
  'in_progress',
  'blocked',
  'closed',
]);
// LABEL_RE mirror for URL filter sanitisation. Mirrors backend regex.
const URL_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;

export function BeadsPage() {
  usePageTitle('Beads');
  // cd-iiq7: deep-link via URL params — cockpit chips hand us
  // ?status=… / ?label=… / ?label_prefix=… and we hydrate the filter
  // state once on mount. Interactive filter changes (e.g. clicking a
  // label chip) do NOT push back to the URL today — URL state sync is
  // a follow-up (the cd-d68p reviewer flagged it).
  const [searchParams] = useSearchParams();
  const initialStatus = (() => {
    const v = searchParams.get('status');
    return v && URL_STATUS_VALUES.has(v as 'open') ? (v as 'open' | 'in_progress' | 'blocked' | 'closed') : null;
  })();
  const initialLabel = (() => {
    const v = searchParams.get('label');
    return v && URL_LABEL_RE.test(v) ? v : null;
  })();
  const initialLabelPrefix = (() => {
    const v = searchParams.get('label_prefix');
    return v && URL_LABEL_RE.test(v) ? v : null;
  })();

  const [data, setData] = useState<ListBeadsResponse | null>(null);
  const [sort, setSort] = useState<BeadSortKey>('updated_at');
  const [order, setOrder] = useState<BeadSortOrder>('desc');
  const [labelFilter, setLabelFilter] = useState<string | null>(initialLabel);
  const [labelPrefixFilter, setLabelPrefixFilter] = useState<string | null>(initialLabelPrefix);
  const [statusFilter, setStatusFilter] = useState<'open' | 'in_progress' | 'blocked' | 'closed' | null>(initialStatus);
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
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
      const result = await api.listBeads({
        sort,
        order,
        label: labelFilter ?? undefined,
        label_prefix: labelPrefixFilter ?? undefined,
        status: statusFilter ?? undefined,
        showAll,
        cursor: cursor ?? undefined,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [sort, order, labelFilter, labelPrefixFilter, statusFilter, showAll, cursor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Phase C: live updates when supervisor emits bead.* — re-fetch the
  // current page. We don't reset the cursor; a state change on a row in
  // the current page should refresh in place without scrolling the user.
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

  const handleSortChange = useCallback((next: SortState) => {
    const key = SORT_COL_TO_KEY[next.key];
    if (!key) return;
    setSort(key);
    setOrder(next.dir);
    setCursor(null); // sort change resets to first page; cursor offsets are sort-dependent
  }, []);

  const handleLabelChipClick = useCallback((label: string) => {
    setLabelFilter((cur) => (cur === label ? null : label));
    setCursor(null);
  }, []);

  const tableSort = useMemo<SortState>(() => ({
    key: KEY_TO_SORT_COL[sort],
    dir: order,
  }), [sort, order]);

  const columns = useMemo<ReadonlyArray<TableColumn<GcBead>>>(() => [
    {
      key: 'id',
      label: 'ID',
      sortable: true,
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
      // Title isn't sortable server-side in this PR — supervisor only
      // accepts id/priority/created_at/updated_at/status. Drop the
      // sortable affordance so users don't get a no-op control.
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
          {Array.isArray(r.labels) && r.labels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.labels.slice(0, 8).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLabelChipClick(l);
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
      render: (r) => <StatusPill status={r.status} />,
      className: 'w-28',
    },
    {
      key: 'updated',
      label: 'Updated',
      sortable: true,
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
  ], [actionInFlight, runAction, handleLabelChipClick]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.page_size ?? 50;
  const view = data?.view ?? 'engineering';
  // Best-effort range estimate. We don't echo back the offset itself —
  // derive it from the cursor + items. The end of the page is offset +
  // items.length; start is end - items.length + 1.
  // To avoid coupling to cursor encoding, just show "N of total" + page hints.

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-sans font-semibold text-ink-100">Beads</h1>
          <p className="text-xs text-ink-300">
            Engineering work in <code className="font-sans">gc bd</code>
            {' · '}
            <span className="text-ink-200">
              {items.length} of {total} {view === 'engineering' ? 'engineering' : 'matching'} bead{total === 1 ? '' : 's'}
            </span>
            {labelFilter !== null && (
              <> · label <code className="text-accent-500">{labelFilter}</code></>
            )}
            {showAll && <> · <span className="text-warn-500">showing all (incl. session/message noise)</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-error-500">{error}</span>}
          <label className="flex items-center gap-1.5 text-xs text-ink-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => {
                setShowAll(e.target.checked);
                setCursor(null);
              }}
              className="accent-accent-700"
            />
            show all
          </label>
          <Button size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {labelFilter !== null && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-xs text-accent-500 flex items-center justify-between gap-3">
          <span>
            Filtering by label <code className="font-sans text-ink-100">{labelFilter}</code> · {total} total
          </span>
          <button
            type="button"
            onClick={() => {
              setLabelFilter(null);
              setCursor(null);
            }}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            clear
          </button>
        </div>
      )}

      {labelPrefixFilter !== null && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-xs text-accent-500 flex items-center justify-between gap-3">
          <span>
            Filtering by label-prefix <code className="font-sans text-ink-100">{labelPrefixFilter}*</code> · {total} total
          </span>
          <button
            type="button"
            onClick={() => {
              setLabelPrefixFilter(null);
              setCursor(null);
            }}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            clear
          </button>
        </div>
      )}

      {statusFilter !== null && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-xs text-accent-500 flex items-center justify-between gap-3">
          <span>
            Filtering by status <code className="font-sans text-ink-100">{statusFilter}</code> · {total} total
          </span>
          <button
            type="button"
            onClick={() => {
              setStatusFilter(null);
              setCursor(null);
            }}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            clear
          </button>
        </div>
      )}

      {data?.view_capped && (
        <div className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-1.5 text-xs text-warn-500 flex items-center justify-between gap-3">
          <span>
            Engineering view capped at 1000/type — some items may be missing.
            Toggle <code className="font-sans">show all</code> for the unfiltered view.
          </span>
          <button
            type="button"
            onClick={() => {
              setShowAll(true);
              setCursor(null);
            }}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn-500 rounded-sm"
          >
            show all
          </button>
        </div>
      )}

      {actionResult && (
        <div className="rounded-md border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs text-ink-200">
          {actionResult}
        </div>
      )}

      <div className="panel">
        <Table
          columns={columns}
          rows={items}
          rowKey={(r) => r.id}
          sort={tableSort}
          onSortChange={handleSortChange}
          empty={
            labelFilter !== null
              ? `No beads match label "${labelFilter}"`
              : 'Nothing on the queue right now'
          }
        />
      </div>

      <Pagination
        prevCursor={data?.prev_cursor ?? null}
        nextCursor={data?.next_cursor ?? null}
        onPage={(c) => setCursor(c)}
        pageSize={pageSize}
        total={total}
        disabled={loading}
      />

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

function Pagination({
  prevCursor,
  nextCursor,
  onPage,
  pageSize,
  total,
  disabled,
}: {
  prevCursor: string | null;
  nextCursor: string | null;
  onPage: (cursor: string | null) => void;
  pageSize: number;
  total: number;
  disabled: boolean;
}) {
  if (prevCursor === null && nextCursor === null && total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-ink-300">
      <span>
        Page size {pageSize} · {total} total
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          tone="ghost"
          disabled={prevCursor === null || disabled}
          onClick={() => onPage(prevCursor)}
        >
          ← Prev
        </Button>
        <Button
          size="sm"
          tone="ghost"
          disabled={nextCursor === null || disabled}
          onClick={() => onPage(nextCursor)}
        >
          Next →
        </Button>
      </div>
    </div>
  );
}

// td-nky2js: colour-code label chips by family so Charlie's eye picks out
// pipeline-state at a glance.
// Pipeline-state labels (approved/needs-review/needs-impl:*/needs-*) are
// LOAD-BEARING per the `gc-labels-state-sling-delivery` memory — they
// drive routing decisions in mayor + refinery. Before changing the
// colour-grouping below, read that memory; the groupings reflect the
// state-machine, not arbitrary aesthetics.
function labelTone(label: string): string {
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
    return 'bg-error-500/20 border-error-500/30 text-error-500';
  }
  if (label.startsWith('scope:')) {
    return 'bg-ink-700 border-ink-600 text-ink-200';
  }
  if (label.startsWith('gc:') || label.startsWith('agent:')) {
    return 'bg-ink-800 border-ink-700 text-ink-300';
  }
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
