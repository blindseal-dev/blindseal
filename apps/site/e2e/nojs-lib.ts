// Shared by the JS-disabled checks: every rendered text node must be visible — no ancestor at opacity 0 or
// visibility:hidden (the old failure: .reveal stayed at opacity 0 forever without the kit). Text that is
// not rendered at all (display:none, [hidden], zero-size sr-only) is skipped: it is not "invisible content".
export const INVISIBLE_TEXT = `(() => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.nodeValue.trim(); if (!t) continue;
    const el = n.parentElement; if (!el || el.closest('script,style,noscript,template,[aria-hidden="true"]')) continue;   // aria-hidden: decorative duplicates (the notch's ink layer)
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;   // not rendered / sr-only
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (Number(cs.opacity) === 0 || cs.visibility === 'hidden') { out.push(t.slice(0, 60) + '  ← ' + a.tagName.toLowerCase() + '.' + [...a.classList].join('.')); break; }
    }
  }
  return out;
})()`;
