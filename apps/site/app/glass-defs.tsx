// The kit's glass filter defs (glass.js ensureDefs), rendered by React in the root layout so the
// server HTML and the hydrated DOM agree; glass.js's ensureDefs() is a no-op when this exists.
function Filter({ id, scale }: { id: string; scale: number }) {
  return (
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.014" numOctaves={2} seed={7} result="noise" />
      <feGaussianBlur in="noise" stdDeviation={3} result="soft" />
      <feDisplacementMap in="SourceGraphic" in2="soft" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}
export function GlassDefs() {
  return (
    <svg id="bs-glass-defs" className="bs-glass-defs" aria-hidden="true" width="0" height="0">
      <defs><Filter id="bs-lg-refract" scale={34} /><Filter id="bs-lg-refract-sm" scale={14} /></defs>
    </svg>
  );
}
