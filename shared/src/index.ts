// Single source of truth for the wire shapes the admin dashboard
// consumes from gc supervisor + emits to the browser. Importing this
// package on both sides surfaces wire-shape drift as a compile error
// instead of a runtime undefined.
//
// Comments mark fields that gc supervisor MAY omit; treat them as
// optional and never assume presence in render code.

export type IsoTimestamp = string;
export type BeadId = string;
export type SessionId = string;

// ── Sessions ──────────────────────────────────────────────────────────────

export interface GcSession {
  id: SessionId;
  template: string;
  alias?: string;
  title?: string;
  state: GcSessionState;
  /** Set when state transition has a structured reason (e.g. "city-stop"). */
  reason?: string;
  /** Human-readable display name from the provider (e.g. "Claude Code"). */
  display_name?: string;
  /** tmux/screen session name on disk. */
  session_name?: string;
  created_at: IsoTimestamp;
  /** Last time the session emitted activity; only set after first activity. */
  last_active?: IsoTimestamp;
  /** Whether a human is currently attached to the tmux session. */
  attached: boolean;
  rig?: string;
  pool?: string;
  agent_kind?: 'pool' | 'role' | string;
  /** Process-running state independent of session.state (which is gc-level). */
  running?: boolean;
  model?: string;
  context_pct?: number;
  context_window?: number;
  /** Coarse activity hint: 'idle' | 'thinking' | 'tool_use' | ... */
  activity?: string;
  provider?: string;
  /** Most recent ISO of a delivered nudge — useful for diagnosing why an agent hasn't responded. */
  last_nudge_delivered_at?: IsoTimestamp;
  /** Bead the agent is currently working on (per `gc supervisor` heuristic). */
  active_bead?: BeadId;
}

export type GcSessionState =
  | 'creating'
  | 'active'
  | 'asleep'
  | 'detached'
  | 'failed'
  | 'closed'
  | string;

export interface GcSessionList {
  items: GcSession[];
}

/**
 * One turn in a session's transcript. Architect th-1i30ih addendum
 * (td-wisp-ijk7g) confirmed peek is an HTTP API endpoint with structured
 * turns — NOT shell-exec — via GET /v0/city/{name}/session/{id}/transcript.
 *
 * `role` strings vary by provider; the renderer treats unknown values as
 * "other" and falls through to a neutral pill. `text` is LLM-generated
 * content; server-side strips ANSI/OSC/control chars before it reaches
 * the browser per the XSS posture in SECURITY.md.
 */
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | string;
  text: string;
}

export interface TranscriptResult {
  session_id: SessionId;
  template?: string;
  provider?: string;
  format?: 'conversation' | string;
  turns: TranscriptTurn[];
  /** Total characters across all turns after sanitisation. */
  total_chars: number;
  /** ISO timestamp of when the snapshot was taken. */
  captured_at: IsoTimestamp;
  /** True if any individual turn was truncated at the per-turn cap. */
  truncated: boolean;
}

// ── Beads ─────────────────────────────────────────────────────────────────

export type BeadStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'closed'
  | 'deferred'
  | string;

export type BeadIssueType =
  | 'feature'
  | 'bug'
  | 'task'
  | 'docs'
  | 'session'
  | 'message'
  | 'convoy'
  | string;

export interface GcBead {
  id: BeadId;
  title: string;
  status: BeadStatus;
  issue_type: BeadIssueType;
  priority: number;
  description?: string;
  owner?: string;
  assignee?: string;
  created_at: IsoTimestamp;
  updated_at?: IsoTimestamp;
  closed_at?: IsoTimestamp;
  labels?: string[];
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  metadata?: Record<string, unknown>;
  /**
   * Supervisor's HTTP /beads returns dependencies as a list of edge
   * stubs ({issue_id, depends_on_id, type}). The bd CLI returns the
   * richer per-dep bead-object form (see BeadDependency in this file
   * for that shape). Both surfaces are typed loosely as unknown[]
   * here because GcBead is the lowest-common-denominator wire shape
   * and the two surfaces don't agree — narrow at the consumer
   * (BeadDetailRaw uses BeadDependency[]; admin.ts:kanban casts
   * to {depends_on_id}-style stubs).
   */
  dependencies?: unknown[];
}

export interface GcBeadList {
  items: GcBead[];
  /** gc supervisor's own total count for the requested scope (independent of the fetch limit). */
  total?: number;
}

/** Frontend-side filter contract. v0 hardcodes; ?showAll=1 disables. */
export interface BeadFilterParams {
  showAll?: boolean;
}

// ── Server-side beads list query (cd-d68p) ───────────────────────────────
//
// At 2000+ beads, pulling all then sorting/filtering in the browser drops
// items outside the fetch window. The /api/beads endpoint accepts these
// params so the WHERE/ORDER BY/LIMIT happens at the source. Cursor is an
// opaque token the server controls — clients pass it back unchanged for
// forward/backward navigation.

export type BeadSortKey = 'id' | 'priority' | 'created_at' | 'updated_at' | 'status';
export type BeadSortOrder = 'asc' | 'desc';

export interface ListBeadsParams {
  sort?: BeadSortKey;
  order?: BeadSortOrder;
  label?: string;
  status?: 'open' | 'in_progress' | 'blocked' | 'closed';
  type?: string;
  cursor?: string;
  limit?: number;
  showAll?: boolean;
}

export interface ListBeadsResponse {
  items: GcBead[];
  /**
   * Best-effort total count matching the filters. For the default
   * engineering view this is the SUM of the four type-filtered totals
   * (feature+bug+task+docs); for a passthrough query this is the
   * supervisor's own total.
   */
  total: number;
  next_cursor: string | null;
  prev_cursor: string | null;
  page_size: number;
  sort: BeadSortKey;
  order: BeadSortOrder;
  /** Which materialisation path served this response. */
  view: 'engineering' | 'passthrough';
  /**
   * True iff this is an engineering view AND any per-type supervisor
   * query in the fan-out hit ENGINEERING_PER_TYPE_LIMIT (1000). Items
   * may be missing from the view; clients should surface this to the
   * user and offer the passthrough / showAll path as an escape hatch.
   * Always false for passthrough (supervisor's total is authoritative).
   */
  view_capped: boolean;
}

export type BeadAction = 'claim' | 'close' | 'nudge';

export interface BeadActionRequest {
  /** Optional reason / note attached to the action. */
  reason?: string;
}

// ── Mail (Phase B but type-locked now so Phase A frontend compiles) ──────

export interface GcMailItem {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  created_at: IsoTimestamp;
  read: boolean;
  thread_id?: string;
  rig?: string;
}

export interface GcMailList {
  items: GcMailItem[];
  total?: number;
}

/** Frontend "viewing as" context state. Default identity is Charlie ('charlie'). */
export interface ViewingAs {
  alias: string;
  /** True iff alias === 'charlie' (the sole identity that can send). */
  isCharlie: boolean;
}

/**
 * Compose payload — the SINGLE wire shape the mail-send router accepts.
 * Architect (security_researcher td-wisp-eb0pn) explicit: no `from` field;
 * server hardcodes the Charlie identity. Frontend cannot trick the server
 * into sending as someone else because there's no slot in the shape.
 */
export interface MailComposeRequest {
  to: string;
  subject: string;
  body: string;
}

export interface MailSendResult {
  ok: true;
  message_id?: string;
}

// ── Activity view: commits + builds (Phase C) ─────────────────────────────

/** One of the hardcoded git log "views". The backend enum is the auth boundary — strings outside this set are rejected. */
export type GitView = 'recent-main' | 'recent-all' | 'today' | 'this-week';

export interface GitCommit {
  sha: string;
  short_sha: string;
  author: string;
  /**
   * Commit date (committer date, %cI in git log). Was author date pre-
   * cd-q9cu; switched to commit date so the displayed timestamp matches
   * git log's default sort order (recent-commits panel appeared
   * unsorted when rebased commits' author dates predated their
   * committer dates). Captures rebases, cherry-picks, amend.
   */
  date: IsoTimestamp;
  subject: string;
  /** Optional refs/branches that point at this commit, e.g. "HEAD -> main". */
  refs?: string;
}

export interface GitCommitList {
  view: GitView;
  items: GitCommit[];
}

export type DeployStatus = 'ok' | 'failed' | 'in-progress' | 'unknown';

export interface DeployRecord {
  at: IsoTimestamp;
  status: DeployStatus;
  /** "old-sha -> new-sha" when status=ok, "stage: X" when failed, raw line otherwise. */
  detail: string;
}

export interface DeployList {
  items: DeployRecord[];
  /** Path the backend parsed; null when the file isn't present. */
  source: string | null;
  /** True if .dev-deploy-FAILED marker is currently present. */
  failed_marker: boolean;
}

// ── Health view (Phase C) ─────────────────────────────────────────────────

export interface SystemHealth {
  /** Backend process state — totally local to the admin dashboard's node process. */
  admin: {
    pid: number;
    uptime_sec: number;
    rss_bytes: number;
    heap_used_bytes: number;
    node_version: string;
  };
  /** Machine-level state from Node's os module. */
  host: {
    load_avg_1: number;
    load_avg_5: number;
    load_avg_15: number;
    total_mem_bytes: number;
    free_mem_bytes: number;
    /** Number of logical CPUs. */
    cpu_count: number;
    uptime_sec: number;
  };
  /** gc supervisor's own /v0/health response, when reachable. */
  supervisor: SupervisorHealth | null;
}

export interface SupervisorHealth {
  status: string;
  version: string;
  city: string;
  uptime_sec: number;
}

export interface DoltNomsSample {
  ts: IsoTimestamp;
  bytes: number;
}

export interface DoltNomsTrend {
  /** Up to 144 samples (24 h at 10-min cadence). */
  samples: DoltNomsSample[];
  /** Null when the metric source isn't wired yet (mechanic surgical-ask td-ulgrt6). */
  source: string | null;
  available: boolean;
}

// ── Events (SSE; Phase C wires; type-locked early) ──────────────────────

export interface GcEvent {
  seq: number;
  type: string;
  ts: IsoTimestamp;
  actor?: string;
  subject?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface GcEventList {
  items: GcEvent[];
  /** Cursor to pass back as ?after=<cursor> to resume. */
  next?: number;
}

// ── Kanban view (td-wyr6ly) ───────────────────────────────────────────────

/**
 * Ordered list of Kanban columns. Order is the rendering order on
 * screen (left to right). Strawman per td-wyr6ly + Charlie directive;
 * blocked-real/blocked-stale distinction is computed client-of-the-classifier
 * side using open-bead-id set membership of each blocked bead's deps.
 */
export type KanbanColumn =
  | 'mayor_plate'
  | 'in_flight'
  | 'stalled'
  | 'blocked_real'
  | 'blocked_stale'
  | 'in_review'
  | 'needs_changes'
  | 'approved'
  | 'closed_24h';

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  'mayor_plate',
  'in_flight',
  'stalled',
  'blocked_real',
  'blocked_stale',
  'in_review',
  'needs_changes',
  'approved',
  'closed_24h',
];

/**
 * Card shape — just the fields the Kanban card needs to render, so the
 * payload is tight even with hundreds of beads. The card links to
 * /beads/:id (td-384rhs drill-in) on click.
 */
export interface KanbanCard {
  id: BeadId;
  /** Truncated server-side so the wire stays small. */
  title: string;
  /** Bead's assignee field as-is (empty string if missing). Used as text only. */
  assignee: string;
  /** ISO of the most-recent activity signal on the bead OR its
   *  bound session — populated whichever surface drove the classification. */
  last_active: IsoTimestamp | null;
  /** Number of open dependencies, for the badge. */
  open_blocker_count: number;
  priority: number;
}

/**
 * Response for /api/admin/kanban — columns keyed by name, cards inside.
 * `as_of` is the snapshot time (drives stale-data UX).
 */
export interface KanbanResponse {
  as_of: IsoTimestamp;
  /** Column → cards, in the order suggested for display per column (newest first). */
  columns: Record<KanbanColumn, KanbanCard[]>;
  /** Total eng beads visible to the classifier (sum of all columns). */
  total: number;
}

// ── Bead drill-in (td-384rhs) ─────────────────────────────────────────────

/**
 * One dependency edge as the bead-show CLI returns it. Verified at
 * impl time: `gc bd show <id> --json` emits dependencies as a list of
 * FULL bead objects (with description/design/notes etc.) annotated
 * with a `dependency_type` field. The drill-in only uses the title /
 * status to render a depth-1 link; other fields are pass-through and
 * not part of the type contract.
 */
export interface BeadDependency {
  /** The other bead's id (this is the dependee, not the source). */
  id: BeadId;
  title?: string;
  status?: BeadStatus;
  /** "blocks" | "related" | future kinds. */
  dependency_type?: string;
}

/**
 * Full bead record as returned by `gc bd show --json` — strictly richer
 * than the supervisor's HTTP /v0/city/{name}/bead/{id} response
 * (supervisor omits design/notes/closed_at/updated_at/owner). The
 * dashboard's /api/beads/:id reads from the CLI to surface the missing
 * fields.
 */
export interface BeadDetailRaw extends GcBead {
  /** Architect's design notes, markdown. */
  design?: string;
  /** Free-form notes, often appended over time. Markdown. */
  notes?: string;
  /** When the bead was closed (refinery sets on merge). */
  closed_at?: IsoTimestamp;
  /** ISO of most-recent claim/state-transition. */
  started_at?: IsoTimestamp;
  /** Filer / responsible party (often != assignee). */
  owner?: string;
  /** Who originally filed the bead. */
  created_by?: string;
  /** Why the bead was closed (refinery sets `merged to <sha>`, etc.). */
  close_reason?: string;
  dependencies?: BeadDependency[];
}

/**
 * Response shape for /api/beads/:id — the raw bead record plus
 * server-side-rendered safe HTML for the three markdown fields.
 * Frontend renders rendered_* via dangerouslySetInnerHTML; raw_* is
 * available for "view source" or future export.
 */
export interface BeadDetailResponse {
  bead: BeadDetailRaw;
  /** HTML rendered from bead.description (markdown). Empty when missing. */
  description_html: string;
  /** HTML rendered from bead.design (markdown). Empty when missing. */
  design_html: string;
  /** HTML rendered from bead.notes (markdown). Empty when missing. */
  notes_html: string;
}

// ── Cockpit view (td-a40qsy) ──────────────────────────────────────────────

/**
 * Bucketed bead-closure throughput. Buckets are oldest-first; each
 * `count` is the number of beads whose `closed_at` falls in
 * [bucket_start, bucket_start + 1h). The last bucket may be partial when
 * `as_of` lands mid-hour.
 */
export interface ThroughputTrend {
  /** ISO of when this was computed; basis for "stale" UX. */
  as_of: IsoTimestamp;
  /** Window in hours (typically 6). */
  window_hours: number;
  buckets: Array<{
    /** Start of the hour bucket, ISO (UTC, top-of-hour). */
    start: IsoTimestamp;
    count: number;
  }>;
}

/**
 * Snapshot of how many beads currently sit at each pipeline stage.
 * Stage names come from the city's label/status conventions:
 *   - needs-arch          : architect needs to look
 *   - needs-impl          : any needs-impl:* label (lumped)
 *   - needs-review        : reviewer queue
 *   - needs-changes       : back to implementer
 *   - in_progress         : claimed and being worked
 *   - blocked             : explicitly blocked
 *   - other_open          : anything else still open
 *
 * Counts apply the engineering-only spam filter (issue_type in
 * {feature,bug,task,docs}, no `gc:` labels) so the numbers match what
 * Charlie sees on the Beads view.
 */
export interface PipelineStageCounts {
  as_of: IsoTimestamp;
  stages: {
    needs_arch: number;
    needs_impl: number;
    needs_review: number;
    needs_changes: number;
    in_progress: number;
    blocked: number;
    other_open: number;
  };
  /** Total of all stages above (= open eng beads). */
  total_open: number;
}

/**
 * The set of destructive city-level actions exposed by /api/admin/*.
 * Names map 1:1 to the route paths.
 */
export type AdminAction =
  | 'pause-polecats'
  | 'resume-polecats'
  | 'stop-city'
  | 'restart-city';

export interface AdminActionResult {
  ok: true;
  /** The gc command that was run, joined by spaces. For confirmation in UI. */
  command: string;
  /** stdout slice (capped). Surfacing to UI so Charlie can confirm the effect. */
  stdout: string;
  /** Optional stderr slice when the command emitted any. */
  stderr?: string;
  /** Wall-clock ms the command took. */
  duration_ms: number;
}

// ── Admin-dashboard internal API responses ───────────────────────────────

/** Wrapped error returned by the backend on any 4xx/5xx. */
export interface ApiError {
  error: string;
  /** Optional machine-readable kind (e.g. "validation", "not_found"). */
  kind?: string;
  /** Optional details object — never leaks raw stderr to the browser. */
  details?: Record<string, string>;
}

/** Audit row written to .gc/events.jsonl on every privileged action. */
export interface AdminAuditEvent {
  type: 'dashboard.exec' | 'dashboard.fetch' | 'dashboard.send_mail' | string;
  endpoint: string;
  actor: 'charlie';
  /** Identity the parent was viewing AS at the time. NEVER affects sender. */
  viewing_as?: string;
  parsed_args?: Record<string, string>;
  exit_code?: number;
  duration_ms?: number;
  ts: IsoTimestamp;
}
