import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BeadDetailResponse, GcSession } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { useViewingAs } from '../contexts/ViewingAsContext';
import { usePageTitle } from '../hooks/usePageTitle';

// Bead drill-in (td-384rhs). Route /beads/:beadId.
//
// Surface per architect:
//   - Header (id, title, status, priority, type, owner, assignee link)
//   - Description / Design / Notes (markdown, server-rendered safe HTML)
//   - Ownership (owner, assignee → /agents/<slug>)
//   - History (closed_at, started_at, created_at)
//   - Dependencies (depth-1 links into other /beads/:id pages)
//   - Quick actions (claim, close — reuse existing POST endpoints)
//
// Markdown safety: description_html/design_html/notes_html come from the
// backend's renderMarkdownSafe() (strict-allowlist sanitiser; see
// backend/src/markdown.ts). The dangerouslySetInnerHTML below trusts
// that path. Mention auto-linking ("td-abc123" → /beads/td-abc123) is
// applied server-side in the same renderer pass.
//
// Out of scope (per architect):
//   - "Full" history (refinery events, audit timeline) — server has no
//     join for this in v0; the close_reason + started_at + closed_at
//     fields cover what's actually visible today.

const SESSIONS_REFRESH_MS = 30_000;

export function BeadDetailPage() {
  const { beadId = '' } = useParams<{ beadId: string }>();
  const navigate = useNavigate();
  const decoded = useMemo(() => decodeURIComponent(beadId), [beadId]);
  const { viewingAs } = useViewingAs();

  const [detail, setDetail] = useState<BeadDetailResponse | null>(null);
  const [sessions, setSessions] = useState<GcSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [actionRunning, setActionRunning] = useState<'claim' | 'close' | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  usePageTitle(
    detail?.bead
      ? `Bead · ${detail.bead.id} · ${detail.bead.title.slice(0, 80)}`
      : `Bead · ${decoded}`,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.beadDetail(decoded);
      setDetail(d);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setNotFound(true);
        setDetail(null);
      } else {
        const msg =
          err instanceof ApiClientError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'bead fetch failed';
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [decoded]);

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await api.listSessions();
      setSessions(items);
    } catch {
      /* sessions panel degrades gracefully */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSessions();
  }, [refresh, refreshSessions]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) {
        void refreshSessions();
      }
    }, SESSIONS_REFRESH_MS);
    return () => clearInterval(tick);
  }, [refreshSessions]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 5_000);
    return () => clearInterval(tick);
  }, []);

  // SSE — refresh this bead on bead.* events so claim/close-from-elsewhere
  // surface within seconds.
  useGcEventRefresh(['bead.', 'session.'], () => {
    void refresh();
    void refreshSessions();
  });

  const assigneeSlug = useMemo<string | null>(() => {
    if (!detail?.bead.assignee || sessions === null) return null;
    const candidate = sessions.find(
      (s) =>
        s.alias === detail.bead.assignee ||
        s.session_name === detail.bead.assignee ||
        s.id === detail.bead.assignee,
    );
    if (!candidate) return null;
    return candidate.session_name ?? candidate.alias ?? candidate.id;
  }, [detail, sessions]);

  const handleClaim = useCallback(async () => {
    if (detail === null) return;
    setActionRunning('claim');
    setActionFeedback(null);
    try {
      await api.claimBead(detail.bead.id);
      setActionFeedback(`Claimed as ${viewingAs.ownerAlias} (refresh in progress).`);
      void refresh();
    } catch (err) {
      setActionFeedback(`Claim failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setActionRunning(null);
    }
  }, [detail, refresh]);

  const handleClose = useCallback(async () => {
    if (detail === null) return;
    const reason = window.prompt('Close reason (optional):', '');
    if (reason === null) return; // user cancelled
    setActionRunning('close');
    setActionFeedback(null);
    try {
      await api.closeBead(detail.bead.id, reason.length > 0 ? reason : undefined);
      setActionFeedback('Closed.');
      void refresh();
    } catch (err) {
      setActionFeedback(`Close failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setActionRunning(null);
    }
  }, [detail, refresh]);

  if (notFound) {
    return (
      <section className="space-y-3">
        <header>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Bead</h1>
          <p className="text-xs text-ink-300">
            No bead matches <code className="font-sans">{decoded}</code>.
          </p>
        </header>
        <div className="panel">
          <div className="panel-body space-y-2">
            <p className="text-sm text-ink-200">
              The id doesn't resolve via <code className="font-sans">gc bd show</code>. It may have been
              deleted, or the id may be malformed.
            </p>
            <Button size="sm" onClick={() => navigate('/beads')}>
              Back to Beads
            </Button>
          </div>
        </div>
      </section>
    );
  }

  if (detail === null) {
    return (
      <p className="text-sm text-ink-300 italic">
        {error ? `Error: ${error}` : 'Loading…'}
      </p>
    );
  }

  const b = detail.bead;

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <code className="font-sans text-xs text-ink-300">{b.id}</code>
            <StatusPill status={b.status} />
            <PriorityPill priority={b.priority} />
            <TypePill type={b.issue_type} />
          </div>
          <h1 className="text-lg font-sans font-semibold text-ink-100 break-words">
            {b.title}
          </h1>
          <p className="text-[11px] text-ink-300 mt-1">
            owner <span className="text-ink-200">{b.owner ?? b.created_by ?? '—'}</span> ·
            assignee <AssigneeLink assignee={b.assignee} slug={assigneeSlug} /> ·
            created {formatRelativeNow(b.created_at, now)}
            {b.updated_at && b.updated_at !== b.created_at && (
              <> · updated {formatRelativeNow(b.updated_at, now)}</>
            )}
            {b.started_at && <> · started {formatRelativeNow(b.started_at, now)}</>}
            {b.closed_at && <> · closed {formatRelativeNow(b.closed_at, now)}</>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {b.status !== 'closed' && (
            <>
              <Button size="sm" onClick={handleClaim} disabled={actionRunning !== null}>
                {actionRunning === 'claim' ? 'Claiming…' : `Claim as ${viewingAs.ownerAlias}`}
              </Button>
              <Button
                size="sm"
                tone="danger"
                onClick={handleClose}
                disabled={actionRunning !== null}
              >
                {actionRunning === 'close' ? 'Closing…' : 'Close'}
              </Button>
            </>
          )}
          <Link to="/beads">
            <Button size="sm" tone="ghost">
              ← Back
            </Button>
          </Link>
        </div>
      </header>

      {actionFeedback && (
        <p
          className={`text-[11px] ${
            actionFeedback.startsWith('Cl') && !actionFeedback.includes('failed')
              ? 'text-accent-500'
              : 'text-error-500'
          }`}
        >
          {actionFeedback}
        </p>
      )}

      {error && !notFound && (
        <div className="rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-xs text-error-500">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 space-y-3">
          <MarkdownPanel title="Description" html={detail.description_html} empty="No description." />
          <MarkdownPanel title="Design" html={detail.design_html} empty="No architect design notes." />
          <MarkdownPanel title="Notes" html={detail.notes_html} empty="No notes." />
          {b.close_reason && (
            <div className="panel">
              <div className="panel-header">
                <span className="text-xs uppercase tracking-wider text-ink-300">Close reason</span>
              </div>
              <div className="panel-body">
                <pre className="text-xs text-ink-100 font-sans whitespace-pre-wrap break-words">
                  {b.close_reason}
                </pre>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-3">
          <LabelsPanel labels={b.labels ?? []} />
          <DepsPanel
            deps={(b.dependencies ?? []).filter((d) => d.id !== b.id)}
          />
          {b.metadata && Object.keys(b.metadata).length > 0 && (
            <MetadataPanel metadata={b.metadata as Record<string, unknown>} />
          )}
        </div>
      </div>

      <p className="text-[10px] text-ink-400 text-right">
        {loading ? 'refreshing…' : `data via gc bd show · auto-refresh on bead.* events`}
      </p>
    </section>
  );
}

// ── Panels ──────────────────────────────────────────────────────────────

function MarkdownPanel({
  title,
  html,
  empty,
}: {
  title: string;
  html: string;
  empty: string;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">{title}</span>
      </div>
      <div className="panel-body">
        {html.length === 0 ? (
          <p className="text-xs text-ink-300 italic">{empty}</p>
        ) : (
          <div
            // eslint-disable-next-line react/no-danger -- HTML is server-rendered by renderMarkdownSafe with strict-allowlist; see backend/src/markdown.ts
            dangerouslySetInnerHTML={{ __html: html }}
            className="prose-bead text-sm text-ink-100 leading-relaxed"
          />
        )}
      </div>
    </div>
  );
}

function LabelsPanel({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="text-xs uppercase tracking-wider text-ink-300">Labels</span>
        </div>
        <div className="panel-body">
          <p className="text-xs text-ink-300 italic">No labels.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">Labels</span>
      </div>
      <div className="panel-body flex flex-wrap gap-1">
        {labels.map((l) => (
          <span
            key={l}
            className="inline-flex items-center rounded-md border border-ink-600 bg-ink-700/60 px-1.5 py-0.5 text-[11px] text-ink-200 font-sans"
          >
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

function DepsPanel({
  deps,
}: {
  deps: Array<{ id: string; title?: string; status?: string; dependency_type?: string }>;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">Depends on</span>
      </div>
      <div className="panel-body">
        {deps.length === 0 ? (
          <p className="text-xs text-ink-300 italic">No dependencies.</p>
        ) : (
          // Architect spec depth-1: clicking opens the dependee's own
          // drill-in page; we don't recurse into its deps here.
          <ul className="space-y-1.5">
            {deps.map((d) => (
              <li key={d.id} className="text-xs">
                <Link
                  to={`/beads/${encodeURIComponent(d.id)}`}
                  className="text-accent-500 hover:underline font-sans whitespace-nowrap"
                >
                  {d.id}
                </Link>
                {d.title && (
                  <span className="text-ink-100 ml-2" title={d.title}>
                    {d.title.length > 60 ? d.title.slice(0, 57) + '…' : d.title}
                  </span>
                )}
                {d.status && (
                  <span
                    className={`ml-2 inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                      d.status === 'closed'
                        ? 'bg-ink-700 text-ink-300 border-ink-600'
                        : d.status === 'in_progress'
                          ? 'bg-accent-700/30 text-accent-500 border-accent-700/40'
                          : 'bg-ink-700/60 text-ink-200 border-ink-600'
                    }`}
                  >
                    {d.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MetadataPanel({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">Metadata</span>
      </div>
      <dl className="px-3 py-2 grid grid-cols-1 gap-1 text-xs">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-300 truncate">{k}</dt>
            <dd className="text-ink-100 tabular-nums truncate text-right">
              {formatMetaValue(v)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatMetaValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '<unrepresentable>';
  }
}

// ── Atoms ──────────────────────────────────────────────────────────────

function AssigneeLink({
  assignee,
  slug,
}: {
  assignee?: string;
  slug: string | null;
}) {
  if (!assignee) return <span className="text-ink-300 italic">unassigned</span>;
  if (slug === null) {
    // No matching session — still show the assignee name but not as link.
    return <span className="text-ink-200 font-sans">{assignee}</span>;
  }
  return (
    <Link
      to={`/agents/${encodeURIComponent(slug)}`}
      className="text-accent-500 hover:underline font-sans"
    >
      {assignee}
    </Link>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'closed'
      ? 'bg-ink-700 text-ink-300 border-ink-600'
      : status === 'in_progress'
        ? 'bg-accent-700/30 text-accent-500 border-accent-700/40'
        : status === 'blocked'
          ? 'bg-warn-500/20 text-warn-500 border-warn-500/30'
          : 'bg-ink-700/60 text-ink-200 border-ink-600';
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {status}
    </span>
  );
}

function PriorityPill({ priority }: { priority: number }) {
  const tone =
    priority === 0
      ? 'bg-error-500/20 text-error-500 border-error-500/40'
      : priority === 1
        ? 'bg-warn-500/20 text-warn-500 border-warn-500/40'
        : 'bg-ink-700/60 text-ink-200 border-ink-600';
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      P{priority}
    </span>
  );
}

function TypePill({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-ink-600 bg-ink-700/40 px-1.5 py-0.5 text-[11px] font-medium text-ink-200">
      {type}
    </span>
  );
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
