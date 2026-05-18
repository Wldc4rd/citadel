import { useCallback, useEffect, useState } from 'react';
import type { DoltNomsTrend, SystemHealth } from 'thriva-admin-shared';
import { api } from '../api/client';
import { Button } from '../components/Button';

export function HealthPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [trend, setTrend] = useState<DoltNomsTrend | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [h, t] = await Promise.all([api.systemHealth(), api.doltTrend()]);
      setHealth(h);
      setTrend(t);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'health failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const tick = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    return () => clearInterval(tick);
  }, [refresh]);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Health</h1>
          <p className="text-xs text-ink-300">
            Process, host, supervisor. Refreshes every 30 s while tab is visible.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-error-500">{error}</span>}
          <Button size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {health ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <HealthCard title="Admin dashboard">
            <Row label="pid" value={health.admin.pid.toString()} />
            <Row label="uptime" value={formatDuration(health.admin.uptime_sec)} />
            <Row label="rss" value={formatBytes(health.admin.rss_bytes)} />
            <Row label="heap used" value={formatBytes(health.admin.heap_used_bytes)} />
            <Row label="node" value={health.admin.node_version} />
          </HealthCard>
          <HealthCard title="Host">
            <Row label="cpus" value={health.host.cpu_count.toString()} />
            <Row
              label="load (1m)"
              value={health.host.load_avg_1.toFixed(2)}
              warn={health.host.load_avg_1 > health.host.cpu_count}
            />
            <Row
              label="load (5m)"
              value={health.host.load_avg_5.toFixed(2)}
              warn={health.host.load_avg_5 > health.host.cpu_count}
            />
            <Row label="load (15m)" value={health.host.load_avg_15.toFixed(2)} />
            <Row
              label="mem free"
              value={`${formatBytes(health.host.free_mem_bytes)} / ${formatBytes(
                health.host.total_mem_bytes,
              )}`}
              warn={health.host.free_mem_bytes / health.host.total_mem_bytes < 0.1}
            />
            <Row label="host uptime" value={formatDuration(health.host.uptime_sec)} />
          </HealthCard>
          <HealthCard title="gc supervisor">
            {health.supervisor ? (
              <>
                <Row label="status" value={health.supervisor.status} />
                <Row label="city" value={health.supervisor.city} />
                <Row label="version" value={health.supervisor.version} />
                <Row label="uptime" value={formatDuration(health.supervisor.uptime_sec)} />
              </>
            ) : (
              <p className="text-xs text-error-500 italic">
                supervisor not reachable — the dashboard shell stays up, but live data is stale.
              </p>
            )}
          </HealthCard>
        </div>
      ) : (
        <p className="text-sm text-ink-300 italic">Loading…</p>
      )}

      <div className="panel">
        <div className="panel-header">
          <span className="text-xs uppercase tracking-wider text-ink-300">
            dolt-noms · 24 h trend
          </span>
          {trend && (
            <span className="text-[11px] text-ink-300">
              {trend.samples.length} sample(s)
            </span>
          )}
        </div>
        <div className="panel-body">
          {trend === null ? (
            <p className="text-sm text-ink-300 italic">Loading…</p>
          ) : !trend.available ? (
            <p className="text-sm text-ink-300 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2 italic">
              Metric source not yet wired (mechanic surgical-ask pending). Ring buffer is running; samples will appear once <code className="font-sans text-ink-200">sampleDoltNomsSize()</code> is implemented.
            </p>
          ) : trend.samples.length === 0 ? (
            <p className="text-sm text-ink-300 italic">
              No samples yet — backend just started; next sample in ≤10 min.
            </p>
          ) : (
            <Sparkline samples={trend.samples} />
          )}
        </div>
      </div>
    </section>
  );
}

function HealthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">{title}</span>
      </div>
      <dl className="px-3 py-2 grid grid-cols-1 gap-1 text-xs">{children}</dl>
    </div>
  );
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-300">{label}</dt>
      <dd className={`tabular-nums truncate ${warn ? 'text-warn-500 font-medium' : 'text-ink-100'}`}>
        {value}
      </dd>
    </div>
  );
}

// Inline sparkline — no chart library. Pure SVG; <200 LOC. Good enough for
// a 24h memory-pressure visual; if Charlie asks for more, add Recharts.
function Sparkline({ samples }: { samples: { ts: string; bytes: number }[] }) {
  if (samples.length === 0) return null;
  const max = Math.max(...samples.map((s) => s.bytes));
  const min = Math.min(...samples.map((s) => s.bytes));
  const range = max - min || 1;
  const width = 600;
  const height = 80;
  const stepX = samples.length > 1 ? width / (samples.length - 1) : width;
  const points = samples
    .map((s, i) => {
      const x = i * stepX;
      const y = height - ((s.bytes - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-20 bg-ink-900/40 rounded-md"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-accent-500"
          points={points}
        />
      </svg>
      <div className="flex items-center justify-between text-[11px] text-ink-300 tabular-nums">
        <span>min: {formatBytes(min)}</span>
        <span>max: {formatBytes(max)}</span>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}
