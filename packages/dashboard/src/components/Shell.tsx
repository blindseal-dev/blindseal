import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStatus, useEventStream } from '../api/hooks';
import { SampleDataBanner } from './SampleDataBanner';

// The dashboard frame is the kit's shell.js (BS.mountShell): sidebar with the sliding pill, glass
// top bar with the title/actions/connection pill, status bar, route cover. React owns only
// <main id="main-content"> (the shell adopts it) and the actions slot (a portal into the shell's
// [data-actions]). Navigation: navigate:false → the shell plays pill + cover in place and calls
// onNavigate(id) at the swap moment, where react-router takes over. Status comes from the §5 API —
// never BS.data — so the shell mounts once the status query has settled, with explicit blanks so
// the kit's built-in sample values never show.
const TITLES: Record<string, string> = {
  decisions: 'Decisions', audit: 'Audit', policy: 'Policy', attestations: 'Attestations', settings: 'Settings', verify: 'Verify',
};
const ROUTES = { decisions: '#/decisions', audit: '#/audit', policy: '#/policy', attestations: '#/attestations', settings: '#/settings' };

type ShellApi = {
  refs: { actions: HTMLElement; main: HTMLElement };
  setActive: (id: string, o?: { animate?: boolean }) => void;
  setTitle: (t: string) => void;
  setConnection: (s: 'connected' | 'reconnecting' | 'offline') => void;
  setAuditHead: (h: { index: number; hash: string; ts: string }) => void;
  setPolicyRoot: (r: string) => void;
};
const kit = () => (window as unknown as { BS?: { mountShell?: (o: unknown) => ShellApi; shell?: ShellApi } }).BS;

export function Shell({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  const { conn } = useEventStream(false);
  const statusQ = useStatus();
  const status = statusQ.data;
  const loc = useLocation();
  const navigate = useNavigate();
  const section = loc.pathname.split('/')[1] || 'decisions';
  const title = TITLES[section] ?? 'Blindseal';
  const [shell, setShell] = useState<ShellApi | null>(null);

  const connState: 'connected' | 'reconnecting' | 'offline' =
    status?.connection === 'offline' || conn === 'closed' ? 'offline'
      : status?.connection === 'reconnecting' || conn === 'connecting' ? 'reconnecting' : 'connected';

  // mount once, after the status query settled (success or 401/offline → blanks, not samples)
  useEffect(() => {
    if (shell || statusQ.isPending) return;
    const BS = kit();
    if (!BS?.mountShell) return;
    const s = status;
    const api = BS.mountShell({
      active: section,
      title,
      routes: ROUTES,
      navigate: false,
      cover: true,
      onNavigate: (id: string) => navigate(`/${id}`),
      connection: connState,
      status: {
        mock: s?.mock ?? false,
        version: s?.version ?? '',
        uptimeSec: s?.uptimeSec ?? 0,
        detectorVersion: s?.detectorVersion ?? '—',
        policyRoot: s?.policyRoot ?? '',
        l3: s?.l3 ?? { mode: '—' },
        audit: s?.audit ?? { index: -1, hash: '', ts: '' },
        signerPubkey: '',
      },
    });
    setShell(api);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusQ.isPending]);

  // route → active item + title (no-op when the shell itself drove the change)
  useEffect(() => { if (shell) { shell.setActive(section, { animate: true }); shell.setTitle(title); } }, [shell, section, title]);
  // live status → connection pill + status bar
  useEffect(() => { if (shell) shell.setConnection(connState); }, [shell, connState]);
  useEffect(() => {
    if (!shell || !status) return;
    if (status.audit) shell.setAuditHead(status.audit);
    if (status.policyRoot) shell.setPolicyRoot(status.policyRoot);
  }, [shell, status]);

  // <main id="main-content"> is React's root container itself (index.html / main.tsx); the shell
  // adopts it into .bs-work. The actions slot is the shell's [data-actions] (a portal).
  return (
    <>
      <SampleDataBanner />
      {children}
      {shell && actions ? createPortal(actions, shell.refs.actions) : null}
    </>
  );
}
