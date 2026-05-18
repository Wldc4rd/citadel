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
//   compose-from field when viewing-as ≠ Charlie. CONSTRAINT IS VISIBLE.
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

const STORAGE_KEY = 'thriva.admin.viewingAs';
const CHARLIE = 'charlie';

interface ViewingAsContextValue {
  viewingAs: ViewingAs;
  setAlias: (alias: string) => void;
  resetToCharlie: () => void;
}

const Context = createContext<ViewingAsContextValue | null>(null);

function readStored(): string {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) return raw;
  } catch {
    /* sessionStorage may be unavailable */
  }
  return CHARLIE;
}

function writeStored(alias: string): void {
  try {
    if (alias === CHARLIE) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, alias);
    }
  } catch {
    /* no-op */
  }
}

export function ViewingAsProvider({ children }: { children: ReactNode }) {
  const [alias, setAliasState] = useState<string>(() => readStored());

  const setAlias = useCallback((next: string) => {
    setAliasState(next);
    writeStored(next);
  }, []);

  const resetToCharlie = useCallback(() => {
    setAliasState(CHARLIE);
    writeStored(CHARLIE);
  }, []);

  const value = useMemo<ViewingAsContextValue>(() => ({
    viewingAs: { alias, isCharlie: alias === CHARLIE },
    setAlias,
    resetToCharlie,
  }), [alias, setAlias, resetToCharlie]);

  // Strict: when the tab is hidden (parent walked away), revert to
  // Charlie. Stops a forgotten "viewing as X" state from being live the
  // next time someone glances at the laptop.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && alias !== CHARLIE) {
        setAliasState(CHARLIE);
        writeStored(CHARLIE);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [alias]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useViewingAs(): ViewingAsContextValue {
  const value = useContext(Context);
  if (value === null) {
    throw new Error('useViewingAs must be inside <ViewingAsProvider>');
  }
  return value;
}

export const CHARLIE_ALIAS = CHARLIE;
