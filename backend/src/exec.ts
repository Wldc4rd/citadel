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
const BEAD_ID_RE = /^(td|th|jt)-[a-z0-9-]{3,32}$/;
const SESSION_ID_RE = /^(td|th)-[a-z0-9]{3,12}$/;
const AGENT_ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;

function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/home/charlie',
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

export async function execSessionPeek(sessionId: string): Promise<ExecResult> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new ExecError(`invalid session id`, 'validation');
  }
  await acquireSlot();
  try {
    const result = await runExec('gc', ['session', 'peek', sessionId], 10_000);
    return {
      ...result,
      stdout: sanitiseTerminalOutput(result.stdout),
    };
  } finally {
    releaseSlot();
  }
}

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

export { sanitiseTerminalOutput };
