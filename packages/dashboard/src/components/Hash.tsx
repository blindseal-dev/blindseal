import { useState } from 'react';

/** A hash everywhere: mono, truncated 0x1234…abcd (hex 6+4, base58 4+4), click to copy. */
export function Hash({ value, lg }: { value: string; lg?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="bs-faint">—</span>;

  const isHex = value.startsWith('0x');
  const short = isHex
    ? value.length > 12
      ? `${value.slice(0, 8)}…${value.slice(-4)}`
      : value
    : value.length > 10
      ? `${value.slice(0, 4)}…${value.slice(-4)}`
      : value;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked; no-op */
    }
  };

  return (
    <button
      type="button"
      className={`bs-hash${copied ? ' is-copied' : ''}`}
      style={lg ? { fontSize: 'var(--hash-size-lg)' } : undefined}
      title={copied ? 'copied' : value}
      onClick={copy}
    >
      {copied ? 'copied' : short}
    </button>
  );
}
