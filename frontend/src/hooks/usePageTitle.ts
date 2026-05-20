import { useEffect } from 'react';

// cd-e5tw: each route calls usePageTitle(<page-specific string>) to set
// document.title. Format: 'Citadel · <title>' so tab-hover preview and
// browser history surface what the user was looking at.
//
// Pass null when the page hasn't loaded its identifying data yet
// (e.g. bead detail before /api/beads/:id returns) — that holds the
// previous page's title rather than flashing a generic one.

const PROJECT_NAME = 'Citadel';

export function usePageTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    document.title = `${PROJECT_NAME} · ${title}`;
  }, [title]);
}
