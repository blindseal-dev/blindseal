import type { ReactNode } from 'react';
import type { CodeLang } from './content';

// BS.ui.code(text, { lang }) + page.js's tokenise() / shell colouring, rendered on the server: the same
// .code block (lang label, <pre><code>, the copy button the kit wires on click via [data-copy]) and the
// same five token kinds (.code__c comment · .tk-s string · .tk-n number · .tk-k keyword · .tk-p key ·
// .tk-x punctuation) so s04.css colours them. No runtime highlighter.
const TOK = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")(\s*:)?|('[^'\n]*')|(\b\d+(?:\.\d+)?\b)|(\b(?:interface|type|string|number|boolean|true|false|null|let|const|use|as|await|import|from)\b)|([A-Za-z_$][\w$]*)(?=\??:)|([{}\[\]();,|&?=<>])/g;

function tokenise(src: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const key = `${keyPrefix}${k++}`;
    if (m[1]) out.push(<span key={key} className="code__c">{m[1]}</span>);
    else if (m[2]) out.push(m[3] ? <span key={key}><span className="tk-p">{m[2]}</span><span className="tk-x">{m[3]}</span></span> : <span key={key} className="tk-s">{m[2]}</span>);
    else if (m[4]) out.push(<span key={key} className="tk-s">{m[4]}</span>);
    else if (m[5]) out.push(<span key={key} className="tk-n">{m[5]}</span>);
    else if (m[6]) out.push(<span key={key} className="tk-k">{m[6]}</span>);
    else if (m[7]) out.push(<span key={key} className="tk-p">{m[7]}</span>);
    else if (m[8]) out.push(<span key={key} className="tk-x">{m[8]}</span>);
    last = TOK.lastIndex;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// a shell line: flags → .tk-p, quoted strings → .tk-s, a trailing "  # note" → .code__c
const SH = /(\s{2,}#[^\n]*$)|('[^']*'|"[^"]*")|(\s-{1,2}[A-Za-z][\w-]*)/g;
function shellLine(l: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  SH.lastIndex = 0;
  while ((m = SH.exec(l))) {
    if (m.index > last) out.push(l.slice(last, m.index));
    const key = `${keyPrefix}${k++}`;
    if (m[1]) out.push(<span key={key} className="code__c">{m[1]}</span>);
    else if (m[2]) out.push(<span key={key} className="tk-s">{m[2]}</span>);
    else out.push(<span key={key} className="tk-p">{m[3]}</span>);
    last = SH.lastIndex;
  }
  if (last < l.length) out.push(l.slice(last));
  return out;
}

function body(text: string, lang: CodeLang): ReactNode[] {
  if (lang === 'json' || lang === 'ts' || lang === 'rust') return tokenise(text, 't');
  return text.split('\n').flatMap((l, i) => {
    const nl = i ? ['\n'] : [];
    if (lang === 'shell' && /^\$ /.test(l)) return [...nl, <span key={`p${i}`} className="code__prompt">$ </span>, ...shellLine(l.slice(2), `l${i}-`)];
    if (lang === 'shell' && /^#/.test(l)) return [...nl, <span key={`c${i}`} className="code__c">{l}</span>];
    if (lang === 'shell') return [...nl, ...shellLine(l, `l${i}-`)];
    // text (the hashing spec, the PDA table): a "-- note" tail is the secondary token
    const c = l.indexOf('-- ');
    if (c > 0) return [...nl, l.slice(0, c), <span key={`c${i}`} className="code__c">{l.slice(c)}</span>];
    return [...nl, l];
  });
}

export function CodeBlock({ text, lang }: { text: string; lang: CodeLang }) {
  const plain = text.split('\n').map((l) => l.replace(/^\$ /, '')).join('\n');
  return (
    <div className="code">
      <span className="code__lang">{lang}</span>
      <pre><code>{body(text, lang)}</code></pre>
      <button type="button" className="copy code__copy" data-copy={plain} aria-label="Copy"><i data-lucide="copy" /></button>
    </div>
  );
}
