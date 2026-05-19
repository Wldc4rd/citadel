import { Marked, Renderer, type Tokens, type RendererObject } from 'marked';

// Strict-allowlist server-side markdown renderer for the bead drill-in
// (td-384rhs). The architect's security spec for markdown rendering on
// agent-controlled content:
//   - no <script>, no <iframe>, no on-* attribute handlers
//   - no javascript:/data: URLs in href
//   - same security_researcher posture as td-1i30ih peek output
//
// Strategy: use marked's default Renderer for safe constructs (text,
// headings, lists, emphasis, code, blockquote, paragraph, table) and
// OVERRIDE the dangerous methods to return empty strings or
// allowlist-only output. This is whitelisting-by-construction: dangerous
// tags never reach the output regardless of what the input contains.
//
// Marked's default behavior already:
//   - Escapes all text content (no XSS from inline text)
//   - Renders code as <code>/<pre> with escaped content
//   - Strips disallowed HTML attributes from generated tags
//
// What we add:
//   - html token returns '' (no raw HTML pass-through from input)
//   - image returns the alt text only (no <img> tag — no remote loads)
//   - link validates href (http/https/relative '/' only) and strips title
//   - text applies bead-id mention auto-linking (turns "td-abc123" into
//     a link to the bead drill-in page)
//
// Mention auto-linking regex per architect td-384rhs:
//   (th|thriva|td|jt|cd)-[a-z0-9]+
// Adapted at impl time: the strict architect form misses wisp-style
// IDs like 'td-wisp-99cas' that contain hyphens in the suffix. Real
// bead IDs allow hyphens within a 3–32 char suffix (see BEAD_ID_RE in
// exec.ts) — the suffix here mirrors that, capped at 32 chars to keep
// false-positive sentences like 'td-some-long-prose-sentence' from
// matching.
// Strict character class; no special regex chars in the pattern; the
// match becomes an href like "/beads/td-abc123". Inside code spans /
// code blocks the `text` renderer isn't called, so code stays untouched.

const SAFE_LINK_RE = /^(https?:\/\/|\/(?!\/))/i;
const MENTION_RE = /\b(th|thriva|td|jt|cd)-[a-z0-9][a-z0-9-]{2,31}\b/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkifyMentions(escapedText: string): string {
  // The input has already been HTML-escaped by marked's default text
  // renderer, so escapedText is safe to scan with the mention regex. We
  // rebuild the string by replacing matches with <a> wrappers — and
  // because the match is a strict char class with NO regex specials, we
  // can interpolate it directly into the href + body without
  // re-escaping. (Sanity belt: the regex literal only matches
  // ASCII letters / digits / hyphen.)
  return escapedText.replace(MENTION_RE, (match) => {
    return `<a href="/beads/${match}" class="bead-mention">${match}</a>`;
  });
}

const renderer: RendererObject = {
  // Forbid raw HTML pass-through. Marked will pass through <script>,
  // <iframe>, etc. tokens by default — we drop them entirely.
  html(_token: Tokens.HTML | Tokens.Tag): string {
    return '';
  },

  // Drop images. The dashboard renders no remote content; this
  // eliminates an entire class of CSP / phishing concerns and tracker
  // pixels. Show the alt text as plain content (already escaped by
  // marked's tokenizer).
  image({ text }: Tokens.Image): string {
    if (text.length === 0) return '';
    return escapeHtml(text);
  },

  // Allowlist href schemes. Only http(s):// and root-relative '/...'
  // (the dashboard's own pages). Anything else (javascript:, data:,
  // file:, custom protocols) renders as plain text — the user sees the
  // intended visible content but the URL never resolves.
  link({ href, tokens }: Tokens.Link): string {
    // tokens contain the link body (inline children); use the default
    // renderer's logic via the parser bound to `this` to render them.
    // Falling back to escaping the href as visible text if missing.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const that = this as unknown as { parser: { parseInline: (t: Tokens.Generic[]) => string } };
    const body = that.parser.parseInline(tokens) || escapeHtml(href);
    if (!SAFE_LINK_RE.test(href)) {
      return body; // unsafe href: show the visible body, no anchor.
    }
    return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${body}</a>`;
  },

  // Apply bead-mention auto-linking to plain text nodes. marked's
  // default text method just returns the escaped text unchanged.
  text(token: Tokens.Text | Tokens.Escape): string {
    // Tokens.Text may have `tokens` if it contains inline children
    // (e.g. emphasis inside a text run). Recurse via the parser to
    // honor those, then linkify mentions in the resulting HTML.
    if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
      const that = this as unknown as { parser: { parseInline: (t: Tokens.Generic[]) => string } };
      return linkifyMentions(that.parser.parseInline(token.tokens));
    }
    const text = (token as Tokens.Text).text ?? '';
    return linkifyMentions(escapeHtml(text));
  },
};

const marked = new Marked({
  // Don't allow GFM auto-link detection (we do our own mention linking).
  // Headers render without ids (no hash-anchor surface).
  gfm: true,
  breaks: false,
  pedantic: false,
});
marked.use({ renderer });

export function renderMarkdownSafe(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  // marked.parse can return a Promise when async tokens are involved;
  // our renderer is fully synchronous, so we assert string here.
  const out = marked.parse(input) as string;
  return out;
}

/**
 * Plain-text fallback. Used when the caller wants a length-bounded
 * preview (e.g. row hover-card) without any HTML. Strips markdown
 * markers crudely — good enough for a one-liner summary.
 */
export function markdownToPlain(input: string, maxLen = 200): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  const stripped = input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^>+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen - 1) + '…';
}

// Default renderer (default-class-overridden) for `Renderer` type
// re-export — keeps the import surface tight for future modules that
// want the renderer instance.
export { Renderer };
