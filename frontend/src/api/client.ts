import type {
  GcSession,
  GcBead,
  PeekResult,
  ApiError,
} from 'thriva-admin-shared';

// Typed fetch client for the admin backend's /api/*. Shares types with
// the backend via the workspace 'thriva-admin-shared' import so wire-shape
// drift produces compile errors instead of runtime undefined.

const COOKIE_NAME = 'thriva_admin_csrf';

function readCsrfCookie(): string | null {
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  return decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
}

async function request<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: object,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const token = readCsrfCookie();
    if (token) headers['X-CSRF-Token'] = token;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let payload: ApiError | null = null;
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiClientError(res.status, payload?.error ?? res.statusText, payload?.kind);
  }
  return (await res.json()) as T;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly kind?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export const api = {
  listSessions(): Promise<{ items: GcSession[] }> {
    return request('GET', '/api/sessions');
  },
  peekSession(id: string): Promise<PeekResult> {
    return request('POST', `/api/sessions/${encodeURIComponent(id)}/peek`, {});
  },
  listBeads(showAll?: boolean): Promise<{ items: GcBead[]; total: number; returned: number }> {
    const qs = showAll ? '?showAll=1' : '';
    return request('GET', `/api/beads${qs}`);
  },
  claimBead(id: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', `/api/beads/${encodeURIComponent(id)}/claim`, {});
  },
  closeBead(id: string, reason?: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', `/api/beads/${encodeURIComponent(id)}/close`, { reason });
  },
  nudgeBead(id: string): Promise<{ ok: true; stdout: string }> {
    return request('POST', `/api/beads/${encodeURIComponent(id)}/nudge`, {});
  },
  health(): Promise<{ ok: boolean; ts: string }> {
    return request('GET', '/api/health');
  },
};
