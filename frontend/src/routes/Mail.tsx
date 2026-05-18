import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GcMailItem, GcSession } from 'citadel-shared';
import { api, ApiClientError } from '../api/client';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Table, type TableColumn } from '../components/Table';
import { useViewingAs, CHARLIE_ALIAS } from '../contexts/ViewingAsContext';

const PROMPT_INJECTION_NOTICE =
  'Content is agent-generated and may contain misleading instructions.';

type MailBox = 'inbox' | 'sent';

export function MailPage() {
  const { viewingAs, setAlias, resetToCharlie } = useViewingAs();
  const [box, setBox] = useState<MailBox>('inbox');
  const [items, setItems] = useState<GcMailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentOptions, setAgentOptions] = useState<string[]>([CHARLIE_ALIAS]);

  const [threadFor, setThreadFor] = useState<GcMailItem | null>(null);
  const [threadItems, setThreadItems] = useState<GcMailItem[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [composing, setComposing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listMail(box, viewingAs.alias);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [box, viewingAs.alias]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull the agent list from /api/sessions once so the identity dropdown
  // shows real aliases rather than a free-form input.
  useEffect(() => {
    void (async () => {
      try {
        const { items: sessions } = await api.listSessions();
        const aliases = new Set<string>([CHARLIE_ALIAS]);
        for (const s of sessions as GcSession[]) {
          if (s.alias && /^[a-z][a-z0-9_./-]{1,63}$/i.test(s.alias)) {
            aliases.add(s.alias);
          }
        }
        setAgentOptions(Array.from(aliases).sort());
      } catch {
        /* fall back to the single charlie option already set */
      }
    })();
  }, []);

  const openThread = useCallback(
    async (mail: GcMailItem) => {
      setThreadFor(mail);
      setThreadItems([]);
      if (!mail.thread_id) return;
      setThreadLoading(true);
      try {
        const data = await api.getThread(mail.thread_id, viewingAs.alias);
        setThreadItems(data.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'thread failed');
      } finally {
        setThreadLoading(false);
      }
    },
    [viewingAs.alias],
  );

  const columns = useMemo<ReadonlyArray<TableColumn<GcMailItem>>>(() => [
    {
      key: 'from',
      label: 'From',
      sortable: true,
      sortValue: (r) => r.from,
      render: (r) => (
        <span className="text-ink-100 text-xs">{r.from}</span>
      ),
      className: 'w-40',
    },
    {
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
    },
    {
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
    },
  ], []);

  return (
    <section className="space-y-3">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-sans font-semibold text-ink-100">Mail</h1>
            <p className="text-xs text-ink-300">
              Read any agent's inbox. Sends always go out as Charlie.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {error && <span className="text-xs text-error-500">{error}</span>}
            <Button
              tone="accent"
              size="sm"
              onClick={() => setComposing(true)}
              disabled={!viewingAs.isCharlie}
              title={
                viewingAs.isCharlie
                  ? 'Compose a new message (sends as Charlie)'
                  : 'Switch back to Charlie to compose'
              }
            >
              Compose
            </Button>
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>

        <IdentitySwitcher
          options={agentOptions}
          value={viewingAs.alias}
          onChange={setAlias}
          onReset={resetToCharlie}
          isCharlie={viewingAs.isCharlie}
        />

        <div className="flex items-center gap-1 text-xs">
          <BoxTab active={box === 'inbox'} onClick={() => setBox('inbox')} label="Inbox" />
          <BoxTab active={box === 'sent'} onClick={() => setBox('sent')} label="Sent" />
        </div>
      </header>

      <div className="panel">
        {/* td-liky3d: default newest-first. Backend already sorts the same
            way; this is the belt that survives any future API order change. */}
        <Table
          columns={columns}
          rows={items}
          rowKey={(r) => r.id}
          onRowClick={(r) => void openThread(r)}
          empty={`${box === 'inbox' ? 'Inbox' : 'Sent'} is empty for ${viewingAs.alias}`}
          initialSort={{ key: 'created_at', dir: 'desc' }}
        />
      </div>

      <Modal
        open={threadFor !== null}
        onClose={() => setThreadFor(null)}
        title={threadFor?.subject ?? 'Thread'}
        caption={`viewing as ${viewingAs.alias} · ${threadItems.length} message(s)`}
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

function IdentitySwitcher({
  options,
  value,
  onChange,
  onReset,
  isCharlie,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  onReset: () => void;
  isCharlie: boolean;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 flex items-center gap-3 flex-wrap text-xs ${
        isCharlie
          ? 'border-ink-600 bg-ink-800/60 text-ink-300'
          : 'border-warn-500/40 bg-warn-500/10 text-warn-500'
      }`}
    >
      <span className="uppercase tracking-wider font-semibold">
        {isCharlie ? 'viewing as' : '⚠ viewing as'}
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
      {!isCharlie && (
        <button
          type="button"
          onClick={onReset}
          className="underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn-500 rounded-sm"
        >
          back to charlie
        </button>
      )}
      {!isCharlie && (
        <span className="ml-auto text-[11px] italic">
          read-only · sends are always from charlie
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

  const canSend = viewingAs.isCharlie && to.length > 0 && subject.length > 0 && body.length > 0 && !sending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New message"
      caption="Sends as charlie — viewing-as has no effect on the sender"
      widthClass="max-w-2xl"
      footer={
        <>
          <Button tone="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" size="sm" disabled={!canSend} onClick={() => void onSend()}>
            {sending ? 'Sending…' : 'Send as charlie'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-xs text-ink-200">
          From
          <input
            type="text"
            value={viewingAs.isCharlie ? 'charlie' : 'charlie (viewing-as does not change sender)'}
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
            placeholder="mayor, mechanic, thriva/devpipeline.architect, …"
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
        {!viewingAs.isCharlie && (
          <p className="text-xs text-warn-500 bg-warn-500/10 border border-warn-500/30 rounded-md px-2 py-1">
            You're viewing-as <code className="font-sans">{viewingAs.alias}</code>. Switch back to Charlie to compose; sends from this modal are structurally locked to Charlie regardless.
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
