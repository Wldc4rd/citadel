import type {
  GcSession,
  GcMailItem,
  TranscriptResult,
  MailComposeRequest,
  MailSendResult,
  GitCommitList,
  GitView,
  DeployList,
  SystemHealth,
  DoltNomsTrend,
  AdminAction,
  AdminActionResult,
  BeadDetailResponse,
  GcBead,
  KanbanResponse,
  PipelineStageCounts,
  ThroughputTrend,
  ListBeadsParams,
  ListBeadsResponse,
  ApiError,
} from 'citadel-shared';

// Typed fetch client for the admin backend's /api/*. Shares types with
// the backend via the workspace 'citadel-shared' import so wire-shape
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
  peekSession(id: string): Promise<TranscriptResult> {
    return request('POST', `/api/sessions/${encodeURIComponent(id)}/peek`, {});
  },
  nudgeSession(id: string, message?: string): Promise<{ ok: true; stdout: string; duration_ms: number }> {
    return request('POST', `/api/sessions/${encodeURIComponent(id)}/nudge`, message ? { message } : {});
  },
  listBeads(params?: ListBeadsParams): Promise<ListBeadsResponse> {
    const qs = new URLSearchParams();
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.order) qs.set('order', params.order);
    if (params?.label) qs.set('label', params.label);
    if (params?.status) qs.set('status', params.status);
    if (params?.type) qs.set('type', params.type);
    if (params?.cursor) qs.set('cursor', params.cursor);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.showAll) qs.set('showAll', '1');
    const s = qs.toString();
    return request('GET', `/api/beads${s.length > 0 ? `?${s}` : ''}`);
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
  beadDetail(id: string): Promise<BeadDetailResponse> {
    return request('GET', `/api/beads/${encodeURIComponent(id)}`);
  },
  listMail(box: 'inbox' | 'sent' | 'all', alias: string): Promise<{ items: GcMailItem[]; total?: number }> {
    const qs = new URLSearchParams({ box, alias }).toString();
    return request('GET', `/api/mail?${qs}`);
  },
  getThread(threadId: string, alias: string): Promise<{ items: GcMailItem[] }> {
    const qs = new URLSearchParams({ alias }).toString();
    return request('GET', `/api/mail/threads/${encodeURIComponent(threadId)}?${qs}`);
  },
  sendMail(payload: MailComposeRequest): Promise<MailSendResult> {
    // The client-side shape mirrors the server's: { to, subject, body }.
    // No `from` field. The architect's physical-separation rule means
    // this fetch hits a different router than reads.
    return request('POST', '/api/mail-send', payload);
  },
  health(): Promise<{ ok: boolean; ts: string }> {
    return request('GET', '/api/health');
  },
  listCommits(view: GitView): Promise<GitCommitList> {
    return request('GET', `/api/git/commits?view=${encodeURIComponent(view)}`);
  },
  listBuilds(): Promise<DeployList> {
    return request('GET', '/api/builds');
  },
  systemHealth(): Promise<SystemHealth> {
    return request('GET', '/api/system/system');
  },
  doltTrend(): Promise<DoltNomsTrend> {
    return request('GET', '/api/dolt-noms/trend');
  },
  // ── Cockpit (td-a40qsy) ────────────────────────────────────────────
  throughputTrend(): Promise<ThroughputTrend> {
    return request('GET', '/api/admin/throughput-trend');
  },
  pipelineStageCounts(): Promise<PipelineStageCounts> {
    return request('GET', '/api/admin/pipeline-stage-counts');
  },
  adminAction(action: AdminAction): Promise<AdminActionResult> {
    return request('POST', `/api/admin/${action}`, {});
  },
  kanban(): Promise<KanbanResponse> {
    return request('GET', '/api/admin/kanban');
  },
  // cd-nim6: Cockpit's recently-closed panel can't lean on /api/beads
  // (supervisor's /v0/beads omits closed_at on closed records). This
  // endpoint shell-execs the bd CLI on a 7-day window with limit 50.
  closedBeads(): Promise<{ items: GcBead[]; total: number }> {
    return request('GET', '/api/admin/closed-beads');
  },
};
