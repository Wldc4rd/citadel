# thriva-admin-dashboard

Localhost-only admin dashboard for Charlie's daily orchestration of the `thriva-dev` city. Runs side-by-side with the generic `gc dashboard` (port 8080); this one is tailored to *this* city's actual ops shape.

Bead: [td-1i30ih](#) · Architect design block in the bead body.

## Five views

1. **Agents** — every session's state at a glance, one-click `gc session peek` snapshot.
2. **Beads** — engineering work only (default filter hides `gc:session` + `gc:message` noise), with claim/close/nudge inline.
3. **Mail** *(Phase B)* — view-as-any-agent dropdown; sends always go out as Charlie.
4. **Activity** *(Phase C)* — recent commits + dev-deploy history.
5. **Health** *(Phase C)* — supervisor process, memory, dolt-noms 24h trend.

## Stack

- **Backend**: Node 20 + Express + TypeScript.
- **Frontend**: React 18 + Vite + TypeScript + Tailwind.
- **Shared types**: `thriva-admin-shared` workspace package — wire-shape drift becomes a compile error on both sides.
- **Deploy**: systemd user unit (NOT `gc [[services]]` — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why).

## Layout

```
tools/admin-dashboard/
├── package.json              # npm workspace root
├── shared/                   # wire-shape types
├── backend/                  # Express + TS
│   └── src/{server.ts,middleware,routes,gc-client.ts,exec.ts,audit.ts}
├── frontend/                 # React + Vite + Tailwind
│   └── src/{components,routes,api}
├── deploy/                   # systemd unit + install README
└── docs/                     # ARCHITECTURE, SECURITY, EXTENDING
```

## Quick start (dev)

```bash
cd tools/admin-dashboard
npm install
npm run build:shared          # types must exist before backend/frontend compile

# Terminal 1 — backend on :8081
npm run dev:backend

# Terminal 2 — Vite dev server on :5174, proxies /api → :8081
npm run dev:frontend
```

Then browse to <http://127.0.0.1:5174>.

## Production build + run

```bash
cd tools/admin-dashboard
npm install
npm run build
node backend/dist/server.js   # serves API + frontend on :8081
```

For the systemd-managed install, see [deploy/README.md](deploy/README.md).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — decisions + tradeoffs (stack, deploy, real-time).
- [docs/SECURITY.md](docs/SECURITY.md) — v0-ship-required posture (DNS rebinding, CSRF, exec whitelist, XSS).
- [docs/EXTENDING.md](docs/EXTENDING.md) — how to add a view, a route, a whitelisted exec command.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| A | Skeleton + Agents + Beads | ✅ this commit |
| B | Mail with identity-switching | pending |
| C | Activity + Health + SSE wiring | pending |
