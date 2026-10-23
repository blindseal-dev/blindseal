import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Decisions } from './pages/Decisions';
import { DecisionDetail } from './pages/DecisionDetail';
import { Audit } from './pages/Audit';
import { Policy } from './pages/Policy';
import { Attestations } from './pages/Attestations';
import { Settings } from './pages/Settings';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Navigate to="/decisions" replace />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/decisions/:id" element={<DecisionDetail />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/policy" element={<Policy />} />
            <Route path="/attestations" element={<Attestations />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Shell>
      </HashRouter>
    </QueryClientProvider>
  );
}
