import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeployRecord, GitCommit, GitView } from 'citadel-shared';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { Table, type TableColumn } from '../components/Table';

const VIEW_OPTIONS: ReadonlyArray<{ value: GitView; label: string }> = [
  { value: 'recent-main', label: 'recent · main' },
  { value: 'recent-all', label: 'recent · all' },
  { value: 'today', label: 'last 24h' },
  { value: 'this-week', label: 'last 7d' },
];

export function ActivityPage() {
  const [view, setView] = useState<GitView>('recent-main');
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [deploys, setDeploys] = useState<DeployRecord[]>([]);
  const [deployFailedMarker, setDeployFailedMarker] = useState(false);
  const [deploySource, setDeploySource] = useState<string | null>(null);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [loadingDeploys, setLoadingDeploys] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCommits = useCallback(async () => {
    setLoadingCommits(true);
    try {
      const data = await api.listCommits(view);
      setCommits(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'commits failed');
    } finally {
      setLoadingCommits(false);
    }
  }, [view]);

  const refreshDeploys = useCallback(async () => {
    setLoadingDeploys(true);
    try {
      const data = await api.listBuilds();
      setDeploys(data.items);
      setDeployFailedMarker(data.failed_marker);
      setDeploySource(data.source);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'builds failed');
    } finally {
      setLoadingDeploys(false);
    }
  }, []);

  useEffect(() => {
    void refreshCommits();
  }, [refreshCommits]);

  useEffect(() => {
    void refreshDeploys();
  }, [refreshDeploys]);

  const commitColumns = useMemo<ReadonlyArray<TableColumn<GitCommit>>>(() => [
    {
      key: 'sha',
      label: 'SHA',
      render: (r) => <code className="font-sans text-xs text-accent-500">{r.short_sha}</code>,
      className: 'w-20',
    },
    {
      key: 'subject',
      label: 'Subject',
      sortable: true,
      sortValue: (r) => r.subject,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-ink-100 truncate">{r.subject}</p>
          {r.refs && <p className="text-[11px] text-accent-500 truncate">{r.refs}</p>}
        </div>
      ),
    },
    {
      key: 'author',
      label: 'Author',
      sortable: true,
      sortValue: (r) => r.author,
      render: (r) => <span className="text-xs text-ink-200">{r.author}</span>,
      className: 'w-32',
    },
    {
      key: 'date',
      label: 'When',
      sortable: true,
      sortValue: (r) => r.date,
      render: (r) => <span className="text-xs text-ink-200 tabular-nums">{formatRelative(r.date)}</span>,
      className: 'w-20',
      align: 'right',
    },
  ], []);

  const deployColumns = useMemo<ReadonlyArray<TableColumn<DeployRecord>>>(() => [
    {
      key: 'at',
      label: 'When',
      sortable: true,
      sortValue: (r) => r.at,
      render: (r) => <span className="text-xs text-ink-200 tabular-nums">{formatRelative(r.at)}</span>,
      className: 'w-20',
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <DeployPill status={r.status} />,
      className: 'w-28',
    },
    {
      key: 'detail',
      label: 'Detail',
      render: (r) => (
        <pre className="text-[11px] font-sans text-ink-200 whitespace-pre-wrap break-all">
          {r.detail}
        </pre>
      ),
    },
  ], []);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Activity</h1>
          <p className="text-xs text-ink-300">
            Recent commits and the dev-deploy log.
          </p>
        </div>
        {error && <span className="text-xs text-error-500">{error}</span>}
      </header>

      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs uppercase tracking-wider text-ink-300">commits</span>
            <div className="flex gap-1">
              {VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setView(opt.value)}
                  className={`px-2 py-0.5 rounded-md text-[11px] transition-colors ${
                    view === opt.value
                      ? 'bg-ink-700 text-ink-100'
                      : 'text-ink-300 hover:bg-ink-700/60 hover:text-ink-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" onClick={() => void refreshCommits()} disabled={loadingCommits}>
            {loadingCommits ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
        <Table
          columns={commitColumns}
          rows={commits}
          rowKey={(r) => r.sha}
          empty="No commits returned by this view"
          initialSort={{ key: 'date', dir: 'desc' }}
        />
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wider text-ink-300">dev-deploy</span>
            {deployFailedMarker && (
              <span className="inline-flex items-center rounded-md border border-error-500/40 bg-error-500/10 text-error-500 px-2 py-0.5 text-[11px] font-medium">
                FAILED marker present
              </span>
            )}
            {deploySource && (
              <span className="text-[11px] text-ink-300 truncate font-sans">
                {deploySource}
              </span>
            )}
          </div>
          <Button size="sm" onClick={() => void refreshDeploys()} disabled={loadingDeploys}>
            {loadingDeploys ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
        <Table
          columns={deployColumns}
          rows={deploys}
          rowKey={(r) => `${r.at}-${r.detail.slice(0, 24)}`}
          empty="No deploy log entries"
          initialSort={{ key: 'at', dir: 'desc' }}
        />
      </div>
    </section>
  );
}

function DeployPill({ status }: { status: string }) {
  const tone =
    status === 'ok'
      ? 'bg-accent-700/30 text-accent-500 border-accent-700/40'
      : status === 'failed'
        ? 'bg-error-500/20 text-error-500 border-error-500/30'
        : status === 'in-progress'
          ? 'bg-warn-500/20 text-warn-500 border-warn-500/30'
          : 'bg-ink-700/60 text-ink-300 border-ink-600';
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {status}
    </span>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1_000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h`;
  return `${Math.round(diffSec / 86_400)}d`;
}
