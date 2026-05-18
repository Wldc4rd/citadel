import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnsiUp } from 'ansi_up';
import type { GcSession, PeekResult } from 'thriva-admin-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';

const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

export function AgentsPage() {
  const [rows, setRows] = useState<GcSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [peekFor, setPeekFor] = useState<GcSession | null>(null);
  const [peekResult, setPeekResult] = useState<PeekResult | null>(null);
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
          {error && <span className="text-xs text-error-500">{error}</span>}
          <Button size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      <div className="panel">
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="No active sessions"
        />
      </div>

      <Modal
        open={peekFor !== null}
        onClose={() => setPeekFor(null)}
        title={peekFor ? `${peekFor.alias ?? peekFor.title ?? peekFor.id} — peek` : 'peek'}
        caption={peekResult ? `${peekResult.bytes} bytes · captured ${formatRelative(peekResult.captured_at, Date.now())}` : 'one-shot tmux snapshot'}
        widthClass="max-w-5xl"
        footer={
          <Button
            size="sm"
            tone="ghost"
            onClick={() => peekFor && void handlePeek(peekFor)}
            disabled={peekLoading}
          >
            Re-peek
          </Button>
        }
      >
        <PeekContent
          loading={peekLoading}
          error={peekError}
          result={peekResult}
        />
      </Modal>
    </section>
  );
}

function PeekContent({
  loading,
  error,
  result,
}: {
  loading: boolean;
  error: string | null;
  result: PeekResult | null;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!result || !preRef.current) return;
    // ansi_up sees only safe SGR sequences — server strips OSC + cursor moves.
    const renderer = new AnsiUp();
    renderer.use_classes = true;
    preRef.current.innerHTML = renderer.ansi_to_html(result.content);
  }, [result]);

  if (loading) {
    return <p className="text-ink-300 italic text-sm">Fetching tmux pane…</p>;
  }
  if (error) {
    return (
      <p className="text-error-500 text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (!result) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-warn-500 bg-warn-500/10 border border-warn-500/30 rounded-md px-2 py-1">
        {PROMPT_INJECTION_NOTICE}
      </p>
      <pre
        ref={preRef}
        className="bg-ink-900 border border-ink-700 rounded-md p-3 text-xs font-sans whitespace-pre-wrap leading-relaxed overflow-x-auto"
      />
      {result.truncated && (
        <p className="text-[11px] text-ink-300 italic">
          Output was truncated at the 100&thinsp;KB cap. Run <code>gc session peek</code> in a terminal for the full pane.
        </p>
      )}
    </div>
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
