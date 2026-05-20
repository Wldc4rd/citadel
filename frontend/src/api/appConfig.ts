import { useEffect, useState } from 'react';

// Single source of truth for the small bootstrap config the frontend
// needs from the backend: the supervisor URL (for direct SSE) and the
// city name (for display + SSE stream path). Cached after first fetch
// so a page with many consumers makes one request.

export interface AppConfig {
  supervisorUrl: string;
  city: string;
}

let cached: AppConfig | null = null;
let inFlight: Promise<AppConfig> | null = null;

export function loadAppConfig(): Promise<AppConfig> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = fetch('/api/config/gc-supervisor', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((j) => {
      const cfg: AppConfig = {
        supervisorUrl: String(j.supervisor_url),
        city: String(j.city),
      };
      cached = cfg;
      return cfg;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useAppConfig(): AppConfig | null {
  const [cfg, setCfg] = useState<AppConfig | null>(cached);
  useEffect(() => {
    if (cfg) return;
    let cancelled = false;
    void loadAppConfig().then((c) => {
      if (!cancelled) setCfg(c);
    });
    return () => {
      cancelled = true;
    };
  }, [cfg]);
  return cfg;
}
