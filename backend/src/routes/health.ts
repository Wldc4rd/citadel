import { Router } from 'express';
import os from 'node:os';
import type { SupervisorHealth, SystemHealth } from 'citadel-shared';
import type { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';

export function healthRouter(gc: GcClient): Router {
  const router = Router();

  router.get('/system', async (_req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const supervisor = await fetchSupervisor(gc);
    const payload: SystemHealth = {
      admin: {
        pid: process.pid,
        uptime_sec: Math.round(process.uptime()),
        rss_bytes: mem.rss,
        heap_used_bytes: mem.heapUsed,
        node_version: process.version,
      },
      host: {
        load_avg_1: load[0] ?? 0,
        load_avg_5: load[1] ?? 0,
        load_avg_15: load[2] ?? 0,
        total_mem_bytes: os.totalmem(),
        free_mem_bytes: os.freemem(),
        cpu_count: os.cpus().length,
        uptime_sec: Math.round(os.uptime()),
      },
      supervisor,
    };
    void recordAudit({
      type: 'dashboard.fetch',
      endpoint: 'GET /api/system/health',
      duration_ms: 0,
    });
    res.json(payload);
  });

  return router;
}

async function fetchSupervisor(gc: GcClient): Promise<SupervisorHealth | null> {
  try {
    // gc supervisor's /v0/city/{name}/health endpoint — verified to return
    // {status, version, city, uptime_sec}. Path is under the city scope,
    // not the supervisor root.
    const url = new URL(
      `${gc.baseUrl}/v0/city/${encodeURIComponent(gc.cityName)}/health`,
    );
    const ctl = AbortSignal.timeout(2_500);
    const res = await fetch(url, { signal: ctl, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const json = (await res.json()) as SupervisorHealth;
    return json;
  } catch {
    return null;
  }
}
