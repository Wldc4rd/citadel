import fs from 'node:fs/promises';
import type { AdminAuditEvent } from 'citadel-shared';

// Audit log writer. Appends one JSON-per-line entry to .gc/events.jsonl —
// the same durable channel gc uses, which survives dolt-hq corruption
// (per architect's design). Single writer, single file; we tolerate
// concurrent appends because fs.appendFile is atomic-at-line for
// reasonable sizes on POSIX.

let logPath = '/home/charlie/thriva-dev/.gc/events.jsonl';
// 'human' is the safe out-of-the-box default — matches the backend config
// default GC_CITY_OWNER_ALIAS and gc's canonical wire identity. server.ts
// calls setAuditOwnerAlias(config.cityOwnerAlias) at startup; until then
// (or in tests that import recordAudit without going through server.ts),
// audit rows fall back to this floor instead of the historical literal
// 'charlie' which assumed a Charlie deploy.
let ownerAlias = 'human';

export function setAuditLogPath(p: string): void {
  logPath = p;
}

export function setAuditOwnerAlias(alias: string): void {
  ownerAlias = alias;
}

export async function recordAudit(
  event: Omit<AdminAuditEvent, 'ts' | 'actor'> & Partial<Pick<AdminAuditEvent, 'actor'>>,
): Promise<void> {
  const row: AdminAuditEvent = {
    actor: ownerAlias,
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
