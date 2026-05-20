import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import type { GcSupervisorConfigResponse } from 'citadel-shared';
import { Layout } from './components/Layout';
import { CockpitPage } from './routes/Cockpit';
import { AgentsPage } from './routes/Agents';
import { AgentDetailPage } from './routes/AgentDetail';
import { BeadsPage } from './routes/Beads';
import { BeadDetailPage } from './routes/BeadDetail';
import { KanbanPage } from './routes/Kanban';
import { MailPage } from './routes/Mail';
import { ActivityPage } from './routes/Activity';
import { HealthPage } from './routes/Health';
import { ViewingAsProvider } from './contexts/ViewingAsContext';

// td-4k317p: bootstrap fetch of /api/config/gc-supervisor — we wait
// for the owner alias before mounting ViewingAsProvider so the initial
// render has the correct identity (no banner-flicker for non-owner
// sessionStorage values during a fetch window). 'human' is the floor
// matching the backend default, used if the fetch fails.
const OWNER_ALIAS_FLOOR = 'human';

export function App() {
  const [ownerAlias, setOwnerAlias] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config/gc-supervisor', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: GcSupervisorConfigResponse) => {
        if (cancelled) return;
        setOwnerAlias(typeof j?.owner_alias === 'string' ? j.owner_alias : OWNER_ALIAS_FLOOR);
      })
      .catch(() => {
        if (cancelled) return;
        // Network/parse failure — fall back to the floor rather than
        // wedging the whole UI on a config fetch. The user will see
        // 'human' as the owner; if their deploy expected a different
        // alias, the banner flicker is the worst case.
        setOwnerAlias(OWNER_ALIAS_FLOOR);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (ownerAlias === null) {
    return (
      <div className="min-h-screen bg-ink-900 text-ink-300 text-xs flex items-center justify-center">
        Loading…
      </div>
    );
  }

  return (
    <ViewingAsProvider ownerAlias={ownerAlias}>
      <Layout>
        <Routes>
          <Route path="/" element={<CockpitPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:slug" element={<AgentDetailPage />} />
          <Route path="/beads" element={<BeadsPage />} />
          <Route path="/beads/:beadId" element={<BeadDetailPage />} />
          <Route path="/kanban" element={<KanbanPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/health" element={<HealthPage />} />
        </Routes>
      </Layout>
    </ViewingAsProvider>
  );
}
