import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useStatus, useEventStream } from '../api/hooks';
import { Hash, Icon } from '../kit/react';

// The dashboard sidebar items (constants.js BS.NAV), with the kit's Lucide names.
const NAV = [
  { to: '/decisions', label: 'Decisions', icon: 'list' },
  { to: '/audit', label: 'Audit', icon: 'link' },
  { to: '/policy', label: 'Policy', icon: 'scroll-text' },
  { to: '/attestations', label: 'Attestations', icon: 'stamp' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];
const TITLES: Record<string, string> = {
  decisions: 'Decisions', audit: 'Audit', policy: 'Policy', attestations: 'Attestations', settings: 'Settings',
};

export function Shell({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  const { conn } = useEventStream(false);
  const { data: status } = useStatus();
  const loc = useLocation();
  const section = loc.pathname.split('/')[1] || 'decisions';
  const title = TITLES[section] ?? 'Blindseal';

  // the kit shell owns html/body sizing + overflow
  useEffect(() => {
    document.documentElement.classList.add('bs-shell');
    return () => document.documentElement.classList.remove('bs-shell');
  }, []);

  const connState = status?.connection === 'offline' || conn === 'closed' ? 'offline'
    : status?.connection === 'reconnecting' || conn === 'connecting' ? 'reconnecting' : 'live';
  const connLabel = connState === 'live' ? 'Connected' : connState === 'reconnecting' ? 'Reconnecting' : 'Offline';

  return (
    <div className="bs-app" data-shell="sidebar">
      <aside className="bs-side">
        <div className="bs-side__brand">
          <NavLink to="/decisions" className="bs-wordmark">
            <Icon name="shield-check" size={18} />
            <span className="bs-wordmark__word">Blindseal</span>
          </NavLink>
          <span className="chip mock">{status?.mock === false ? 'LIVE' : 'MOCK'}</span>
        </div>
        <div className="bs-side__nav">
          <nav className="bs-nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className="bs-navitem">
                <span className="bs-navitem__g"><Icon name={n.icon} /></span>
                <span className="bs-navitem__t">{n.label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="bs-side__foot">
          <div className="bs-proxy">
            <p className="bs-proxy__k"><span className="live-dot" aria-hidden />Proxy</p>
            <Hash value={`127.0.0.1:${7777}`} label="Proxy address" />
          </div>
          <div className="bs-side__footrow">
            <span className="bs-side__ver">v{status?.version ?? '0.4.0'}</span>
          </div>
        </div>
      </aside>

      <div className="bs-work">
        <header className="bs-top">
          <div className="bs-top__lead">
            <h1 className="bs-top__title">{title}</h1>
            <div className="bs-top__actions">{actions}</div>
          </div>
          <div className="bs-top__right">
            <span className="bs-sb" data-state={connState}>
              <span className="live-dot" aria-hidden />
              <span className="bs-sb__v">{connLabel}</span>
            </span>
          </div>
        </header>
        <main className="bs-main" id="main-content">{children}</main>
      </div>

      <footer className="bs-status">
        <span className="bs-sb"><span className="bs-sb__k">audit</span><span className="bs-sb__v">#{status?.audit?.index ?? '—'}</span></span>
        <span className="bs-sb"><span className="bs-sb__k">policy</span><Hash value={status?.policyRoot} /></span>
        <span className="bs-sb"><span className="bs-sb__k">detector</span><Hash value={status?.detectorVersion} /></span>
        <span className="bs-sb"><span className="bs-sb__k">L3</span><span className="bs-sb__v">{status?.l3?.mode ?? '—'}</span></span>
        <span className="bs-status__spacer" />
        <span className="bs-sb" data-state={connState}><span className="live-dot" aria-hidden /><span className="bs-sb__v">{connLabel}</span></span>
      </footer>
    </div>
  );
}
