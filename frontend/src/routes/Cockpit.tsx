import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminAction,
  AdminActionResult,
  GcBead,
  GcSession,
  GitCommit,
  PipelineStageCounts,
  ThroughputTrend,
  TranscriptResult,
} from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import {
  SessionPeekContent,
  formatPeekCaption,
} from '../components/SessionPeekContent';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { usePageTitle } from '../hooks/usePageTitle';

// Cockpit (td-a40qsy) — Charlie's primary landing surface. Four panel
// blocks, each with its own data source + stale-data indicator:
//
//   1. ENGINE GAUGES   — sessions tally, beads tally, throughput sparkline,
//                        pipeline stage counts (all read paths).
//   2. MAYOR PEEK      — gastown.mayor session state + one-click peek
//                        (reuses SessionPeekContent component; see that
//                        file for the architect-mandated reuse story).
//   3. RECENT ACTIVITY — last ~10 commits + last ~10 closed beads.
//   4. COMMON KNOBS    — pause/resume polecats + stop/restart city,
//                        each confirm-modal-gated. Stop/restart get a
//                        double-confirm (type city name to enable).
//
// Stale-data UX per architect: each panel keeps last-successful-fetch +
// shows "stale: 1m 20s" indicator (amber after 30s, red after 2min).
// When ALL panels go red simultaneously a top banner appears. Charlie's
// brief: "useful when gc-supervisor is briefly down."

const STALE_AMBER_MS = 30_000;
const STALE_RED_MS = 120_000;
const REFRESH_INTERVAL_MS = 30_000;
const TICK_MS = 5_000;
const MAYOR_ALIAS_CANDIDATES = ['gastown.mayor', 'mayor'];

type PanelHealth = 'fresh' | 'stale' | 'down';

interface PanelState<T> {
  data: T | null;
  fetchedAt: number | null;
  error: string | null;
}

function emptyPanel<T>(): PanelState<T> {
  return { data: null, fetchedAt: null, error: null };
}

function panelHealth(fetchedAt: number | null, now: number): PanelHealth {
  if (fetchedAt === null) return 'down';
  const age = now - fetchedAt;
  if (age < STALE_AMBER_MS) return 'fresh';
  if (age < STALE_RED_MS) return 'stale';
  return 'down';
}

interface CityConfig {
  city: string;
}

export function CockpitPage() {
  usePageTitle('Cockpit');
  const [now, setNow] = useState(() => Date.now());
  const [cityConfig, setCityConfig] = useState<CityConfig | null>(null);
  const [sessions, setSessions] = useState<PanelState<GcSession[]>>(emptyPanel());
  const [beads, setBeads] = useState<PanelState<GcBead[]>>(emptyPanel());
  // cd-nim6: separate slice for closed beads — /api/beads' closed_at
  // omission means the Recently-Closed panel can't filter the main
  // beads slice. Sourced from /api/admin/closed-beads which shell-execs
  // the bd CLI for the 24h window with closed_at populated.
  const [closedBeads, setClosedBeads] = useState<PanelState<GcBead[]>>(emptyPanel());
  const [throughput, setThroughput] = useState<PanelState<ThroughputTrend>>(emptyPanel());
  const [pipeline, setPipeline] = useState<PanelState<PipelineStageCounts>>(emptyPanel());
  const [commits, setCommits] = useState<PanelState<GitCommit[]>>(emptyPanel());

  const [peekOpen, setPeekOpen] = useState(false);
  const [peekResult, setPeekResult] = useState<TranscriptResult | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);

  // cd-uebi: inline mayor peek for the Mayor card. Separate slice from
  // the on-demand modal peek (above) so the modal still shows a fresh
  // fetch on click while the card surfaces the last refresh from the
  // background poll. Polled on the same 30s tick as the rest of the
  // cockpit; full transcript fetch isn't free (gc supervisor reads the
  // tmux buffer) but a single session per tick is in the same ballpark
  // as the other panels' fetches.
  const [mayorPeekInline, setMayorPeekInline] = useState<PanelState<TranscriptResult>>(emptyPanel());
  // Stretch goal: optional nudge message. Empty → nudge with no message
  // (matches the existing default behaviour).
  const [nudgeMessage, setNudgeMessage] = useState('');

  const [confirmAction, setConfirmAction] = useState<AdminAction | null>(null);
  const [actionRunning, setActionRunning] = useState<AdminAction | null>(null);
  const [actionResult, setActionResult] = useState<{
    action: AdminAction;
    payload: AdminActionResult;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nudging, setNudging] = useState(false);
  const [nudgeFeedback, setNudgeFeedback] = useState<string | null>(null);

  // Best-effort city name fetch for the double-confirm modals. Cached
  // once; failure means double-confirms fall back to a generic prompt.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config/gc-supervisor', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (typeof j?.city === 'string') setCityConfig({ city: j.city });
      })
      .catch(() => {
        /* ignore — confirm modal degrades gracefully */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await api.listSessions();
      setSessions({ data: items, fetchedAt: Date.now(), error: null });
    } catch (err) {
      setSessions((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'sessions failed',
      }));
    }
  }, []);

  const refreshBeads = useCallback(async () => {
    try {
      const { items } = await api.listBeads({ showAll: true, limit: 1000 });
      setBeads({ data: items, fetchedAt: Date.now(), error: null });
    } catch (err) {
      setBeads((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'beads failed',
      }));
    }
  }, []);

  const refreshClosedBeads = useCallback(async () => {
    try {
      const { items } = await api.closedBeads();
      setClosedBeads({ data: items, fetchedAt: Date.now(), error: null });
    } catch (err) {
      setClosedBeads((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'closed beads failed',
      }));
    }
  }, []);

  const refreshThroughput = useCallback(async () => {
    try {
      const t = await api.throughputTrend();
      setThroughput({ data: t, fetchedAt: Date.now(), error: null });
    } catch (err) {
      setThroughput((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'throughput failed',
      }));
    }
  }, []);

  const refreshPipeline = useCallback(async () => {
    try {
      const p = await api.pipelineStageCounts();
      setPipeline({ data: p, fetchedAt: Date.now(), error: null });
    } catch (err) {
      setPipeline((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'pipeline failed',
      }));
    }
  }, []);

  const refreshCommits = useCallback(async () => {
    try {
      const { items } = await api.listCommits('recent-main');
      setCommits({ data: items, fetchedAt: Date.now(), error: null });
    } catch (err) {
      setCommits((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'commits failed',
      }));
    }
  }, []);

  const refreshAll = useCallback(() => {
    void refreshSessions();
    void refreshBeads();
    void refreshClosedBeads();
    void refreshThroughput();
    void refreshPipeline();
    void refreshCommits();
  }, [refreshSessions, refreshBeads, refreshClosedBeads, refreshThroughput, refreshPipeline, refreshCommits]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Periodic refresh — only when the tab is visible so a backgrounded
  // tab doesn't keep hitting the supervisor.
  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) refreshAll();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(tick);
  }, [refreshAll]);

  // Wall-clock tick — drives the stale indicators without re-fetching.
  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(tick);
  }, []);

  // SSE — refresh affected panels on relevant events.
  const sseState = useGcEventRefresh(['session.', 'bead.'], () => {
    refreshAll();
  });

  const mayor = useMemo(() => {
    const list = sessions.data ?? [];
    for (const candidate of MAYOR_ALIAS_CANDIDATES) {
      const found = list.find(
        (s) => s.alias === candidate && s.state === 'active',
      );
      if (found) return found;
    }
    // Fallback: any session whose alias contains 'mayor' (template like
    // "gastown.mayor", "thriva.mayor"); prefer active.
    const fuzzy = list
      .filter((s) => (s.alias ?? s.template ?? '').toLowerCase().includes('mayor'))
      .sort((a) => (a.state === 'active' ? -1 : 1));
    return fuzzy[0] ?? null;
  }, [sessions.data]);

  const handleMayorPeek = useCallback(async () => {
    if (!mayor) return;
    setPeekOpen(true);
    setPeekResult(null);
    setPeekError(null);
    setPeekLoading(true);
    try {
      const result = await api.peekSession(mayor.id);
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
  }, [mayor]);

  const handleMayorNudge = useCallback(async () => {
    if (!mayor) return;
    setNudging(true);
    setNudgeFeedback(null);
    // cd-uebi: forward the optional nudge message to the existing
    // nudgeSession(id, message?) API. Empty string = no message
    // (matches pre-cd-uebi default behaviour).
    const trimmed = nudgeMessage.trim();
    try {
      await api.nudgeSession(mayor.id, trimmed.length > 0 ? trimmed : undefined);
      setNudgeFeedback(trimmed.length > 0
        ? `Nudge delivered: "${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}"`
        : 'Nudge delivered (wait-idle).',
      );
      setNudgeMessage('');
      window.setTimeout(() => setNudgeFeedback(null), 4_000);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'nudge failed';
      setNudgeFeedback(`Nudge failed: ${msg}`);
    } finally {
      setNudging(false);
    }
  }, [mayor, nudgeMessage]);

  // cd-uebi: background poll of mayor peek for the inline card preview.
  // Keyed on mayor.id so it re-fires when the mayor session rotates
  // (failover, restart). Same 30s cadence as the rest of the cockpit
  // polls. AbortController guards against stale-result overwrite per
  // senior_developer's "ANY POLLING LOOP MUST GUARD AGAINST STALE-
  // RESULT OVERWRITE" rule (cd-uebi review): if a /peek request out-
  // lasts the 30s tick, the next tick aborts the previous in-flight
  // fetch so the older response can't race-resolve and clobber a
  // newer one. The cancelled flag is belt to the controller's braces
  // — fetch rejects with AbortError on abort but state-setters still
  // need to be no-ops if the effect itself has torn down.
  useEffect(() => {
    if (!mayor) {
      setMayorPeekInline(emptyPanel());
      return;
    }
    let cancelled = false;
    let controller = new AbortController();

    const tick = async () => {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const result = await api.peekSession(mayor.id, signal);
        if (cancelled) return;
        setMayorPeekInline({ data: result, fetchedAt: Date.now(), error: null });
      } catch (err) {
        if (cancelled) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        setMayorPeekInline((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'mayor peek failed',
        }));
      }
    };

    void tick();
    const interval = setInterval(() => {
      if (!document.hidden) void tick();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [mayor]);

  const handleAdminAction = useCallback(
    async (action: AdminAction) => {
      setActionRunning(action);
      setActionError(null);
      setActionResult(null);
      try {
        const payload = await api.adminAction(action);
        setActionResult({ action, payload });
        // After a destructive action, refresh state so Charlie sees the
        // effect without waiting for the next 30s tick.
        refreshAll();
      } catch (err) {
        const msg =
          err instanceof ApiClientError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'action failed';
        setActionError(msg);
      } finally {
        setActionRunning(null);
        setConfirmAction(null);
      }
    },
    [refreshAll],
  );

  // Stale-banner: if every panel is 'down' simultaneously, show banner.
  const allHealthValues: PanelHealth[] = [
    panelHealth(sessions.fetchedAt, now),
    panelHealth(beads.fetchedAt, now),
    panelHealth(throughput.fetchedAt, now),
    panelHealth(pipeline.fetchedAt, now),
    panelHealth(commits.fetchedAt, now),
  ];
  const allDown = allHealthValues.length > 0 && allHealthValues.every((h) => h === 'down');

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Cockpit</h1>
          <p className="text-xs text-ink-300">
            City pulse at a glance. Live updates via SSE; manual refresh below if needed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SseIndicator state={sseState} />
          <Button size="sm" onClick={refreshAll}>
            Refresh
          </Button>
        </div>
      </header>

      {allDown && (
        <div className="rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-xs text-error-500">
          <strong className="font-semibold">gc supervisor unreachable.</strong>{' '}
          All panels are stale. Data shown below is from the last successful fetch.
        </div>
      )}

      <CommonKnobsBar
        onAction={setConfirmAction}
        running={actionRunning}
        cityName={cityConfig?.city ?? null}
      />

      {/* ENGINE GAUGES */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <SessionsPanel
          sessions={sessions.data}
          health={panelHealth(sessions.fetchedAt, now)}
          fetchedAt={sessions.fetchedAt}
          now={now}
          error={sessions.error}
        />
        <BeadsTallyPanel
          beads={beads.data}
          health={panelHealth(beads.fetchedAt, now)}
          fetchedAt={beads.fetchedAt}
          now={now}
          error={beads.error}
        />
        <ThroughputPanel
          trend={throughput.data}
          health={panelHealth(throughput.fetchedAt, now)}
          fetchedAt={throughput.fetchedAt}
          now={now}
          error={throughput.error}
        />
        <PipelineStagesPanel
          counts={pipeline.data}
          health={panelHealth(pipeline.fetchedAt, now)}
          fetchedAt={pipeline.fetchedAt}
          now={now}
          error={pipeline.error}
        />
      </div>

      {/* MAYOR */}
      <MayorPanel
        mayor={mayor}
        loading={sessions.fetchedAt === null}
        now={now}
        onPeek={handleMayorPeek}
        onNudge={handleMayorNudge}
        nudging={nudging}
        nudgeFeedback={nudgeFeedback}
        peekInline={mayorPeekInline.data}
        peekInlineError={mayorPeekInline.error}
        peekInlineFetchedAt={mayorPeekInline.fetchedAt}
        nudgeMessage={nudgeMessage}
        onNudgeMessageChange={setNudgeMessage}
      />

      {/* RECENT ACTIVITY */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <CommitsPanel
          commits={commits.data}
          health={panelHealth(commits.fetchedAt, now)}
          fetchedAt={commits.fetchedAt}
          now={now}
          error={commits.error}
        />
        <ClosedBeadsPanel
          beads={closedBeads.data}
          health={panelHealth(closedBeads.fetchedAt, now)}
          fetchedAt={closedBeads.fetchedAt}
          now={now}
          error={closedBeads.error}
        />
      </div>

      {/* Action result/error toast — last-ran action's outcome. */}
      {actionResult && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-2 text-xs text-accent-500">
          <p className="font-medium">
            ✓ {actionResult.action} ({actionResult.payload.duration_ms}ms)
          </p>
          {actionResult.payload.stdout && (
            <pre className="mt-1 text-ink-200 whitespace-pre-wrap text-[11px]">
              {actionResult.payload.stdout.slice(0, 512)}
            </pre>
          )}
        </div>
      )}
      {actionError && (
        <div className="rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-xs text-error-500">
          <p className="font-medium">action failed: {actionError}</p>
        </div>
      )}

      <Modal
        open={peekOpen}
        onClose={() => setPeekOpen(false)}
        title={mayor ? `${mayor.alias ?? mayor.id} — transcript` : 'transcript'}
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
            onClick={() => void handleMayorPeek()}
            disabled={peekLoading}
          >
            Re-fetch
          </Button>
        }
      >
        <SessionPeekContent loading={peekLoading} error={peekError} result={peekResult} />
      </Modal>

      <ConfirmActionModal
        action={confirmAction}
        cityName={cityConfig?.city ?? null}
        running={actionRunning}
        onClose={() => setConfirmAction(null)}
        onConfirm={(a) => void handleAdminAction(a)}
      />
    </section>
  );
}

// ── Panels ──────────────────────────────────────────────────────────────

interface PanelChromeProps {
  title: string;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
  children: React.ReactNode;
}

function PanelChrome({ title, health, fetchedAt, now, error, children }: PanelChromeProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">{title}</span>
        <StaleIndicator health={health} fetchedAt={fetchedAt} now={now} error={error} />
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

function StaleIndicator({
  health,
  fetchedAt,
  now,
  error,
}: {
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  if (fetchedAt === null) {
    return <span className="text-[11px] text-ink-300 italic">loading…</span>;
  }
  const ageSec = Math.max(0, Math.round((now - fetchedAt) / 1_000));
  const tone =
    health === 'fresh'
      ? 'text-ink-300'
      : health === 'stale'
        ? 'text-warn-500'
        : 'text-error-500';
  const label =
    health === 'fresh'
      ? `${ageSec}s ago`
      : health === 'stale'
        ? `stale: ${formatAge(ageSec)}`
        : `down: ${formatAge(ageSec)}`;
  return (
    <span className={`text-[11px] tabular-nums ${tone}`} title={error ?? undefined}>
      {label}
    </span>
  );
}

function SessionsPanel({
  sessions,
  health,
  fetchedAt,
  now,
  error,
}: {
  sessions: GcSession[] | null;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  const tallies = useMemo(() => {
    const t = { active: 0, asleep: 0, attached: 0, hot_context: 0, total: 0 };
    for (const s of sessions ?? []) {
      t.total += 1;
      if (s.state === 'active') t.active += 1;
      if (s.state === 'asleep') t.asleep += 1;
      if (s.attached) t.attached += 1;
      if (typeof s.context_pct === 'number' && s.context_pct >= 95) t.hot_context += 1;
    }
    return t;
  }, [sessions]);

  return (
    <PanelChrome title="Sessions" health={health} fetchedAt={fetchedAt} now={now} error={error}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <BigNumber label="active" value={tallies.active} to="/agents?state=active" />
        <BigNumber label="asleep" value={tallies.asleep} to="/agents?state=asleep" />
        <BigNumber
          label="hot ctx"
          value={tallies.hot_context}
          warn={tallies.hot_context > 0}
          to="/agents?hot_context=1"
        />
        <BigNumber label="attached" value={tallies.attached} to="/agents?attached=1" />
      </dl>
    </PanelChrome>
  );
}

function BeadsTallyPanel({
  beads,
  health,
  fetchedAt,
  now,
  error,
}: {
  beads: GcBead[] | null;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  const tally = useMemo(() => {
    const t = { open: 0, in_progress: 0, blocked: 0, needs_review: 0 };
    for (const b of beads ?? []) {
      if (b.status === 'open') t.open += 1;
      if (b.status === 'in_progress') t.in_progress += 1;
      if (b.status === 'blocked') t.blocked += 1;
      if (b.labels?.includes('needs-review')) t.needs_review += 1;
    }
    return t;
  }, [beads]);

  return (
    <PanelChrome title="Beads" health={health} fetchedAt={fetchedAt} now={now} error={error}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <BigNumber label="open" value={tally.open} to="/beads?status=open" />
        <BigNumber label="in prog" value={tally.in_progress} to="/beads?status=in_progress" />
        <BigNumber label="needs rvw" value={tally.needs_review} to="/beads?label=needs-review" />
        <BigNumber
          label="blocked"
          value={tally.blocked}
          warn={tally.blocked > 0}
          to="/beads?status=blocked"
        />
      </dl>
    </PanelChrome>
  );
}

function ThroughputPanel({
  trend,
  health,
  fetchedAt,
  now,
  error,
}: {
  trend: ThroughputTrend | null;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  const sum = trend?.buckets.reduce((a, b) => a + b.count, 0) ?? 0;
  return (
    <PanelChrome
      title={`Throughput · ${trend?.window_hours ?? 6}h`}
      health={health}
      fetchedAt={fetchedAt}
      now={now}
      error={error}
    >
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums text-ink-100">{sum}</span>
          <span className="text-[11px] text-ink-300">closures</span>
        </div>
        <BucketSparkline trend={trend} />
      </div>
    </PanelChrome>
  );
}

function BucketSparkline({ trend }: { trend: ThroughputTrend | null }) {
  if (!trend) {
    return <p className="text-[11px] text-ink-300 italic">—</p>;
  }
  const buckets = trend.buckets;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const width = 160;
  const height = 28;
  const barWidth = width / buckets.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-7 bg-ink-900/40 rounded-md"
    >
      {buckets.map((b, i) => {
        const h = (b.count / max) * height;
        const x = i * barWidth;
        const y = height - h;
        return (
          <rect
            key={b.start}
            x={x + 1}
            y={y}
            width={Math.max(1, barWidth - 2)}
            height={h}
            className="fill-accent-500"
          >
            <title>
              {new Date(b.start).toLocaleString()} — {b.count} closure(s)
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function PipelineStagesPanel({
  counts,
  health,
  fetchedAt,
  now,
  error,
}: {
  counts: PipelineStageCounts | null;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  // cd-iiq7: each stage links to /beads pre-filtered. Three patterns:
  //   - exact label match (review, changes): ?label=<label>
  //   - label prefix family (arch, impl): ?label_prefix=<pfx> matches
  //     all needs-impl:X / needs-arch* variants
  //   - status-only (in prog, blocked, other open): ?status=<status>
  // 'arch' classifier accepts both needs-arch + needs-architect so the
  // prefix 'needs-arch' covers both (needs-architect starts with it).
  const stages: Array<[string, number, boolean, string]> = counts
    ? [
        ['arch', counts.stages.needs_arch, false, '/beads?label_prefix=needs-arch'],
        ['impl', counts.stages.needs_impl, false, '/beads?label_prefix=needs-impl'],
        ['review', counts.stages.needs_review, false, '/beads?label=needs-review'],
        ['changes', counts.stages.needs_changes, true, '/beads?label=needs-changes'],
        ['in prog', counts.stages.in_progress, false, '/beads?status=in_progress'],
        ['blocked', counts.stages.blocked, true, '/beads?status=blocked'],
        ['other', counts.stages.other_open, false, '/beads?status=open'],
      ]
    : [];
  const max = Math.max(1, ...stages.map(([, v]) => v));
  return (
    <PanelChrome
      title="Pipeline · stages"
      health={health}
      fetchedAt={fetchedAt}
      now={now}
      error={error}
    >
      {counts === null ? (
        <p className="text-[11px] text-ink-300 italic">—</p>
      ) : (
        <ul className="space-y-1">
          {stages.map(([label, value, warn, to]) => (
            <li key={label}>
              <Link
                to={to}
                className="flex items-center gap-2 text-xs tabular-nums rounded-sm -mx-1 px-1 hover:bg-ink-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 group"
                title={`Open filtered beads: ${label}`}
              >
                <span className="w-16 text-ink-300 group-hover:text-ink-200 group-hover:underline">{label}</span>
                <span
                  className={`block h-2 rounded-sm ${warn && value > 0 ? 'bg-warn-500/70' : 'bg-accent-500/70'}`}
                  style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
                />
                <span className={`text-ink-100 ml-auto ${warn && value > 0 ? 'text-warn-500' : ''}`}>
                  {value}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelChrome>
  );
}

function MayorPanel({
  mayor,
  loading,
  now,
  onPeek,
  onNudge,
  nudging,
  nudgeFeedback,
  peekInline,
  peekInlineError,
  peekInlineFetchedAt,
  nudgeMessage,
  onNudgeMessageChange,
}: {
  mayor: GcSession | null;
  loading: boolean;
  now: number;
  onPeek: () => void;
  onNudge: () => void;
  nudging: boolean;
  nudgeFeedback: string | null;
  /** cd-uebi: last polled mayor transcript snapshot for the inline preview. */
  peekInline: TranscriptResult | null;
  peekInlineError: string | null;
  peekInlineFetchedAt: number | null;
  /** cd-uebi: optional nudge message — passed to nudgeSession when set. */
  nudgeMessage: string;
  onNudgeMessageChange: (value: string) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">Mayor</span>
        {mayor && (
          <span className="text-[11px] text-ink-300">
            {mayor.alias ?? mayor.template ?? mayor.id}
          </span>
        )}
      </div>
      <div className="panel-body">
        {loading ? (
          <p className="text-xs text-ink-300 italic">Loading…</p>
        ) : !mayor ? (
          <p className="text-xs text-ink-300 italic">
            No active mayor session found. Check <code className="font-sans">gc session list</code>.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-sm">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <StatePill state={mayor.state} attached={mayor.attached} />
                  <span className="text-ink-200 text-xs">
                    {mayor.activity ?? (mayor.running ? 'running' : '—')}
                  </span>
                  {typeof mayor.context_pct === 'number' && (
                    <span
                      className={`text-[11px] tabular-nums ${
                        mayor.context_pct >= 95
                          ? 'text-error-500'
                          : mayor.context_pct >= 80
                            ? 'text-warn-500'
                            : 'text-ink-300'
                      }`}
                    >
                      ctx {mayor.context_pct}%
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-ink-300">
                  last active {formatRelativeNow(mayor.last_active ?? mayor.created_at, now)} · created{' '}
                  {formatRelativeNow(mayor.created_at, now)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" tone="accent" onClick={onPeek}>
                  Peek
                </Button>
              </div>
            </div>

            {/* cd-uebi: stretch goal — nudge message input. Empty = old
                no-message nudge behaviour preserved. */}
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                value={nudgeMessage}
                onChange={(e) => onNudgeMessageChange(e.target.value)}
                placeholder="optional nudge message"
                maxLength={1024}
                className="flex-1 min-w-0 bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs font-sans text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-500"
                onKeyDown={(e) => {
                  // Enter sends — quick-keyboard nudge for the common case.
                  if (e.key === 'Enter' && !nudging) onNudge();
                }}
              />
              <Button size="sm" tone="default" onClick={onNudge} disabled={nudging}>
                {nudging ? 'Nudging…' : 'Nudge'}
              </Button>
            </div>

            {nudgeFeedback && (
              <p
                className={`text-[11px] ${
                  nudgeFeedback.startsWith('Nudge delivered')
                    ? 'text-accent-500'
                    : 'text-error-500'
                }`}
              >
                {nudgeFeedback}
              </p>
            )}

            {/* cd-uebi: inline peek preview — last turn's tail, refreshed
                on the 30s tick. Modal Peek button above still serves the
                full transcript view. */}
            <MayorPeekInline
              peek={peekInline}
              error={peekInlineError}
              fetchedAt={peekInlineFetchedAt}
              now={now}
              onOpenFull={onPeek}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// cd-uebi: tiny inline-peek renderer. Shows the tail of the most recent
// turn so Charlie can read what the mayor is saying right now without
// opening the full peek modal.
//
// Lines-per-turn cap (LAST_TURN_LINES) keeps the card compact; the full
// modal Peek button still serves the whole transcript. ansi_up is NOT
// applied here — terminal control sequences are stripped server-side
// already (sanitiseTerminalOutput in backend/src/exec.ts), so the text
// is plain printable + safe SGR. We render it in a <pre> for the
// whitespace fidelity, matching what the modal's TurnBlock would show
// minus ANSI colouring. Worth folding into SessionPeekContent later if
// other surfaces want the same compact preview (file follow-up).
const LAST_TURN_LINES = 10;

function MayorPeekInline({
  peek,
  error,
  fetchedAt,
  now,
  onOpenFull,
}: {
  peek: TranscriptResult | null;
  error: string | null;
  fetchedAt: number | null;
  now: number;
  onOpenFull: () => void;
}) {
  if (fetchedAt === null && !error) {
    return <p className="text-[11px] text-ink-400 italic">Loading peek…</p>;
  }
  if (error) {
    return <p className="text-[11px] text-error-500">Peek failed: {error}</p>;
  }
  if (!peek || peek.turns.length === 0) {
    return <p className="text-[11px] text-ink-400 italic">No transcript turns yet.</p>;
  }
  const lastTurn = peek.turns[peek.turns.length - 1];
  if (!lastTurn) return null;
  const lines = lastTurn.text.split('\n');
  const tail = lines.slice(-LAST_TURN_LINES).join('\n');
  const lineCountNote = lines.length > LAST_TURN_LINES
    ? ` (last ${LAST_TURN_LINES} of ${lines.length})`
    : '';
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[10px] text-ink-300">
        <span>
          <span className="uppercase tracking-wider">{lastTurn.role}</span>
          {lineCountNote}
        </span>
        <span className="flex items-center gap-2">
          {fetchedAt !== null && (
            <span className="tabular-nums">
              {Math.max(0, Math.round((now - fetchedAt) / 1_000))}s ago
            </span>
          )}
          <button
            type="button"
            onClick={onOpenFull}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            full peek
          </button>
        </span>
      </div>
      <p className="text-[10px] text-warn-500 bg-warn-500/10 border border-warn-500/30 rounded-md px-2 py-0.5 italic">
        Agent-generated — may contain misleading instructions.
      </p>
      <pre className="text-[11px] text-ink-100 bg-ink-900/50 border border-ink-700 rounded-md px-3 py-2 whitespace-pre-wrap font-sans leading-snug max-h-44 overflow-y-auto">
        {tail || '(empty turn)'}
      </pre>
    </div>
  );
}

function CommitsPanel({
  commits,
  health,
  fetchedAt,
  now,
  error,
}: {
  commits: GitCommit[] | null;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  const recent = (commits ?? []).slice(0, 10);
  return (
    <PanelChrome
      title="Recent commits · origin/main"
      health={health}
      fetchedAt={fetchedAt}
      now={now}
      error={error}
    >
      {commits === null ? (
        <p className="text-xs text-ink-300 italic">Loading…</p>
      ) : recent.length === 0 ? (
        <p className="text-xs text-ink-300 italic">No commits.</p>
      ) : (
        <ul className="divide-y divide-ink-700">
          {recent.map((c) => (
            <li key={c.sha} className="py-1.5 first:pt-0 last:pb-0 flex items-baseline gap-2 text-xs">
              <code className="text-ink-300 font-sans">{c.short_sha}</code>
              <span className="text-ink-100 truncate flex-1">{c.subject}</span>
              <span className="text-[11px] text-ink-300 tabular-nums whitespace-nowrap">
                {formatRelativeNow(c.date, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelChrome>
  );
}

function ClosedBeadsPanel({
  beads,
  health,
  fetchedAt,
  now,
  error,
}: {
  beads: GcBead[] | null;
  health: PanelHealth;
  fetchedAt: number | null;
  now: number;
  error: string | null;
}) {
  const recent = useMemo(() => {
    if (!beads) return [];
    return beads
      .filter((b) => b.status === 'closed' && typeof b.closed_at === 'string')
      .sort((a, b) => (b.closed_at! > a.closed_at! ? 1 : -1))
      .slice(0, 10);
  }, [beads]);
  return (
    <PanelChrome
      title="Recently closed beads"
      health={health}
      fetchedAt={fetchedAt}
      now={now}
      error={error}
    >
      {beads === null ? (
        <p className="text-xs text-ink-300 italic">Loading…</p>
      ) : recent.length === 0 ? (
        <p className="text-xs text-ink-300 italic">No closed beads in window.</p>
      ) : (
        <ul className="divide-y divide-ink-700">
          {recent.map((b) => (
            <li key={b.id} className="py-1.5 first:pt-0 last:pb-0 flex items-baseline gap-2 text-xs">
              <code className="text-ink-300 font-sans whitespace-nowrap">{b.id}</code>
              <span className="text-ink-100 truncate flex-1">{b.title}</span>
              <span className="text-[11px] text-ink-300 tabular-nums whitespace-nowrap">
                {formatRelativeNow(b.closed_at!, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelChrome>
  );
}

// ── Common knobs (destructive actions) ──────────────────────────────────

const ACTION_LABEL: Record<AdminAction, string> = {
  'pause-polecats': 'Pause polecats',
  'resume-polecats': 'Resume polecats',
  'stop-city': 'Stop city',
  'restart-city': 'Restart city',
};

const ACTION_DESCRIPTION: Record<AdminAction, string> = {
  'pause-polecats':
    'Sets suspended=true on the polecat agent in city.toml. The reconciler will stop spawning polecat workers. Existing sessions continue.',
  'resume-polecats':
    'Sets suspended=false on the polecat agent in city.toml. The reconciler will start spawning polecat workers again.',
  'stop-city':
    'Sends interrupt to every agent session in the city, waits for graceful shutdown, then force-kills. Also stops the Dolt server. The dashboard stays up (separate process).',
  'restart-city':
    'Equivalent to "gc stop" followed by "gc start". Triggers immediate reconcile after start. The dashboard stays up.',
};

function isDoubleConfirm(action: AdminAction): boolean {
  return action === 'stop-city' || action === 'restart-city';
}

function CommonKnobsBar({
  onAction,
  running,
  cityName,
}: {
  onAction: (a: AdminAction) => void;
  running: AdminAction | null;
  cityName: string | null;
}) {
  const actions: AdminAction[] = [
    'pause-polecats',
    'resume-polecats',
    'stop-city',
    'restart-city',
  ];
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">
          Common knobs {cityName && <span className="text-ink-200">· {cityName}</span>}
        </span>
      </div>
      <div className="panel-body flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a}
            size="sm"
            tone={isDoubleConfirm(a) ? 'danger' : 'default'}
            onClick={() => onAction(a)}
            disabled={running !== null}
          >
            {running === a ? `${ACTION_LABEL[a]}…` : ACTION_LABEL[a]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ConfirmActionModal({
  action,
  cityName,
  running,
  onClose,
  onConfirm,
}: {
  action: AdminAction | null;
  cityName: string | null;
  running: AdminAction | null;
  onClose: () => void;
  onConfirm: (a: AdminAction) => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    setTyped('');
  }, [action]);
  if (action === null) return null;
  const dangerous = isDoubleConfirm(action);
  const expectedCity = cityName ?? '';
  const canConfirm =
    running === null && (!dangerous || (expectedCity.length > 0 && typed === expectedCity));
  return (
    <Modal
      open={action !== null}
      onClose={running === null ? onClose : () => undefined}
      title={ACTION_LABEL[action]}
      caption={dangerous ? 'Double-confirm required.' : 'Confirm to proceed.'}
      widthClass="max-w-md"
      footer={
        <>
          <Button size="sm" tone="ghost" onClick={onClose} disabled={running !== null}>
            Cancel
          </Button>
          <Button
            size="sm"
            tone={dangerous ? 'danger' : 'accent'}
            onClick={() => onConfirm(action)}
            disabled={!canConfirm}
          >
            {running === action ? 'Running…' : `Run ${ACTION_LABEL[action]}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-100">{ACTION_DESCRIPTION[action]}</p>
        {dangerous && (
          <div className="space-y-1">
            <label className="block text-[11px] text-ink-300">
              Type the city name to confirm:{' '}
              {expectedCity ? (
                <code className="font-sans text-ink-200">{expectedCity}</code>
              ) : (
                <span className="italic text-warn-500">city name unavailable</span>
              )}
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              disabled={running !== null || expectedCity.length === 0}
              className="w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1 text-sm text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              placeholder={expectedCity || ''}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Tiny shared atoms ──────────────────────────────────────────────────

function BigNumber({
  label,
  value,
  warn = false,
  to,
}: {
  label: string;
  value: number;
  warn?: boolean;
  /**
   * cd-iiq7: when present, the chip renders as a Link to a pre-filtered
   * list view (e.g. /agents?state=active, /beads?status=open). Hover
   * affordance signals clickability; non-clickable chips render the
   * same atoms in a div.
   */
  to?: string;
}) {
  const body = (
    <>
      <dt className="text-[10px] uppercase tracking-wider text-ink-300">{label}</dt>
      <dd className={`text-xl font-semibold tabular-nums ${warn ? 'text-warn-500' : 'text-ink-100'}`}>
        {value}
      </dd>
    </>
  );
  if (to !== undefined) {
    return (
      <Link
        to={to}
        className="block group rounded-md -mx-1 px-1 hover:bg-ink-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        title={`Open filtered list: ${label}`}
      >
        <dt className="text-[10px] uppercase tracking-wider text-ink-300 group-hover:text-ink-200">{label}</dt>
        <dd className={`text-xl font-semibold tabular-nums ${warn ? 'text-warn-500' : 'text-ink-100'} group-hover:underline`}>
          {value}
        </dd>
      </Link>
    );
  }
  return <div>{body}</div>;
}

function StatePill({ state, attached }: { state: string; attached: boolean }) {
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
    >
      {state}
      {attached && <span className="text-[9px] uppercase">·att</span>}
    </span>
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

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
  }
  return `${Math.floor(sec / 3600)}h`;
}

function formatRelativeNow(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diffSec = Math.max(0, Math.round((now - ms) / 1_000));
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
}
