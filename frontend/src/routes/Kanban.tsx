import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { KanbanCard, KanbanColumn, KanbanResponse } from 'citadel-shared';
import { KANBAN_COLUMNS } from 'citadel-shared';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { useGcEventRefresh } from '../hooks/useGcEvents';

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
  const [data, setData] = useState<KanbanResponse | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.kanban();
      setData(d);
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
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Column({
  col,
  cards,
  now,
}: {
  col: KanbanColumn;
  cards: KanbanCard[];
  now: number;
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
          cards.map((c) => <Card key={c.id} card={c} now={now} />)
        )}
      </ul>
    </div>
  );
}

function Card({ card, now }: { card: KanbanCard; now: number }) {
  // cd-8g9g: the bottom row (assignee + last_active) lives OUTSIDE the
  // bead Link so the assignee can carry its own /agents/<assignee> Link
  // without nesting <a>s (invalid HTML — browsers would close the outer
  // <a> when they hit the inner one and the card click would break).
  return (
    <li className="rounded border border-ink-700 bg-ink-900/40 hover:bg-ink-900 transition-colors">
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
        {card.last_active && (
          <span className="text-ink-400 tabular-nums whitespace-nowrap">
            {formatRelativeNow(card.last_active, now)}
          </span>
        )}
      </div>
    </li>
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
