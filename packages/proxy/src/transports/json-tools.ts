/// JSON helpers with no model-layer dependencies, shared by reply screening and the scan worker
/// (scan-worker.ts), which must stay light: it is loaded once per worker thread.

export type Obj = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/// JSON.parse into null-prototype objects. JSON.parse itself keeps a literal "__proto__" key as an
/// own property, but any later copy into a `{}` (assignment, Object.assign) turns it into a
/// prototype change and the key disappears from Object.keys. Null-prototype objects have no
/// `__proto__` accessor, so the key stays an ordinary property everywhere downstream.
export function parseJson(text: string): unknown {
  return toNullPrototype(JSON.parse(text));
}

/// JSON-RPC messages are shallow; anything nested deeper than this is refused at parse time (the
/// caller treats it as unparseable: never forwarded), so no later recursive step — redaction,
/// serialisation — can overflow the stack and take the proxy down.
export const MAX_JSON_DEPTH = 256;

/// Rebuilds every plain object of a parsed value with a null prototype. Iterative: a deeply nested
/// message must not overflow the stack here (a reviver recursed, threw at ~3000 levels, and the
/// caller then treated the line as "not JSON").
function toNullPrototype(root: unknown): unknown {
  const convert = (v: unknown): unknown => {
    if (!isPlainObject(v)) return v;
    const o = Object.create(null) as Obj;
    for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: v[k], enumerable: true, writable: true, configurable: true });
    return o;
  };
  const top = convert(root);
  const stack: Array<[unknown, number]> = [[top, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth > MAX_JSON_DEPTH) throw new RangeError(`JSON nested deeper than ${MAX_JSON_DEPTH} levels`);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { v[i] = convert(v[i]); stack.push([v[i], depth + 1]); }
    } else {
      for (const k of Object.keys(v as Obj)) { (v as Obj)[k] = convert((v as Obj)[k]); stack.push([(v as Obj)[k], depth + 1]); }
    }
  }
  return top;
}

/// Deterministic JSON: object keys sorted recursively. Builds the string directly (no
/// intermediate object), so a "__proto__" key is serialised like any other key.
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (v: unknown): string | undefined => {
    if (v === null) return 'null';
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (typeof v !== 'object') return JSON.stringify(v);
    if (seen.has(v)) return JSON.stringify('[circular]');
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = '[' + v.map((x) => enc(x) ?? 'null').join(',') + ']';
    } else {
      const parts: string[] = [];
      for (const k of Object.keys(v).sort()) {
        const s = enc((v as Obj)[k]);
        if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s);
      }
      out = '{' + parts.join(',') + '}';
    }
    seen.delete(v);
    return out;
  };
  return enc(value) ?? '';
}

/// Every string in a JSON value — object keys and string leaves — in stable key order. Iterative,
/// so a deeply nested reply cannot overflow the stack.
export function stringLeaves(value: unknown, order: 'sorted' | 'as-sent' = 'sorted', keys = true): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') { out.push(v); continue; }
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
      continue;
    }
    const names = order === 'sorted' ? Object.keys(v).sort() : Object.keys(v);
    for (let i = names.length - 1; i >= 0; i--) {
      stack.push((v as Obj)[names[i]!]);
      if (keys) stack.push(names[i]!); // the key is visited before its value
    }
  }
  return out;
}

/// Leaves joined with '\n'. Scanned alongside the stable JSON: JSON escaping turns a real newline
/// or tab inside a value into a literal backslash sequence, which whitespace-based patterns miss.
export function jsonStringLeaves(value: unknown): string {
  return stringLeaves(value).join('\n');
}

/// The body with strings already screened on their own (text items) replaced by a short marker,
/// structure kept.
export function withoutScreened(v: unknown, skip: Set<string>): unknown {
  if (typeof v === 'string') return skip.has(v) ? '[screened separately]' : v;
  if (Array.isArray(v)) return v.map((x) => withoutScreened(x, skip));
  if (isPlainObject(v)) {
    const o = Object.create(null) as Obj;
    for (const k of Object.keys(v)) o[k] = withoutScreened(v[k], skip);
    return o;
  }
  return v;
}
