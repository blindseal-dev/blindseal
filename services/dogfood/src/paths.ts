/// Where the pieces live: the proxy's CLI entry (the `blindseal` package in the workspace), this
/// service's own MCP server, and the repo fixtures dry run copies. Works from src (tsx) and from dist.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/// Running from the compiled output or from source under tsx.
const fromDist = here.split(path.sep).includes('dist');

export interface NodeEntry { args: string[] }

/// `blindseal` (packages/proxy): dist/index.js when built, else src/index.ts under tsx.
export function blindsealCli(): NodeEntry {
  const pkgDir = path.dirname(require.resolve('blindseal/package.json'));
  const dist = path.join(pkgDir, 'dist', 'index.js');
  if (existsSync(dist)) return { args: [dist] };
  return { args: ['--import', 'tsx', path.join(pkgDir, 'src', 'index.ts')] };
}

/// This service's MCP server (src/mcp/server.ts), as something `node` can run. paths.ts sits at the top
/// of src/ and dist/, so the server is a sibling directory either way.
export function mcpServerEntry(): NodeEntry {
  if (fromDist) return { args: [path.join(here, 'mcp', 'server.js')] };
  return { args: ['--import', 'tsx', path.join(here, 'mcp', 'server.ts')] };
}

/// services/dogfood
export function packageRoot(): string { return path.resolve(here, '..'); }

/// tests/fixtures at the repo root (dry run copies the mainnet sample attestation from there).
export function fixturesDir(): string {
  return path.resolve(packageRoot(), '..', '..', 'tests', 'fixtures');
}
export const FIXTURE_ATTESTATION = 'attestation-mainnet-demo-0.7.0.json';
