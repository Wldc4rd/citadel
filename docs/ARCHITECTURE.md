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

## Real-time: backend cursor-polls → SSE-to-browser

`/v0/city/{name}/events` is **not** SSE upstream — it returns cursor-paged JSON. So:

- Backend cursor-polls `/v0/city/thriva-dev/events` every 2 s (Phase C).
- Backend exposes its **own** SSE endpoint (`GET /api/events`) to the browser.
- Browser uses `EventSource` — unidirectional fits this perfectly.
- Backend keeps last-cursor **in memory only** — no persistent store. Reconnects pick up from the server's current cursor.
- Single cursor-poller hits `gc` once per 2 s regardless of how many browser tabs Charlie has open.
- Belt-and-braces: every panel has a manual Refresh button. SSE drops on tab-sleep / laptop-close — the user-controlled escape valve.

**Phase A** ships poll-on-mount + manual refresh only; SSE wiring lands in Phase C.

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
