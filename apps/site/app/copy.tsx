'use client';
import { useState } from 'react';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="copy" aria-label={label ?? 'Copy'} onClick={() => {
      navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }).catch(() => {});
    }}>
      <i data-lucide={done ? 'check' : 'copy'} />
    </button>
  );
}
