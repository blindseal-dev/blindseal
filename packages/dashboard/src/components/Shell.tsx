import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useEventStream, useStatus } from '../api/hooks';
import { Hash } from './Hash';

const NAV = [
  { to: '/decisions', label: 'Decisions' },
  { to: '/audit', label: 'Audit' },
  { to: '/policy', label: 'Policy' },
  { to: '/attestations', label: 'Attestations' },
  { to: '/settings', label: 'Settings' },
];

const TITLE: Record<string, string> = {
  decisions: 'Decisions',
  audit: 'Audit',
  policy: 'Policy',
  attestations: 'Attestations',
  settings: 'Settings',
};

export function Shell({ children }: { children: ReactNode }) {
  const { conn } = useEventStream(false);
  const { data: status } = useStatus();
  const loc = useLocation();
  const section = loc.pathname.split('/')[1] || 'decisions';
  const title = TITLE[section] ?? 'Blindseal';
  const connLabel = conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Reconnecting' : 'Offline';

  return (
    <div className="bs-app">
      <aside className="bs-side">
        <div className="bs-side__brand">
          <span className="bs-side__seal" aria-hidden />
          Blindseal
        </div>
        <nav className="bs-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className="bs-navitem">
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="bs-side__foot">
          <span className="bs-conn" data-conn={conn}>
            <span className="bs-conn__dot" />
            {connLabel}
          </span>
          <span className="bs-chip bs-chip--mock" style={{ alignSelf: 'start' }}>
            {status?.mock === false ? 'LIVE' : 'MOCK'}
          </span>
        </div>
      </aside>

      <div className="bs-main">
        <header className="bs-top">
          <div className="bs-top__title">{title}</div>
          <div className="bs-top__right">
            <span className="bs-conn" data-conn={conn}>
              <span className="bs-conn__dot" />
              {connLabel}
            </span>
          </div>
        </header>

        <main className="bs-work">{children}</main>

        <footer className="bs-statusbar">
          <span>
            audit head <b>#{status?.audit.index ?? '—'}</b>
          </span>
          <span>
            policy <b><Hash value={status?.policyRoot ?? ''} /></b>
          </span>
          <span>
            detector <b><Hash value={status?.detectorVersion ?? ''} /></b>
          </span>
          <span>
            L3 <b>{status?.l3.mode ?? '—'}</b>
          </span>
        </footer>
      </div>
    </div>
  );
}
