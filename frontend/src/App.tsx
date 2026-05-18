import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AgentsPage } from './routes/Agents';
import { BeadsPage } from './routes/Beads';
import { MailPage } from './routes/Mail';
import { ActivityPage } from './routes/Activity';
import { HealthPage } from './routes/Health';
import { ViewingAsProvider } from './contexts/ViewingAsContext';

export function App() {
  return (
    <ViewingAsProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/agents" replace />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/beads" element={<BeadsPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/health" element={<HealthPage />} />
        </Routes>
      </Layout>
    </ViewingAsProvider>
  );
}
