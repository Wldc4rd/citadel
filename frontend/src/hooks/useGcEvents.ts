import { useEffect, useRef, useState } from 'react';

// EventSource against the dashboard's own same-origin SSE proxy at
// /api/events/stream. The backend pipes the gc supervisor's real SSE
// stream over loopback (see backend/src/routes/events.ts).
//
// cd-16a94: this used to open EventSource cross-origin straight at the
// supervisor (:8372). But the supervisor's CORS only echoes
// Access-Control-Allow-Origin for loopback page origins, so when the
// dashboard was reached over the LAN (http://thriva-dev:8081) the browser
// CORS-blocked every connection and the indicator flapped forever, never
// 'open'. Going through the same-origin proxy removes the cross-origin
// problem entirely — connect-src 'self' covers it.

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

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEventId: string | null = null;
    let retryDelayMs = 1_000;

    const connect = () => {
      try {
        // Same-origin proxy path. We drive reconnection ourselves (close +
        // re-create with backoff below), so the browser's automatic
        // Last-Event-ID header won't carry across; pass the resume cursor
        // explicitly as ?after=. The backend honours both.
        const u = `/api/events/stream${
          lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : ''
        }`;
        es = new EventSource(u);
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
              onMatchRef.current();
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
            connect();
          }, retryDelayMs);
        };
      } catch {
        if (cancelled) return;
        setState('closed');
        retryTimer = setTimeout(() => {
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
          connect();
        }, retryDelayMs);
      }
    };

    connect();

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
