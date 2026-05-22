import { useEffect, useState } from 'react';

// Single source of truth for the small bootstrap config the frontend
// needs from the backend: the city name (for display). The event stream
// is reached via the same-origin /api/events/stream proxy (cd-16a94), so
// no supervisor URL is surfaced here any more. Cached after first fetch
// so a page with many consumers makes one request.

export interface AppConfig {
  city: string;
}

let cached: AppConfig | null = null;
let inFlight: Promise<AppConfig> | null = null;

export function loadAppConfig(): Promise<AppConfig> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = fetch('/api/config/gc-supervisor', { credentials: 'same-origin' })
    .then((r) => {
      // Fail loud — a 4xx/5xx body shaped like {error:'…'} would otherwise
      // coerce undefined fields into the cached AppConfig via String(undefined)
      // ('undefined' literal), and that wrong value persists for the page
      // lifetime. Consumers (useAppConfig) can surface the error state instead.
      if (!r.ok) throw new Error(`appConfig fetch failed: ${r.status}`);
      return r.json();
    })
    .then((j) => {
      const cfg: AppConfig = {
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
