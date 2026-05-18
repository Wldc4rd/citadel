import { useEffect, useRef, useState } from 'react';

// Direct EventSource against gc supervisor's /v0/city/{name}/events/stream.
// Architect addendum td-wisp-ijk7g + mechanic td-wisp-e1v14: gc supervisor
// serves real SSE on this path and its CORS is permissive (echoes Origin,
// allows all verbs, supports Last-Event-ID). No backend cursor-poll
// wrapper needed.
//
// CSP connect-src already includes the supervisor URL (see security
// middleware). The browser opens the stream directly.

export type GcEventConnState = 'connecting' | 'open' | 'closed';

interface GcEventConfig {
  /** URL is fetched once from /api/config/gc-supervisor; cached after. */
  supervisorUrl: string;
  city: string;
}

let cachedConfig: GcEventConfig | null = null;
let configPromise: Promise<GcEventConfig> | null = null;

async function loadConfig(): Promise<GcEventConfig> {
  if (cachedConfig) return cachedConfig;
  if (!configPromise) {
    configPromise = fetch('/api/config/gc-supervisor', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => {
        const cfg: GcEventConfig = {
          supervisorUrl: String(j.supervisor_url),
          city: String(j.city),
        };
        cachedConfig = cfg;
        return cfg;
      });
  }
  return configPromise;
}

/**
 * Subscribe to gc events. When an event whose type starts with any of
 * `prefixes` arrives, `onMatch` is invoked. Designed for "refresh this
 * panel when its underlying data changed" — pass refresh().
 */
export function useGcEventRefresh(
  prefixes: ReadonlyArray<string>,
  onMatch: () => void,
): GcEventConnState {
  const [state, setState] = useState<GcEventConnState>('connecting');
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  // Stable hash of prefixes for the effect dep array.
  const prefixKey = prefixes.join(',');

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEventId: string | null = null;
    let retryDelayMs = 1_000;

    const connect = async () => {
      try {
        const cfg = await loadConfig();
        if (cancelled) return;
        // The supervisor's stream path lives under /v0/city/{name}/events/stream.
        const u = new URL(
          `${cfg.supervisorUrl}/v0/city/${encodeURIComponent(cfg.city)}/events/stream`,
        );
        if (lastEventId) u.searchParams.set('after', lastEventId);
        es = new EventSource(u, { withCredentials: false });
        setState('connecting');
        es.onopen = () => {
          if (cancelled) return;
          setState('open');
          retryDelayMs = 1_000;
        };
        es.onmessage = (msg: MessageEvent<string>) => {
          if (cancelled) return;
          if (msg.lastEventId) lastEventId = msg.lastEventId;
          let parsed: { type?: string } | null = null;
          try {
            parsed = JSON.parse(msg.data) as { type?: string };
          } catch {
            return;
          }
          const t = parsed?.type;
          if (typeof t !== 'string') return;
          for (const prefix of prefixes) {
            if (t.startsWith(prefix)) {
              onMatchRef.current();
              break;
            }
          }
        };
        es.onerror = () => {
          if (cancelled) return;
          setState('closed');
          es?.close();
          es = null;
          // Exponential backoff capped at 30s.
          retryTimer = setTimeout(() => {
            retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
            void connect();
          }, retryDelayMs);
        };
      } catch {
        if (cancelled) return;
        setState('closed');
        retryTimer = setTimeout(() => {
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
          void connect();
        }, retryDelayMs);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
    // We re-bind only when the prefix set changes — onMatch is captured in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefixKey]);

  return state;
}
