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
}

export interface GcBeadList {
  items: GcBead[];
}

/** Frontend-side filter contract. v0 hardcodes; ?showAll=1 disables. */
export interface BeadFilterParams {
  showAll?: boolean;
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
