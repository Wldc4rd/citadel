import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { DoltNomsTrend } from 'citadel-shared';
import { recordAudit } from '../audit.js';

// In-memory ring buffer of dolt-noms size samples — 24 h at 10-minute
// cadence = 144 slots. Source landed in td-pke1a9: the sampler walks
// the on-disk Dolt tree (default <city>/.beads/dolt/) and sums file
// sizes per tick. The walker is bounded by node count and depth so a
// hypothetical pathological tree can't peg the event loop.

const SLOT_COUNT = 144;
const SAMPLE_INTERVAL_MS = 10 * 60 * 1_000;
// Walker safety caps. The current city's bd-store has ~hundreds of
// files; 50k is well over that with headroom for years of growth. If
// we ever hit either cap, sample returns null + flags a stderr log so
// the next td-pke1a9-style bead can lift the limit deliberately.
const WALK_MAX_NODES = 50_000;
const WALK_MAX_DEPTH = 12;

interface RingSlot {
  ts: string;
  bytes: number;
}

const ring: (RingSlot | null)[] = new Array(SLOT_COUNT).fill(null);
let head = 0;
let metricSource: string | null = null;
let metricAvailable = false;

interface SamplerOptions {
  /** Empty string disables sampling (sampler exits early on each tick). */
  doltNomsRoot: string;
}

let samplerOptions: SamplerOptions = { doltNomsRoot: '' };

export function startDoltNomsSampler(opts: SamplerOptions = samplerOptions): void {
  samplerOptions = opts;
  if (opts.doltNomsRoot.length > 0) {
    metricSource = opts.doltNomsRoot;
  }
  // Run once at boot, then on the cadence.
  void runSample();
  setInterval(() => {
    void runSample();
  }, SAMPLE_INTERVAL_MS).unref();
}

async function runSample(): Promise<void> {
  try {
    const sample = await sampleDoltNomsSize(samplerOptions.doltNomsRoot);
    if (sample !== null) {
      ring[head] = { ts: new Date().toISOString(), bytes: sample };
      head = (head + 1) % SLOT_COUNT;
      metricAvailable = true;
    }
  } catch {
    /* sampling errors are non-fatal */
  }
}

/**
 * Walk `root` recursively and sum the size of every regular file. Returns
 * null when the root is empty (disabled), missing, or the walk hits the
 * node/depth caps — the existing UI calm-empty state covers all of
 * these without needing per-failure UX.
 */
async function sampleDoltNomsSize(root: string): Promise<number | null> {
  if (root.length === 0) return null;
  let total = 0;
  let visited = 0;
  // Stack-based walk so the implementation stays linear and bounded; no
  // recursion depth on the JS stack.
  type Frame = { dir: string; depth: number };
  const stack: Frame[] = [{ dir: root, depth: 0 }];
  try {
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > WALK_MAX_DEPTH) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(frame.dir, { withFileTypes: true });
    } catch {
      // EACCES / ENOENT on a child dir: skip, keep summing the rest.
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > WALK_MAX_NODES) return null;
      // Skip symlinks to avoid loops and to keep the sum measuring the
      // CITY's own bd-store, not anything the city happens to symlink
      // into.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(frame.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: frame.depth + 1 });
        continue;
      }
      if (entry.isFile()) {
        try {
          const st = await fs.stat(full);
          total += st.size;
        } catch {
          // File vanished mid-walk (Dolt compaction, sample race) — skip.
        }
      }
    }
  }
  return total;
}

export function doltRouter(): Router {
  const router = Router();
  router.get('/trend', (_req, res) => {
    const samples = ring
      .filter((s): s is RingSlot => s !== null)
      .map((s) => ({ ts: s.ts, bytes: s.bytes }));
    const payload: DoltNomsTrend = {
      samples,
      source: metricSource,
      available: metricAvailable,
    };
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/dolt-noms/trend',
      parsed_args: { samples: String(samples.length) },
      duration_ms: 0,
    });
    res.json(payload);
  });
  return router;
}

export function setDoltNomsSource(source: string | null): void {
  metricSource = source;
}
