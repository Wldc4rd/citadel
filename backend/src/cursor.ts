// Shared opaque-cursor codec used by paginated /api endpoints.
//
// Why extracted rather than duplicated per route: the cursor's wire
// shape (v:1 byte + base64url-encoded JSON {v, o}) is determined by
// HTTP cursor-pagination semantics, not domain-specific. The v:2
// migration to stable (sort_key, id) cursors should touch one file.
// First two consumers: /api/beads (cd-d68p) and /api/mail (cd-5cxk).
//
// Drift on concurrent insert is a documented limitation of offset-
// based cursors — clients that observe duplicate or skipped items
// across pages should refetch from offset 0. v:2 will address that
// at the cost of being unable to jump backwards by N items in one
// page step. v:1's offset semantics are explicit; the version byte
// is the migration seam.

const CURSOR_VERSION = 1;

// Defensive cap matching the inline implementations' prior behavior:
// reject any base64url payload longer than this without parsing.
// Pre-base64 (raw bytes): the JSON {v:1,o:<offset>} is ~20 bytes at
// 6-digit offsets, so 256 is many orders of magnitude above any
// legitimate cursor.
const MAX_CURSOR_LENGTH = 256;

// Defensive cap on offset value: reject any decoded offset that
// would imply a deeply-paginated query the dashboard would never
// issue on purpose. Pre-cd-d68p the dashboard pulled at most ~5000
// beads in the wide window; 1e6 is far above any honest call site.
const MAX_OFFSET = 1_000_000;

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      v?: unknown;
      o?: unknown;
    };
    // Reject unknown cursor versions. Tolerate v=undefined for any
    // residual pre-version-byte cursors still in flight from a paused
    // browser tab (treat as v=1 since that was the only shape).
    if (decoded.v !== undefined && decoded.v !== CURSOR_VERSION) return 0;
    const offset = decoded?.o;
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 && offset < MAX_OFFSET) {
      return offset;
    }
  } catch {
    /* invalid cursors → offset 0 */
  }
  return 0;
}
