import { Router } from 'express';
import type { GcMailItem, ListMailResponse, MailBox } from 'citadel-shared';
import type { GcClient } from '../gc-client.js';
import { recordAudit } from '../audit.js';
import { decodeCursor, encodeCursor } from '../cursor.js';

// READ-only mail router. The architect (security_researcher td-wisp-eb0pn)
// requires PHYSICAL SEPARATION from the send path — see ./mail-send.ts.
// Anything in this file may read `viewing-as`; nothing in this file sends.

const ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;
const BOX_VALUES = new Set<MailBox>(['inbox', 'sent', 'all']);
// td-7t24i6 scope expansion: gc supervisor's mail endpoint defaults to
// limit=50 and caps at 1000 (verified — limit=2000 returns 1000). 1000 is
// the practical max. For the current corpus (~1167 mails) this covers
// ~86% which is enough for the common alias-filtered case; pagination
// would need a separate v1 design if the corpus grows past 2-3× this.
const FETCH_LIMIT = 1000;
// cd-5cxk: page-size cap for the 'All mail' cursor pagination. Mirrors
// cd-d68p shape on /beads. Default tuned for the typical narrow viewport;
// MAX 200 keeps the response under a few hundred KB even with verbose
// bodies.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Free-text filter inputs validated against a permissive shape — accept
// anything a user might reasonably type, reject control characters +
// excessive length. The supervisor doesn't interpret these (we filter
// server-side here), so injection isn't the concern; bounding length
// is the concern.
const TEXT_FILTER_RE = /^[^\x00-\x1f\x7f]{1,128}$/;
// ISO-8601 instant lower/upper bounds for date range filters.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

interface ParsedListQuery {
  box: MailBox;
  alias: string;
  from: string | undefined;
  to: string | undefined;
  subject: string | undefined;
  after: string | undefined;
  before: string | undefined;
  offset: number;
  limit: number;
}

function parseListQuery(
  query: Record<string, unknown>,
  defaultAlias: string,
): ParsedListQuery | { error: string } {
  const rawAlias = typeof query.alias === 'string' ? query.alias : defaultAlias;
  const alias = ALIAS_RE.test(rawAlias) ? rawAlias : defaultAlias;
  const rawBox = typeof query.box === 'string' ? query.box : 'inbox';
  const box: MailBox = BOX_VALUES.has(rawBox as MailBox) ? (rawBox as MailBox) : 'inbox';

  // cd-5cxk: free-text filters validated lightly — bounded length, no
  // control chars. Substring matching happens in JS post-fetch.
  const fromRaw = typeof query.from === 'string' && query.from.length > 0 ? query.from : undefined;
  if (fromRaw && !TEXT_FILTER_RE.test(fromRaw)) return { error: 'invalid from filter' };
  const toRaw = typeof query.to === 'string' && query.to.length > 0 ? query.to : undefined;
  if (toRaw && !TEXT_FILTER_RE.test(toRaw)) return { error: 'invalid to filter' };
  const subjectRaw = typeof query.subject === 'string' && query.subject.length > 0 ? query.subject : undefined;
  if (subjectRaw && !TEXT_FILTER_RE.test(subjectRaw)) return { error: 'invalid subject filter' };

  const afterRaw = typeof query.after === 'string' && query.after.length > 0 ? query.after : undefined;
  if (afterRaw && !ISO_RE.test(afterRaw)) return { error: 'invalid after timestamp' };
  const beforeRaw = typeof query.before === 'string' && query.before.length > 0 ? query.before : undefined;
  if (beforeRaw && !ISO_RE.test(beforeRaw)) return { error: 'invalid before timestamp' };

  const limit = parsePositiveInt(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = decodeCursor(query.cursor);

  return {
    box,
    alias,
    from: fromRaw,
    to: toRaw,
    subject: subjectRaw,
    after: afterRaw,
    before: beforeRaw,
    offset,
    limit,
  };
}

export function mailRouter(gc: GcClient, ownerAlias: string): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = parseListQuery(req.query as Record<string, unknown>, ownerAlias);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error, kind: 'validation' });
      return;
    }
    const { box, alias, from, to, subject, after, before, offset, limit } = parsed;

    try {
      // td-h3n2ar fix: gc supervisor's `box` + `alias` query params are
      // silently ignored upstream (verified: box=sent&alias=mayor and
      // box=sent&alias=human both return the same first items with
      // to=mayor). So we can't lean on the supervisor to filter by sender.
      //
      // Pull a wide window and filter server-side. cd-5cxk extends this to
      // accept from/to/subject/after/before filters + cursor pagination
      // for the 'All' box. The same FETCH_LIMIT cap applies — upstream_
      // capped surfaces when the supervisor returned the ceiling so the
      // UI can warn that the filtered count may miss older rows.
      const { items: rawItems } = await gc.listMail(undefined, { limit: FETCH_LIMIT });
      const upstream_capped = rawItems.length >= FETCH_LIMIT;

      const filtered = applyFilters(rawItems, { box, alias, from, to, subject, after, before });
      // Newest first — td-liky3d default sort, applied at the source so
      // the API contract is stable independent of any table sort UI.
      filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const total = filtered.length;
      const items = filtered.slice(offset, offset + limit);
      const next_cursor = offset + items.length < total ? encodeCursor(offset + limit) : null;
      const prev_cursor = offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null;

      res.setHeader('Cache-Control', 'no-store');
      const payload: ListMailResponse = {
        items,
        total,
        next_cursor,
        prev_cursor,
        page_size: limit,
        box,
        upstream_capped,
      };
      res.json(payload);
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/mail',
        viewing_as: alias,
        parsed_args: {
          box,
          alias,
          // Document active filters for audit-debugging without leaking
          // the actual filter values (which could include third-party
          // names a future privacy review might object to).
          filters: [from && 'from', to && 'to', subject && 'subject', after && 'after', before && 'before']
            .filter(Boolean)
            .join(',') || 'none',
          returned: String(items.length),
          total: String(total),
        },
        duration_ms: 0,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to list mail', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  // Thread view: gc supervisor doesn't expose a /threads/:id endpoint
  // (verified: returns 404). cd-5cxk extends the previous shape: when
  // ?alias= is absent (typical for 'All mail' thread clicks), pull the
  // wide window and filter by thread_id only — no alias filter.
  router.get('/threads/:id', async (req, res) => {
    const threadId = req.params.id;
    if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 128) {
      res.status(400).json({ error: 'invalid thread id', kind: 'validation' });
      return;
    }
    // cd-5cxk: alias-less thread lookup is a deliberate path for the
    // All-mail surface — when no ?alias= is provided, fall through to
    // the wide-window fetch below and filter only by thread_id. The
    // typed-alias path is preserved when an alias IS provided.
    const rawAlias = typeof req.query.alias === 'string' ? req.query.alias : '';
    const alias = ALIAS_RE.test(rawAlias) ? rawAlias : '';
    try {
      let all: GcMailItem[];
      if (alias.length === 0) {
        // cd-5cxk: alias-less thread lookup for the All-mail surface.
        // Pull the wide window once and filter by thread_id.
        const { items } = await gc.listMail(undefined, { limit: FETCH_LIMIT });
        all = items;
      } else {
        const [inbox, sent] = await Promise.all([
          gc.listMail(undefined, { box: 'inbox', alias }),
          gc.listMail(undefined, { box: 'sent', alias }),
        ]);
        all = [...inbox.items, ...sent.items];
      }
      const items = all
        .filter((m) => m.thread_id === threadId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      // De-dup by id (a message may appear in both inbox + sent views).
      const seen = new Set<string>();
      const deduped = items.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: deduped });
      void recordAudit({
        type: 'dashboard.fetch',
        endpoint: 'GET /api/mail/threads/:id',
        viewing_as: alias || '(all)',
        parsed_args: { thread_id: threadId, alias: alias || '(all)' },
        duration_ms: 0,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: 'failed to load thread', kind: 'upstream', details: { message: (err as Error).message } });
    }
  });

  return router;
}

// The dashboard owner can have a display alias ('charlie') distinct from
// their gc-wire alias ('human'). exec.ts pins --from=human on mail-send,
// and inbound mail for the dashboard owner is also addressed to 'human'.
// Without this expansion, viewing-as-charlie returns an empty inbox even
// when there are 5+ messages addressed to 'human' (cd-d9db).
//
// Symmetric so 'human' selected manually shows the same view. Hardcodes
// the charlie↔human pair; td-4k317p made the DISPLAY alias config-driven
// (GC_CITY_OWNER_ALIAS, default 'human') but kept this wire-alias bridge
// hardcoded — a non-Charlie deploy with an asymmetric display/wire pair
// (e.g. operator's display='alice' but wire='human') would still need
// to add their pair here. Filed as follow-up for env-driven
// OWNER_WIRE_ALIASES (e.g. GC_CITY_OWNER_WIRE_ALIAS='alice:human').
const OWNER_ALIASES: ReadonlyArray<[string, string]> = [['charlie', 'human']];

function expandOwnerAlias(alias: string): Set<string> {
  const a = alias.toLowerCase();
  const out = new Set<string>([a]);
  for (const [x, y] of OWNER_ALIASES) {
    if (a === x) out.add(y);
    else if (a === y) out.add(x);
  }
  return out;
}

interface FilterParams {
  box: MailBox;
  alias: string;
  from: string | undefined;
  to: string | undefined;
  subject: string | undefined;
  after: string | undefined;
  before: string | undefined;
}

function applyFilters(items: GcMailItem[], p: FilterParams): GcMailItem[] {
  // cd-5cxk: combined filter pipeline. Box first (preserves cd-d9db
  // OWNER_ALIASES bridge behaviour for inbox/sent), then text + date
  // filters on top. All filters AND together — a single message must
  // satisfy every active filter.
  const boxed = filterByBox(items, p.box, p.alias);
  const fromLower = p.from?.toLowerCase();
  const toLower = p.to?.toLowerCase();
  const subjectLower = p.subject?.toLowerCase();
  return boxed.filter((m) => {
    if (fromLower && (typeof m.from !== 'string' || !m.from.toLowerCase().includes(fromLower))) return false;
    if (toLower && (typeof m.to !== 'string' || !m.to.toLowerCase().includes(toLower))) return false;
    if (subjectLower && (typeof m.subject !== 'string' || !m.subject.toLowerCase().includes(subjectLower))) return false;
    if (p.after && m.created_at < p.after) return false;
    if (p.before && m.created_at > p.before) return false;
    return true;
  });
}

function filterByBox(
  items: GcMailItem[],
  box: MailBox,
  alias: string,
): GcMailItem[] {
  // Aliases are case-insensitive at our scale — gc emits a mix of styles
  // (e.g. 'thriva/devpipeline.architect' vs 'human'). Lowercase both sides.
  const matchSet = expandOwnerAlias(alias);
  if (box === 'all') return items.slice();
  if (box === 'inbox') {
    return items.filter((m) => typeof m.to === 'string' && matchSet.has(m.to.toLowerCase()));
  }
  // sent
  return items.filter((m) => typeof m.from === 'string' && matchSet.has(m.from.toLowerCase()));
}
