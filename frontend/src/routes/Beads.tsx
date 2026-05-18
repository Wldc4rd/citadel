import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GcBead } from 'thriva-admin-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';
import { useGcEventRefresh } from '../hooks/useGcEvents';

export function BeadsPage() {
  const [rows, setRows] = useState<GcBead[]>([]);
  const [total, setTotal] = useState(0);
  const [returned, setReturned] = useState(0);
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
      setTotal(data.total);
      setReturned(data.returned);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [showAll]);

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
        <code className="font-sans text-xs text-accent-500">{r.id}</code>
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
          <p className="text-ink-100 truncate">{r.title}</p>
          <p className="text-[11px] text-ink-300">
            {r.issue_type}{r.assignee ? ` · ${r.assignee}` : ''}
          </p>
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

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Beads</h1>
          <p className="text-xs text-ink-300">
            Engineering work in <code className="font-sans">gc bd</code> · showing {returned} of {total} · v0 filter hides session/message noise.
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
          rows={rows}
          rowKey={(r) => r.id}
          empty="Nothing on the queue right now"
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
