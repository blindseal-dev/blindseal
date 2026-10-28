import { useStatus } from '../api/hooks';

/// Shown on every page while the API serves the bundled sample data (`blindseal run --mock`), so
/// demo numbers are never mistaken for this machine's decisions.
export function SampleDataBanner() {
  const { data: status } = useStatus();
  if (!status?.mock) return null;
  return (
    <div className="bs-sample-banner" role="status" data-testid="sample-data-banner">
      <strong>Sample data</strong> — bundled demo fixtures served by <code>blindseal run --mock</code>, not decisions
      recorded on this machine. Run <code>blindseal run</code> for your own.
    </div>
  );
}
