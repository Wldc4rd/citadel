import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GcSession, TranscriptResult } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';
import { SessionPeekContent, formatPeekCaption } from '../components/SessionPeekContent';
import { useGcEventRefresh } from '../hooks/useGcEvents';

export function AgentsPage() {
  const [rows, setRows] = useState<GcSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [peekFor, setPeekFor] = useState<GcSession | null>(null);
  const [peekResult, setPeekResult] = useState<TranscriptResult | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items } = await api.listSessions();
      setRows(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 15_000);
    return () => clearInterval(tick);
  }, []);

  // Phase C: live updates from gc supervisor's SSE stream. When the
  // supervisor emits any session.* event, refetch the table. Falls back
  // silently if the stream disconnects — the manual Refresh button is
  // the user-controlled escape valve per architect's design.
  const sseState = useGcEventRefresh(['session.'], () => void refresh());

  const handlePeek = useCallback(async (session: GcSession) => {
    setPeekFor(session);
    setPeekResult(null);
    setPeekError(null);
    setPeekLoading(true);
    try {
      const result = await api.peekSession(session.id);
      setPeekResult(result);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'peek failed';
      setPeekError(msg);
    } finally {
      setPeekLoading(false);
    }
  }, []);

  const columns = useMemo<ReadonlyArray<TableColumn<GcSession>>>(() => [
    {
      key: 'alias',
      label: 'Agent',
      sortable: true,
      sortValue: (r) => r.alias ?? r.title ?? r.id,
      render: (r) => (
        <div className="min-w-0">
          <div className="text-ink-100 font-medium truncate">
            {r.alias ?? r.title ?? r.id}
          </div>
          <div className="text-[11px] text-ink-300 truncate">
            {r.template ?? r.provider ?? ''}
          </div>
        </div>
      ),
    },
    {
      key: 'state',
      label: 'State',
      sortable: true,
      sortValue: (r) => r.state,
      render: (r) => <StatePill state={r.state} attached={r.attached} reason={r.reason} />,
      className: 'w-28',
    },
    {
      key: 'activity',
      label: 'Activity',
      sortable: true,
      sortValue: (r) => r.activity ?? '',
      render: (r) => (
        <span className="text-ink-200 text-xs">
          {r.activity ?? (r.running ? 'running' : '—')}
        </span>
      ),
      className: 'w-24',
    },
    {
      key: 'context',
      label: 'Context',
      sortable: true,
      sortValue: (r) => r.context_pct ?? -1,
      align: 'right',
      render: (r) =>
        typeof r.context_pct === 'number' ? (
          <span
            className={`text-xs tabular-nums ${
              r.context_pct >= 95
                ? 'text-error-500'
                : r.context_pct >= 80
                  ? 'text-warn-500'
                  : 'text-ink-200'
            }`}
          >
            {r.context_pct}%
          </span>
        ) : (
          <span className="text-ink-300">—</span>
        ),
      className: 'w-20',
    },
    {
      key: 'last_active',
      label: 'Last active',
      sortable: true,
      sortValue: (r) => r.last_active ?? r.created_at,
      render: (r) => (
        <span className="text-xs text-ink-200 tabular-nums">
          {formatRelative(r.last_active ?? r.created_at, now)}
        </span>
      ),
      className: 'w-32',
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <Button size="sm" tone="ghost" onClick={() => void handlePeek(r)}>
          Peek
        </Button>
      ),
      align: 'right',
      className: 'w-20',
    },
  ], [handlePeek, now]);

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Agents</h1>
          <p className="text-xs text-ink-300">
            Live session state from <code className="font-sans">gc supervisor</code>. Click Peek for a one-shot tmux snapshot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SseIndicator state={sseState} />
          {error && <span className="text-xs text-error-500">{error}</span>}
          <Button size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      <div className="panel">
        {/* td-liky3d: default newest-first by last_active so most recently
            active sessions sit at the top + the idle ones drop to the bottom. */}
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No active sessions"
          initialSort={{ key: 'last_active', dir: 'desc' }}
        />
      </div>

      <Modal
        open={peekFor !== null}
        onClose={() => setPeekFor(null)}
        title={peekFor ? `${peekFor.alias ?? peekFor.title ?? peekFor.id} — transcript` : 'transcript'}
        caption={
          peekResult
            ? formatPeekCaption(peekResult, Date.now())
            : "one-shot snapshot from gc supervisor's /transcript API"
        }
        widthClass="max-w-5xl"
        footer={
          <Button
            size="sm"
            tone="ghost"
            onClick={() => peekFor && void handlePeek(peekFor)}
            disabled={peekLoading}
          >
            Re-fetch
          </Button>
        }
      >
        <SessionPeekContent
          loading={peekLoading}
          error={peekError}
          result={peekResult}
        />
      </Modal>
    </section>
  );
}

function SseIndicator({ state }: { state: 'connecting' | 'open' | 'closed' }) {
  const tone =
    state === 'open'
      ? 'bg-accent-700/30 text-accent-500 border-accent-700/40'
      : state === 'connecting'
        ? 'bg-warn-500/20 text-warn-500 border-warn-500/30'
        : 'bg-error-500/20 text-error-500 border-error-500/30';
  const label = state === 'open' ? 'live' : state === 'connecting' ? 'connecting' : 'offline';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
      title={`SSE stream: ${state}`}
    >
      <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${state === 'open' ? 'bg-accent-500 animate-pulse' : 'bg-current'}`} />
      {label}
    </span>
  );
}

function StatePill({
  state,
  attached,
  reason,
}: {
  state: string;
  attached: boolean;
  reason?: string;
}) {
  const tone =
    state === 'active'
      ? 'bg-accent-700/40 text-accent-500 border-accent-700/60'
      : state === 'asleep'
        ? 'bg-ink-700 text-ink-300 border-ink-600'
        : state === 'failed' || state === 'closed'
          ? 'bg-error-500/20 text-error-500 border-error-500/30'
          : 'bg-ink-700/60 text-ink-200 border-ink-600';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
      title={reason ? `reason: ${reason}` : undefined}
    >
      {state}
      {attached && <span className="text-[9px] uppercase">·att</span>}
    </span>
  );
}

function formatRelative(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diffSec = Math.max(0, Math.round((now - ms) / 1_000));
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h`;
  return `${Math.round(diffSec / 86_400)}d`;
}
