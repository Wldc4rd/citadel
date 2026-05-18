// Single place for env-driven knobs. Anything new goes here so SECURITY.md
// can audit the configurable surface.

export interface AdminConfig {
  /** Listener port. Default 8081, side-by-side with gc dashboard at 8080. */
  port: number;
  /** Bind host. 127.0.0.1 only (DNS-rebinding defense). */
  bindHost: '127.0.0.1';
  /** gc supervisor base URL (no trailing slash). */
  gcSupervisorUrl: string;
  /** Name of the city this admin dashboard manages. */
  cityName: string;
  /** Path to .gc/events.jsonl for audit-log append. */
  auditLogPath: string;
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
  return {
    port,
    bindHost: '127.0.0.1',
    gcSupervisorUrl: (env.GC_SUPERVISOR_URL ?? 'http://127.0.0.1:8372').replace(/\/+$/, ''),
    cityName: env.GC_CITY_NAME ?? 'thriva-dev',
    auditLogPath:
      env.ADMIN_AUDIT_LOG_PATH ?? '/home/charlie/thriva-dev/.gc/events.jsonl',
    frontendDistPath: env.ADMIN_FRONTEND_DIST ?? '../frontend/dist',
    disabled: env.THRIVA_ADMIN_DASHBOARD_DISABLED === '1',
  };
}
