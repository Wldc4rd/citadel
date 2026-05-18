import type {
  GcSessionList,
  GcBeadList,
  GcMailList,
  GcEventList,
} from 'thriva-admin-shared';

// Typed client for the gc supervisor HTTP API. All reads of supervisor
// state go through here; no other module fetches from supervisor
// directly. That keeps the wire-shape boundary in ONE place.

export interface GcClientOptions {
  baseUrl: string;
  cityName: string;
}

export class GcClient {
  constructor(private readonly opts: GcClientOptions) {}

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

  async listMail(signal?: AbortSignal, params?: { box?: 'inbox' | 'sent'; alias?: string }): Promise<GcMailList> {
    const search = new URLSearchParams();
    if (params?.box) search.set('box', params.box);
    if (params?.alias) search.set('alias', params.alias);
    const qs = search.toString();
    const path = `/mail${qs.length > 0 ? `?${qs}` : ''}`;
    return this.getJson<GcMailList>(this.cityPath(path), signal);
  }

  async listEvents(signal?: AbortSignal, after?: number): Promise<GcEventList> {
    const path = `/events${after !== undefined ? `?after=${after}` : ''}`;
    return this.getJson<GcEventList>(this.cityPath(path), signal);
  }
}
