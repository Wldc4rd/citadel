import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GcBead, GcMailItem, GcSession, TranscriptResult } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import {
  SessionPeekContent,
  formatPeekCaption,
} from '../components/SessionPeekContent';
import { useGcEventRefresh } from '../hooks/useGcEvents';
import { usePageTitle } from '../hooks/usePageTitle';
import { useViewingAs } from '../contexts/ViewingAsContext';

// Agent drill-in page (td-uxfwox). Route: /agents/:slug where slug is
// the session's session_name (always URL-safe). Falls back to matching
// by alias or id if a stale URL is opened.
//
// Surface:
//   - Live peek (auto-refreshes every 7s while tab visible).
//   - Currently-working-on bead (from session.active_bead).
//   - Beads-assigned (client-side filter of /api/beads against the
//     agent's alias / session_name / id — bead-store assignees use
//     varied formats; OR-match catches all).
//   - Metadata (template, rig, pool, model, ctx%, attached, created).
//   - Quick actions: Nudge (one-click), Refresh peek.
//
// Out-of-scope (per architect td-uxfwox §"Beads previously worked on"):
//   - History of completed beads — v0 scopes down to currently-assigned
//     only. The relevant query would need a server-side join we don't
//     have today; flag here so the next drill-in bead picks it up.

const PEEK_AUTO_REFRESH_MS = 7_000;
const SESSIONS_REFRESH_MS = 15_000;
const BEADS_REFRESH_MS = 30_000;
const DEFAULT_NUDGE_MESSAGE = 'check work';
// cd-wlav: chat panel cadence + size caps. 10s poll matches the
// "feels live but doesn't hammer the supervisor" trade-off of the
// rest of the cockpit's polling; max 200 messages is generous for
// a single human↔agent thread (cap exists so a runaway agent talker
// doesn't bloat the panel).
const CHAT_REFRESH_MS = 10_000;
const CHAT_MESSAGE_CAP = 200;
const CHAT_BODY_MAXLEN = 16 * 1024;
// Wire identity for outbound: dashboard owner is pinned to 'human' on
// the wire (security_researcher td-wisp-eb0pn physical separation).
// We also match inbound mail addressed to 'human' as belonging to the
// owner side of the conversation — same cd-d9db OWNER_ALIASES bridge
// the mail.ts backend already applies.
const OWNER_WIRE_ALIAS = 'human';

export function AgentDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { viewingAs } = useViewingAs();

  const [sessions, setSessions] = useState<GcSession[] | null>(null);
  const [beads, setBeads] = useState<GcBead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [peekResult, setPeekResult] = useState<TranscriptResult | null>(null);
  const [peekFetchedAt, setPeekFetchedAt] = useState<number | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);

  const [nudging, setNudging] = useState(false);
  const [nudgeFeedback, setNudgeFeedback] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // cd-wlav: chat thread between dashboard owner and this agent.
  // Pulled from /api/mail box=all (one wide fetch, filtered client-
  // side) so the conversation shows BOTH directions regardless of
  // which alias the user is "viewing as" in the Mail page.
  const [chatMessages, setChatMessages] = useState<GcMailItem[] | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatFetchedAt, setChatFetchedAt] = useState<number | null>(null);
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatSendError, setChatSendError] = useState<string | null>(null);

  const decoded = useMemo(() => decodeURIComponent(slug), [slug]);

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await api.listSessions();
      setSessions(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sessions failed');
    }
  }, []);

  const refreshBeads = useCallback(async () => {
    try {
      const { items } = await api.listBeads({ showAll: true, limit: 1000 });
      setBeads(items);
    } catch {
      /* don't blow away the page; surfaced via the per-panel area */
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshBeads();
  }, [refreshSessions, refreshBeads]);

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
      if (!document.hidden) {
        void refreshBeads();
      }
    }, BEADS_REFRESH_MS);
    return () => clearInterval(tick);
  }, [refreshBeads]);

  // Wall-clock tick — drives "Ns ago" labels without re-fetching.
  useEffect(() => {
    const tick = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 5_000);
    return () => clearInterval(tick);
  }, []);

  // SSE — refresh sessions on session.* events, beads on bead.* events.
  useGcEventRefresh(['session.', 'bead.'], () => {
    void refreshSessions();
    void refreshBeads();
  });

  // Locate the session by the slug. Prefer session_name (the URL-safe
  // primary form) but fall back to alias and id so old bookmarks still
  // resolve.
  const session = useMemo<GcSession | null>(() => {
    if (sessions === null) return null;
    return (
      sessions.find((s) => s.session_name === decoded) ??
      sessions.find((s) => s.alias === decoded) ??
      sessions.find((s) => s.id === decoded) ??
      null
    );
  }, [sessions, decoded]);

  usePageTitle(`Agent · ${session?.alias ?? decoded}`);

  // Beads belonging to this agent. Bead-store assignees use mixed
  // formats — match on alias, session_name, or session_id to capture
  // them all (each is exact-string, no normalization).
  const assignedBeads = useMemo<GcBead[]>(() => {
    if (session === null || beads === null) return [];
    const candidates = new Set<string>();
    if (session.alias) candidates.add(session.alias);
    if (session.session_name) candidates.add(session.session_name);
    candidates.add(session.id);
    return beads.filter((b) => b.assignee && candidates.has(b.assignee));
  }, [session, beads]);

  const activeBead = useMemo<GcBead | null>(() => {
    if (session?.active_bead == null || beads === null) return null;
    return beads.find((b) => b.id === session.active_bead) ?? null;
  }, [session, beads]);

  // Auto-refresh peek. Only when we know which session to peek; pauses
  // when tab is hidden. The 7s cadence is a compromise per architect:
  // tight enough for "live" feel, loose enough to not hammer the
  // supervisor with 30+ agents open.
  const refreshPeek = useCallback(async () => {
    if (session === null) return;
    setPeekLoading(true);
    setPeekError(null);
    try {
      const result = await api.peekSession(session.id);
      setPeekResult(result);
      setPeekFetchedAt(Date.now());
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
  }, [session]);

  useEffect(() => {
    if (session === null) return;
    // Initial fetch is immediate; tab-visibility gate kicks in for the cadence.
    void refreshPeek();
    const tick = setInterval(() => {
      if (!document.hidden) void refreshPeek();
    }, PEEK_AUTO_REFRESH_MS);
    return () => clearInterval(tick);
  }, [session, refreshPeek]);

  // cd-wlav: agent's "chat alias" — the mailbox name we send to and
  // expect replies from. The supervisor's mail rows use alias-style
  // (e.g. 'thriva/devpipeline.architect') so we prefer session.alias;
  // fall back to session_name then id for sessions that don't have an
  // alias yet.
  const agentChatAlias = useMemo<string | null>(() => {
    if (!session) return null;
    return session.alias ?? session.session_name ?? session.id ?? null;
  }, [session]);

  const refreshChat = useCallback(async () => {
    if (!agentChatAlias) return;
    setChatError(null);
    try {
      // Wide fetch — box='all' returns the supervisor's mail window
      // unfiltered by alias (the alias arg is ignored when box='all'
      // per backend/src/routes/mail.ts::filterByBox). Filtering
      // happens locally in chatThread useMemo below.
      const result = await api.listMail('all', viewingAs.ownerAlias);
      // listMail returns the existing shape {items, total?, upstream_total?};
      // store the raw items + let chatThread useMemo do the work.
      setChatMessages(result.items);
      setChatFetchedAt(Date.now());
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'chat fetch failed');
    }
  }, [agentChatAlias, viewingAs.ownerAlias]);

  useEffect(() => {
    if (!agentChatAlias) return;
    void refreshChat();
    const tick = setInterval(() => {
      if (!document.hidden) void refreshChat();
    }, CHAT_REFRESH_MS);
    return () => clearInterval(tick);
  }, [agentChatAlias, refreshChat]);

  // cd-wlav: filter the wide-fetch mail to messages BETWEEN the
  // dashboard owner and this specific agent. Owner side includes the
  // configured display alias AND 'human' (wire identity per cd-d9db
  // OWNER_ALIASES bridge — Charlie display = 'charlie' but wire-from =
  // 'human', and the agent's reply may go to either alias).
  const chatThread = useMemo<GcMailItem[]>(() => {
    if (chatMessages === null || !agentChatAlias) return [];
    const ownerSet = new Set([viewingAs.ownerAlias.toLowerCase(), OWNER_WIRE_ALIAS]);
    const agentL = agentChatAlias.toLowerCase();
    const filtered = chatMessages.filter((m) => {
      const from = (m.from || '').toLowerCase();
      const to = (m.to || '').toLowerCase();
      return (ownerSet.has(from) && to === agentL) || (from === agentL && ownerSet.has(to));
    });
    // Oldest first for chat-style chronological display. Cap at the
    // chat message limit to keep render cheap on long histories.
    filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return filtered.slice(-CHAT_MESSAGE_CAP);
  }, [chatMessages, agentChatAlias, viewingAs.ownerAlias]);

  const handleChatSend = useCallback(async () => {
    if (!agentChatAlias) return;
    const body = chatDraft.trim();
    if (body.length === 0) return;
    setChatSending(true);
    setChatSendError(null);
    try {
      // Subject is auto-derived from the first ~60 chars of body so
      // the rolled-up mail thread (when viewed via /mail) still has a
      // human-readable subject. Body holds the actual message.
      const subject = body.split('\n')[0]?.slice(0, 60) || '[chat]';
      await api.sendMail({ to: agentChatAlias, subject, body });
      setChatDraft('');
      // Immediate refresh so the just-sent message renders without
      // waiting for the next tick.
      void refreshChat();
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'send failed';
      setChatSendError(msg);
    } finally {
      setChatSending(false);
    }
  }, [agentChatAlias, chatDraft, refreshChat]);

  const handleNudge = useCallback(async () => {
    if (session === null) return;
    setNudging(true);
    setNudgeFeedback(null);
    try {
      await api.nudgeSession(session.id, DEFAULT_NUDGE_MESSAGE);
      setNudgeFeedback('Nudge delivered (wait-idle).');
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
  }, [session]);

  // ── Loading + not-found states ───────────────────────────────────────

  if (sessions === null) {
    return <p className="text-sm text-ink-300 italic">Loading session list…</p>;
  }

  if (session === null) {
    return (
      <section className="space-y-3">
        <header>
          <h1 className="text-lg font-sans font-semibold text-ink-100">Agent</h1>
          <p className="text-xs text-ink-300">No session matches <code className="font-sans">{decoded}</code>.</p>
        </header>
        <div className="panel">
          <div className="panel-body">
            <p className="text-sm text-ink-200">
              The slug doesn't match any current session's <code className="font-sans">session_name</code>, <code className="font-sans">alias</code>, or <code className="font-sans">id</code>.
            </p>
            <p className="text-xs text-ink-300 mt-2">
              Sessions are listed at <Link to="/agents" className="underline">/agents</Link>.
            </p>
            <Button size="sm" onClick={() => navigate('/agents')} className="mt-3">
              Back to Agents
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-lg font-sans font-semibold text-ink-100 truncate">
              {session.alias ?? session.session_name ?? session.id}
            </h1>
            <StatePill state={session.state} attached={session.attached} reason={session.reason} />
          </div>
          <p className="text-xs text-ink-300">
            <code className="font-sans">{session.template ?? '—'}</code>
            {session.session_name && session.session_name !== session.alias && (
              <span className="text-ink-400"> · {session.session_name}</span>
            )}
            <span className="text-ink-400"> · id <code className="font-sans">{session.id}</code></span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleNudge} disabled={nudging}>
            {nudging ? 'Nudging…' : 'Nudge'}
          </Button>
          <Link to="/agents">
            <Button size="sm" tone="ghost">
              ← Back
            </Button>
          </Link>
        </div>
      </header>

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

      {error && (
        <div className="rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-xs text-error-500">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <MetadataPanel session={session} now={now} />
        <CurrentBeadPanel session={session} activeBead={activeBead} />
        <BeadsAssignedPanel
          session={session}
          beads={assignedBeads}
          beadsLoading={beads === null}
        />
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="text-xs uppercase tracking-wider text-ink-300">Live peek</span>
          <div className="flex items-center gap-2">
            {peekFetchedAt && (
              <span className="text-[11px] text-ink-300 tabular-nums">
                refreshed {formatRelativeNow(new Date(peekFetchedAt).toISOString(), now)}
              </span>
            )}
            <Button size="sm" tone="ghost" onClick={() => void refreshPeek()} disabled={peekLoading}>
              {peekLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
        <div className="panel-body">
          {peekResult && (
            <p className="text-[11px] text-ink-300 mb-2">
              {formatPeekCaption(peekResult, now)} · auto-refresh {PEEK_AUTO_REFRESH_MS / 1_000}s
            </p>
          )}
          <SessionPeekContent loading={peekLoading && peekResult === null} error={peekError} result={peekResult} />
        </div>
      </div>

      {/* Directives first (read-once context: what the agent is told
          to do); chat below (active-engagement: what we're saying to
          each other right now). */}
      <DirectivesPanel agentAlias={session.alias ?? session.template ?? null} />

      {/* cd-wlav: chat thread with this agent. Two-way via mail — user
          input goes through /api/mail-send (wire identity pinned to
          'human'); agent replies (whenever the agent's loop reads
          mail) come back via /api/mail box=all + filter. */}
      <ChatPanel
        agentAlias={agentChatAlias}
        ownerAlias={viewingAs.ownerAlias}
        messages={chatThread}
        loaded={chatMessages !== null}
        fetchedAt={chatFetchedAt}
        now={now}
        error={chatError}
        draft={chatDraft}
        onDraftChange={setChatDraft}
        onSend={handleChatSend}
        sending={chatSending}
        sendError={chatSendError}
        canSend={viewingAs.isOwner}
      />
    </section>
  );
}

// cd-i81q: composed behavioural prompt for the agent. Read-only —
// the bead's edit-and-save stretch goal is deferred behind security_
// researcher review (direct prompt edit via UI is a high-blast-radius
// action). Filed-for-followup with the same scope notes from the bead.
//
// Lazy: fetched on first render of the panel; cached for the page's
// lifetime (the prompt rarely changes during a session). Manual
// Refresh button re-fetches.
function DirectivesPanel({ agentAlias }: { agentAlias: string | null }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const refresh = useCallback(async () => {
    if (!agentAlias) return;
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const result = await api.agentPrime(agentAlias);
      setPrompt(result.prompt);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setNotConfigured(true);
        setPrompt(null);
      } else {
        const msg =
          err instanceof ApiClientError
            ? `${err.status} ${err.message}`
            : err instanceof Error
              ? err.message
              : 'prime failed';
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [agentAlias]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!agentAlias) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">
          Directives · <code className="font-sans">gc prime {agentAlias}</code>
        </span>
        <div className="flex items-center gap-2">
          {prompt && (
            <span className="text-[11px] text-ink-300 tabular-nums">
              {prompt.length.toLocaleString()} chars
            </span>
          )}
          <Button size="sm" tone="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>
      <div className="panel-body space-y-2">
        <p className="text-[11px] text-ink-300">
          The composed behavioural prompt the agent reads on next wake — built
          from the agent's <code className="font-sans">prompt_template</code> +
          city config patches. Read-only; edit-and-save deferred behind a
          security review (see cd-i81q follow-up).
        </p>
        {loading && prompt === null && (
          <p className="text-xs text-ink-300 italic">Loading directives…</p>
        )}
        {notConfigured && (
          <div className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
            Agent <code className="font-sans">{agentAlias}</code> has no entry in city.toml.
            <code className="font-sans"> gc prime --strict</code> reports it as not configured;
            the runtime would fall back to a generic worker prompt.
          </div>
        )}
        {error && !notConfigured && (
          <div className="rounded-md border border-error-500/40 bg-error-500/10 px-3 py-2 text-xs text-error-500">
            Error: {error}
          </div>
        )}
        {prompt !== null && (
          <pre className="text-[11px] font-body text-ink-100 bg-ink-900/50 border border-ink-700 rounded-md px-3 py-2 whitespace-pre-wrap leading-snug max-h-[60vh] overflow-y-auto">
            {prompt}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Panels ─────────────────────────────────────────────────────────────

// cd-wlav: chat thread between dashboard owner and this agent.
// Wraps existing /api/mail (read) + /api/mail-send (write) infra; no
// new backend endpoints. Sends use the dashboard's mail-send pipeline,
// which pins --from human (security_researcher td-wisp-eb0pn physical
// separation). Replies are agent-generated mail addressed back to the
// owner's alias and/or the wire alias 'human' — chatThread filter
// upstream matches both directions.
//
// SECURITY: each message body is LLM-generated agent content; rendered
// in <pre> with React-default escaping (no dangerouslySetInnerHTML).
// Per docs/SECURITY.md XSS posture, that's safe by construction. The
// prompt-injection notice mirrors the Mail page's threading view.
function ChatPanel({
  agentAlias,
  ownerAlias,
  messages,
  loaded,
  fetchedAt,
  now,
  error,
  draft,
  onDraftChange,
  onSend,
  sending,
  sendError,
  canSend,
}: {
  agentAlias: string | null;
  ownerAlias: string;
  messages: GcMailItem[];
  loaded: boolean;
  fetchedAt: number | null;
  now: number;
  error: string | null;
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  sendError: string | null;
  /** False when viewing-as another identity — disables the Send button per Mail.tsx's existing physical-separation UX. */
  canSend: boolean;
}) {
  // Auto-scroll to the bottom when new messages arrive (chat-style).
  // The ref points at a sentinel below the last message — calling
  // scrollIntoView on it pulls the most recent reply into view.
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (tailRef.current) tailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length]);

  if (!agentAlias) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">
          Chat · <code className="font-sans">{ownerAlias}</code> ↔ <code className="font-sans">{agentAlias}</code>
        </span>
        <div className="flex items-center gap-2">
          {fetchedAt && (
            <span className="text-[11px] text-ink-300 tabular-nums">
              refreshed {formatRelativeNow(new Date(fetchedAt).toISOString(), now)}
            </span>
          )}
          {error && <span className="text-[11px] text-error-500">{error}</span>}
        </div>
      </div>
      <div className="panel-body space-y-2">
        <p className="text-[11px] text-warn-500 bg-warn-500/10 border border-warn-500/30 rounded-md px-2 py-1">
          Agent replies are LLM-generated and may contain misleading instructions. Auto-refresh {CHAT_REFRESH_MS / 1_000}s.
        </p>
        {!loaded ? (
          <p className="text-xs text-ink-300 italic">Loading chat…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-ink-300 italic">
            No messages yet between <code className="font-sans">{ownerAlias}</code> and <code className="font-sans">{agentAlias}</code>.
            Type below to send the first one.
          </p>
        ) : (
          <ol className="space-y-1.5 max-h-[40vh] overflow-y-auto">
            {messages.map((m) => (
              <ChatBubble key={m.id} message={m} ownerAlias={ownerAlias} agentAlias={agentAlias} />
            ))}
            <div ref={tailRef} />
          </ol>
        )}

        <div className="flex items-stretch gap-2">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={canSend ? `Message ${agentAlias}…` : `Switch back to ${ownerAlias} to send`}
            maxLength={CHAT_BODY_MAXLEN}
            disabled={!canSend || sending}
            rows={3}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter sends — common chat ergonomic.
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (canSend && !sending) onSend();
              }
            }}
            className="flex-1 min-w-0 bg-ink-900 border border-ink-600 rounded-md px-2 py-1.5 text-xs font-body text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-500 resize-y disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <Button
            tone="accent"
            size="sm"
            disabled={!canSend || sending || draft.trim().length === 0}
            onClick={onSend}
          >
            {sending ? 'Sending…' : `Send → ${agentAlias}`}
          </Button>
        </div>
        {sendError && (
          <p role="alert" className="text-xs text-error-500 bg-error-500/10 border border-error-500/30 rounded-md px-2 py-1">
            {sendError}
          </p>
        )}
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  ownerAlias,
  agentAlias,
}: {
  message: GcMailItem;
  ownerAlias: string;
  agentAlias: string;
}) {
  const fromLower = (message.from || '').toLowerCase();
  const isOwnerSide =
    fromLower === ownerAlias.toLowerCase() || fromLower === OWNER_WIRE_ALIAS;
  const sideClasses = isOwnerSide
    ? 'border-accent-700/40 bg-accent-700/10 ml-6'
    : 'border-ink-700 bg-ink-900/40 mr-6';
  const senderLabel = isOwnerSide ? ownerAlias : agentAlias;
  return (
    <li className={`rounded border ${sideClasses} px-2 py-1.5`}>
      <header className="flex items-baseline justify-between gap-2 text-[10px] text-ink-300 mb-1">
        <span className={isOwnerSide ? 'text-accent-500 font-medium' : 'text-ink-100 font-medium'}>
          {senderLabel}
        </span>
        <span className="tabular-nums">{formatChatTime(message.created_at)}</span>
      </header>
      {message.subject && message.subject !== '[chat]' && !message.body.startsWith(message.subject) && (
        <p className="text-[11px] text-ink-300 mb-0.5">
          <span className="text-ink-400">subj: </span>
          <span className="text-ink-200">{message.subject}</span>
        </p>
      )}
      <pre className="text-xs font-body whitespace-pre-wrap leading-snug text-ink-100">{message.body}</pre>
    </li>
  );
}

function formatChatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function MetadataPanel({ session, now }: { session: GcSession; now: number }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">Metadata</span>
      </div>
      <dl className="px-3 py-2 grid grid-cols-1 gap-1 text-xs">
        <Row label="state" value={session.state} />
        {session.reason && <Row label="reason" value={session.reason} />}
        <Row label="activity" value={session.activity ?? (session.running ? 'running' : '—')} />
        {session.rig && <Row label="rig" value={session.rig} />}
        {session.pool && <Row label="pool" value={session.pool} />}
        {session.agent_kind && <Row label="kind" value={session.agent_kind} />}
        {session.model && <Row label="model" value={session.model} />}
        {typeof session.context_pct === 'number' && (
          <Row
            label="context"
            value={`${session.context_pct}%`}
            warn={session.context_pct >= 80}
          />
        )}
        <Row label="created" value={formatRelativeNow(session.created_at, now)} />
        <Row label="last active" value={formatRelativeNow(session.last_active ?? session.created_at, now)} />
        {session.last_nudge_delivered_at && (
          <Row label="last nudge" value={formatRelativeNow(session.last_nudge_delivered_at, now)} />
        )}
        <Row label="attached" value={session.attached ? 'yes' : 'no'} />
      </dl>
    </div>
  );
}

function CurrentBeadPanel({
  session,
  activeBead,
}: {
  session: GcSession;
  activeBead: GcBead | null;
}) {
  const beadId = session.active_bead;
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">Currently working on</span>
      </div>
      <div className="panel-body">
        {!beadId ? (
          <p className="text-xs text-ink-300 italic">
            No bead reported as active by the supervisor.
          </p>
        ) : (
          <div className="space-y-1">
            <BeadLink id={beadId} title={activeBead?.title} status={activeBead?.status} />
            {activeBead === null && (
              <p className="text-[11px] text-ink-300 italic">
                Bead details not in the open-bead window — try the Beads page or <code className="font-sans">gc bd show {beadId}</code>.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BeadsAssignedPanel({
  session,
  beads,
  beadsLoading,
}: {
  session: GcSession;
  beads: GcBead[];
  beadsLoading: boolean;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="text-xs uppercase tracking-wider text-ink-300">
          Assigned · {beads.length}
        </span>
      </div>
      <div className="panel-body">
        {beadsLoading ? (
          <p className="text-xs text-ink-300 italic">Loading…</p>
        ) : beads.length === 0 ? (
          <p className="text-xs text-ink-300 italic">
            No open beads currently assigned to <code className="font-sans">{session.alias ?? session.session_name ?? session.id}</code>.
          </p>
        ) : (
          <ul className="divide-y divide-ink-700">
            {beads.slice(0, 20).map((b) => (
              <li key={b.id} className="py-1.5 first:pt-0 last:pb-0 flex items-baseline gap-2 text-xs">
                <BeadLink id={b.id} title={b.title} status={b.status} compact />
              </li>
            ))}
            {beads.length > 20 && (
              <li className="py-1.5 text-[11px] text-ink-300 italic">
                +{beads.length - 20} more — see Beads page filtered by assignee.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Atoms ──────────────────────────────────────────────────────────────

function BeadLink({
  id,
  title,
  status,
  compact = false,
}: {
  id: string;
  title?: string;
  status?: string;
  compact?: boolean;
}) {
  // Bead drill-in (td-384rhs) isn't built yet — the link is still
  // useful as a copyable anchor for now, and will resolve once
  // /beads/:id ships. Avoiding a stale "not yet" affordance keeps the
  // page from acquiring tech debt at the link site.
  return (
    <>
      <Link
        to={`/beads/${encodeURIComponent(id)}`}
        className="text-accent-500 hover:underline font-sans text-xs whitespace-nowrap"
        title={title ?? id}
      >
        {id}
      </Link>
      {title && (
        <span
          className={`text-ink-100 ${compact ? 'truncate flex-1' : ''}`}
          title={title}
        >
          {title}
        </span>
      )}
      {status && <StatusPill status={status} />}
    </>
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
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ml-auto whitespace-nowrap ${tone}`}
    >
      {status}
    </span>
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
