# Citadel

A small, opinionated admin dashboard for [Gas City](https://github.com/gastownhall/gascity) (`gc`) orchestrations — built for a single operator running a single city.

The upstream `gc dashboard` (port 8080) is the generic multi-city surface. Citadel is the one you keep open in a tab and check every few minutes: agents, beads, mail, recent activity, system health, all on one page each.

## What it gives you

Five views.

1. **Agents** — every session's state at a glance. Click for a live `gc session peek` snapshot.
2. **Beads** — engineering work only (default filter hides system tracking noise). Claim, close, nudge inline.
3. **Mail** — read any agent's mailbox via a view-as dropdown. Outgoing mail always goes from you; impersonation is read-only.
4. **Activity** — recent commits, dev-deploy events, refinery merges. Real-time updates via Server-Sent Events from the gc supervisor.
5. **Health** — supervisor process state, host memory pressure (RSS + Committed_AS), dolt-noms 24-hour trend, dev-deploy success/failure history.

## Prerequisites

- A running [Gas City](https://github.com/gastownhall/gascity) (`gc supervisor` reachable over HTTP — `:8372` by default)
- Node.js 20+
- Linux user with `systemd --user` enabled (for the systemd deploy path; alternatives in [deploy/README.md](deploy/README.md))

## Quick start (dev)

```bash
git clone https://github.com/Wldc4rd/citadel.git
cd citadel
npm install
npm run build:shared          # types must build first

# Terminal 1 — backend on :8081
npm run dev:backend

# Terminal 2 — Vite dev server on :5174, proxies /api → :8081
npm run dev:frontend
```

Browse <http://127.0.0.1:5174>.

## Production build + run

```bash
cd citadel
npm install
npm run build
node backend/dist/server.js   # serves API + frontend on :8081
```

For the systemd-managed install: [deploy/README.md](deploy/README.md).

## Configuration

All knobs are environment variables. See [`backend/src/config.ts`](backend/src/config.ts) for the authoritative source.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | TCP port the dashboard listens on |
| `HOST` | `127.0.0.1` | Bind interface. Set `0.0.0.0` for LAN access on a trusted network. |
| `ADMIN_EXTRA_ALLOWED_HOSTS` | (empty) | CSV of extra hostnames allowed in the `Host:` header (e.g. `my-vm,192.168.1.58`). The floor `127.0.0.1`/`localhost` is always allowed. |
| `GC_SUPERVISOR_URL` | `http://127.0.0.1:8372` | gc supervisor API base URL |
| `GC_CITY_NAME` | `thriva-dev` | Name of the city this dashboard manages (one dashboard per city) |
| `ADMIN_AUDIT_LOG_PATH` | (gc's `events.jsonl`) | Where state-changing actions append audit entries |
| `ADMIN_FRONTEND_DIST` | `../frontend/dist` | Path to built frontend assets |
| `ADMIN_DOLT_NOMS_ROOT` | `/home/charlie/thriva-dev/.beads/dolt` | Root of the bd-store Dolt tree the Health sparkline samples (10-min cadence). Set to `""` to disable. |
| `THRIVA_ADMIN_GIT_REPO` | `/home/charlie/thriva` | Repo for the Activity view's `git log` queries |
| `THRIVA_ADMIN_DASHBOARD_DISABLED` | `0` | Kill switch — set to `1` to refuse to start |

## Security model

Admin tooling that assumes **the operator is the only user** and the dashboard is reachable only on a trusted network.

- **Default bind** is `127.0.0.1` only — DNS-rebinding floor
- **Host-header allow-list** always permits `127.0.0.1` and `localhost`; LAN names opt in via `ADMIN_EXTRA_ALLOWED_HOSTS`
- **CSRF** — state-changing endpoints require a token issued via cookie (double-submit pattern)
- **Origin check** — POST/PATCH/DELETE require an `Origin` matching the allowed-host set
- **Content Security Policy** — `script-src 'self'`, no inline scripts, no `eval`
- **Exec whitelist** — every shell-out is enumerated explicitly in `backend/src/exec.ts`. There is no general-purpose command execution path by design.

Full threat model: [docs/SECURITY.md](docs/SECURITY.md).

## Stack

- **Backend** — Node 20 + Express + TypeScript. Single port serves API at `/api/*` and the SPA from `/`.
- **Frontend** — React 18 + Vite + TypeScript + Tailwind. Single-page app, statically served by the backend in production.
- **Shared types** — `citadel-shared` workspace package. Wire-shape drift becomes a compile error on both sides.
- **Deploy** — systemd user unit. Deliberately *not* managed by `gc [[services]]` — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why the dashboard must outlive supervisor outages.

## Layout

```
citadel/
├── package.json              # npm workspace root
├── shared/                   # wire-shape types
├── backend/                  # Express + TS
│   └── src/{server.ts,middleware,routes,gc-client.ts,exec.ts,audit.ts}
├── frontend/                 # React + Vite + Tailwind
│   └── src/{components,routes,api}
├── deploy/                   # systemd unit + install README
└── docs/                     # ARCHITECTURE, SECURITY, EXTENDING
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions and tradeoffs
- [docs/SECURITY.md](docs/SECURITY.md) — full threat model + posture
- [docs/EXTENDING.md](docs/EXTENDING.md) — how to add a view, route, or whitelisted exec command
- [deploy/README.md](deploy/README.md) — systemd install, update, kill-switch, diagnostics

## Origin and name

This was extracted from a private project (`tools/admin-dashboard/`) once it proved more useful for one specific operator's daily workflow than the upstream generic gc dashboard. Its full commit history is preserved via `git subtree split` and lives at the root of this repo.

The name is from *Mad Max: Fury Road* — Furiosa's fortified stronghold from which the wasteland is overseen and the war rig is dispatched. Admin dashboard, fortified stronghold — same idea.

## Contributing

Built for a specific way of running a gc city. Parameterized via env vars so it *could* serve other operators with similar shapes, but no claim of broad generality is made. Bug reports welcome; feature requests considered against the "should be useful on a single screen kept open all day" sniff test.

## License

[MIT](LICENSE) © 2026 Charlie Coutts
