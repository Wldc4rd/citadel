import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { GcSession, TranscriptResult } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';
import { SessionPeekContent, formatPeekCaption } from '../components/SessionPeekContent';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { usePageTitle } from '../hooks/usePageTitle';

/** Slug used as the /agents/:slug param. session_name is always present and URL-safe; alias has '/' which doesn't fit a single React Router segment. Fallback to id covers the rare missing-session_name case. */
function detailSlug(s: GcSession): string {
  return s.session_name ?? s.alias ?? s.id;
}

// cd-ycoh: visible filter UI + URL sync. The Agents page now exposes
// state / rig / template dropdowns with filter chips at the top, and
// every filter change writes to the URL so the view is shareable +
// survives reload. Reading the URL on mount also lets the cockpit's
// Sessions tally chips (cd-iiq7) deep-link into a filtered view.
//
// SCOPE NOTE — server-side execution is out of this PR. The bead
// description mentions it as forward-looking for "large agent counts",
// but /api/sessions doesn't accept query params today and a city's
// session count is well under 100 typical. Client-side filtering is
// cheap at this scale; if the count grows past ~1k we revisit.

export function AgentsPage() {
  usePageTitle('Agents');
  const [searchParams, setSearchParams] = useSearchParams();
  const stateFilter = searchParams.get('state');
  const rigFilter = searchParams.get('rig');
  const templateFilter = searchParams.get('template');

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

  // cd-ycoh: derive filter dropdown options from current rows so the
  // user only sees aliases/rigs/templates that actually exist. Stable
  // alphabetical ordering. The lists shrink as rows shrink (e.g. if
  // sessions failed off the screen) — that's correct because filters
  // for vanished values are unreachable.
  const uniqueStates = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.state) s.add(r.state);
    return Array.from(s).sort();
  }, [rows]);
  const uniqueRigs = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.rig) s.add(r.rig);
    return Array.from(s).sort();
  }, [rows]);
  const uniqueTemplates = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.template) s.add(r.template);
    return Array.from(s).sort();
  }, [rows]);

  const setFilter = useCallback((key: 'state' | 'rig' | 'template', value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const filteredRows = useMemo(() => {
    if (!stateFilter && !rigFilter && !templateFilter) return rows;
    return rows.filter((r) => {
      if (stateFilter && r.state !== stateFilter) return false;
      if (rigFilter && r.rig !== rigFilter) return false;
      if (templateFilter && r.template !== templateFilter) return false;
      return true;
    });
  }, [rows, stateFilter, rigFilter, templateFilter]);

  const anyFilterActive = stateFilter !== null || rigFilter !== null || templateFilter !== null;

  const columns = useMemo<ReadonlyArray<TableColumn<GcSession>>>(() => [
    {
      key: 'alias',
      label: 'Agent',
      sortable: true,
      sortValue: (r) => r.alias ?? r.title ?? r.id,
      render: (r) => (
        <Link
          to={`/agents/${encodeURIComponent(detailSlug(r))}`}
          className="block min-w-0 group"
          title="Open agent drill-in"
        >
          <div className="text-ink-100 font-medium truncate group-hover:text-accent-500 group-hover:underline">
            {r.alias ?? r.title ?? r.id}
          </div>
          <div className="text-[11px] text-ink-300 truncate">
            {r.template ?? r.provider ?? ''}
          </div>
        </Link>
      ),
    },
    {
      // cd-ycoh: rig column. Sortable; empty rig sorts last.
      key: 'rig',
      label: 'Rig',
      sortable: true,
      sortValue: (r) => r.rig ?? '',
      render: (r) =>
        r.rig ? (
          <span className="text-xs text-ink-200">{r.rig}</span>
        ) : (
          <span className="text-ink-300">—</span>
        ),
      className: 'w-20',
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
            Live session state from <code className="font-sans">gc supervisor</code>. Click the agent name for the drill-in, or Peek for a one-shot transcript snapshot.
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

      <FilterBar
        state={stateFilter}
        stateOptions={uniqueStates}
        onStateChange={(v) => setFilter('state', v)}
        rig={rigFilter}
        rigOptions={uniqueRigs}
        onRigChange={(v) => setFilter('rig', v)}
        template={templateFilter}
        templateOptions={uniqueTemplates}
        onTemplateChange={(v) => setFilter('template', v)}
        active={anyFilterActive}
        onClear={() => setSearchParams({}, { replace: true })}
        shown={filteredRows.length}
        total={rows.length}
      />

      <div className="panel">
        {/* td-liky3d: default newest-first by last_active so most recently
            active sessions sit at the top + the idle ones drop to the bottom. */}
        <Table
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.id}
          empty={anyFilterActive ? 'No sessions match the active filter' : 'No active sessions'}
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

// cd-ycoh: filter dropdown row above the table. Empty option = no
// filter; the bar collapses to "(none)" + total. Active filters render
// a banner row underneath with the shown-vs-total count and a Clear
// button (mirrors Beads.tsx's pattern from cd-d68p / cd-iiq7).
function FilterBar({
  state, stateOptions, onStateChange,
  rig, rigOptions, onRigChange,
  template, templateOptions, onTemplateChange,
  active, onClear, shown, total,
}: {
  state: string | null;
  stateOptions: string[];
  onStateChange: (v: string | null) => void;
  rig: string | null;
  rigOptions: string[];
  onRigChange: (v: string | null) => void;
  template: string | null;
  templateOptions: string[];
  onTemplateChange: (v: string | null) => void;
  active: boolean;
  onClear: () => void;
  shown: number;
  total: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <FilterDropdown label="State" value={state} options={stateOptions} onChange={onStateChange} />
        <FilterDropdown label="Rig" value={rig} options={rigOptions} onChange={onRigChange} />
        <FilterDropdown label="Template" value={template} options={templateOptions} onChange={onTemplateChange} />
      </div>
      {active && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-xs text-accent-500 flex items-center justify-between gap-3">
          <span>
            Showing {shown} of {total} sessions matching active filters
          </span>
          <button
            type="button"
            onClick={onClear}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            clear all
          </button>
        </div>
      )}
    </div>
  );
}

function FilterDropdown({
  label, value, options, onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-ink-300">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs text-ink-100 focus:outline-none focus:ring-2 focus:ring-accent-500 max-w-[16rem]"
      >
        <option value="">all</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
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
