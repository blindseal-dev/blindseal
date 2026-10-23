import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Decisions } from './pages/Decisions';
import { DecisionDetail } from './pages/DecisionDetail';
import { Stub } from './pages/Stub';

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
            <Route path="/audit" element={<Stub title="Audit" note="Chain head, verify chain, disclosure export." />} />
            <Route path="/policy" element={<Stub title="Policy" note="Rules, Merkle root (from the API on save), dry run." />} />
            <Route path="/attestations" element={<Stub title="Attestations" note="Lifecycle, decoded public inputs, submit, export." />} />
            <Route path="/settings" element={<Stub title="Settings" note="Upstreams, L3 mode, prover, token rotate." />} />
          </Routes>
        </Shell>
      </HashRouter>
    </QueryClientProvider>
  );
}
