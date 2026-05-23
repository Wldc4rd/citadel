import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  BeadDetailResponse,
  KanbanCard,
  KanbanColumn,
  KanbanResponse,
} from 'citadel-shared';
import { KANBAN_COLUMNS } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { usePageTitle } from '../hooks/usePageTitle';

// Read-only Kanban (td-wyr6ly). Charlie directive 2026-05-19 17:02 UTC:
// trello-style board, ownership-state columns, cards link into the
// bead drill-in (td-384rhs). Strawman columns per the bead.
//
// READ-ONLY: no drag-drop, no inline edits. Charlie's brief explicitly
// scopes that out. Cards navigate to /beads/:id for any state change.
//
// Refresh strategy mirrors cockpit: 30s tick + SSE-triggered refresh
// on bead.* / session.* events.

const REFRESH_INTERVAL_MS = 30_000;
const TICK_MS = 5_000;
const STALE_AMBER_MS = 30_000;
const STALE_RED_MS = 120_000;
// cd-6w92: animation + activity feed for column transitions. Cards
// that move column-to-column get a transient ring highlight; the feed
// below the board retains the last N moves for "I blinked, what just
// changed?".
const MOVED_HIGHLIGHT_MS = 2_500;
const FEED_MAX_ENTRIES = 15;

/**
 * cd-tle7m: reconcile a freshly-fetched Kanban against the last displayed
 * one so a transiently-missing bead doesn't flicker out. The supervisor's
 * /v0/city/{name}/beads can return an inconsistent PARTIAL city-store set
 * per call (the high-churn city/td- store is read mid-bd-auto-import-rebuild;
 * reproduced: td- count swings 14/31/22/32 across consecutive calls while
 * cd/th/jt stay stable). So a card present last refresh but absent now is
 * almost always a partial read, not a real removal. Retain such a card for
 * ONE refresh; only drop it after it's been absent from TWO consecutive
 * responses. `absence` holds the per-bead consecutive-miss count (mutated).
 * Note: this is a display-layer mitigation; the root fix is a consistent
 * supervisor read (td-k3rxae family).
 */
export function reconcileKanban(
  prev: KanbanResponse | null,
  next: KanbanResponse,
  absence: Map<string, number>,
): KanbanResponse {
  if (prev === null) {
    absence.clear();
    return next;
  }
  const nextIds = new Set<string>();
  for (const col of KANBAN_COLUMNS) {
    for (const card of next.columns[col] ?? []) nextIds.add(card.id);
  }
  // Cards present this read reset their miss counter.
  for (const id of nextIds) absence.delete(id);
  // Start from next, then carry over cards that were displayed last time
  // but are missing now — unless they've already missed once (2nd
  // consecutive miss => genuine removal, drop it).
  const columns = {} as Record<KanbanColumn, KanbanCard[]>;
  for (const col of KANBAN_COLUMNS) {
    columns[col] = [...(next.columns[col] ?? [])];
    for (const card of prev.columns[col] ?? []) {
      if (nextIds.has(card.id)) continue;
      if ((absence.get(card.id) ?? 0) === 0) {
        absence.set(card.id, 1);
        columns[col].push(card);
      } else {
        absence.delete(card.id);
      }
    }
  }
  let total = 0;
  for (const col of KANBAN_COLUMNS) total += columns[col].length;
  return { as_of: next.as_of, columns, total };
}

/**
 * cd-6w92: one column-to-column transition observed between two
 * refreshes. fromColumn/toColumn are the KanbanResponse columns the
 * card was in then-and-now; ts is when the diff was detected (client
 * wall clock; the bead's actual transition time is somewhere within
 * the previous refresh interval).
 */
interface KanbanTransition {
  beadId: string;
  title: string;
  fromColumn: KanbanColumn;
  toColumn: KanbanColumn;
  ts: number;
}

const COLUMN_LABELS: Record<KanbanColumn, string> = {
  mayor_plate: 'Mayor Plate',
  in_flight: 'In-Flight',
  stalled: 'Stalled',
  blocked_real: 'Blocked (Real)',
  blocked_stale: 'Blocked (Stale)',
  in_review: 'In Review',
  needs_changes: 'Needs Changes',
  approved: 'Approved',
  closed_24h: 'Closed (24h)',
};

const COLUMN_TONE: Record<KanbanColumn, string> = {
  // Mayor needs to act
  mayor_plate: 'border-warn-500/40',
  // Active work
  in_flight: 'border-accent-700/40',
  // Trouble states — Charlie's eye should be drawn here
  stalled: 'border-error-500/40',
  blocked_real: 'border-ink-600',
  blocked_stale: 'border-warn-500/40',
  // Pipeline downstream — work going forward
  in_review: 'border-thriva-primary/40',
  needs_changes: 'border-warn-500/40',
  approved: 'border-accent-700/40',
  // Done
  closed_24h: 'border-ink-700',
};

const COLUMN_HELP: Record<KanbanColumn, string> = {
  mayor_plate: 'Open, no in-flight signal — mayor monitors routing + pickup.',
  in_flight: 'Claimed; assignee session active and recently touched.',
  stalled: 'Claimed but session inactive >1h or asleep — mayor pokes.',
  blocked_real: 'Blocked label + at least one open dep — wait or unblock dep.',
  blocked_stale: 'Blocked label + all deps closed — mayor unblock.',
  in_review: 'Implementer done; reviewer audits.',
  needs_changes: 'Reviewer bounced — back to implementer.',
  approved: 'Reviewer approved; refinery to merge.',
  closed_24h: 'Closed within last 24 hours.',
};

export function KanbanPage() {
  usePageTitle('Kanban');
  const [data, setData] = useState<KanbanResponse | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // cd-ykl9: lazy-loaded detail popover. Click the "ⓘ" on a card →
  // fetch /api/beads/:id and show curated metadata + notes preview in
  // a modal. The full drill-in stays the card's primary action; this
  // modal is the at-a-glance answer for "what's the latest on this?"
  // without leaving Kanban context.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<BeadDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // cd-6w92: card-id → column it was in on the last refresh. Stored in
  // a ref because the diff happens INSIDE the effect that reacts to
  // `data`; the ref doesn't need to trigger re-renders. First-load
  // sentinel handled inline: an empty map means "no prior state, skip
  // the diff" so every card on first paint doesn't generate a
  // transition.
  const prevLocationsRef = useRef<Map<string, KanbanColumn>>(new Map());
  // cd-tle7m: last-displayed Kanban + per-bead consecutive-miss counts, for
  // reconcileKanban (retain a transiently-missing card across one refresh).
  const displayedRef = useRef<KanbanResponse | null>(null);
  const absenceRef = useRef<Map<string, number>>(new Map());
  const [transitions, setTransitions] = useState<KanbanTransition[]>([]);
  // Set of card ids currently in the "just moved" highlight window.
  // Cleared per-card after MOVED_HIGHLIGHT_MS; timers stored in
  // movedTimersRef so unmount can clean up.
  const [recentlyMovedIds, setRecentlyMovedIds] = useState<ReadonlySet<string>>(new Set());
  const movedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.kanban();
      // cd-tle7m: reconcile against last-displayed so a transiently-missing
      // bead (supervisor partial city-store read) doesn't flicker out.
      const merged = reconcileKanban(displayedRef.current, d, absenceRef.current);
      displayedRef.current = merged;
      setData(merged);
      setFetchedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'kanban fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(tick);
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const sseState = useGcEventRefresh(['bead.', 'session.'], () => void refresh());

  // cd-ykl9: lazy-loaded detail popover handlers (modal open/close).
  // Orthogonal to cd-6w92's diff effect below; coexist on the same page.
  const handleDetail = useCallback(async (beadId: string) => {
    setDetailFor(beadId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await api.beadDetail(beadId);
      setDetail(d);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'detail fetch failed';
      setDetailError(msg);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetailFor(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  // cd-6w92: detect column transitions whenever `data` changes. Diff
  // current cards-by-column against the previous snapshot; emit one
  // KanbanTransition per card whose column changed. Skip the first
  // load (empty prev map) — every card on first paint would otherwise
  // count as "moved".
  useEffect(() => {
    if (data === null) return;
    const currentLocations = new Map<string, KanbanColumn>();
    const titleById = new Map<string, string>();
    for (const col of KANBAN_COLUMNS) {
      for (const c of data.columns[col]) {
        currentLocations.set(c.id, col);
        titleById.set(c.id, c.title);
      }
    }
    const prev = prevLocationsRef.current;
    // First load — populate prev silently.
    if (prev.size > 0) {
      const moved: KanbanTransition[] = [];
      const movedIds: string[] = [];
      for (const [id, currentCol] of currentLocations.entries()) {
        const prevCol = prev.get(id);
        if (prevCol !== undefined && prevCol !== currentCol) {
          moved.push({
            beadId: id,
            title: titleById.get(id) ?? '(no title)',
            fromColumn: prevCol,
            toColumn: currentCol,
            ts: Date.now(),
          });
          movedIds.push(id);
        }
      }
      if (moved.length > 0) {
        // Prepend newest first; cap to FEED_MAX_ENTRIES.
        setTransitions((existing) => [...moved.reverse(), ...existing].slice(0, FEED_MAX_ENTRIES));
        // Highlight moved cards briefly. Per-card timer so consecutive
        // moves don't truncate each other's animations.
        setRecentlyMovedIds((existing) => {
          const next = new Set(existing);
          for (const id of movedIds) next.add(id);
          return next;
        });
        for (const id of movedIds) {
          const prevTimer = movedTimersRef.current.get(id);
          if (prevTimer) clearTimeout(prevTimer);
          const t = setTimeout(() => {
            setRecentlyMovedIds((existing) => {
              if (!existing.has(id)) return existing;
              const next = new Set(existing);
              next.delete(id);
              return next;
            });
            movedTimersRef.current.delete(id);
          }, MOVED_HIGHLIGHT_MS);
          movedTimersRef.current.set(id, t);
        }
      }
    }
    prevLocationsRef.current = currentLocations;
  }, [data]);

  // Clean up any pending highlight timers on unmount.
  useEffect(() => {
    const timers = movedTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const staleness = fetchedAt === null
    ? 'down'
    : now - fetchedAt < STALE_AMBER_MS
      ? 'fresh'
      : now - fetchedAt < STALE_RED_MS
        ? 'amber'
        : 'red';

  return (
    <section className="space-y-3">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Kanban</h1>
          <p className="text-xs text-ink-300">
            Read-only ownership view.{' '}
            {data && (
              <>
                {data.total} engineering bead{data.total === 1 ? '' : 's'} classified
              </>
            )}
            {' · auto-refresh 30s + SSE.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SseIndicator state={sseState} />
          {fetchedAt !== null && (
            <span
              className={`text-[11px] tabular-nums ${
                staleness === 'fresh'
                  ? 'text-ink-300'
                  : staleness === 'amber'
                    ? 'text-warn-500'
                    : 'text-error-500'
              }`}
            >
              {Math.max(0, Math.round((now - fetchedAt) / 1_000))}s ago
            </span>
          )}
          {error && <span className="text-xs text-error-500">{error}</span>}
          <Button size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {data === null && !error && (
        <p className="text-sm text-ink-300 italic">Loading kanban…</p>
      )}

      {data !== null && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {KANBAN_COLUMNS.map((col) => (
            <Column
              key={col}
              col={col}
              cards={data.columns[col]}
              now={now}
              onDetail={handleDetail}
              recentlyMovedIds={recentlyMovedIds}
            />
          ))}
        </div>
      )}

      {/* cd-6w92: rolling activity feed sits below the board. Lives as
          long as the page session; clears on full reload. Per the bead's
          design recommendation, feed (panel) is primary; a toast layer
          could be added later as a quick-attention surface. */}
      <ActivityFeed transitions={transitions} now={now} />

      {/* cd-ykl9: lazy-loaded quick-detail modal. Triggered by the ⓘ on
          each Card; orthogonal to the activity feed above. */}
      <Modal
        open={detailFor !== null}
        onClose={closeDetail}
        title={detail?.bead.title ?? (detailFor ? `Loading ${detailFor}…` : 'Bead detail')}
        caption={detailFor ?? undefined}
        widthClass="max-w-2xl"
        footer={
          detailFor && (
            <Link
              to={`/beads/${encodeURIComponent(detailFor)}`}
              className="text-xs text-accent-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
            >
              Open full detail page →
            </Link>
          )
        }
      >
        {detailLoading ? (
          <p className="text-sm text-ink-300 italic">Loading bead detail…</p>
        ) : detailError ? (
          <p className="text-sm text-error-500">Error: {detailError}</p>
        ) : detail ? (
          <BeadQuickDetail detail={detail} now={now} />
        ) : null}
      </Modal>
    </section>
  );
}

// cd-6w92: activity feed renders the rolling list of recent transitions.
// Empty state is muted ("waiting for the next move…") so the panel
// surface is always present, signalling 'this is the spot to watch'.
function ActivityFeed({
  transitions,
  now,
}: {
  transitions: ReadonlyArray<KanbanTransition>;
  now: number;
}) {
  return (
    <section className="rounded-md border border-ink-700 bg-ink-800/60">
      <header className="px-3 py-1.5 border-b border-ink-700 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-200">
          Recent moves
        </span>
        <span className="text-[10px] text-ink-400">
          {transitions.length === 0
            ? 'waiting for the next move…'
            : `${transitions.length} of last ${FEED_MAX_ENTRIES}`}
        </span>
      </header>
      {transitions.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-ink-400 italic">
          Detected once a card changes column between refreshes (~30s tick + SSE).
        </p>
      ) : (
        <ul className="divide-y divide-ink-700">
          {transitions.map((t) => (
            <li key={`${t.beadId}-${t.ts}`} className="px-3 py-1.5 flex items-baseline gap-2 text-xs">
              <Link
                to={`/beads/${encodeURIComponent(t.beadId)}`}
                className="font-sans text-[10px] text-accent-500 hover:underline whitespace-nowrap"
              >
                {t.beadId}
              </Link>
              <span className="text-ink-200 truncate flex-1" title={t.title}>{t.title}</span>
              <span className="text-[10px] text-ink-300 whitespace-nowrap">
                <span className="text-ink-400">{COLUMN_LABELS[t.fromColumn]}</span>
                <span className="mx-1">→</span>
                <span className="text-ink-100 font-medium">{COLUMN_LABELS[t.toColumn]}</span>
              </span>
              <span className="text-[10px] text-ink-400 tabular-nums whitespace-nowrap">
                {formatRelativeNow(new Date(t.ts).toISOString(), now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Column({
  col,
  cards,
  now,
  onDetail,
  recentlyMovedIds,
}: {
  col: KanbanColumn;
  cards: KanbanCard[];
  now: number;
  onDetail: (beadId: string) => void;
  recentlyMovedIds: ReadonlySet<string>;
}) {
  return (
    <div className={`shrink-0 w-64 rounded-md border bg-ink-800 ${COLUMN_TONE[col]}`}>
      <header className="px-3 py-2 border-b border-ink-700 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-100 uppercase tracking-wider">
          {COLUMN_LABELS[col]}
        </span>
        <span className="text-[11px] tabular-nums text-ink-300">{cards.length}</span>
      </header>
      <p className="px-3 py-1 text-[10px] text-ink-400 italic border-b border-ink-700">
        {COLUMN_HELP[col]}
      </p>
      <ul className="p-2 space-y-1.5 max-h-[70vh] overflow-y-auto">
        {cards.length === 0 ? (
          <li className="text-[11px] text-ink-400 italic text-center py-2">empty</li>
        ) : (
          cards.map((c) => (
            <Card
              key={c.id}
              card={c}
              now={now}
              onDetail={onDetail}
              isRecentlyMoved={recentlyMovedIds.has(c.id)}
            />
          ))
        )}
      </ul>
    </div>
  );
}

function Card({
  card,
  now,
  onDetail,
  isRecentlyMoved,
}: {
  card: KanbanCard;
  now: number;
  onDetail: (beadId: string) => void;
  /** cd-6w92: card moved between columns within MOVED_HIGHLIGHT_MS — flash a ring. */
  isRecentlyMoved: boolean;
}) {
  // cd-8g9g: the bottom row (assignee + last_active) lives OUTSIDE the
  // bead Link so the assignee can carry its own /agents/<assignee> Link
  // without nesting <a>s (invalid HTML — browsers would close the outer
  // <a> when they hit the inner one and the card click would break).
  return (
    <li
      className={`rounded border border-ink-700 bg-ink-900/40 hover:bg-ink-900 transition-all duration-300 ${
        isRecentlyMoved ? 'ring-2 ring-accent-500/80 shadow-md shadow-accent-500/30' : ''
      }`}
    >
      <Link
        to={`/beads/${encodeURIComponent(card.id)}`}
        className="block px-2 pt-1.5 pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded"
        title={card.title}
      >
        <div className="flex items-baseline gap-1.5 mb-1">
          <code className="font-sans text-[10px] text-accent-500 whitespace-nowrap">
            {card.id}
          </code>
          <PriorityChip priority={card.priority} />
          {card.open_blocker_count > 0 && (
            <span
              className="inline-flex items-center text-[10px] text-warn-500"
              title={`${card.open_blocker_count} open blocker(s)`}
            >
              ⛔ {card.open_blocker_count}
            </span>
          )}
        </div>
        <p className="text-[11px] text-ink-100 leading-snug line-clamp-3">
          {card.title || '(no title)'}
        </p>
      </Link>
      <div className="px-2 pb-1.5 flex items-baseline justify-between gap-2 text-[10px]">
        {card.assignee ? (
          <Link
            to={`/agents/${encodeURIComponent(card.assignee)}`}
            className="text-ink-300 truncate hover:text-accent-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
            title={`Open agent · ${card.assignee}`}
          >
            {card.assignee}
          </Link>
        ) : (
          <span className="text-ink-300 truncate" title="unassigned">—</span>
        )}
        <div className="flex items-baseline gap-1.5">
          {card.last_active && (
            <span className="text-ink-400 tabular-nums whitespace-nowrap">
              {formatRelativeNow(card.last_active, now)}
            </span>
          )}
          {/* cd-ykl9: lazy-load detail without leaving Kanban context. The
              button is OUTSIDE the card's Link wrapper — no nested <a>s. */}
          <button
            type="button"
            onClick={() => onDetail(card.id)}
            className="text-ink-400 hover:text-accent-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm px-0.5"
            title="Quick detail (notes, deps, age) without leaving Kanban"
            aria-label={`Show quick detail for ${card.id}`}
          >
            ⓘ
          </button>
        </div>
      </div>
    </li>
  );
}

// cd-ykl9: curated detail surface for the Kanban quick-popover modal.
// Optimised for at-a-glance scan: timestamps, owner/assignee, deps
// count, recent notes preview. The full /beads/:id page is still the
// canonical detail; this is the "answer the obvious question without
// losing my place in Kanban" surface.
function BeadQuickDetail({ detail, now }: { detail: BeadDetailResponse; now: number }) {
  const b = detail.bead;
  const depCount = Array.isArray(b.dependencies) ? b.dependencies.length : 0;
  return (
    <div className="space-y-3 text-xs">
      <dl className="grid grid-cols-[6rem,1fr] gap-x-3 gap-y-1">
        <dt className="text-ink-300">Status</dt>
        <dd className="text-ink-100">
          {b.status}
          {b.close_reason && (
            <span className="ml-2 text-ink-300 italic">· {b.close_reason}</span>
          )}
        </dd>
        <dt className="text-ink-300">Type</dt>
        <dd className="text-ink-100">
          {b.issue_type} <span className="text-ink-300">· P{b.priority}</span>
        </dd>
        {b.owner && (
          <>
            <dt className="text-ink-300">Owner</dt>
            <dd className="text-ink-100">{b.owner}</dd>
          </>
        )}
        {b.assignee && (
          <>
            <dt className="text-ink-300">Assignee</dt>
            <dd className="text-ink-100">
              <Link
                to={`/agents/${encodeURIComponent(b.assignee)}`}
                className="text-accent-500 hover:underline"
              >
                {b.assignee}
              </Link>
            </dd>
          </>
        )}
        <dt className="text-ink-300">Created</dt>
        <dd className="text-ink-200 tabular-nums">
          {formatRelativeNow(b.created_at, now)}
          {b.created_by && <span className="text-ink-300"> · by {b.created_by}</span>}
        </dd>
        {b.started_at && b.started_at !== b.created_at && (
          <>
            <dt className="text-ink-300">Started</dt>
            <dd className="text-ink-200 tabular-nums">{formatRelativeNow(b.started_at, now)}</dd>
          </>
        )}
        {b.updated_at && b.updated_at !== b.created_at && (
          <>
            <dt className="text-ink-300">Updated</dt>
            <dd className="text-ink-200 tabular-nums">{formatRelativeNow(b.updated_at, now)}</dd>
          </>
        )}
        {b.closed_at && (
          <>
            <dt className="text-ink-300">Closed</dt>
            <dd className="text-ink-200 tabular-nums">{formatRelativeNow(b.closed_at, now)}</dd>
          </>
        )}
        <dt className="text-ink-300">Dependencies</dt>
        <dd className="text-ink-100">
          {depCount === 0 ? <span className="text-ink-300">—</span> : `${depCount} edge${depCount === 1 ? '' : 's'}`}
        </dd>
        {Array.isArray(b.labels) && b.labels.length > 0 && (
          <>
            <dt className="text-ink-300">Labels</dt>
            <dd className="flex flex-wrap gap-1">
              {b.labels.map((l) => (
                <span
                  key={l}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-ink-700/60 border border-ink-600 text-ink-200"
                >
                  {l}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      {detail.notes_html && detail.notes_html.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-[10px] uppercase tracking-wider text-ink-300">Recent notes</h3>
          {/* notes_html is rendered server-side by renderMarkdownSafe
              (strict-allowlist sanitiser; see backend/src/markdown.ts).
              The same dangerouslySetInnerHTML pattern that /beads/:id
              uses — safe here for the same reason. Capped via CSS
              max-h + overflow-y so a notes-heavy bead doesn't bloat
              the modal. */}
          <div
            className="bead-md text-[11px] max-h-64 overflow-y-auto rounded-md border border-ink-700 bg-ink-900/50 px-3 py-2"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: detail.notes_html }}
          />
        </section>
      )}
    </div>
  );
}

function PriorityChip({ priority }: { priority: number }) {
  const tone =
    priority === 0
      ? 'bg-error-500/20 text-error-500'
      : priority === 1
        ? 'bg-warn-500/20 text-warn-500'
        : 'bg-ink-700/60 text-ink-300';
  return (
    <span
      className={`inline-flex items-center rounded px-1 text-[9px] font-medium tabular-nums ${tone}`}
    >
      P{priority}
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

function formatRelativeNow(iso: string | null, now: number): string {
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
