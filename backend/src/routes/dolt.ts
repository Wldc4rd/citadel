import { Router } from 'express';
import type { DoltNomsTrend } from 'thriva-admin-shared';
import { recordAudit } from '../audit.js';

// In-memory ring buffer of dolt-noms size samples — 24 h at 10-minute
// cadence = 144 slots. Sampling is wired but the actual metric source
// is pending mechanic surgical-ask (filed as a follow-up bead per
// architect's "don't pull mechanic off th-ks4dw" guard). Once the
// source lands, swap the `sampleDoltNomsSize()` stub for the real
// implementation; the ring buffer + endpoint shape don't change.

const SLOT_COUNT = 144;
const SAMPLE_INTERVAL_MS = 10 * 60 * 1_000;

interface RingSlot {
  ts: string;
  bytes: number;
}

const ring: (RingSlot | null)[] = new Array(SLOT_COUNT).fill(null);
let head = 0;
let metricSource: string | null = null;
let metricAvailable = false;

export function startDoltNomsSampler(): void {
  // Run once at boot, then on the cadence.
  void runSample();
  setInterval(() => {
    void runSample();
  }, SAMPLE_INTERVAL_MS).unref();
}

async function runSample(): Promise<void> {
  try {
    const sample = await sampleDoltNomsSize();
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
 * STUB. Mechanic surgical-ask filed (td-ulgrt6 to come): "expose a
 * dolt-noms metric endpoint or document where to read the disk size."
 * Until that lands this returns null and the endpoint signals
 * available=false with source=null so the UI can render a calm "metric
 * source pending" state instead of fake zeros.
 */
async function sampleDoltNomsSize(): Promise<number | null> {
  return null;
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
