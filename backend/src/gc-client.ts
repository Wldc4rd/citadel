import type {
  GcSessionList,
  GcBeadList,
  GcMailList,
  GcEventList,
  TranscriptTurn,
} from 'thriva-admin-shared';

interface GcTranscriptResponse {
  id?: string;
  template?: string;
  provider?: string;
  format?: string;
  turns?: TranscriptTurn[];
}

// Typed client for the gc supervisor HTTP API. All reads of supervisor
// state go through here; no other module fetches from supervisor
// directly. That keeps the wire-shape boundary in ONE place.

export interface GcClientOptions {
  baseUrl: string;
  cityName: string;
}

export class GcClient {
  constructor(private readonly opts: GcClientOptions) {}

  /** Base URL of the gc supervisor (no trailing slash). Used for non-city endpoints (e.g. /v0/health) + frontend CSP connect-src. */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** City name this client is scoped to. */
  get cityName(): string {
    return this.opts.cityName;
  }

  private cityPath(suffix: string): string {
    const url = `${this.opts.baseUrl}/v0/city/${encodeURIComponent(this.opts.cityName)}${suffix}`;
    return url;
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(url, {
      signal,
      // gc supervisor is a localhost service; no cross-origin headers needed.
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`gc supervisor returned ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  }

  async listSessions(signal?: AbortSignal): Promise<GcSessionList> {
    return this.getJson<GcSessionList>(this.cityPath('/sessions'), signal);
  }

  async listBeads(signal?: AbortSignal): Promise<GcBeadList> {
    return this.getJson<GcBeadList>(this.cityPath('/beads'), signal);
  }

  async listMail(
    signal?: AbortSignal,
    params?: { box?: 'inbox' | 'sent'; alias?: string; limit?: number },
  ): Promise<GcMailList> {
    // NOTE: per td-h3n2ar diagnosis, gc supervisor's `box` + `alias`
    // params are silently ignored upstream. We still pass them in case a
    // future supervisor version starts honoring them — the no-op today is
    // harmless. The actual sender/recipient filter happens in
    // routes/mail.ts::filterByBox.
    const search = new URLSearchParams();
    if (params?.box) search.set('box', params.box);
    if (params?.alias) search.set('alias', params.alias);
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    const path = `/mail${qs.length > 0 ? `?${qs}` : ''}`;
    return this.getJson<GcMailList>(this.cityPath(path), signal);
  }

  async listEvents(signal?: AbortSignal, after?: number): Promise<GcEventList> {
    const path = `/events${after !== undefined ? `?after=${after}` : ''}`;
    return this.getJson<GcEventList>(this.cityPath(path), signal);
  }

  /**
   * Architect addendum (td-wisp-ijk7g + mechanic td-wisp-e1v14): peek is an
   * HTTP endpoint, not shell-exec. Returns structured turns.
   */
  async fetchTranscript(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GcTranscriptResponse> {
    return this.getJson<GcTranscriptResponse>(
      this.cityPath(`/session/${encodeURIComponent(sessionId)}/transcript`),
      signal,
    );
  }
}
