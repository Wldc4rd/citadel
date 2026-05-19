import { useMemo } from 'react';
import { AnsiUp } from 'ansi_up';
import type { TranscriptResult, TranscriptTurn } from 'citadel-shared';

// Shared peek-modal body. Used by:
//   - routes/Agents.tsx          (Peek button on the agents list)
//   - routes/Cockpit.tsx         (mayor peek panel — td-a40qsy)
//   - routes/Agents/<alias>.tsx  (future drill-in — td-uxfwox)
//
// Architect td-a40qsy: "DO NOT build the cockpit peek separately;
// inherit the agent-drill-in peek component." This is that component —
// extracted in td-a40qsy implementation rather than waiting for
// td-uxfwox, which is blocked behind cockpit. Future drill-in just
// imports.
//
// SECURITY: turn.text has already been sanitised server-side
// (sanitiseTerminalOutput in backend/src/exec.ts). ansi_up sees only
// SGR sequences; the dangerouslySetInnerHTML below is safe because of
// that two-stage strip. Adding new render paths? They must use this
// component or replicate the sanitise-then-ansi_up dance — see
// docs/SECURITY.md.

const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

export interface SessionPeekContentProps {
  loading: boolean;
  error: string | null;
  result: TranscriptResult | null;
}

export function SessionPeekContent({
  loading,
  error,
  result,
}: SessionPeekContentProps) {
  if (loading) {
    return <p className="text-ink-300 italic text-sm">Fetching transcript…</p>;
  }
  if (error) {
    return (
      <p className="text-error-500 text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (!result) return null;
  if (result.turns.length === 0) {
    return <p className="text-ink-300 italic text-sm">No turns in this session yet.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-warn-500 bg-warn-500/10 border border-warn-500/30 rounded-md px-2 py-1">
        {PROMPT_INJECTION_NOTICE}
      </p>
      <ol className="space-y-2">
        {result.turns.map((turn, idx) => (
          <TurnBlock key={idx} turn={turn} index={idx} />
        ))}
      </ol>
      {result.truncated && (
        <p className="text-[11px] text-ink-300 italic">
          Some turns were truncated at the per-turn / total cap. Run <code>gc session peek</code> in a terminal for the full transcript.
        </p>
      )}
    </div>
  );
}

function TurnBlock({ turn, index }: { turn: TranscriptTurn; index: number }) {
  const html = useMemo(() => {
    const renderer = new AnsiUp();
    renderer.use_classes = true;
    return renderer.ansi_to_html(turn.text);
  }, [turn.text]);

  return (
    <li className="rounded-md border border-ink-700 bg-ink-900/60 overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-3 py-1 border-b border-ink-700 bg-ink-800/60">
        <span className="text-[10px] uppercase tracking-wider text-ink-300">
          #{index + 1}
        </span>
        <RolePill role={turn.role} />
      </header>
      <pre
        className="px-3 py-2 text-xs font-sans whitespace-pre-wrap leading-relaxed overflow-x-auto text-ink-100"
        // eslint-disable-next-line react/no-danger -- html is ansi_up output of server-sanitised text; see SECURITY.md
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </li>
  );
}

function RolePill({ role }: { role: string }) {
  const tone =
    role === 'assistant'
      ? 'bg-accent-700/20 text-accent-500 border-accent-700/40'
      : role === 'user'
        ? 'bg-thriva-primary/20 text-thriva-primary border-thriva-primary/40'
        : role === 'system'
          ? 'bg-warn-500/20 text-warn-500 border-warn-500/40'
          : role === 'tool_use' || role === 'tool_result'
            ? 'bg-ink-700 text-ink-200 border-ink-600'
            : 'bg-ink-700/60 text-ink-300 border-ink-600';
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {role}
    </span>
  );
}

export function formatPeekCaption(result: TranscriptResult, now: number): string {
  return `${result.turns.length} turn(s) · ${formatChars(result.total_chars)} · captured ${formatRelative(result.captured_at, now)}`;
}

function formatChars(n: number): string {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diffSec = Math.max(0, Math.round((now - ms) / 1_000));
  if (diffSec < 5) return 'now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
}
