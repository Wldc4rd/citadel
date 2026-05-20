import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ViewingAs } from 'citadel-shared';

// Architect td-1i30ih §"Identity-switching for mail":
//
//   Frontend: visible "Viewing as <agent>" badge with colour; disable the
//   compose-from field when viewing-as ≠ <owner>. CONSTRAINT IS VISIBLE.
//
//   No client-side caching of mail under as-identity: Cache-Control:
//   no-store + no localStorage retention.
//
// We use sessionStorage so the chosen identity survives accidental page
// refresh in the same tab but does NOT persist beyond tab close — the
// "no retention" rule applies to cached mail bodies, not the user's
// chosen viewing context, but tab-scoped is friendlier here than fully
// transient. If that conflicts with anyone's reading of the rule in
// review, drop to in-memory only — trivial change.
//
// td-4k317p: the owner alias is now a backend-config value
// (GC_CITY_OWNER_ALIAS, default 'human'), surfaced via
// /api/config/gc-supervisor and threaded in here as a prop by App.tsx.
// This module no longer hardcodes 'charlie'; resetToOwner / isOwner
// pivot on whatever the deploy configured.

const STORAGE_KEY = 'thriva.admin.viewingAs';

interface ViewingAsContextValue {
  viewingAs: ViewingAs;
  setAlias: (alias: string) => void;
  resetToOwner: () => void;
}

const Context = createContext<ViewingAsContextValue | null>(null);

function readStored(fallback: string): string {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) return raw;
  } catch {
    /* sessionStorage may be unavailable */
  }
  return fallback;
}

function writeStored(alias: string, ownerAlias: string): void {
  try {
    if (alias === ownerAlias) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, alias);
    }
  } catch {
    /* no-op */
  }
}

export function ViewingAsProvider({
  ownerAlias,
  children,
}: {
  ownerAlias: string;
  children: ReactNode;
}) {
  const [alias, setAliasState] = useState<string>(() => readStored(ownerAlias));

  const setAlias = useCallback((next: string) => {
    setAliasState(next);
    writeStored(next, ownerAlias);
  }, [ownerAlias]);

  const resetToOwner = useCallback(() => {
    setAliasState(ownerAlias);
    writeStored(ownerAlias, ownerAlias);
  }, [ownerAlias]);

  const value = useMemo<ViewingAsContextValue>(() => ({
    viewingAs: { alias, ownerAlias, isOwner: alias === ownerAlias },
    setAlias,
    resetToOwner,
  }), [alias, ownerAlias, setAlias, resetToOwner]);

  // Strict: when the tab is hidden (parent walked away), revert to
  // the configured owner. Stops a forgotten "viewing as X" state from
  // being live the next time someone glances at the laptop.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && alias !== ownerAlias) {
        setAliasState(ownerAlias);
        writeStored(ownerAlias, ownerAlias);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [alias, ownerAlias]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useViewingAs(): ViewingAsContextValue {
  const value = useContext(Context);
  if (value === null) {
    throw new Error('useViewingAs must be inside <ViewingAsProvider>');
  }
  return value;
}
