import { NavLink, useLocation } from 'react-router-dom';
import { useViewingAs } from '../contexts/ViewingAsContext';
import { useAppConfig } from '../api/appConfig';

interface NavItem {
  to: string;
  label: string;
  hint: string;
  /** When true, NavLink does end-match — needed for '/' which is a prefix of every route. */
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Cockpit', hint: 'overview + common knobs', end: true },
  { to: '/kanban', label: 'Kanban', hint: 'ownership-state board' },
  { to: '/agents', label: 'Agents', hint: 'sessions, peek, nudge' },
  { to: '/beads', label: 'Beads', hint: 'queued work; filtered' },
  { to: '/mail', label: 'Mail', hint: 'view as any agent' },
  { to: '/activity', label: 'Activity', hint: 'commits + builds' },
  { to: '/health', label: 'Health', hint: 'dolt, mem, supervisor' },
];

export function Sidebar() {
  const { viewingAs } = useViewingAs();
  const cfg = useAppConfig();
  const cityLabel = cfg?.city ?? '…';
  const location = useLocation();
  // cd-64ol: the viewing-as chip implies a global identity swap, but
  // the only surface that actually honours the alias is Mail (mail.ts
  // /api/mail filters by it; nothing else reads it). Showing the chip
  // on /cockpit, /beads, /agents etc. was misleading. Scope it to the
  // mail route so the indicator reads as the mail-context it really is.
  // The alias state itself is preserved across navigation — going back
  // to /mail still shows the chosen identity. The visibility-change
  // auto-revert in ViewingAsContext still applies as the safety net.
  const isOnMailRoute = location.pathname === '/mail' || location.pathname.startsWith('/mail/');
  return (
    <nav className="w-56 shrink-0 border-r border-ink-700 bg-ink-800 px-3 py-4 flex flex-col">
      <div className="px-2 mb-4">
        <p className="text-xs uppercase tracking-widest text-ink-300">{cityLabel}</p>
        <p className="font-sans text-sm font-semibold text-ink-100">admin</p>
      </div>
      {!viewingAs.isOwner && isOnMailRoute && (
        <div className="px-2 py-1.5 mb-3 rounded-md border border-warn-500/40 bg-warn-500/10 text-warn-500 text-[11px]">
          <span className="uppercase tracking-wider font-semibold block">mail · viewing as</span>
          <span className="block truncate">{viewingAs.alias}</span>
          <span className="block text-[10px] text-warn-500/80 mt-0.5">read-only · reverts on tab hide</span>
        </div>
      )}
      <ul className="space-y-1 flex-1">
        {NAV.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-ink-700 text-ink-100'
                    : 'text-ink-200 hover:bg-ink-700/60 hover:text-ink-100'
                }`
              }
            >
              <div className="flex items-center justify-between">
                <span>{item.label}</span>
              </div>
              <span className="block text-[10px] text-ink-300 mt-0.5">{item.hint}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="px-2 pt-3 mt-3 border-t border-ink-700 text-[10px] text-ink-300">
        {window.location.host} · {viewingAs.ownerAlias}
      </div>
    </nav>
  );
}
