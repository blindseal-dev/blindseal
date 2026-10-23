import type { Layer } from '../api/types';

/** The four-layer strip: L0 L1 L2 L3, each tinted by its verdict (skip is faint). */
export function LayerStrip({ layers }: { layers: Layer[] }) {
  return (
    <span className="bs-layers">
      {layers.map((l) => (
        <span
          key={l.layer}
          className="bs-layer"
          data-v={l.ran ? l.verdict : 'skip'}
          title={`${l.layer} · ${l.ran ? l.verdict : 'skipped'}${l.score != null ? ` · ${l.score}` : ''} · ${l.latencyMs}ms`}
        >
          {l.layer}
        </span>
      ))}
    </span>
  );
}
