// React wrappers over the kit JS primitives (internals untouched — see DECISIONS). Components emit
// the kit's class names so the verbatim kit CSS styles them; behaviour calls window.BS.*.
import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

const BS = () => (typeof window !== 'undefined' ? window.BS : undefined);

/** After each render, swap lucide placeholders, decorate glass, and run reveals once. */
/**
 * The mockups' DOMContentLoaded mount sequence, run after React commits and on every route change,
 * idempotently (data-kit* markers + the kit's own seen-sets): syncMotionAttr → icons →
 * glass.decorate(document) → spaces for unmounted hosts → mountReveals(main) → mountDrawIn →
 * mountPause → diagrams. The frame itself is BS.mountShell (Shell.tsx).
 */
export function useKitBoot(deps: unknown[] = []) {
  useEffect(() => {
    const bs = BS();
    if (!bs) return;
    const once = (el: HTMLElement, key: string, fn: (el: HTMLElement) => void) => {
      const k = `kit${key}`;
      if (el.dataset[k]) return;
      el.dataset[k] = '1';
      try { fn(el); } catch { /* a kit module missing is not fatal */ }
    };
    const raf = requestAnimationFrame(() => {
      try { bs.motion?.syncMotionAttr?.(); } catch { /* noop */ }
      try { bs.icons?.(); } catch { /* noop */ }
      try { bs.glass?.decorate?.(document); } catch { /* noop */ }
      document.querySelectorAll<HTMLElement>('[data-space], [data-bg]').forEach((host) => {
        if (host.hasAttribute('data-space-mounted')) return;
        host.setAttribute('data-space-mounted', '');
        const i = host.getAttribute('data-intensity') || host.getAttribute('data-space') || 'hero';
        try { bs.mountSpace?.(host, { intensity: i === 'faint' ? 'faint' : 'hero' }); } catch { /* noop */ }
      });
      const main = document.getElementById('main-content') ?? document;
      try { bs.motion?.mountReveals?.(main); } catch { /* noop */ }
      document.querySelectorAll<HTMLElement>('[data-draw-in], .draw-in').forEach((el) => once(el, 'Draw', (e) => bs.motion?.mountDrawIn?.(e)));
      document.querySelectorAll<HTMLElement>('[data-pause]').forEach((el) => once(el, 'Pause', (e) => bs.motion?.mountPause?.(e)));
      document.querySelectorAll<HTMLElement>('[data-figure]').forEach((el) => once(el, 'Figure', (e) => bs.diagrams?.render?.(e.dataset.figure!, e, {})));
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Reduced-motion flag from the kit (OS setting or ?motion=reduce). */
export function reducedMotion(): boolean {
  try { return !!BS()?.motion?.reduced?.(); } catch { return false; }
}

/** Odometer: rolls a number in a ref'd element via BS.motion.odometer. */
export function useOdometer(value: number, opts?: { mode?: 'roll' | 'tick'; format?: (n: number) => string }) {
  const ref = useRef<HTMLElement>(null);
  const odo = useRef<any>(null);
  useEffect(() => {
    const fmt = opts?.format ?? String;
    const bs = BS();
    if (!ref.current) return;
    if (bs?.motion?.odometer) {
      if (!odo.current) odo.current = bs.motion.odometer(ref.current, value, { mode: opts?.mode ?? 'tick', format: fmt });
      else odo.current.set(value);
    } else {
      ref.current.textContent = fmt(value); // fallback: no motion engine
    }
  }, [value, opts?.mode, opts?.format]);
  return ref;
}

export function Icon({ name, size, cls, label }: { name: string; size?: number; cls?: string; label?: string }) {
  // Render a lucide placeholder; useKitBoot swaps it to inline SVG after mount.
  return <i data-lucide={name} data-size={size} className={cls} aria-label={label} aria-hidden={label ? undefined : true} />;
}

function shorten(v: string): string {
  if (!v) return '';
  if (v.startsWith('0x')) return v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
  return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v;
}

/** The hash component: kit .hash markup + click-to-copy (behaviour parity). */
export function Hash({ value, label, lg, cls }: { value?: string | null; label?: string; lg?: boolean; cls?: string }) {
  const full = value == null ? '' : String(value);
  const ref = useRef<HTMLButtonElement>(null);
  if (!full) return <span className="hash" aria-hidden><span className="hash__v">—</span></span>;
  const copy = () => {
    const el = ref.current;
    navigator.clipboard?.writeText(full).then(() => {
      if (!el) return;
      el.classList.add('is-copied');
      setTimeout(() => el.classList.remove('is-copied'), 1400);
    }).catch(() => { /* clipboard blocked */ });
  };
  return (
    <button
      type="button"
      ref={ref}
      className={`hash${lg ? ' lg' : ''}${cls ? ` ${cls}` : ''}`}
      data-hash={full}
      data-label={label}
      title={full}
      aria-label={`${label ? label + ' ' : ''}${full}. Copy`}
      onClick={copy}
    >
      <span className="hash__v">{shorten(full)}</span>
    </button>
  );
}

export type Verdict = 'pass' | 'flag' | 'block';
export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const v: Verdict = verdict === 'block' || verdict === 'flag' ? verdict : 'pass';
  return <span className={`verdict ${v}`}>{v}</span>;
}

export interface LayerLike {
  layer?: string;
  verdict: string;
  ran?: boolean;
  score?: number;
  ruleIds?: string[];
  latencyMs?: number;
}
export function Layers({ layers, lg }: { layers: LayerLike[]; lg?: boolean }) {
  const sum = layers.map((r, i) => `${r.layer || 'L' + i} ${r.ran === false ? 'skip' : r.verdict}`).join(', ');
  return (
    <span className={`layers${lg ? ' lg' : ''}`} role="img" aria-label={`Layers: ${sum}`}>
      {layers.map((r, i) => {
        const v = r.ran === false ? 'skip' : r.verdict;
        const tip = `${r.layer || 'L' + i} · ${r.score != null ? r.score.toFixed(2) : r.ruleIds?.length ? r.ruleIds.join(', ') : v}${r.latencyMs != null ? ' · ' + Math.round(r.latencyMs) + ' ms' : ''}`;
        return <span key={i} className="layers__cell" data-v={v} data-tip={tip} />;
      })}
    </span>
  );
}

export function StatusChip({ status, progress }: { status: string; progress?: number }) {
  const p = Math.max(0, Math.min(100, progress ?? 0));
  if (status === 'generating')
    return (
      <span className="status" data-s="generating">
        generating<span className="status__pct">{Math.round(p)}%</span>
        <span className="status__bar"><i style={{ '--p': p / 100 } as CSSProperties} /></span>
      </span>
    );
  if (status === 'consumed')
    return <span className="status" data-s="consumed"><Icon name="check" />consumed</span>;
  return <span className="status" data-s={status}>{status}</span>;
}

/** A drawn figure from diagrams.js. */
export function Figure({ name, opts, className }: { name: string; opts?: Record<string, unknown>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bs = BS();
    if (ref.current && bs?.diagrams?.render) {
      ref.current.innerHTML = '';
      try { bs.diagrams.render(name, ref.current, opts || {}); } catch { /* noop */ }
    }
  }, [name, opts]);
  return <div ref={ref} className={className} />;
}

/** Nebula background via space.js. */
export function Space({ intensity, seed, stars, className }: { intensity?: string; seed?: number; stars?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bs = BS();
    if (ref.current && bs?.mountSpace) try { bs.mountSpace(ref.current, { intensity, seed, stars }); } catch { /* noop */ }
  }, [intensity, seed, stars]);
  return <div ref={ref} className={className} aria-hidden />;
}

/** Reveal wrapper: children get the kit's .reveal once-fire entrance. */
export function Reveal({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`reveal${className ? ' ' + className : ''}`} style={style}>{children}</div>;
}
