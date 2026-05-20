import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GcMailItem, GcSession, ListMailResponse, MailBox } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';
import { useViewingAs } from '../contexts/ViewingAsContext';
import { usePageTitle } from '../hooks/usePageTitle';

const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

// cd-5cxk: per-bead "design with the convention that 'All mail' is
// power-user / opt-in, not the default landing view." → page lands on
// Inbox unless ?box=all is in the URL.
const ALLOWED_BOXES: ReadonlySet<MailBox> = new Set(['inbox', 'sent', 'all']);

function parseBox(raw: string | null): MailBox {
  return raw && ALLOWED_BOXES.has(raw as MailBox) ? (raw as MailBox) : 'inbox';
}

export function MailPage() {
  usePageTitle('Mail');
  const { viewingAs, setAlias, resetToOwner } = useViewingAs();

  // cd-5cxk: filter + pagination state hydrated from URL. Filter changes
  // and pagination clicks rewrite the URL (replace, no history clutter)
  // so the All-mail view is shareable + survives reload. Box change is
  // also URL-driven.
  const [searchParams, setSearchParams] = useSearchParams();
  const box = parseBox(searchParams.get('box'));
  const fromFilter = searchParams.get('from') ?? '';
  const toFilter = searchParams.get('to') ?? '';
  const subjectFilter = searchParams.get('subject') ?? '';
  const afterFilter = searchParams.get('after') ?? '';
  const beforeFilter = searchParams.get('before') ?? '';
  const cursor = searchParams.get('cursor');

  const [data, setData] = useState<ListMailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentOptions, setAgentOptions] = useState<string[]>([viewingAs.ownerAlias]);

  const [threadFor, setThreadFor] = useState<GcMailItem | null>(null);
  const [threadItems, setThreadItems] = useState<GcMailItem[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [composing, setComposing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listMail({
        box,
        alias: box === 'all' ? undefined : viewingAs.alias,
        from: fromFilter || undefined,
        to: toFilter || undefined,
        subject: subjectFilter || undefined,
        after: afterFilter || undefined,
        before: beforeFilter || undefined,
        cursor: cursor ?? undefined,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [box, viewingAs.alias, fromFilter, toFilter, subjectFilter, afterFilter, beforeFilter, cursor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull the agent list from /api/sessions once so the identity dropdown
  // shows real aliases rather than a free-form input.
  useEffect(() => {
    void (async () => {
      try {
        const { items: sessions } = await api.listSessions();
        const aliases = new Set<string>([viewingAs.ownerAlias]);
        for (const s of sessions as GcSession[]) {
          if (s.alias && /^[a-z][a-z0-9_./-]{1,63}$/i.test(s.alias)) {
            aliases.add(s.alias);
          }
        }
        setAgentOptions(Array.from(aliases).sort());
      } catch {
        /* fall back to the single owner-alias option already set */
      }
    })();
  }, [viewingAs.ownerAlias]);

  const openThread = useCallback(
    async (mail: GcMailItem) => {
      setThreadFor(mail);
      setThreadItems([]);
      if (!mail.thread_id) return;
      setThreadLoading(true);
      try {
        // cd-5cxk: alias-less thread lookup in 'all' mode — backend
        // skips the owner-alias bridge and filters by thread_id only.
        const data = await api.getThread(mail.thread_id, box === 'all' ? undefined : viewingAs.alias);
        setThreadItems(data.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'thread failed');
      } finally {
        setThreadLoading(false);
      }
    },
    [box, viewingAs.alias],
  );

  // cd-5cxk: URL helpers — mutate a single search param while preserving
  // the rest, except that any filter / box change resets the cursor
  // (the offset is sort-and-filter dependent).
  const setUrlParam = useCallback((key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
        next.delete('cursor');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const goToCursor = useCallback((c: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (c === null) next.delete('cursor');
        else next.set('cursor', c);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const clearAllFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        // Preserve box; drop the rest (filters + cursor).
        const b = next.get('box');
        const fresh = new URLSearchParams();
        if (b) fresh.set('box', b);
        return fresh;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const hasActiveFilters =
    fromFilter.length > 0
    || toFilter.length > 0
    || subjectFilter.length > 0
    || afterFilter.length > 0
    || beforeFilter.length > 0;

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.page_size ?? 50;
  const upstreamCapped = data?.upstream_capped ?? false;

  // cd-5cxk: in 'all' mode we want From AND To columns visible because
  // both vary. In box=inbox the recipient is always the viewing alias,
  // so From is the interesting column. In box=sent the sender is fixed.
  const columns = useMemo<ReadonlyArray<TableColumn<GcMailItem>>>(() => {
    const out: TableColumn<GcMailItem>[] = [];
    if (box !== 'sent') {
      out.push({
        key: 'from',
        label: 'From',
        sortable: true,
        sortValue: (r) => r.from,
        render: (r) => <span className="text-ink-100 text-xs">{r.from}</span>,
        className: 'w-40',
      });
    }
    if (box === 'all' || box === 'sent') {
      out.push({
        key: 'to',
        label: 'To',
        sortable: true,
        sortValue: (r) => r.to,
        render: (r) => <span className="text-ink-100 text-xs">{r.to}</span>,
        className: 'w-40',
      });
    }
    out.push({
      key: 'subject',
      label: 'Subject',
      sortable: true,
      sortValue: (r) => r.subject,
      render: (r) => (
        <div className="min-w-0">
          <p className={`truncate ${r.read ? 'text-ink-200' : 'text-ink-100 font-medium'}`}>
            {r.subject}
          </p>
          <p className="text-[11px] text-ink-300 truncate">
            {r.body.split('\n')[0] ?? ''}
          </p>
        </div>
      ),
    });
    out.push({
      key: 'created_at',
      label: 'When',
      sortable: true,
      sortValue: (r) => r.created_at,
      render: (r) => (
        <span className="text-xs text-ink-200 tabular-nums">
          {formatRelative(r.created_at)}
        </span>
      ),
      className: 'w-24',
    });
    return out;
  }, [box]);

  const emptyMessage = box === 'all'
    ? (hasActiveFilters ? 'No mail matches the active filters' : 'No mail in the city store')
    : `${box === 'inbox' ? 'Inbox' : 'Sent'} is empty for ${viewingAs.alias}`;

  return (
    <section className="space-y-3">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-sans font-semibold text-ink-100">Mail</h1>
            <p className="text-xs text-ink-300">
              {box === 'all' ? (
                'All city mail across every sender/recipient. Power-user view.'
              ) : (
                <>Read any agent's inbox. Sends always go out as <code className="font-sans">{viewingAs.ownerAlias}</code>.</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {error && <span className="text-xs text-error-500">{error}</span>}
            <Button
              tone="accent"
              size="sm"
              onClick={() => setComposing(true)}
              disabled={!viewingAs.isOwner}
              title={
                viewingAs.isOwner
                  ? `Compose a new message (sends as ${viewingAs.ownerAlias})`
                  : `Switch back to ${viewingAs.ownerAlias} to compose`
              }
            >
              Compose
            </Button>
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>

        {/* cd-5cxk: the viewing-as switcher only meaningfully filters
            inbox + sent (which key off the alias). In 'all' mode it's
            inert — hide it to reduce visual noise + signal that the
            view ignores identity. */}
        {box !== 'all' && (
          <IdentitySwitcher
            options={agentOptions}
            value={viewingAs.alias}
            onChange={setAlias}
            onReset={resetToOwner}
            isOwner={viewingAs.isOwner}
            ownerAlias={viewingAs.ownerAlias}
          />
        )}

        <div className="flex items-center gap-1 text-xs">
          <BoxTab active={box === 'inbox'} onClick={() => setUrlParam('box', null)} label="Inbox" />
          <BoxTab active={box === 'sent'} onClick={() => setUrlParam('box', 'sent')} label="Sent" />
          <BoxTab active={box === 'all'} onClick={() => setUrlParam('box', 'all')} label="All mail" />
        </div>

        {box === 'all' && (
          <MailFilterBar
            from={fromFilter}
            to={toFilter}
            subject={subjectFilter}
            after={afterFilter}
            before={beforeFilter}
            onChange={setUrlParam}
            onClear={clearAllFilters}
            active={hasActiveFilters}
            total={total}
          />
        )}

        {upstreamCapped && (
          <div className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-1.5 text-xs text-warn-500">
            Upstream cap hit ({total} matched within the latest ~1000 mail items).
            Older mail outside that window is not represented; tighten the
            <code className="font-sans"> after</code> filter to advance the window.
          </div>
        )}
      </header>

      <div className="panel">
        {/* td-liky3d: default newest-first. Backend already sorts the same
            way; this is the belt that survives any future API order change. */}
        <Table
          columns={columns}
          rows={items}
          rowKey={(r) => r.id}
          onRowClick={(r) => void openThread(r)}
          empty={emptyMessage}
          initialSort={{ key: 'created_at', dir: 'desc' }}
        />
      </div>

      <MailPagination
        prevCursor={data?.prev_cursor ?? null}
        nextCursor={data?.next_cursor ?? null}
        onPage={goToCursor}
        pageSize={pageSize}
        total={total}
        disabled={loading}
      />

      <Modal
        open={threadFor !== null}
        onClose={() => setThreadFor(null)}
        title={threadFor?.subject ?? 'Thread'}
        caption={
          box === 'all'
            ? `all mail · ${threadItems.length} message(s)`
            : `viewing as ${viewingAs.alias} · ${threadItems.length} message(s)`
        }
        widthClass="max-w-3xl"
      >
        {threadLoading ? (
          <p className="text-ink-300 italic text-sm">Loading thread…</p>
        ) : threadItems.length === 0 && threadFor ? (
          <ThreadMessage message={threadFor} />
        ) : (
          <ol className="space-y-3">
            {threadItems.map((m) => (
              <li key={m.id}>
                <ThreadMessage message={m} />
              </li>
            ))}
          </ol>
        )}
      </Modal>

      <ComposeModal
        open={composing}
        onClose={() => setComposing(false)}
        onSent={() => {
          setComposing(false);
          if (box === 'sent') void refresh();
        }}
      />
    </section>
  );
}

// cd-5cxk: filter input row for the All-mail view. Each field updates
// the URL on change (with cursor reset). 'after' / 'before' are
// type="date" inputs that produce YYYY-MM-DD strings — backend ISO_RE
// accepts both date-only and full instants.
function MailFilterBar({
  from, to, subject, after, before,
  onChange, onClear, active, total,
}: {
  from: string;
  to: string;
  subject: string;
  after: string;
  before: string;
  onChange: (key: string, value: string | null) => void;
  onClear: () => void;
  active: boolean;
  total: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <FilterInput label="From" value={from} onChange={(v) => onChange('from', v)} placeholder="sender substring" />
        <FilterInput label="To" value={to} onChange={(v) => onChange('to', v)} placeholder="recipient substring" />
        <FilterInput label="Subject" value={subject} onChange={(v) => onChange('subject', v)} placeholder="subject substring" />
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">After</span>
          <input
            type="date"
            value={after}
            onChange={(e) => onChange('after', e.target.value || null)}
            className="bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs text-ink-100 focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-300">Before</span>
          <input
            type="date"
            value={before}
            onChange={(e) => onChange('before', e.target.value || null)}
            className="bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs text-ink-100 focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </label>
      </div>
      {active && (
        <div className="rounded-md border border-accent-700/40 bg-accent-700/10 px-3 py-1.5 text-xs text-accent-500 flex items-center justify-between gap-3">
          <span>Filtering · {total} message{total === 1 ? '' : 's'} match</span>
          <button
            type="button"
            onClick={onClear}
            className="underline decoration-dotted hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
          >
            clear all
          </button>
        </div>
      )}
    </div>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string | null) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-ink-300">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder={placeholder}
        maxLength={128}
        className="bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent-500 w-44"
      />
    </label>
  );
}

function MailPagination({
  prevCursor,
  nextCursor,
  onPage,
  pageSize,
  total,
  disabled,
}: {
  prevCursor: string | null;
  nextCursor: string | null;
  onPage: (cursor: string | null) => void;
  pageSize: number;
  total: number;
  disabled: boolean;
}) {
  if (prevCursor === null && nextCursor === null && total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-ink-300">
      <span>
        Page size {pageSize} · {total} total
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          tone="ghost"
          disabled={prevCursor === null || disabled}
          onClick={() => onPage(prevCursor)}
        >
          ← Prev
        </Button>
        <Button
          size="sm"
          tone="ghost"
          disabled={nextCursor === null || disabled}
          onClick={() => onPage(nextCursor)}
        >
          Next →
        </Button>
      </div>
    </div>
  );
}

function IdentitySwitcher({
  options,
  value,
  onChange,
  onReset,
  isOwner,
  ownerAlias,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  onReset: () => void;
  isOwner: boolean;
  ownerAlias: string;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 flex items-center gap-3 flex-wrap text-xs ${
        isOwner
          ? 'border-ink-600 bg-ink-800/60 text-ink-300'
          : 'border-warn-500/40 bg-warn-500/10 text-warn-500'
      }`}
    >
      <span className="uppercase tracking-wider font-semibold">
        {isOwner ? 'viewing as' : '⚠ viewing as'}
      </span>
      <label className="flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs text-ink-100 focus:outline-none focus:ring-2 focus:ring-accent-500"
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
      {!isOwner && (
        <button
          type="button"
          onClick={onReset}
          className="underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn-500 rounded-sm"
        >
          back to {ownerAlias}
        </button>
      )}
      {!isOwner && (
        <span className="ml-auto text-[11px] italic">
          read-only · sends are always from {ownerAlias}
        </span>
      )}
    </div>
  );
}

function BoxTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-md transition-colors ${
        active
          ? 'bg-ink-700 text-ink-100'
          : 'text-ink-300 hover:bg-ink-700/60 hover:text-ink-100'
      }`}
    >
      {label}
    </button>
  );
}

function ThreadMessage({ message }: { message: GcMailItem }) {
  return (
    <article className="rounded-md border border-ink-700 bg-ink-900/60 overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-3 py-1 border-b border-ink-700 bg-ink-800/60">
        <div className="text-[11px] text-ink-300 truncate">
          <span className="text-ink-100 font-medium">{message.from}</span>
          <span className="mx-1 text-ink-300">→</span>
          <span>{message.to}</span>
        </div>
        <span className="text-[10px] text-ink-300 tabular-nums">
          {formatAbsolute(message.created_at)}
        </span>
      </header>
      <p className="px-3 py-2 text-xs text-ink-200">
        <span className="text-ink-300">Subject: </span>
        <span className="text-ink-100">{message.subject}</span>
      </p>
      <p className="px-3 py-1 text-[11px] text-warn-500 bg-warn-500/10 border-t border-warn-500/30">
        {PROMPT_INJECTION_NOTICE}
      </p>
      <pre className="px-3 py-2 text-xs font-sans whitespace-pre-wrap leading-relaxed text-ink-100 overflow-x-auto">
        {message.body}
      </pre>
    </article>
  );
}

function ComposeModal({
  open,
  onClose,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const { viewingAs } = useViewingAs();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTo('');
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open]);

  const onSend = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      await api.sendMail({ to, subject, body });
      onSent();
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'send failed';
      setError(msg);
    } finally {
      setSending(false);
    }
  }, [body, onSent, subject, to]);

  const canSend = viewingAs.isOwner && to.length > 0 && subject.length > 0 && body.length > 0 && !sending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New message"
      caption={`Sends as ${viewingAs.ownerAlias} — viewing-as has no effect on the sender`}
      widthClass="max-w-2xl"
      footer={
        <>
          <Button tone="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" size="sm" disabled={!canSend} onClick={() => void onSend()}>
            {sending ? 'Sending…' : `Send as ${viewingAs.ownerAlias}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-ink-200">
          From
          <input
            type="text"
            value={viewingAs.isOwner ? viewingAs.ownerAlias : `${viewingAs.ownerAlias} (viewing-as does not change sender)`}
            disabled
            className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm font-sans text-ink-300 italic"
          />
        </label>
        <label className="block text-xs text-ink-200">
          To <span className="text-ink-300">(alias)</span>
          <input
            type="text"
            autoFocus
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="mayor, mechanic, agent-name, <rig>/<agent>"
            className="mt-1 w-full bg-ink-900 border border-ink-600 rounded-md px-2 py-1.5 text-sm font-sans text-ink-100 focus:border-accent-700 focus:outline-none focus:ring-2 focus:ring-accent-700/30"
          />
        </label>
        <label className="block text-xs text-ink-200">
          Subject
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            className="mt-1 w-full bg-ink-900 border border-ink-600 rounded-md px-2 py-1.5 text-sm font-body text-ink-100 focus:border-accent-700 focus:outline-none focus:ring-2 focus:ring-accent-700/30"
          />
        </label>
        <label className="block text-xs text-ink-200">
          Body
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            maxLength={16 * 1024}
            className="mt-1 w-full bg-ink-900 border border-ink-600 rounded-md px-2 py-1.5 text-sm font-body text-ink-100 focus:border-accent-700 focus:outline-none focus:ring-2 focus:ring-accent-700/30 resize-y"
          />
        </label>
        {!viewingAs.isOwner && (
          <p className="text-xs text-warn-500 bg-warn-500/10 border border-warn-500/30 rounded-md px-2 py-1">
            You're viewing-as <code className="font-sans">{viewingAs.alias}</code>. Switch back to <code className="font-sans">{viewingAs.ownerAlias}</code> to compose; sends from this modal are structurally locked to <code className="font-sans">{viewingAs.ownerAlias}</code> regardless.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-error-500 bg-error-500/10 border border-error-500/30 rounded-md px-2 py-1">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1_000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h`;
  return `${Math.round(diffSec / 86_400)}d`;
}

function formatAbsolute(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
