/// Identifiers for the wrapped server that are safe to keep on disk (audit chain, scan history)
/// and to print. A server's command line or URL can carry credentials (`--api-key …`, `?token=`,
/// `user:pass@`); none of that may end up in an identifier.

import { createHash } from 'node:crypto';
import path from 'node:path';

/// Flags whose next argument is treated as a credential and never used as the server name.
const SECRET_FLAG = /(key|token|secret|passw|pwd|auth|cred|bearer|cookie|session)/i;

/// Build a stable reputation identifier from the upstream command + args. The naive
/// "stdio:<cmd>" collapses every npx-launched server into one bucket, making the on-chain
/// score useless. We append the first non-flag arg (typically the package name or module),
/// stripping path / extension if it's a filesystem path. Examples:
///   npx -y @modelcontextprotocol/server-filesystem /tmp → stdio:npx:@modelcontextprotocol/server-filesystem
///   uvx mcp-server-git                                  → stdio:uvx:mcp-server-git
///   python -m mcp_server_fs                             → stdio:python:mcp_server_fs
///   node /home/user/server.js                           → stdio:node:server
///   npx (bare, no args)                                 → stdio:npx
/// The value after a credential-looking flag (`--api-key SECRET`) is never chosen, and a URL
/// argument is reduced to its host.
export function computeServerIdentifier(cmd: string, args: string[]): string {
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string' || a.length === 0) continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && SECRET_FLAG.test(a)) i++; // skip the flag's value
      continue;
    }
    target = a;
    break;
  }
  if (!target) return `stdio:${cmd}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return `stdio:${cmd}:${urlHost(target)}`;
  // Strip filesystem paths down to basename-without-extension. Scoped npm packages
  // (@scope/name) also contain '/' but should be preserved as-is — distinguish by leading '@'.
  const looksLikePath =
    !target.startsWith('@') &&
    (target.startsWith('/') ||
      target.startsWith('./') ||
      target.startsWith('../') ||
      target.includes('\\'));
  if (looksLikePath) {
    target = path.basename(target).replace(/\.[a-z]+$/i, '');
  }
  return `stdio:${cmd}:${target}`;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host || 'url';
  } catch {
    return 'url';
  }
}

/// `http:<host>#<8 hex>` for an upstream URL: the host for people, a short hash of the full URL so
/// two endpoints on one host stay apart. No credentials, path or query.
export function httpServerIdentifier(url: string): string {
  return `http:${urlHost(url)}#${createHash('sha256').update(url).digest('hex').slice(0, 8)}`;
}

/// An upstream URL as printed: scheme and host only (`https://mcp.example/…`).
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' && !u.search ? '/' : '/…'}`;
  } catch {
    return '<upstream>';
  }
}
