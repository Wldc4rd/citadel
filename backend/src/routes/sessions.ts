import { Router } from 'express';
import type { TranscriptResult, TranscriptTurn } from 'citadel-shared';
import type { GcClient } from '../gc-client.js';
import { ExecError, execSessionNudge, sanitiseTerminalOutput } from '../exec.js';
import { recordAudit } from '../audit.js';

const SESSION_ID_RE = /^(td|th)-[a-z0-9]{3,12}$/;
const PER_TURN_CAP = 16 * 1024;
const TOTAL_CAP = 256 * 1024;

// Default nudge message used when the caller omits one. Short + neutral
// — the agent's prompt template knows what "check work" means in
// context. The cockpit's "Nudge mayor" button (td-a40qsy success
// criterion: "One-click 'nudge mayor' works without leaving the page")
// uses this default; future per-agent drill-in UIs can pass a custom
// message.
const DEFAULT_NUDGE_MESSAGE = 'check work';
const MAX_NUDGE_MESSAGE_LEN = 1024;

export function sessionsRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const { items } = await gc.listSessions();
      res.json({ items });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to list sessions', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  // POST /api/sessions/:id/nudge — delivers a text nudge to a running session.
  //
  // Cockpit (td-a40qsy) success criterion: "one-click 'nudge mayor'
  // works without leaving the page." Uses gc session nudge under the
  // hood; wait-idle delivery (gc default) so we don't interrupt
  // mid-tool-use. The message defaults to a short neutral string when
  // omitted by the caller.
  router.post('/:id/nudge', async (req, res) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid session id', kind: 'validation' });
      return;
    }
    const rawMessage = typeof req.body?.message === 'string' ? req.body.message : '';
    const message = rawMessage.length > 0 ? rawMessage : DEFAULT_NUDGE_MESSAGE;
    if (message.length > MAX_NUDGE_MESSAGE_LEN) {
      res.status(400).json({
        error: `message exceeds ${MAX_NUDGE_MESSAGE_LEN} chars`,
        kind: 'validation',
      });
      return;
    }
    const start = Date.now();
    try {
      const result = await execSessionNudge(id, message);
      void recordAudit({
        type: 'dashboard.exec',
        endpoint: 'POST /api/sessions/:id/nudge',
        parsed_args: { session_id: id, message_len: String(message.length) },
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      });
      if (result.exitCode !== 0) {
        res.status(502).json({
          error: `gc session nudge failed with exit ${result.exitCode}`,
          kind: 'upstream',
          details: { stderr: result.stderr.slice(0, 1024) },
        });
        return;
      }
      res.json({ ok: true, stdout: result.stdout.slice(0, 1024), duration_ms: result.durationMs });
    } catch (err) {
      void recordAudit({
        type: 'dashboard.exec',
        endpoint: 'POST /api/sessions/:id/nudge',
        parsed_args: { session_id: id, failed: 'true' },
        duration_ms: Date.now() - start,
      });
      if (err instanceof ExecError) {
        const status = err.kind === 'validation' ? 400 : err.kind === 'timeout' ? 504 : 500;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      res.status(500).json({ error: (err as Error).message, kind: 'internal' });
    }
  });

  // POST /api/sessions/:id/peek — returns the session's transcript.
  //
  // Architect addendum td-wisp-ijk7g (mechanic td-wisp-e1v14): peek is an
  // HTTP endpoint, not a shell-exec. We still POST here (frontend issues
  // a CSRF-protected write to bound the audit log + keep the action
  // explicit) but the backend's work collapses to: fetch from gc, strip
  // dangerous characters, cap size, return.
  router.post('/:id/peek', async (req, res) => {
    const id = req.params.id;
    if (!SESSION_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid session id', kind: 'validation' });
      return;
    }
    const start = Date.now();
    try {
      const raw = await gc.fetchTranscript(id);
      const result = buildTranscriptResult(id, raw.turns ?? [], raw);
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'POST /api/sessions/:id/peek',
        parsed_args: { session_id: id },
        duration_ms: Date.now() - start,
      });
      res.json(result);
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to fetch transcript', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  return router;
}

function buildTranscriptResult(
  sessionId: string,
  rawTurns: TranscriptTurn[],
  raw: { template?: string; provider?: string; format?: string },
): TranscriptResult {
  const turns: TranscriptTurn[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const turn of rawTurns) {
    if (typeof turn?.text !== 'string') continue;
    let cleaned = sanitiseTerminalOutput(turn.text);
    if (cleaned.length > PER_TURN_CAP) {
      cleaned = cleaned.slice(0, PER_TURN_CAP);
      truncated = true;
    }
    if (totalChars + cleaned.length > TOTAL_CAP) {
      const remaining = TOTAL_CAP - totalChars;
      if (remaining > 0) {
        turns.push({ role: turn.role, text: cleaned.slice(0, remaining) });
        totalChars += remaining;
      }
      truncated = true;
      break;
    }
    turns.push({ role: typeof turn.role === 'string' ? turn.role : 'unknown', text: cleaned });
    totalChars += cleaned.length;
  }
  return {
    session_id: sessionId,
    template: raw.template,
    provider: raw.provider,
    format: raw.format,
    turns,
    total_chars: totalChars,
    captured_at: new Date().toISOString(),
    truncated,
  };
}
