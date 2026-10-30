'use client';
import { usePageKit } from './use-page-kit';

// S01 · Home — the round-2 scroll-lit hero: the mockup's r2/home/page.js, run once the kit has mounted the
// chrome (use-page-kit.ts), so the banner img.hero__banner the kit puts in .hero__space exists. page.tsx renders
// the hooks (kit/site.css: .hero--pinned, .hero__stage, .hero__reveal) and this fills them.
//
// Progress: section.hero--pinned is (1 + --hero-scroll) × max(100vh, 720) tall and its stage sticks for the extra
// viewport; p = scrolled / (hero height − stage height), 0 → 1 over the pin. The drawn value glides toward the
// scroll target (τ 150 ms; × 4 under ?motion=slow). rAF runs only while the value is moving: nothing autoplays,
// nothing idles.
//
// The clip (/kit/brand/dial-ignite-720.mp4: H.264 1280 × 720, a keyframe every 6 frames, no B-frames, no audio,
// moov first) is never played: muted, playsInline, no autoplay, play() is never called and a stray "play" is
// paused. currentTime = p × 7.6 s. One seek in flight at a time; the newest target waits for "seeked", so a
// fast scroll never queues stale frames. PRODUCTION PATH (the mockup fetched a blob because its static server
// sent no byte ranges): a plain src with preload="auto", set after the page's load event, so the decoder
// range-requests only what each seek needs (the standalone server honours Range: e2e checks it).
//
// Registration: the plate is placed by the ring. The banner's ring (a circle fit to its glowing pixels) is read
// from where the kit's CSS draws it (the computed object-position of img.hero__banner), and the clip's ring is
// put on that point; the plate is scaled so the rings match and raised just enough to cover the stage. The plate
// is invisible at rest (the banner is the rest frame) and fades in over p 0 → .04 once a frame has decoded.
//
// Reduced motion (?motion=reduce or the OS setting, re-read live on bs:motion): no pin (home.css keys on
// html[data-motion]), the opened end still (dial-ignite-end.webp) registered the same way, and the clip is never
// requested. PHONES (< 720 px, the kit's breakpoint): the still as well, never the clip — the plate fills the
// stage with the still cropped so the ring sits top right, under a uniform scrim that keeps the copy at 4.5:1 or
// better (home.css); the hero hugs its content as before, no pin.
const T_END = 7.6;
const BANNER_RING = { x: 0.70171, y: 0.45155, r: 0.11832 };   /* of the banner image (1672 × 941) */
const CLIP_RING = { x: 0.69157, y: 0.43662, r: 0.11549 };     /* of the clip frame (16:9) */
const CLIP_AR = 16 / 9;
const CLIP_SRC = '/kit/brand/dial-ignite-720.mp4';
const STILL_END = '/kit/brand/dial-ignite-end.webp';
const PHONE = '(max-width: 719.98px)';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export interface HomeStats { seeks: number; coalesced: number; total: number; max: number; avg: number; ready: boolean; loadMs: number; requested: boolean; plays: number }

export function HomeKit() {
  usePageKit((BS) => {
    const M = BS.motion;
    const hero = document.querySelector<HTMLElement>('.hero.hero--pinned');
    if (!hero || !M) return;
    const stage = hero.querySelector<HTMLElement>('.hero__stage');
    const layer = hero.querySelector<HTMLElement>('.hm-light');
    const plate = layer?.querySelector<HTMLElement>('.hm-light__plate');
    const video = plate?.querySelector<HTMLVideoElement>('.hm-light__video');
    const still = plate?.querySelector<HTMLImageElement>('.hm-light__still');
    const scrim = layer?.querySelector<HTMLElement>('.hm-light__scrim');
    const space = hero.querySelector<HTMLElement>('.hero__space');
    if (!stage || !layer || !plate || !video || !still || !scrim) return;
    const cleanups: Array<() => void> = [];
    const on = (t: EventTarget, type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
      t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o));
    };
    const stats: HomeStats = { seeks: 0, coalesced: 0, total: 0, max: 0, avg: 0, ready: false, loadMs: 0, requested: false, plays: 0 };
    const phoneMq = window.matchMedia(PHONE);
    const reducedNow = () => !!M.reduced();
    let reduced = reducedNow(), phone = phoneMq.matches;
    const stillMode = () => reduced || phone;

    /* ── registration: where the kit draws the banner's ring, then the plate on it ─────────────────── */
    const geo: { ring: Record<string, number> | null; plate: Record<string, unknown> | null } = { ring: null, plate: null };
    const lenPx = (v: string, ref: number) => {     /* "12px" | "50%" | "calc(100% + 90.81px)" | "calc(100% - 4px)" → px */
      v = String(v).trim();
      const m = /^calc\(\s*(-?[\d.]+)%\s*([+-])\s*(-?[\d.]+)px\s*\)$/.exec(v);
      if (m) return ref * Number(m[1]) / 100 + (m[2] === '-' ? -1 : 1) * Number(m[3]);
      if (/%$/.test(v)) return ref * parseFloat(v) / 100;
      if (/px$/.test(v)) return parseFloat(v);
      if (v === 'left' || v === 'top') return 0;
      if (v === 'right' || v === 'bottom') return ref;
      return ref / 2;
    };
    const splitPos = (s: string) => {     /* two top-level tokens, calc() kept whole */
      const out: string[] = []; let depth = 0, cur = '';
      for (const c of s) {
        if (c === '(') depth++; else if (c === ')') depth--;
        if (c === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += c;
      }
      if (cur) out.push(cur);
      return out;
    };
    const bannerImg = () => space?.querySelector<HTMLImageElement>('img.hero__banner') ?? null;
    function bannerRing() {
      const img = bannerImg();
      const bw = stage!.clientWidth, bh = stage!.clientHeight;
      const nw = (img && img.naturalWidth) || 1672, nh = (img && img.naturalHeight) || 941;
      const k = Math.max(bw / nw, bh / nh), rw = nw * k, rh = nh * k;
      const pos = img ? splitPos(getComputedStyle(img).objectPosition) : ['100%', '50%'];
      const x = lenPx(pos[0] ?? '100%', bw - rw), y = lenPx(pos[1] ?? '50%', bh - rh);
      return { x: x + BANNER_RING.x * rw, y: y + BANNER_RING.y * rh, r: BANNER_RING.r * rw, bw, bh };
    }
    function layout() {
      if (phone) {   /* home.css: the plate fills the stage, the still is cropped by CSS */
        for (const k of ['left', 'top', 'width', 'height'] as const) plate!.style.removeProperty(k);
        geo.ring = null; geo.plate = null;
        return;
      }
      const g = bannerRing();
      let pw = g.r / CLIP_RING.r;                                /* rings the same size */
      const need = Math.max(
        (g.y / CLIP_RING.y) * CLIP_AR,                           /* top edge at or above 0 */
        ((g.bh - g.y) / (1 - CLIP_RING.y)) * CLIP_AR,            /* bottom edge at or below the stage's */
        (g.bw - g.x) / (1 - CLIP_RING.x),                        /* right edge at or past the stage's */
        g.x / CLIP_RING.x,                                       /* left edge at or before 0 */
      );
      pw = Math.max(pw, need);
      const ph = pw / CLIP_AR;
      const left = g.x - CLIP_RING.x * pw, top = g.y - CLIP_RING.y * ph;
      plate!.style.left = left.toFixed(2) + 'px'; plate!.style.top = top.toFixed(2) + 'px';
      plate!.style.width = pw.toFixed(2) + 'px'; plate!.style.height = ph.toFixed(2) + 'px';
      geo.ring = { x: +g.x.toFixed(2), y: +g.y.toFixed(2), r: +g.r.toFixed(2) };
      geo.plate = { left: +left.toFixed(2), top: +top.toFixed(2), w: +pw.toFixed(2), h: +ph.toFixed(2),
        clipRing: { x: +(left + CLIP_RING.x * pw).toFixed(2), y: +(top + CLIP_RING.y * ph).toFixed(2), r: +(CLIP_RING.r * pw).toFixed(2) } };
    }

    /* ── the clip: never played, its currentTime set from p ───────────────────────────────────────── */
    let want = 0, issued = -1, busy = false, t0 = 0, ready = false, tLoad = 0;
    video.muted = true; video.defaultMuted = true; video.playsInline = true; video.autoplay = false; video.loop = false;
    function seek() {
      if (!ready || video!.hidden) return;
      if (busy) { stats.coalesced++; return; }
      if (Math.abs(issued - want) < 1 / 96) return;
      busy = true; issued = want; t0 = performance.now(); stats.seeks++;
      video!.currentTime = want;
    }
    on(video, 'seeked', () => {
      if (!busy) return;
      const dt = performance.now() - t0;
      stats.total += dt; stats.max = Math.max(stats.max, +dt.toFixed(1)); stats.avg = +(stats.total / stats.seeks).toFixed(1);
      busy = false;
      if (!plate.classList.contains('is-ready')) plate.classList.add('is-ready');   /* the first decoded frame is on screen */
      seek();                                                                       /* the newest target, if it moved */
    });
    on(video, 'play', () => { stats.plays++; video.pause(); });
    on(video, 'loadeddata', () => {
      ready = stats.ready = true;
      stats.loadMs = Math.round(performance.now() - tLoad);
      issued = -1; if (want === 0) want = 0.001;                   /* a first seek drops the poster state */
      seek();
    });
    on(video, 'error', () => { if (console && console.warn) console.warn('[home] the hero clip did not load; the banner stays'); });
    function loadClip() {
      if (stats.requested || stillMode()) return;
      stats.requested = true; tLoad = performance.now();
      /* production: a plain src — the server answers byte ranges, so the decoder fetches what each seek needs */
      video!.preload = 'auto';
      video!.src = CLIP_SRC;
      video!.load();
    }
    let idleId: number | ReturnType<typeof setTimeout> | 0 = 0, idleIsRic = false;
    function whenIdle(fn: () => void) {
      const go = () => {
        const w = window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number };
        if (w.requestIdleCallback) { idleIsRic = true; idleId = w.requestIdleCallback(fn, { timeout: 1200 }); }
        else { idleIsRic = false; idleId = setTimeout(fn, 1); }
      };
      if (document.readyState === 'complete') go(); else on(window, 'load', go, { once: true });
    }
    cleanups.push(() => {
      if (!idleId) return;
      const w = window as unknown as { cancelIdleCallback?: (id: number) => void };
      if (idleIsRic) w.cancelIdleCallback?.(idleId as number); else clearTimeout(idleId as ReturnType<typeof setTimeout>);
    });

    /* ── drawing one progress value ───────────────────────────────────────────────────────────────── */
    function apply(p: number) {
      const stillOn = stillMode();
      plate!.style.opacity = stillOn ? '1' : smooth(0, 0.04, p).toFixed(3);
      scrim!.style.opacity = stillOn && phone ? '1' : mix(0.25, 1, smooth(0, 0.45, p)).toFixed(3);
      if (!stillOn) { want = Math.max(0.001, p * T_END); seek(); }
    }

    let target = 0, cur = 0, raf = 0, last = 0;
    function measure() {
      const run = hero!.offsetHeight - stage!.offsetHeight;
      return run > 0 ? clamp(-hero!.getBoundingClientRect().top / run, 0, 1) : 1;
    }
    function tick(now: number) {
      raf = 0;
      const dt = Math.min(64, Math.max(1, now - last)); last = now;
      const tau = Math.max(1, typeof M.scale === 'function' ? M.scale(150) : 150);
      cur += (target - cur) * (1 - Math.exp(-dt / tau));
      if (Math.abs(target - cur) < 0.0004) cur = target;
      apply(cur);
      if (cur !== target) raf = requestAnimationFrame(tick);
    }
    function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }

    function setMode() {
      const s = stillMode();
      video!.hidden = s;
      still!.hidden = !s;
      if (s) {
        if (!still!.getAttribute('src')) still!.src = STILL_END;
        if (!video!.paused) video!.pause();
      } else {
        issued = -1;
        whenIdle(loadClip);
      }
    }
    function sync() {
      layout();
      if (stillMode()) { if (raf) { cancelAnimationFrame(raf); raf = 0; } cur = target = 1; apply(1); }
      else { cur = target = measure(); apply(cur); }
    }
    on(window, 'scroll', () => { if (stillMode()) return; target = measure(); kick(); }, { passive: true });
    on(window, 'resize', () => { layout(); if (stillMode()) apply(1); else { target = measure(); kick(); } });
    const img0 = bannerImg();
    if (img0 && !img0.complete) on(img0, 'load', () => layout(), { once: true });
    function onChange() {
      const r = reducedNow(), ph = phoneMq.matches;
      if (r === reduced && ph === phone) return;
      reduced = r; phone = ph;
      setMode();
      requestAnimationFrame(sync);                                 /* after the kit has flipped html[data-motion] */
    }
    on(document, 'bs:motion', onChange);
    const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    on(rmq, 'change', onChange);
    on(phoneMq, 'change', onChange);

    setMode();
    sync();

    BS.home = {
      stats, geo,
      get p() { return cur; }, get target() { return target; },
      get video() { return video; }, get phone() { return phone; }, apply, layout,
    };
    cleanups.push(() => {
      if (raf) cancelAnimationFrame(raf);
      if (BS.home && BS.home.video === video) delete BS.home;
      /* release the decoder: the hero is gone with the route */
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* noop */ }
    });
    return () => { cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch { /* noop */ } }); };
  });
  return null;
}
