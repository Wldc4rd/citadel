# Deploying thriva-admin-dashboard

Single-user, localhost-only systemd user unit. Designed to **outlive gc-supervisor outages** — the dashboard is exactly what Charlie wants open when gc is misbehaving, so it must not be `gc-supervisor`-managed.

## One-time install

```bash
# 1. Build everything
cd /home/charlie/thriva-dev/tools/admin-dashboard
npm install
npm run build

# 2. Link the unit into the user-level systemd dir
mkdir -p ~/.config/systemd/user
cp deploy/thriva-admin-dashboard.service ~/.config/systemd/user/

# 3. Enable + start
systemctl --user daemon-reload
systemctl --user enable --now thriva-admin-dashboard.service
```

Browse to <http://127.0.0.1:8081>.

## Updating

```bash
cd /home/charlie/thriva-dev/tools/admin-dashboard
git pull          # or your usual update mechanism
npm install
npm run build
systemctl --user restart thriva-admin-dashboard.service
```

## Diagnostics

```bash
systemctl --user status thriva-admin-dashboard.service
journalctl --user -u thriva-admin-dashboard.service -f
ss -tln 'sport = :8081'        # port-in-use check
curl -fsS http://127.0.0.1:8081/api/health  # smoke test
```

## Kill switch

```bash
THRIVA_ADMIN_DASHBOARD_DISABLED=1 systemctl --user start thriva-admin-dashboard.service
# → the service refuses to bind the listener; clean exit.
```

For permanent disable: `systemctl --user disable --now thriva-admin-dashboard.service`.

## Notes

- Bound to `127.0.0.1:8081` only (not `0.0.0.0`) — see `docs/SECURITY.md` for the DNS-rebinding posture.
- `gc-supervisor` outage takes the dashboard's data with it; the dashboard SHELL stays up (renders the cached/empty state) until supervisor returns.
- Audit log is appended to `/home/charlie/thriva-dev/.gc/events.jsonl` (durable channel; survives dolt-hq corruption).
