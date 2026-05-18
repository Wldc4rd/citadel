import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
  hint: string;
}

const NAV: NavItem[] = [
  { to: '/agents', label: 'Agents', hint: 'sessions, peek, nudge' },
  { to: '/beads', label: 'Beads', hint: 'queued work; filtered' },
  { to: '/mail', label: 'Mail', hint: 'view as any agent' },
  { to: '/activity', label: 'Activity', hint: 'commits + builds' },
  { to: '/health', label: 'Health', hint: 'dolt, mem, supervisor' },
];

export function Sidebar() {
  return (
    <nav className="w-56 shrink-0 border-r border-ink-700 bg-ink-800 px-3 py-4 flex flex-col">
      <div className="px-2 mb-4">
        <p className="text-xs uppercase tracking-widest text-ink-300">thriva-dev</p>
        <p className="font-sans text-sm font-semibold text-ink-100">admin</p>
      </div>
      <ul className="space-y-1 flex-1">
        {NAV.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
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
        localhost:8081 · charlie
      </div>
    </nav>
  );
}
