// Single place for env-driven knobs. Anything new goes here so SECURITY.md
// can audit the configurable surface.

export interface AdminConfig {
  /** Listener port. Default 8081, side-by-side with gc dashboard at 8080. */
  port: number;
  /** Bind host. Default 127.0.0.1; override via HOST env for headless-VM workflows (e.g. HOST=0.0.0.0). */
  bindHost: string;
  /**
   * Extra hostnames allowed in the Host: header allow-list, on top of the
   * always-present floor ['127.0.0.1','localhost']. CSV via ADMIN_EXTRA_ALLOWED_HOSTS.
   * Used when bindHost=0.0.0.0 and clients reach the dashboard by LAN name/IP.
   */
  extraAllowedHosts: ReadonlyArray<string>;
  /** gc supervisor base URL (no trailing slash). */
  gcSupervisorUrl: string;
  /** Name of the city this admin dashboard manages. */
  cityName: string;
  /** Path to .gc/events.jsonl for audit-log append. */
  auditLogPath: string;
  /**
   * Root directory of the beads' Dolt store. The Health view's 24h
   * sparkline samples this tree's total file size every 10 minutes
   * (per-rig subdirs sum to the city's full bd footprint). Set to
   * empty string to disable the sampler (size feature degrades to the
   * existing "metric source not yet wired" empty-state UX).
   */
  doltNomsRoot: string;
  /** Path to the dist/ of the frontend build, served by express.static. */
  frontendDistPath: string;
  /** Kill-switch: set to '1' to refuse to start. */
  disabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const portRaw = env.PORT ?? '8081';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }
  const extraAllowedHosts = (env.ADMIN_EXTRA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return {
    port,
    bindHost: env.HOST ?? '127.0.0.1',
    extraAllowedHosts,
    gcSupervisorUrl: (env.GC_SUPERVISOR_URL ?? 'http://127.0.0.1:8372').replace(/\/+$/, ''),
    cityName: env.GC_CITY_NAME ?? 'thriva-dev',
    auditLogPath:
      env.ADMIN_AUDIT_LOG_PATH ?? '/home/charlie/thriva-dev/.gc/events.jsonl',
    // Default reflects gc's bd-store layout: <city>/.beads/dolt/<rig>/...
    // Per-rig subdirs roll up to the city's full dolt footprint when the
    // walker sums all file sizes under this root.
    doltNomsRoot:
      env.ADMIN_DOLT_NOMS_ROOT ?? '/home/charlie/thriva-dev/.beads/dolt',
    frontendDistPath: env.ADMIN_FRONTEND_DIST ?? '../frontend/dist',
    disabled: env.THRIVA_ADMIN_DASHBOARD_DISABLED === '1',
  };
}
