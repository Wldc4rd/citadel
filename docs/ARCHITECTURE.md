# Architecture — thriva-admin-dashboard

> The full design lives in the architect's bead block (`gc bd show td-1i30ih`). This file is the engineer's-eye summary of decisions that affect implementation.

## Stack: Node + TypeScript end-to-end

- Backend: Node 20 + Express + TypeScript.
- Frontend: React 18 + Vite + TypeScript + Tailwind.
- **Shared types**: `tools/admin-dashboard/shared/` exports the wire shapes (Session, Bead, Mail, Events). Imported by **both** backend and frontend. When a `gc` API field-shape changes, a compile error surfaces the breakage instead of an undefined at runtime — the biggest 6-month maintainability investment for a project of this size.

Rejected alternatives:

- **Python + FastAPI** — deploy messier (venv vs system), no shared types, slower to build this shape.
- **Go** — wrong coupling direction (admin tool shouldn't carry gc-the-orchestrator's lang dep).
- **Direct-from-frontend (no backend)** — doesn't work; peek + git + system-health need shell-exec.

## Real-time: direct EventSource against gc

Architect addendum **td-wisp-ijk7g** (mechanic td-wisp-e1v14) corrected the earlier reading: `/v0/city/{name}/events/stream` IS SSE today (the `/stream` suffix; the previous probe missed it). gc supervisor also serves a permissive CORS policy that echoes the request `Origin`, so the browser can `new EventSource(...)` directly against it.

What this collapses:

- No backend cursor-poll indirection.
- No backend-emitted SSE wrapper.
- Phase C wires `EventSource` from the frontend straight to `http://127.0.0.1:8372/v0/city/thriva-dev/events/stream`, with `Last-Event-ID` for resume.
- Belt-and-braces still applies: every panel has a manual Refresh button for the tab-sleep / laptop-close case.

**Phase A** ships poll-on-mount + manual refresh only; SSE direct-from-browser lands in Phase C.

## Peek is HTTP, not shell-exec

Same architect addendum: `GET /v0/city/{name}/session/{id}/transcript` returns structured JSON with `turns: [{role, text}, ...]`. The dashboard fetches the transcript via the backend's `GcClient.fetchTranscript`, sanitises each turn's text server-side (ANSI/OSC/control-char strip, per-turn 16 KB cap, total 256 KB cap), and the frontend renders each turn as a role-tagged block.

Why we still go through the backend for peek (rather than calling gc direct from the browser):

- The frontend's CSRF / audit posture stays uniform across read + write paths.
- Server-side sanitisation is the load-bearing XSS defence; doing it in one place (`routes/sessions.ts::buildTranscriptResult`) avoids the temptation to skip it on a client-only path.
- Future SSE upgrade for live-tail can swap from the polled transcript to the streaming endpoint without re-architecting the consumer.

## Deploy: systemd user unit (NOT `gc [[services]]`)

Three load-bearing reasons (per `security_researcher` td-wisp-eb0pn + `senior_developer` td-wisp-uvmru):

1. **Adoption-as-symmetry is a smell.** The Services card on the gc dashboard is correctly empty for this city.
2. **`[[services]]` is underexercised.** Admin dashboard is too Charlie-critical to be the first adopter of an untested lifecycle primitive.
3. **Inverted dependency.** gc-managed services restart with the gc-supervisor — but the dashboard is *exactly what Charlie wants open when gc is misbehaving*. Dashboard must outlive supervisor outages.

systemd is boring, well-understood, and `journalctl`-debuggable. `ExecStartPre` includes a port-in-use check (`senior_developer` gotcha #5). Revisit `[[services]]` in v1+ when it has battle-tested adopters elsewhere.

## Process model

```
   Charlie (browser)
        │
        │  HTTP/loopback :8081
        ▼
   ┌──────────────────────┐
   │  Express server      │  ← single process, supervised by systemd
   │  - /api/*            │
   │  - SPA at /          │  (express.static, immutable cache on hashed assets)
   │  - SSE at /api/events│  (Phase C)
   │  - Audit → events.jsonl
   └──────────┬───────────┘
              │
              ├── HTTP → gc supervisor (:8372)  — reads
              │
              └── spawn() → `gc` CLI            — whitelisted writes
```

## Trust boundaries

- **Browser ↔ backend**: same-origin, Host-allowlist, Origin check, CSP, CSRF on writes. See `SECURITY.md`.
- **Backend ↔ gc supervisor**: loopback HTTP. Trusts the supervisor's responses (typed via shared/types, but no signature verification).
- **Backend ↔ shell (`gc` CLI)**: whitelisted commands only, `shell: false`, clean env, param schemas. See `SECURITY.md`.

## Phasing

Five views ship in three milestones. Each milestone has an acceptance gate:

- **Phase A (this commit)** — skeleton + Agents view + Beads view. *Gate*: Charlie can identify any session's state + peek tmux content without a shell; can see filtered beads + claim/close from the browser.
- **Phase B** — Mail with identity-switching (view-as-X, sends-as-Charlie via separate router). *Gate*: Charlie can read any agent's thread cross-agent; verify every send logs `actor=charlie`.
- **Phase C** — Activity (commits + builds) + Health (process + dolt-noms 24 h trend) + SSE wiring. *Gate*: Charlie can spot the refinery's last merge + memory pressure trend without terminal.

Internal tool — the "anti-scope-reduction reflex" doesn't apply here. The five views are loosely coupled; phasing is logical build order, not feature cuts.

## Reversibility

Remove the `tools/admin-dashboard/` subtree + the systemd unit. No persistent state to clean up. The audit log entries written to `.gc/events.jsonl` are read-only signal and won't break gc itself.

## What's deferred

- **PIN-quick-path for parent mode** is not this project (different bead).
- **Per-event-class notification opt-out** is not this project.
- **TanStack Table** — premature dep at our scale; the in-house `<Table>` covers sortable columns + filter chips + click-row in <200 LOC.
- **xterm.js** for peek — overkill (no need for terminal emulation, just a snapshot view). `ansi_up` (~3 KB) is sufficient.
- **Light theme / system-pref auto** — Charlie can request in v1 if dark-default bites.
