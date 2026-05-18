import fs from 'node:fs/promises';
import type { AdminAuditEvent } from 'thriva-admin-shared';

// Audit log writer. Appends one JSON-per-line entry to .gc/events.jsonl —
// the same durable channel gc uses, which survives dolt-hq corruption
// (per architect's design). Single writer, single file; we tolerate
// concurrent appends because fs.appendFile is atomic-at-line for
// reasonable sizes on POSIX.

let logPath = '/home/charlie/thriva-dev/.gc/events.jsonl';

export function setAuditLogPath(p: string): void {
  logPath = p;
}

export async function recordAudit(
  event: Omit<AdminAuditEvent, 'ts' | 'actor'> & Partial<Pick<AdminAuditEvent, 'actor'>>,
): Promise<void> {
  const row: AdminAuditEvent = {
    actor: 'charlie',
    ts: new Date().toISOString(),
    ...event,
  };
  try {
    await fs.appendFile(logPath, JSON.stringify(row) + '\n', 'utf-8');
  } catch (err) {
    // Audit-log write failures are operationally important but should
    // never crash the request path. Surface via stderr only.
    console.error(`[admin-audit] write failed: ${(err as Error).message}`);
  }
}
