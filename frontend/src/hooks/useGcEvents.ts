import { useEffect, useRef, useState } from 'react';
import { loadAppConfig } from '../api/appConfig';

// Direct EventSource against gc supervisor's /v0/city/{name}/events/stream.
// Architect addendum td-wisp-ijk7g + mechanic td-wisp-e1v14: gc supervisor
// serves real SSE on this path and its CORS is permissive (echoes Origin,
// allows all verbs, supports Last-Event-ID). No backend cursor-poll
// wrapper needed.
//
// CSP connect-src already includes the supervisor URL (see security
// middleware). The browser opens the stream directly.

export type GcEventConnState = 'connecting' | 'open' | 'closed';

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

  // cd-tle7m: coalesce event-driven refetches. A busy city emits many
  // bead.*/session.* events per second; firing onMatch per-event made
  // consumers (e.g. the Kanban) refetch /beads ungated (~1/sec), which both
  // hammered the supervisor's city-store read AND amplified its partial-read
  // flicker (td- beads vanish/reappear). Throttle to at most one onMatch per
  // COALESCE_MS (leading + trailing): a burst yields one refetch now and one
  // after it settles, never a per-event storm.
  const lastFireRef = useRef(0);
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEventId: string | null = null;
    let retryDelayMs = 1_000;

    const COALESCE_MS = 2_500;
    const fireMatch = () => {
      lastFireRef.current = Date.now();
      onMatchRef.current();
    };
    // Leading + trailing throttle: fire immediately when outside the window,
    // otherwise schedule a single trailing fire at the window edge. Coalesces
    // a burst of matching events into <=1 onMatch per COALESCE_MS.
    const scheduleMatch = () => {
      const elapsed = Date.now() - lastFireRef.current;
      if (elapsed >= COALESCE_MS) {
        if (coalesceTimerRef.current) {
          clearTimeout(coalesceTimerRef.current);
          coalesceTimerRef.current = null;
        }
        fireMatch();
      } else if (coalesceTimerRef.current === null) {
        coalesceTimerRef.current = setTimeout(() => {
          coalesceTimerRef.current = null;
          if (!cancelled) fireMatch();
        }, COALESCE_MS - elapsed);
      }
    };

    const connect = async () => {
      try {
        const cfg = await loadAppConfig();
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
        // td-tlo122: the supervisor emits frames with a named event field
        // (`event: event`) per WHATWG SSE — those dispatch to
        // addEventListener('event', …), NOT to onmessage (which only sees
        // unnamed / 'message'-named frames). Bind both so the hook
        // survives the current convention AND a future switch to
        // unnamed frames without code change.
        const handleSseFrame = (msg: MessageEvent<string>) => {
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
              scheduleMatch();
              break;
            }
          }
        };
        es.addEventListener('event', handleSseFrame);
        es.addEventListener('message', handleSseFrame);
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
      if (coalesceTimerRef.current) {
        clearTimeout(coalesceTimerRef.current);
        coalesceTimerRef.current = null;
      }
      es?.close();
    };
    // We re-bind only when the prefix set changes — onMatch is captured in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefixKey]);

  return state;
}
