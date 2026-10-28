import { describe, it, expect } from 'vitest';
import { computeServerIdentifier } from '../src/transports/stdio.js';
import { displayUrl, httpServerIdentifier } from '../src/transports/server-id.js';

describe('computeServerIdentifier — distinguishes servers within the same launcher', () => {
  it('npx + scoped package', () => {
    expect(computeServerIdentifier('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']))
      .toBe('stdio:npx:@modelcontextprotocol/server-filesystem');
  });

  it('npx + different scoped package = different identifier', () => {
    const a = computeServerIdentifier('npx', ['-y', '@modelcontextprotocol/server-filesystem']);
    const b = computeServerIdentifier('npx', ['-y', '@modelcontextprotocol/server-postgres']);
    expect(a).not.toBe(b);
  });

  it('uvx + python package', () => {
    expect(computeServerIdentifier('uvx', ['mcp-server-git'])).toBe('stdio:uvx:mcp-server-git');
  });

  it('python -m module', () => {
    expect(computeServerIdentifier('python', ['-m', 'mcp_server_fs'])).toBe('stdio:python:mcp_server_fs');
    expect(computeServerIdentifier('python3', ['-m', 'mcp_server_fs'])).toBe('stdio:python3:mcp_server_fs');
  });

  it('node + absolute path → strips path and extension', () => {
    expect(computeServerIdentifier('node', ['/home/user/server.js'])).toBe('stdio:node:server');
  });

  it('node + relative path → strips path and extension', () => {
    expect(computeServerIdentifier('node', ['./src/server.js'])).toBe('stdio:node:server');
  });

  it('handles uppercase extensions', () => {
    expect(computeServerIdentifier('node', ['/home/x/Server.JS'])).toBe('stdio:node:Server');
  });

  it('falls back to bare cmd when args contain no non-flag entries', () => {
    expect(computeServerIdentifier('npx', [])).toBe('stdio:npx');
    expect(computeServerIdentifier('npx', ['-y'])).toBe('stdio:npx');
    expect(computeServerIdentifier('npx', ['--help'])).toBe('stdio:npx');
  });

  it('skips multiple leading flags', () => {
    expect(computeServerIdentifier('npx', ['-y', '--quiet', '--no-progress', '@scope/srv']))
      .toBe('stdio:npx:@scope/srv');
  });

  it('ignores additional args after the first target', () => {
    expect(computeServerIdentifier('npx', ['-y', '@scope/srv', '/data', '--port', '8080']))
      .toBe('stdio:npx:@scope/srv');
  });

  it('deno run', () => {
    expect(computeServerIdentifier('deno', ['run', '--allow-all', 'server.ts']))
      .toBe('stdio:deno:run');
    // "run" is the first non-flag arg. This is suboptimal for deno but consistent with
    // the algorithm. Documented behavior — operators using deno can override by passing
    // BLINDSEAL_MCP_SERVER_URL in the future. For now, all deno-launched servers will
    // collapse to stdio:deno:run, which is no worse than the previous bug.
  });

  it('idempotent', () => {
    const id = computeServerIdentifier('npx', ['-y', '@scope/server']);
    expect(computeServerIdentifier('npx', ['-y', '@scope/server'])).toBe(id);
  });
});

/// 0.7.0 re-audit follow-up: the identifier is written to the audit chain and scan history, so it
/// must never carry a credential from the command line or an upstream URL.
describe('server identifiers hold no credentials', () => {
  it('the value after a credential-looking flag is never the server name', () => {
    expect(computeServerIdentifier('srv', ['--api-key', 'SECRET123'])).toBe('stdio:srv');
    expect(computeServerIdentifier('node', ['--token', 'SECRET123', 'server.js'])).toBe('stdio:node:server.js');
    expect(computeServerIdentifier('uvx', ['--auth', 'SECRET123', 'mcp-server-git'])).toBe('stdio:uvx:mcp-server-git');
    expect(computeServerIdentifier('srv', ['--api-key=SECRET123', 'pkg'])).toBe('stdio:srv:pkg');
  });

  it('a URL argument is reduced to its host', () => {
    expect(computeServerIdentifier('npx', ['-y', 'https://user:pw@mcp.example/sse?token=SECRET123'])).toBe('stdio:npx:mcp.example');
  });

  it('http upstreams: host plus a short hash, never path, query or user:password', () => {
    const id = httpServerIdentifier('https://user:pw@mcp.example/v1/SECRETPATH?token=SECRET123');
    expect(id).toMatch(/^http:mcp\.example#[0-9a-f]{8}$/);
    expect(id).not.toMatch(/SECRET|pw/);
    expect(httpServerIdentifier('https://mcp.example/a')).not.toBe(httpServerIdentifier('https://mcp.example/b'));
    expect(displayUrl('https://user:pw@mcp.example/v1?token=SECRET123')).toBe('https://mcp.example/…');
  });
});

describe('server identifiers: assignments and shell snippets are never the server name', () => {
  it('env VAR=…, docker -e KEY=…, sh -c "…"', () => {
    expect(computeServerIdentifier('env', ['GITHUB_TOKEN=ghp_SECRET', 'npx', 'srv'])).toBe('stdio:env:npx');
    expect(computeServerIdentifier('docker', ['run', '-e', 'TOKEN=abcSECRET', 'img'])).toBe('stdio:docker:run');
    expect(computeServerIdentifier('sh', ['-c', 'API_KEY=SECRET node srv.js'])).toBe('stdio:sh');
  });
});
