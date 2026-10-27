// API client for the proxy local API. The bearer token arrives in the URL fragment on first load
// (`#token=…`) and is kept in memory only — never localStorage/sessionStorage
// (privacy rule: the dashboard stores nothing sensitive). All requests are same-origin to the
// proxy (dev: Vite proxies /api and /events to 127.0.0.1); nothing leaves the host.

let token = '';

/** Read `#token=…` from the fragment once, then strip it from the URL so it isn't left in history. */
export function captureToken(): void {
  if (typeof window === 'undefined') return;
  const frag = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(frag);
  const t = params.get('token');
  if (t) {
    token = t;
    params.delete('token');
    const rest = params.toString();
    const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
    window.history.replaceState(null, '', url);
  }
}

export function setToken(t: string): void {
  token = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'Proxy unreachable');
  }
  if (!res.ok) {
    let code = 'ERROR';
    let message = res.statusText;
    try {
      const j = await res.json();
      code = j.code ?? code;
      message = j.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => req<T>('GET', path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => req<T>('POST', path, body, headers),
  put: <T>(path: string, body?: unknown) => req<T>('PUT', path, body),
};

/** URL for the /events WebSocket, same-origin (dev proxy forwards to the mock API). */
export function eventsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}/events${q}`;
}
