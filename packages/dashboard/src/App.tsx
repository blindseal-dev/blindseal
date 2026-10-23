import { createContext, useContext, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useKitBoot } from './kit/react';
import { Decisions } from './pages/Decisions';
import { DecisionDetail } from './pages/DecisionDetail';
import { Audit } from './pages/Audit';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
});

// Pages set the top-bar actions through this context (the mockup passes them to BS.mountShell).
const ActionsContext = createContext<(n: ReactNode) => void>(() => {});
export const useTopActions = () => useContext(ActionsContext);

function Layout() {
  const [actions, setActions] = useState<ReactNode>(null);
  const loc = useLocation();
  useKitBoot([loc.pathname]);
  return (
    <ActionsContext.Provider value={setActions}>
      <Shell actions={actions}>
        <Routes>
          <Route path="/" element={<Navigate to="/decisions" replace />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/decisions/:id" element={<DecisionDetail />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/policy" element={<Placeholder name="Policy" />} />
          <Route path="/attestations" element={<Placeholder name="Attestations" />} />
          <Route path="/settings" element={<Placeholder name="Settings" />} />
        </Routes>
      </Shell>
    </ActionsContext.Provider>
  );
}

function Placeholder({ name }: { name: string }) {
  return <div className="page" style={{ padding: 24, color: 'var(--muted)' }}>{name} — ported in a later step of the sprint.</div>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Layout />
      </HashRouter>
    </QueryClientProvider>
  );
}
