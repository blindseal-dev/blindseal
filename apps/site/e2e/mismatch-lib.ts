// Shared by e2e/mismatch-probe.mts and live.spec.ts. INIT runs before any page script (addInitScript):
// it stores the DOM React hydrates against (outerHTML at DOMContentLoaded) and collects every
// console.error / reportError / window 'error' / unhandledrejection mentioning 418, 423 or hydration.
// DIFF(kit) walks that captured tree against the live DOM, every attribute, text and child; with
// kit=true it excludes only what the kit creates after mount (site.js chrome, glass sheens, icon svgs,
// space canvases, kit layers, kit-set data-* / state classes / inline styles).
export const INIT = `
  window.__errs = []; window.__pre = null;
  const keep = (s) => { s = String(s); if (/418|423|hydrat|did not match|Hydration/i.test(s)) window.__errs.push(s.slice(0, 300)); };
  const ce = console.error.bind(console); console.error = (...a) => { a.forEach(keep); ce(...a); };
  const re = window.reportError; window.reportError = (e) => { keep(e && e.message || e); return re && re.call(window, e); };
  window.addEventListener('error', (e) => keep(e.message || (e.error && e.error.message) || e));
  window.addEventListener('unhandledrejection', (e) => keep(e.reason && e.reason.message || e.reason));
  document.addEventListener('DOMContentLoaded', () => { window.__pre = document.documentElement.outerHTML; }, { once: true });
`;
export const DIFF = `(kit) => {
  const SKIP_TAG = new Set(['SCRIPT', 'NOSCRIPT', 'NEXT-ROUTE-ANNOUNCER', 'TEMPLATE']);
  const KIT_SEL = '.glass-sheen, .glass-glow, canvas, #bs-toasts, .toasts, .tooltip, .dialog, .sheet, .menu, style:not([data-href]), link[rel~="icon"]';
  const SPACE = '.hero__space, .ex-mast__space, .hiw-mast__space, .cl-mast__space, .vf-mast__space, [data-space]';
  const kitNode = (el) => kit && (el.matches(KIT_SEL) || !!el.closest(KIT_SEL) || (el.tagName.toLowerCase() === 'svg' && !!el.parentElement && el.parentElement.matches('i[data-lucide]')) || (!!el.closest(SPACE) && !el.matches(SPACE)));
  const skipAttr = (n) => kit && (/^data-(kit|glass|space-mounted|page-hydrated|motion|reveal|seen|dg|odo|site)/.test(n) || n === 'style' || n === 'data-bg');
  const normClass = (v) => (v || '').split(/\\s+/).filter((t) => t && !(kit && /^(is-|has-|bs-site|bs-js-ready|in-view|reveal--)/.test(t))).sort().join(' ');
  const kids = (el) => [...el.childNodes].filter((n) => (n.nodeType === 1 && !SKIP_TAG.has(n.tagName) && !kitNode(n)) || (n.nodeType === 3 && n.nodeValue.trim()));
  const pathOf = (el) => { const parts = []; for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '')); return parts.join(' > '); };
  const label = (n) => n.nodeType === 3 ? '#text' : n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : '');
  const out = [];
  const cmp = (a, b) => {
    if (out.length > 40) return;
    if (a.nodeType === 3 || b.nodeType === 3) {
      if (a.nodeType !== b.nodeType) out.push({ at: pathOf(a.parentElement || b.parentElement), kind: 'node-type', pre: label(a), post: label(b) });
      else if (a.nodeValue.trim() !== b.nodeValue.trim()) out.push({ at: pathOf(a.parentElement), kind: 'text', pre: a.nodeValue.trim().slice(0, 120), post: b.nodeValue.trim().slice(0, 120) });
      return;
    }
    if (a.tagName !== b.tagName) { out.push({ at: pathOf(a), kind: 'tag', pre: a.tagName, post: b.tagName }); return; }
    for (const n of new Set([...a.getAttributeNames(), ...b.getAttributeNames()])) {
      if (skipAttr(n)) continue; const x = a.getAttribute(n), y = b.getAttribute(n);
      const same = n === 'class' ? normClass(x) === normClass(y) : x === y;
      if (!same) out.push({ at: pathOf(a), kind: 'attr', name: n, pre: x == null ? null : String(x).slice(0, 160), post: y == null ? null : String(y).slice(0, 160) });
    }
    const ka = kids(a), kb = kids(b);
    if (ka.length !== kb.length) out.push({ at: pathOf(a), kind: 'children', pre: ka.length + ' [' + ka.map(label).join(',') + ']', post: kb.length + ' [' + kb.map(label).join(',') + ']' });
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) cmp(ka[i], kb[i]);
  };
  if (!window.__pre) return { errs: window.__errs, diff: [{ kind: 'no __pre captured' }] };
  cmp(new DOMParser().parseFromString(window.__pre, 'text/html').documentElement, document.documentElement);
  return { errs: window.__errs, diff: out };
}`;
export const ROUTES = ['/', '/how-it-works', '/verify', '/docs', '/docs/hashing', '/explorer', '/changelog'];

// Entries that touch <html> (attributes), <head> (children/attributes) or a DIRECT child of <body> (an
// insertion/removal at body level, or an attribute change on a body child). With the kit running these must
// be none: the chrome is server-rendered and the kit only adopts it.
export function chromeViolations(diff: { at?: string; kind?: string }[]) {
  return diff.filter((d) => {
    const at = d.at || '';
    if (/^html(\.[\w-]+)*$/.test(at)) return true;
    if (/^html(\.[\w-]+)* > head/.test(at)) return true;
    if (/^html(\.[\w-]+)* > body$/.test(at)) return true;
    if (/^html(\.[\w-]+)* > body > [^>]+$/.test(at) && d.kind !== 'children') return true;
    return false;
  });
}
