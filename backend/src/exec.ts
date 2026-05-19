import { spawn } from 'node:child_process';

// Whitelisted-only shell-exec wrapper. Every privileged invocation in the
// app routes through this — there is intentionally no general-purpose
// exec helper exported elsewhere.
//
// Per security_researcher td-wisp-eb0pn:
//   - ENUM whitelist of allowed commands.
//   - shell:false (non-negotiable).
//   - Clean env — no inherited PATH/HOME/LANG.
//   - Timeout (10-30s) + output cap (100KB).
//   - Concurrency cap (semaphore).
//   - Bead-id / agent-alias param schemas enforced.

const MAX_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT = 4;

// Param schemas — every privileged exec validates its args against these.
// SESSION_ID_RE lives in routes/sessions.ts now that peek is HTTP, not exec.
const BEAD_ID_RE = /^(td|th|jt)-[a-z0-9-]{3,32}$/;
const AGENT_ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;

function cleanEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '/home/charlie';
  // PATH explicitly includes ~/.local/bin because that's where `gc` lives
  // on Charlie's machine. Override via THRIVA_ADMIN_PATH env if a future
  // install moves it.
  const path =
    process.env.THRIVA_ADMIN_PATH ?? `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
  return {
    PATH: path,
    HOME: home,
    LANG: 'C.UTF-8',
  };
}

let runningCount = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (runningCount < MAX_CONCURRENT) {
        runningCount += 1;
        resolve();
      } else {
        waiting.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseSlot(): void {
  runningCount -= 1;
  const next = waiting.shift();
  if (next) next();
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export class ExecError extends Error {
  constructor(message: string, public readonly kind: 'validation' | 'timeout' | 'spawn') {
    super(message);
    this.name = 'ExecError';
  }
}

function runExec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const child = spawn(cmd, args, {
      shell: false,
      timeout: timeoutMs,
      env: cleanEnv(),
      // Cut off stdin so the child can't block on prompts.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_BYTES) {
        const remaining = Math.max(0, MAX_BYTES - stdout.length);
        stdout += chunk.toString('utf-8', 0, remaining);
        truncated = true;
        child.kill('SIGTERM');
      } else {
        stdout += chunk.toString('utf-8');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length <= MAX_BYTES) {
        stderr += chunk.toString('utf-8');
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs + 500);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new ExecError(`spawn failed: ${err.message}`, 'spawn'));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ExecError(`exec timed out after ${timeoutMs}ms`, 'timeout'));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - start,
      });
    });
  });
}

// Strip ANSI / OSC / control chars from peek output. Per
// security_researcher's regex spec. Server-side strip happens BEFORE the
// content reaches the browser; ansi_up on the client only ever sees
// safe SGR sequences (or none).
const CSI_NON_SGR_RE = /\x1b\[[?0-9;]*[a-ln-zA-LN-Z]/g; // CSI but excluding 'm' (SGR)
const OSC_RE = /\x1b\][^\x07]*\x07/g;
// Control chars except \t, \n; everything < 0x20 except those two.
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

function sanitiseTerminalOutput(raw: string): string {
  return raw
    .replace(OSC_RE, '')
    .replace(CSI_NON_SGR_RE, '')
    .replace(CTRL_RE, '');
}

// ── Public exec wrappers — each one is a named, whitelisted call. ──────
//
// Note: peek used to be a shell-exec wrapper here. Architect addendum
// td-wisp-ijk7g (mechanic td-wisp-e1v14) confirmed peek is served by
// `gc supervisor`'s HTTP API as a structured transcript — see
// `routes/sessions.ts` + `gc-client.ts::fetchTranscript`. The SESSION_ID_RE
// + sanitiseTerminalOutput pair stays here for use by that path.

export async function execBeadAction(
  beadId: string,
  action: 'claim' | 'close' | 'nudge',
  reason?: string,
): Promise<ExecResult> {
  if (!BEAD_ID_RE.test(beadId)) {
    throw new ExecError('invalid bead id', 'validation');
  }
  const args: string[] = ['bd'];
  if (action === 'claim') {
    args.push('update', beadId, '--status=in_progress', '--assignee=charlie');
  } else if (action === 'close') {
    args.push('close', beadId);
    if (typeof reason === 'string' && reason.length > 0 && reason.length <= 1024) {
      args.push('--reason', reason);
    }
  } else if (action === 'nudge') {
    if (!AGENT_ALIAS_RE.test(beadId)) {
      // 'nudge' is on agent alias, not bead. We thread it through this
      // function for parity — but require alias format here.
      throw new ExecError('nudge requires agent alias, not bead id', 'validation');
    }
    args.push('nudge', beadId);
  }
  await acquireSlot();
  try {
    return await runExec('gc', args, 15_000);
  } finally {
    releaseSlot();
  }
}

export async function execAgentNudge(alias: string): Promise<ExecResult> {
  if (!AGENT_ALIAS_RE.test(alias)) {
    throw new ExecError('invalid agent alias', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec('gc', ['agents', 'nudge', alias], 10_000);
  } finally {
    releaseSlot();
  }
}

// PHYSICAL SEPARATION (security_researcher td-wisp-eb0pn): mail-send is its
// OWN wrapper, deliberately with NO `from` / `as` parameter in its
// signature. The --from human pin is the SECOND belt — even if some
// future caller tries to add a `from` arg, the function refuses it because
// it isn't a parameter at all.
//
// `human` is gc's canonical wire identity for Charlie. The audit log
// separately records `actor=charlie` (see audit.ts) — that's the
// dashboard's internal accounting, distinct from gc's wire-level sender.
export async function execMailSend(
  to: string,
  subject: string,
  body: string,
): Promise<ExecResult> {
  if (!AGENT_ALIAS_RE.test(to)) {
    throw new ExecError('invalid recipient alias', 'validation');
  }
  if (subject.length === 0 || subject.length > 200) {
    throw new ExecError('subject must be 1–200 chars', 'validation');
  }
  if (body.length === 0 || body.length > 16 * 1024) {
    throw new ExecError('body too short or too long', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gc',
      ['mail', 'send', to, '--from', 'human', '-s', subject, '-m', body],
      10_000,
    );
  } finally {
    releaseSlot();
  }
}

// Hardcoded enum of `git log` invocations. Each view's args live entirely
// in this file — Charlie cannot pass arbitrary git arguments to the
// server. The caller can only pick a view *name* (validated upstream).
// td-7t24i6 scope expansion: git log views previously capped at -n 50 in
// recent-main / recent-all, same undercount risk. Recent-main bumped to
// 200 (matches main's typical commit frequency * ~2 weeks); recent-all
// bumped to 200 too. The since= variants are time-windowed, not count-
// windowed, so no explicit cap needed — git's default for those is fine.
const GIT_LOG_VIEWS: Record<string, string[]> = {
  'recent-main': [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '-n',
    '200',
    'origin/main',
  ],
  'recent-all': [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '-n',
    '200',
    '--branches',
    '--remotes',
  ],
  today: [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '--since=24.hours.ago',
    '--branches',
    '--remotes',
  ],
  'this-week': [
    'log',
    '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%D%x09%s',
    '--since=7.days.ago',
    '--branches',
    '--remotes',
  ],
};

const GIT_REPO_PATH = process.env.THRIVA_ADMIN_GIT_REPO ?? '/home/charlie/thriva';

export async function execGitLog(view: string): Promise<ExecResult> {
  const args = GIT_LOG_VIEWS[view];
  if (!args) {
    throw new ExecError('unknown git view', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec('git', ['-C', GIT_REPO_PATH, ...args], 10_000);
  } finally {
    releaseSlot();
  }
}

// ── Cockpit destructive admin actions (td-a40qsy) ──────────────────────
//
// Each city-level action is its own named wrapper with NO arbitrary args.
// Defense-in-depth on the supervisor-auth concern in th-s1sqq: even if
// some future regression breaks Origin/CSRF/host checks upstream, this
// enum + the AGENT_NAME_RE below is the floor — no caller can shape a
// `gc agent suspend <attacker-chosen-name>` from this surface.
//
// AGENT_NAME_RE is intentionally stricter than AGENT_ALIAS_RE: the four
// city-level actions only ever touch named agents in city.toml; there
// is no rig/path syntax to permit.
const ADMIN_AGENT_NAME_RE = /^[a-z][a-z0-9_-]{1,32}$/;

// Hardcoded enum of agent names eligible for suspend/resume from the
// cockpit. v0: only "polecat" — Charlie's filed list of "common knobs"
// names polecats (the worker pool). To expand the list later, add the
// name here AND surface a button in the frontend. There is intentionally
// no dynamic list-of-agents-from-config path — that's how arbitrary
// suspend/resume creeps in.
const COCKPIT_SUSPEND_AGENTS: ReadonlyArray<string> = ['polecat'];

function isCockpitSuspendAgent(name: string): boolean {
  if (!ADMIN_AGENT_NAME_RE.test(name)) return false;
  return COCKPIT_SUSPEND_AGENTS.includes(name);
}

/** Maps to `gc agent suspend <name>`. */
export async function execAgentSuspend(name: string): Promise<ExecResult> {
  if (!isCockpitSuspendAgent(name)) {
    throw new ExecError('agent not in cockpit suspend allowlist', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec('gc', ['agent', 'suspend', name], 10_000);
  } finally {
    releaseSlot();
  }
}

/** Maps to `gc agent resume <name>`. */
export async function execAgentResume(name: string): Promise<ExecResult> {
  if (!isCockpitSuspendAgent(name)) {
    throw new ExecError('agent not in cockpit suspend allowlist', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec('gc', ['agent', 'resume', name], 10_000);
  } finally {
    releaseSlot();
  }
}

/**
 * `gc stop` — graceful shutdown of all agent sessions in the city.
 * Pass --timeout=30s to bound wall-clock so the HTTP request doesn't
 * hang on a slow agent shutdown. The 30s is a backstop; gc honours its
 * own internal grace timers underneath that.
 */
export async function execCityStop(): Promise<ExecResult> {
  await acquireSlot();
  try {
    // exec timeout slightly above the gc --timeout to give gc a chance
    // to surface its own "force-killed N orphans" summary before we cap.
    return await runExec('gc', ['stop', '--timeout=30s'], 35_000);
  } finally {
    releaseSlot();
  }
}

/**
 * `gc restart` — equivalent to stop + start. Same timeout reasoning as
 * execCityStop; restart has start latency on top so we cap a bit
 * higher.
 */
export async function execCityRestart(): Promise<ExecResult> {
  await acquireSlot();
  try {
    return await runExec('gc', ['restart'], 60_000);
  } finally {
    releaseSlot();
  }
}

/**
 * `gc bd list --status=closed --closed-after=<iso> --json` — used by the
 * cockpit throughput trend. The supervisor's HTTP /beads endpoint omits
 * `closed_at` on closed beads (and `updated_at` too), so the bd CLI is
 * the only source of closure timestamps. The `--closed-after` server-side
 * filter is critical: a no-window query returns hundreds of KB and the
 * 100KB MAX_BYTES cap in runExec terminates the process with no exit
 * code. With a 6-hour window the output is typically <50 beads (~30KB).
 *
 * `cityPath` is the absolute path to the city root (--city=<name> is
 * interpreted as a relative path, not a registered-city lookup).
 *
 * `closedAfter` is an ISO-8601 instant (e.g. "2026-05-19T10:00:00Z").
 */
export async function execBdListClosed(
  cityPath: string,
  closedAfter: string,
  limit: number,
): Promise<ExecResult> {
  // Defensive: cityPath comes from server config, but treat as untrusted
  // anyway — block ../ and ensure it's absolute. exec.ts is the choke
  // point; centralising the check here makes any future caller safe.
  if (!cityPath.startsWith('/') || cityPath.includes('..')) {
    throw new ExecError('invalid city path', 'validation');
  }
  // closedAfter is rendered from server `new Date().toISOString()` and not
  // user input today, but defend the boundary anyway — the regex matches
  // an ISO instant and nothing else, so no shell or flag injection slips
  // in even if the source ever changes.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(closedAfter)) {
    throw new ExecError('invalid closed-after timestamp', 'validation');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new ExecError('invalid limit', 'validation');
  }
  await acquireSlot();
  try {
    // --exclude-label=order-tracking AND --exclude-type=session,message,convoy:
    // both pre-filter system noise upstream so the JSON output fits well
    // within runExec's MAX_BYTES cap. Without the type-exclusion, session
    // beads (~3-5KB each, hundreds per 6h window) blow past 100KB long
    // before any limit takes effect. The JS-side isEngBead filter in
    // routes/admin.ts:computeThroughput still applies the final pass —
    // these excludes are a bandwidth saver, not the source of truth.
    return await runExec(
      'gc',
      [
        'bd',
        'list',
        `--city=${cityPath}`,
        '--status=closed',
        `--closed-after=${closedAfter}`,
        '--exclude-label=order-tracking',
        '--exclude-type=session,message,convoy',
        `--limit=${limit}`,
        '--json',
      ],
      15_000,
    );
  } finally {
    releaseSlot();
  }
}

/**
 * `gc session nudge <alias> <message>` — deliver text to a running
 * session. Used by cockpit "Nudge mayor" + future per-agent drill-in.
 * Wait-idle delivery is the default (gc waits for the agent's next
 * interactive boundary before sending) — this is the right semantic for
 * a "go check your queue" nudge and avoids interrupting mid-tool-use.
 */
export async function execSessionNudge(
  alias: string,
  message: string,
): Promise<ExecResult> {
  if (!AGENT_ALIAS_RE.test(alias)) {
    throw new ExecError('invalid session alias', 'validation');
  }
  if (message.length === 0 || message.length > 1024) {
    throw new ExecError('message must be 1–1024 chars', 'validation');
  }
  await acquireSlot();
  try {
    return await runExec(
      'gc',
      ['session', 'nudge', alias, message],
      10_000,
    );
  } finally {
    releaseSlot();
  }
}

export { sanitiseTerminalOutput };
