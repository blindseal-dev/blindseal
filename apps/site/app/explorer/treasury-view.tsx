'use client';
// The explorer's Treasury tab: the panel is server-rendered from the snapshot (treasury-rows.ts builds
// the strings) in whichever state the server knows — not configured, offline, empty, or totals + rows —
// so it reads without JS; once the kit has mounted, icons are drawn and Retry (offline) re-reads
// /explorer/treasury and repaints the same strings. explorer-view.tsx owns the tab switch and this
// panel's `hidden`.
import type { TreasurySnapshot } from '@blindseal/chain-reads';
import { usePageKit, decorate } from '../use-page-kit';
import { treasuryPanelHtml, treasuryViewOf } from './treasury-rows';

type LoadError = { code?: string; message?: string };

export function TreasuryView({ snapshot, hidden }: { snapshot: TreasurySnapshot; hidden: boolean }) {
  usePageKit(() => {
    const root = document.getElementById('ex-treasury')!, body = document.getElementById('ex-tr-body')!;
    let attempt = 1, disposed = false;
    decorate(root);
    const paint = (x: TreasurySnapshot) => {
      body.innerHTML = treasuryPanelHtml(x, attempt);
      root.setAttribute('data-view', treasuryViewOf(x));
      decorate(root);
      const rows = body.querySelector('.ex-tx-rows');
      if (rows && !document.body.matches('[data-motion="reduce"]')) { rows.classList.add('is-entering'); setTimeout(() => rows.classList.remove('is-entering'), 600); }
    };
    const retry = () => {
      const b = body.querySelector<HTMLButtonElement>('#ex-tr-retry'); if (!b) return;
      b.setAttribute('aria-busy', 'true');
      body.querySelector('.ex-alt__track')?.classList.add('is-on');
      attempt++;
      fetch('/explorer/treasury', { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((r) => { if (!r.ok) throw { code: 'RPC_UNAVAILABLE', message: 'The treasury endpoint answered ' + r.status + '. Retry in a moment.' }; return r.json() as Promise<TreasurySnapshot>; })
        .then((x) => { if (!disposed) paint(x); })
        .catch((e: LoadError) => {
          if (disposed) return;
          paint({ ...snapshot, live: false, error: { code: (e && (e.code as 'RPC_UNAVAILABLE')) || 'RPC_UNAVAILABLE', message: (e && e.message) || 'Solana RPC unreachable. Retry in a moment.' } });
        });
    };
    /* the Retry button is re-created by every repaint, so the listener sits on the panel */
    const onClick = (e: Event) => { if ((e.target as Element).closest?.('#ex-tr-retry')) retry(); };
    root.addEventListener('click', onClick);
    return () => { disposed = true; root.removeEventListener('click', onClick); };
  });

  return (
    <div className="ex ex-tr" id="ex-treasury" role="tabpanel" aria-labelledby="ex-tab-treasury" data-view={treasuryViewOf(snapshot)} hidden={hidden}>
      <div id="ex-tr-body" dangerouslySetInnerHTML={{ __html: treasuryPanelHtml(snapshot) }} />
      <p className="ex-foot">Amounts and transaction signatures are public on chain. Nothing here names a buyer; a counterparty is a wallet address.</p>
    </div>
  );
}
